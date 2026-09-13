/**
 * ImageForge - scripts/pack.js
 *
 * 把「上线真正需要的文件」从工程里挑出来，产出一个可直接上传的目录和一个 zip。
 *
 * 为什么需要这一步：工程根目录混着源码、构建脚本、node_modules（本机实测 15,599 个文件），
 * 直接整包上传到静态服务器等于把源码和依赖一起公开出去，而且不少平台有文件数上限
 * （Cloudflare Pages 拖拽上传就是 1,000 个）。这里用白名单（而不是黑名单）挑选，
 * 新增的工程文件默认不会被误传上线。
 *
 * 产出的目录同时也是本地预览的根目录（scripts/serve.js 默认服务这个目录），
 * 所以「预览看到什么」== 「上传后别人看到什么」，不存在只在本地好的情况。
 *
 * 用法：
 *   node scripts/pack.js                          # 通用目标：产出 build/ 与 release/*.zip
 *   node scripts/pack.js --target=cloudflare      # 去掉 .gz/.br，加上 _headers
 *   node scripts/pack.js --with-examples          # 额外带上 examples/ 演示页
 */

const fs = require('fs');
const path = require('path');

const { ROOT, loadBrand } = require('./lib/brand.js');
const { createZip } = require('./lib/zip.js');

const BRAND = loadBrand();

const BUILD = path.join(ROOT, 'build');
const RELEASE = path.join(ROOT, 'release');
const WITH_EXAMPLES = process.argv.includes('--with-examples');

/**
 * 目标平台差异。这是个显式的开关，而不是让同一份产物试图讨好所有平台：
 *   generic    —— 自建服务器（Nginx）。保留构建期生成的 .gz / .br，靠 gzip_static 直接返。
 *   cloudflare —— Cloudflare Pages。边缘会自己压缩，预压缩产物纯属浪费上传体积，
 *                 所以丢掉；同时补一个 _headers 来接管缓存与安全响应头
 *                 （相当于把 deploy/nginx.conf 里的 header 段翻译成 Cloudflare 的写法）。
 */
const TARGETS = {
	generic: {
		skip: [],
		extras: [],
		note: '预压缩产物保留，需要服务器开 gzip_static / brotli_static 才生效',
	},
	cloudflare: {
		skip: [/\.(gz|br)$/],
		extras: [{ from: 'deploy/cloudflare/_headers', to: '_headers' }],
		note: '已去掉 .gz/.br（Cloudflare 边缘自动压缩），并加入 _headers 响应头配置',
	},
};

/** Cloudflare Pages 的硬限制，用来在打包时给出可行性判断 */
const LIMITS = {
	cloudflare: { files: 1000, fileSize: 25 * 1024 * 1024, label: '拖拽上传上限' },
	generic: { files: Infinity, fileSize: Infinity, label: '' },
};

const TARGET = (() => {
	const arg = process.argv.find(a => a.startsWith('--target='));
	const value = arg ? arg.slice('--target='.length) : 'generic';
	if (!TARGETS[value]) {
		throw new Error('未知的 --target=' + value + '，可选：' + Object.keys(TARGETS).join(' | '));
	}
	return value;
})();

const RULES = TARGETS[TARGET];

function kb(bytes) {
	return (bytes / 1024).toFixed(1) + ' KB';
}

/** 根目录下要上线的一级条目（白名单） */
const ROOT_FILES = ['index.html', 'manifest.webmanifest', 'robots.txt', 'sitemap.xml'];
const COPY_DIRS = ['dist', 'images'];
/** 演示数据，仅 examples/ 引用，不需要上线 */
const SKIP_FILES = new Set(['images/test-collection.json']);

function isSkipped(rel) {
	if (SKIP_FILES.has(rel)) return true;
	return RULES.skip.some(re => re.test(rel));
}

function assertExists(rel) {
	if (!fs.existsSync(path.join(ROOT, rel))) {
		throw new Error('缺少上线必需的文件: ' + rel + '\n先跑一次 npm run build');
	}
}

/**
 * 上线前自检：把 index.html / manifest 里引用的本地资源逐个验在不在。
 *
 * 原项目就栽在这里 —— 它的 index.html 里写着 href="dist/manifest.json"，
 * 而 dist/ 下根本没有这个文件，线上一直是一个静默 404。
 */
