/**
 * ImageForge - scripts/lib/brand.js
 *
 * 构建期读取品牌配置，并生成模板占位符替换表。
 * 运行时侧对应 src/js/brand.js，两者共用根目录的 brand.config.json。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadBrand() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, 'brand.config.json'), 'utf8'));
}

function loadPackage() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/**
 * 文本方向：config 里显式写了 dir 就用它，否则按 locale 推断。
 * 这样把 locale 改成 ar / he 之类时，页面与 PWA 清单会一起转 RTL，
 * 不需要再去手改模板里的 dir="ltr"。
 */
const RTL_LOCALES = /^(ar|he|fa|ur|yi|dv|ku|ps|sd|ug)(-|$)/i;

function resolveDir(brand) {
	if (brand.dir) return brand.dir;
	return RTL_LOCALES.test(brand.locale || 'en') ? 'rtl' : 'ltr';
}

/**
 * @param {object} options
 * @param {string} [options.hash]  产物内容指纹
 * @param {string} [options.date]  构建日期
 */
function buildTokens(options) {
	const brand = loadBrand();
	const pkg = loadPackage();
	const opts = options || {};

	return {
		BRAND_NAME: brand.name,
		BRAND_SHORT_NAME: brand.shortName || brand.name,
		BRAND_TAGLINE: brand.tagline || '',
		BRAND_DESCRIPTION: brand.description || '',
		BRAND_SHORT_DESCRIPTION: brand.shortDescription || brand.description || '',
		BRAND_AUTHOR: brand.author || brand.name,
		BRAND_EMAIL: brand.email || '',
		BRAND_SITE: String(brand.site || '').replace(/\/+$/, ''),
		BRAND_REPOSITORY: brand.repository || '',
		BRAND_ISSUES: brand.issues || (brand.repository ? brand.repository + '/issues' : ''),
		BRAND_LOCALE: brand.locale || 'en',
		BRAND_DIR: resolveDir(brand),
		BRAND_THEME_COLOR: brand.themeColor || '#2f7df6',
		BRAND_BACKGROUND_COLOR: brand.backgroundColor || '#666d6f',
		BRAND_KEYWORDS: (brand.keywords || []).join(', '),
		BRAND_UPSTREAM_NAME: (brand.upstream && brand.upstream.name) || '',
		BRAND_UPSTREAM_URL: (brand.upstream && brand.upstream.url) || '',
		BUILD_VERSION: pkg.version || '0.0.0',
		BUILD_HASH: opts.hash || 'dev',
		BUILD_DATE: opts.date || new Date().toISOString().slice(0, 10),
	};
}

module.exports = { ROOT, loadBrand, loadPackage, buildTokens, resolveDir };
