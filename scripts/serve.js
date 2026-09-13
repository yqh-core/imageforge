/**
 * ImageForge - scripts/serve.js
 *
 * 本地"仿真上线"预览：行为刻意贴近生产静态服务器，用来验证部署后的真实表现。
 *   - 命中 dist/*.gz / *.br 时按 Accept-Encoding 返回预压缩内容
 *   - 正确的 MIME 类型（尤其是 .webmanifest / .svg / .js）
 *   - 目录请求回落到 index.html
 *   - 输出 Cache-Control / Content-Encoding，方便对照 deploy/nginx.conf
 *
 * 用法： node scripts/serve.js [port] [--source]
 *
 * 默认服务 build/（npm run pack 的产出），保证"本地看到的 == 上传后别人看到的"。
 * 加 --source 则服务工程根目录（build/ 还没生成时自动回退到根目录）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const { ROOT } = require('./lib/brand.js');

const PORT = parseInt(process.argv.find(a => /^\d+$/.test(a)), 10) || 4173;

const BUILD = path.join(ROOT, 'build');
const SERVE_ROOT = (!process.argv.includes('--source') && fs.existsSync(path.join(BUILD, 'index.html')))
	? BUILD
	: ROOT;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.map': 'application/json; charset=utf-8',
};

function cacheHeader(relPath) {
	if (relPath.startsWith('dist/')) return 'public, max-age=31536000, immutable';
	if (relPath.endsWith('.html')) return 'no-cache';
	return 'public, max-age=3600';
}

function send(res, status, headers, body) {
	res.writeHead(status, headers);
	res.end(body);
}

// 这些文件上线后不应该被浏览器拿到：
//   _headers / _redirects  Cloudflare 会解析它们转成平台配置，本身不对外提供
//   *.gz / *.br            预压缩产物只供服务器内部读取（见 deploy/nginx.conf 的 deny 规则）
const NEVER_PUBLIC = /^\/(_headers|_redirects)$|\.(gz|br)$/;

const server = http.createServer((req, res) => {
	const parsed = url.parse(req.url);
	let rel = decodeURIComponent(parsed.pathname);
	if (rel === '/' || rel === '') rel = '/index.html';

	if (NEVER_PUBLIC.test(rel)) {
		return send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' },
			'<h1>404</h1><p>' + rel + ' 不对外提供（平台控制文件 / 预压缩产物）。</p>');
	}

	// 防目录穿越
	const abs = path.join(SERVE_ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
	if (!abs.startsWith(SERVE_ROOT)) {
		return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
	}

	if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
		rel = path.posix.join(rel, 'index.html');
	}
	const finalAbs = path.join(SERVE_ROOT, rel);

	if (!fs.existsSync(finalAbs) || fs.statSync(finalAbs).isDirectory()) {
		return send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' },
			'<h1>404</h1><p>' + rel + ' not found. Did you run <code>npm run build</code>?</p>');
	}

	const ext = path.extname(finalAbs).toLowerCase();
	const type = MIME[ext] || 'application/octet-stream';
	const accept = String(req.headers['accept-encoding'] || '');
	const relKey = path.relative(SERVE_ROOT, finalAbs).replace(/\\/g, '/');

	const headers = {
		'Content-Type': type,
		'Cache-Control': cacheHeader(relKey),
		'Vary': 'Accept-Encoding',
	};

	// 优先返回预压缩产物，与 nginx gzip_static / brotli_static 行为一致
	if (accept.includes('br') && fs.existsSync(finalAbs + '.br')) {
		const buf = fs.readFileSync(finalAbs + '.br');
		headers['Content-Encoding'] = 'br';
		headers['Content-Length'] = buf.length;
		return send(res, 200, headers, buf);
	}
	if (accept.includes('gzip') && fs.existsSync(finalAbs + '.gz')) {
		const buf = fs.readFileSync(finalAbs + '.gz');
		headers['Content-Encoding'] = 'gzip';
		headers['Content-Length'] = buf.length;
		return send(res, 200, headers, buf);
	}

	const raw = fs.readFileSync(finalAbs);
	headers['Content-Length'] = raw.length;
	send(res, 200, headers, raw);
});

server.listen(PORT, '127.0.0.1', () => {
	console.log('');
	console.log('ImageForge preview  http://127.0.0.1:' + PORT + '/');
	console.log('serving             ' + SERVE_ROOT
		+ (SERVE_ROOT === BUILD ? '   <- build/ 上线产物' : '   <- 工程根目录 (build/ 尚未生成)'));
	console.log('pre-compressed      .gz / .br are used when requested by the browser');
	console.log('');
	console.log('Ctrl+C to stop.');
});
