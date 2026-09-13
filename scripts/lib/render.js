/**
 * ImageForge - scripts/lib/render.js
 *
 * 把 src/template/ 下的模板渲染成站点根目录的真实文件。
 * 页面、PWA 清单、robots、sitemap 全部由同一份品牌配置驱动，
 * 因此不存在"改了名字某处忘改"的问题。
 */

const fs = require('fs');
const path = require('path');
const { ROOT, buildTokens } = require('./brand.js');

const TEMPLATE_DIR = path.join(ROOT, 'src', 'template');
const BUNDLE_PATH = path.join(ROOT, 'dist', 'bundle.js');

/**
 * 产物文件名 → 是否参与 `?v=` 版本注入
 *
 * 404.html / service-worker.js 也走同一套渲染，理由和 index.html 一样：
 * 品牌名、主题色、站点地址、构建指纹都得来自 brand.config.json + 本次构建，
 * 不能出现"改了品牌但错误页还写着旧名字"这种角落。
 */
const OUTPUTS = [
	{ template: 'index.html', output: 'index.html', injectBundleVersion: true },
	{ template: '404.html', output: '404.html' },
	{ template: 'service-worker.js', output: 'service-worker.js', injectBundleVersion: true },
	{ template: 'manifest.webmanifest', output: 'manifest.webmanifest' },
	{ template: 'robots.txt', output: 'robots.txt' },
	{ template: 'sitemap.xml', output: 'sitemap.xml' },
];

function applyTokens(content, tokens) {
	return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, function (match, key) {
		return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match;
	});
}

function findUnresolved(content, file) {
	const found = content.match(/\{\{[A-Z0-9_]+\}\}/g);
	if (found) {
		const list = Array.from(new Set(found)).join(', ');
		throw new Error('模板 ' + file + ' 存在未替换的占位符: ' + list);
	}
}

/**
 * @param {object} [options]
 * @param {string} [options.hash] 覆盖内容指纹（默认读取 dist/bundle.js 计算）
 * @param {boolean} [options.quiet]
 * @returns {{ hash: string, files: string[] }}
 */
function renderSite(options) {
	const opts = options || {};
	const hash = opts.hash || hashOfBundle();
	const tokens = buildTokens({ hash });

	const written = [];
	for (const entry of OUTPUTS) {
		const src = path.join(TEMPLATE_DIR, entry.template);
		if (!fs.existsSync(src)) continue;

		let content = applyTokens(fs.readFileSync(src, 'utf8'), tokens);
		if (entry.injectBundleVersion) {
			content = content.replace(/dist\/bundle\.js(\?v=[^"']*)?/g, 'dist/bundle.js?v=' + hash);
		}
		findUnresolved(content, entry.template);

		const dest = path.join(ROOT, entry.output);
		fs.writeFileSync(dest, content, 'utf8');
		written.push(entry.output);
	}

	if (!opts.quiet) {
		console.log('  rendered: ' + written.join(', ') + '  (v=' + hash + ')');
	}
	return { hash: hash, files: written };
}

function hashOfBundle() {
	if (!fs.existsSync(BUNDLE_PATH)) return 'dev';
	const crypto = require('crypto');
	const buf = fs.readFileSync(BUNDLE_PATH);
	return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

module.exports = { renderSite, applyTokens, hashOfBundle };
