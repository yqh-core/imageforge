/**
 * ImageForge - scripts/build.js
 *
 * 一条命令完成可上线产物：
 *   1. webpack 生产打包        → dist/bundle.js
 *   2. 按品牌配置渲染站点页面  → index.html / manifest.webmanifest / robots.txt / sitemap.xml
 *   3. 生成 gzip + brotli 预压缩 → dist/*.gz / dist/*.br
 *
 * 设计原则：每个步骤只做一件事，失败即中止，不在半成品状态下继续。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const webpack = require('webpack');

const { ROOT } = require('./lib/brand.js');
const { renderSite } = require('./lib/render.js');

const DIST = path.join(ROOT, 'dist');

function kb(bytes) {
	return (bytes / 1024).toFixed(1) + ' KB';
}

function compile() {
	const config = require('../webpack.config.js')({}, { mode: 'production' });

	return new Promise((resolve, reject) => {
		webpack(config, (err, stats) => {
			if (err) return reject(err);
			if (stats.hasErrors()) {
				return reject(new Error(stats.toString({ all: false, errors: true })));
			}
			const info = stats.toJson({ all: false, warnings: true, assets: true });
			if (info.warnings && info.warnings.length) {
				console.log('  webpack warnings:');
				info.warnings.forEach(w => console.log('    - ' + (w.message || w)));
			}
			resolve(stats);
		});
	});
}

function precompress() {
	const targets = fs.existsSync(DIST)
		? fs.readdirSync(DIST).filter(f => /\.(js|css|html|webmanifest|svg|json)$/.test(f))
		: [];

	const report = [];
	for (const name of targets) {
		const file = path.join(DIST, name);
		const buf = fs.readFileSync(file);

		// 小于 1KB 的文件压缩收益为负，跳过
		if (buf.length < 1024) continue;

		const gz = zlib.gzipSync(buf, { level: 9 });
		fs.writeFileSync(file + '.gz', gz);
		report.push({ name, raw: buf.length, gz: gz.length });

		if (typeof zlib.brotliCompressSync === 'function') {
			const br = zlib.brotliCompressSync(buf, {
				params: {
					[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
					[zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
				},
			});
			fs.writeFileSync(file + '.br', br);
		}
	}
	return report;
}

function summarize() {
	const rows = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else rows.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
		}
	};
	walk(DIST);
	return rows.sort((a, b) => b.size - a.size);
}

async function main() {
	const started = Date.now();
	console.log('');
	console.log('ImageForge build');
	console.log('================');

	console.log('\n[1/3] webpack production bundle');
	await compile();
	const bundle = path.join(DIST, 'bundle.js');
	const hash = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex').slice(0, 10);
	console.log('  dist/bundle.js  ' + kb(fs.statSync(bundle).size) + '  (hash ' + hash + ')');

	console.log('\n[2/3] render pages from brand.config.json');
	renderSite({ hash });

	console.log('\n[3/3] pre-compress static assets');
	const report = precompress();
	report.forEach(r => {
		console.log('  ' + r.name.padEnd(22) + kb(r.raw).padStart(10) + ' → ' + kb(r.gz).padStart(10) + ' gzip'
			+ '  (' + Math.round((1 - r.gz / r.raw) * 100) + '% smaller)');
	});

	console.log('\ndist/ contents');
	summarize().forEach(r => console.log('  ' + r.file.padEnd(28) + kb(r.size).padStart(10)));
	console.log('\nDone in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
	console.log('Next: npm run pack   (挑出上线文件 → build/ + zip)');
	console.log('      npm run preview (本地按生产静态服务器行为预览 build/)\n');
}

main().catch(err => {
	console.error('\nBUILD FAILED');
	console.error(err && err.message ? err.message : err);
	process.exit(1);
});
