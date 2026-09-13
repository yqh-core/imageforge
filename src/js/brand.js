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

const brand = {
	name: brandConfig.name,
	shortName: brandConfig.shortName || brandConfig.name,
	tagline: brandConfig.tagline,
	description: brandConfig.description,
	shortDescription: brandConfig.shortDescription || brandConfig.description,
	author: brandConfig.author,
	email: brandConfig.email,
	site: brandConfig.site,
	repository: brandConfig.repository,
	issues: brandConfig.issues || brandConfig.repository + '/issues',
	locale: brandConfig.locale || 'en',
	themeColor: brandConfig.themeColor || '#2f7df6',
	backgroundColor: brandConfig.backgroundColor || '#666d6f',
	keywords: brandConfig.keywords || [],
	upstream: brandConfig.upstream || {},
};

export default brand;