function checkReferences(files, errors) {
	const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

	// 只看真正承载 URL 的属性：href / src，以及 content 里长得像文件路径的值。
	// （meta 的 content 大多是描述文本，不能一股脑当路径去验）
	const looksLikeAsset = v => /^[^\s"'<>]+\.(png|jpe?g|svg|gif|webp|ico|js|css|json|webmanifest|xml|txt)$/i.test(v);

	const localRefs = [];
	for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) localRefs.push(m[1]);
	for (const m of html.matchAll(/content="([^"]+)"/g)) {
		if (looksLikeAsset(m[1])) localRefs.push(m[1]);
	}

	const manifestPath = path.join(ROOT, 'manifest.webmanifest');
	if (fs.existsSync(manifestPath)) {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		for (const icon of manifest.icons || []) localRefs.push(icon.src);
	}

	for (const ref of new Set(localRefs)) {
		if (/^https?:|^#|^data:|^mailto:/.test(ref)) continue;
		const rel = ref.split('?')[0].replace(/^\.\//, '');
		if (!rel) continue;
		if (!fs.existsSync(path.join(ROOT, rel))) {
			errors.push(rel + '  (被页面引用，但文件不存在 → 上线后是 404)');
		} else if (!files.includes(rel) && !isSkipped(rel)) {
			errors.push(rel + '  (被页面引用，但不在打包白名单里 → 会被漏传)');
		}
	}
}

function collect() {
	const files = [];

	for (const rel of ROOT_FILES) {
		assertExists(rel);
		files.push(rel);
	}

	const walk = (rel) => {
		const abs = path.join(ROOT, rel);
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const childRel = rel + '/' + entry.name;
			if (entry.isDirectory()) walk(childRel);
			else if (!isSkipped(childRel)) files.push(childRel);
		}
	};
	for (const dir of COPY_DIRS) {
		assertExists(dir);
		walk(dir);
	}

	if (WITH_EXAMPLES) {
		assertExists('examples');
		walk('examples');
	}

	return files.sort();
}

function copyInto(files) {
	fs.rmSync(BUILD, { recursive: true, force: true });

	let total = 0;
	let largest = { rel: '', size: 0 };

	const put = (srcAbs, rel) => {
		const dst = path.join(BUILD, rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(srcAbs, dst);
		const size = fs.statSync(srcAbs).size;
		total += size;
		if (size > largest.size) largest = { rel, size };
	};

	for (const rel of files) put(path.join(ROOT, rel), rel);

	for (const extra of RULES.extras) {
		assertExists(extra.from);
		put(path.join(ROOT, extra.from), extra.to);
		files.push(extra.to);
	}

	return { total, largest };
}

function makeZip(files) {
	fs.mkdirSync(RELEASE, { recursive: true });
	const entries = files.map(rel => ({
		name: rel,
		data: fs.readFileSync(path.join(BUILD, rel)),
	}));
	const { buffer, stored, deflated } = createZip(entries);

	const version = require(path.join(ROOT, 'package.json')).version;
	const suffix = TARGET === 'generic' ? '' : '-' + TARGET;
	const zipPath = path.join(RELEASE, 'imageforge-site-' + version + suffix + '.zip');
	fs.writeFileSync(zipPath, buffer);
	return { zipPath, size: buffer.length, stored, deflated };
}

function main() {
	console.log('');
	console.log('ImageForge pack  (target: ' + TARGET + ')');
	console.log('=================');

	const errors = [];
	const files = collect();
	checkReferences(files, errors);

	if (errors.length) {
		console.log('\n自检不通过：');
		errors.forEach(e => console.log('  ✗ ' + e));
		throw new Error('存在无效的资源引用，已中止打包');
	}

	const { total, largest } = copyInto(files);
	console.log('\n' + RULES.note);
	console.log('\n产出目录  build/            ' + files.length + ' 个文件, ' + kb(total));

	const limits = LIMITS[TARGET];
	const countRatio = limits.files === Infinity
		? ''
		: '  (平台' + limits.label + ' ' + limits.files + '，占用 '
			+ (files.length / limits.files * 100).toFixed(1) + '%)';
	console.log('文件数上限检查            ' + files.length + ' / ' + limits.files + countRatio);
	console.log('单文件上限检查            最大 ' + largest.rel + ' = ' + kb(largest.size)
		+ ' / ' + kb(limits.fileSize)
		+ (largest.size > limits.fileSize ? '   ✗ 超过平台限制' : '   ✓'));
	if (files.length > limits.files) {
		throw new Error('文件数超过 ' + TARGET + ' 的上限 ' + limits.files);
	}

	const zip = makeZip(files);
	console.log('\n产出压缩包 ' + path.relative(ROOT, zip.zipPath).replace(/\\/g, '/')
		+ '  ' + kb(zip.size) + '  (' + zip.deflated + ' 个已压缩 / ' + zip.stored + ' 个原样存储)');

	// 占位值提醒：这些绝对地址会被写进 SEO 标签
	const placeholders = [];
	const check = (label, value) => {
		if (/yourname|example\.com/.test(value)) placeholders.push(label + ' = ' + value);
	};
	check('site', BRAND.site);
	check('repository', BRAND.repository);
	check('issues', BRAND.issues);
	check('email', BRAND.email);

	if (placeholders.length) {
		console.log('\n⚠ brand.config.json 里仍是占位值（上线前需要替换）：');
		placeholders.forEach(p => console.log('  - ' + p));
		console.log('  改完记得重新 npm run build && npm run pack');
	}

	if (TARGET === 'cloudflare') {
		console.log('\n上传方式二选一：');
		console.log('  拖拽  把 build/ 里的内容（或 release/*.zip）拖进 Cloudflare 控制台');
		console.log('  CLI   npx wrangler pages deploy build');
	} else {
		console.log('\n把 build/ 里的内容整个上传到站点根目录即可，入口是 index.html。');
	}
	console.log('');
}

main();
