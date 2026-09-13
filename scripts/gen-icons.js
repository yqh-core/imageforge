/**
 * ImageForge - scripts/gen-icons.js
 *
 * 从一张矢量源 images/favicon.svg 生成全部位图图标，
 * 源文件改了只跑一条命令即可全部同步，避免手工导出六份不一致的 PNG。
 *
 * 用法： node scripts/gen-icons.js
 *
 * 产出清单：
 *   images/favicon.png          192px，页面 <link rel="icon"> 用
 *   images/manifest/*.png       7 档，PWA 清单声明的启动图标
 *   favicon.ico                 16/32/48 三档合一的传统图标，见 buildIco()
 */

const fs = require('fs');
const path = require('path');

// sharp 是可选依赖：它只在本脚本（矢量源 → PNG 图标）里用到，
// 上线构建完全不碰它。这样即使某个平台装不上 sharp 的本地二进制，
// 也不会连带把部署搞挂 —— 图标 PNG 已经提交在仓库里，本来就是最新的。
let sharp;
try {
	sharp = require('sharp');
} catch (err) {
	console.error('');
	console.error('SKIPPED  -  sharp is not installed');
	console.error('');
	console.error('sharp 是可选依赖，只用于从 images/favicon.svg 重新生成 PNG 图标。');
	console.error('仓库里已提交的 images/*.png 就是最新产物，构建和部署都不需要它。');
	console.error('');
	console.error('确实要重新生成图标的话，先装上它：');
	console.error('');
	console.error('  npm install');
	console.error('');
	process.exit(0);
}

const { ROOT } = require('./lib/brand.js');

const SOURCE = path.join(ROOT, 'images', 'favicon.svg');
const MANIFEST_DIR = path.join(ROOT, 'images', 'manifest');

/** 目标：文件路径 → 边长 */
const TARGETS = [
	{ file: path.join(ROOT, 'images', 'favicon.png'), size: 192 },
	{ file: path.join(MANIFEST_DIR, '48x48.png'), size: 48 },
	{ file: path.join(MANIFEST_DIR, '72x72.png'), size: 72 },
	{ file: path.join(MANIFEST_DIR, '96x96.png'), size: 96 },
	{ file: path.join(MANIFEST_DIR, '144x144.png'), size: 144 },
	{ file: path.join(MANIFEST_DIR, '168x168.png'), size: 168 },
	{ file: path.join(MANIFEST_DIR, '192x192.png'), size: 192 },
	{ file: path.join(MANIFEST_DIR, '512x512.png'), size: 512 },
];

/**
 * favicon.ico 里放哪几档。
 *
 * 为什么还要 ico：现代浏览器认 <link rel="icon">，但地址栏、书签栏、RSS 阅读器、
 * 各种爬虫和部分老工具会**无条件去请求 /favicon.ico**。没有这个文件时，
 * Cloudflare Pages 会把它当普通路径回落到 index.html（返回 200 + HTML），
 * 于是日志里全是"图标请求返回了一个网页"。放在站点根目录，这个请求就有正解了。
 *
 * 只要 16/32/48 三档：这是 Windows 外壳和浏览器标签实际会取的尺寸，
 * 再往上加（64/128/256）只会让文件变大，没有可见收益。
 */
const ICO_SIZES = [16, 32, 48];
const ICO_FILE = path.join(ROOT, 'favicon.ico');

/**
 * 把若干张 PNG 直接封装成 .ico。
 *
 * 说明：sharp 只支持**读取** ico，不支持写出，所以这里手搓容器。
 * 好消息是 ico 从 Vista 起就允许条目内直接嵌 PNG 数据（不要求 BMP/DIB），
 * 所有现代浏览器和系统都认，于是"封装"只是拼几十字节的头，不需要做像素转换。
 *
 * 结构（小端）：
 *   ICONDIR        6 字节   reserved(2)=0 type(2)=1 count(2)
 *   ICONDIRENTRY   16 字节 × count
 *   image data     按条目顺序紧跟其后，偏移由条目里的 imageOffset 指向
 */
function buildIco(entries) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);            // reserved，必须为 0
	header.writeUInt16LE(1, 2);            // 1 = icon，2 = cursor
	header.writeUInt16LE(entries.length, 4);

	let offset = 6 + 16 * entries.length;
	const dir = [];

	for (const entry of entries) {
		const d = Buffer.alloc(16);
		// 宽高各 1 字节，256 用 0 表示。这里最大 48，直接写。
		d.writeUInt8(entry.size, 0);
		d.writeUInt8(entry.size, 1);
		d.writeUInt8(0, 2);                 // 调色板色数，真彩色填 0
		d.writeUInt8(0, 3);                 // reserved
		d.writeUInt16LE(1, 4);              // color planes
		d.writeUInt16LE(32, 6);             // 每像素位数
		d.writeUInt32LE(entry.png.length, 8);
		d.writeUInt32LE(offset, 12);
		dir.push(d);
		offset += entry.png.length;
	}

	return Buffer.concat([header, ...dir, ...entries.map(e => e.png)]);
}

async function render(svg, size, extra) {
	const pipeline = sharp(svg, { density: 600 })
		.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png(Object.assign({ compressionLevel: 9, palette: true }, extra || {}));
	return pipeline.toBuffer();
}

async function main() {
	if (!fs.existsSync(SOURCE)) {
		throw new Error('缺少矢量源文件: images/favicon.svg');
	}
	fs.mkdirSync(MANIFEST_DIR, { recursive: true });

	const svg = fs.readFileSync(SOURCE);

	console.log('');
	console.log('ImageForge icons');
	console.log('================');
	console.log('source  images/favicon.svg');

	for (const target of TARGETS) {
		const buf = await render(svg, target.size);
		fs.writeFileSync(target.file, buf);

		console.log('  → ' + path.relative(ROOT, target.file).replace(/\\/g, '/').padEnd(30)
			+ target.size + 'x' + target.size + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
	}

	console.log('\nfavicon.ico (root, for /favicon.ico requests)');
	const icoEntries = [];
	for (const size of ICO_SIZES) {
		const png = await render(svg, size);
		icoEntries.push({ size, png });
		console.log('  + ' + (size + 'x' + size).padEnd(9) + (png.length / 1024).toFixed(1) + ' KB');
	}
	const ico = buildIco(icoEntries);
	fs.writeFileSync(ICO_FILE, ico);
	console.log('  → favicon.ico' + ' '.repeat(17) + (ico.length / 1024).toFixed(1) + ' KB  ('
		+ ICO_SIZES.length + ' sizes)');

	console.log('\n' + (TARGETS.length + 1) + ' files generated.\n');
}

main().catch(err => {
	console.error('\nICON GENERATION FAILED');
	console.error(err && err.message ? err.message : err);
	process.exit(1);
});
