/**
 * ImageForge - brand.js
 *
 * 品牌信息的唯一运行时读取入口。
 * 数据源是项目根目录的 brand.config.json —— 改品牌只改那一个文件，
 * 业务代码不要再硬编码任何名称、域名、邮箱或仓库地址。
 *
 * 另有 scripts/build.js 用同一份配置生成 index.html / manifest.webmanifest /
 * robots.txt，保证页面、PWA 清单与源码三处永远一致。
 */

import brandConfig from './../../brand.config.json';

/**
 * 邮箱在 brand.config.json 里是拆成 user + domain 两段存的。
 * 原因：整份配置会被打进 bundle.js，写成完整地址等于把邮箱同时交给
 * HTML 和 JS，任何 grep 都能抓到。拆开后静态抓取匹配不到，运行时再拼。
 * 改配置时两段都要改。
 */
function composeEmail(email) {
	if (!email) return '';
	if (typeof email === 'string') return email;
	const user = email.user || '';
	const domain = email.domain || '';
	if (user && domain) return user + '@' + domain;
	return user || domain || '';
}

const brand = {
	name: brandConfig.name,
	shortName: brandConfig.shortName || brandConfig.name,
	tagline: brandConfig.tagline,
	description: brandConfig.description,
	shortDescription: brandConfig.shortDescription || brandConfig.description,
	author: brandConfig.author,
	email: composeEmail(brandConfig.email),
	site: brandConfig.site,
	repository: brandConfig.repository,
	issues: brandConfig.issues || brandConfig.repository + '/issues',
	locale: brandConfig.locale || 'en',
	themeColor: brandConfig.themeColor || '#2f7df6',
	backgroundColor: brandConfig.backgroundColor || '#666d6f',
	keywords: brandConfig.keywords || [],
	upstream: brandConfig.upstream || {},
	// 第三方服务密钥。留空即表示该功能未配置，对应工具会给出明确提示，
	// 而不是拿着空 key 去请求、然后静默失败。
	services: brandConfig.services || {},
};

export default brand;
