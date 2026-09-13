/**
 * ImageForge - scripts/gen-icons.js
 *
 * 从一张矢量源 images/favicon.svg 生成全部位图图标，
 * 源文件改了只跑一条命令即可全部同步，避免手工导出六份不一致的 PNG。
 *
 * 用法： node scripts/gen-icons.js
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
		await sharp(svg, { density: 600 })
			.resize(target.size, target.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ compressionLevel: 9, palette: true })
			.toFile(target.file);

		const size = fs.statSync(target.file).size;
		console.log('  → ' + path.relative(ROOT, target.file).replace(/\\/g, '/').padEnd(30)
			+ target.size + 'x' + target.size + '  ' + (size / 1024).toFixed(1) + ' KB');
	}

	console.log('\n' + TARGETS.length + ' icons generated.\n');
}

main().catch(err => {
	console.error('\nICON GENERATION FAILED');
	console.error(err && err.message ? err.message : err);
	process.exit(1);
});
