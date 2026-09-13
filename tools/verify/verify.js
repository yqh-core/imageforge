/**
 * ImageForge —— 真实渲染验证（Headless Chrome + CDP）
 *
 * 为什么需要它：静态资源检查（HTTP 状态码、MIME、缓存头）只能证明"文件在位"，
 * 证明不了"页面真的能跑"。这个脚本用真实的 Chrome 打开构建产物，验证首屏渲染、
 * 品牌文案、菜单交互、About 弹窗、控制台报错，并留下截图。
 *
 * 零第三方依赖：用 Node 内置 fetch + WebSocket 直连 CDP。
 *
 * 用法：
 *   npm run ship:cloudflare    # 先生成 build/
 *   npm run preview            # 另开一个终端，http://127.0.0.1:4173/
 *   npm run verify
 *
 * 环境变量：
 *   BASE          被测地址，默认 http://127.0.0.1:4173
 *                 指向线上域名即可做线上验收：BASE=https://<项目>.pages.dev
 *   CHROME        Chrome 可执行文件路径（各平台默认值见下）
 *   OUT           截图输出目录，默认 .verify/
 *   VERIFY_PROXY  需要经代理访问外网时指定，如 `VERIFY_PROXY=$HTTPS_PROXY`
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CHROME = {
	win32: [
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
	],
	darwin: [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
	],
	linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

function resolveChrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const candidates = DEFAULT_CHROME[process.platform] || [];
	return candidates.find(p => p && fs.existsSync(p)) || null;
}

const CHROME = resolveChrome();
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || path.join(process.cwd(), '.verify');
const PORT = 9344;

// 期望值来自品牌配置，改 brand.config.json 后这里自动跟着变
const BRAND = JSON.parse(fs.readFileSync(path.join(__dirname, '../../brand.config.json'), 'utf8'));
const esc = s => String(s || '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log((pass ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  -> ' + detail : ''));
}

async function http(url) {
	const res = await fetch(url, { redirect: 'manual' });
	const body = await res.text().catch(() => '');
	return { status: res.status, headers: res.headers, body };
}

async function main() {
	if (!CHROME) {
		console.error('找不到 Chrome。用 CHROME=/path/to/chrome 指定，或安装 Google Chrome。');
		process.exit(2);
	}
	fs.mkdirSync(OUT, { recursive: true });
	console.log('chrome: ' + CHROME);
	console.log('base:   ' + BASE);

	// ---------- 静态层：直接用 HTTP 校验 ----------
	console.log('\n-- static server behaviour --');
	const idx = await http(BASE + '/');
	check('GET / -> 200', idx.status === 200, 'HTTP ' + idx.status);
	check('index.html is not long-cached',
		/no-cache|max-age=0/.test(idx.headers.get('cache-control') || ''),
		idx.headers.get('cache-control'));
	const bundleRef = (idx.body.match(/dist\/bundle\.js\?v=([a-f0-9]+)/) || [])[1];
	check('index.html carries ?v= fingerprint', !!bundleRef, 'v=' + bundleRef);
	const bundle = await http(BASE + '/dist/bundle.js' + (bundleRef ? '?v=' + bundleRef : ''));
	check('GET /dist/bundle.js -> 200', bundle.status === 200, 'HTTP ' + bundle.status);
	const mani = await http(BASE + '/manifest.webmanifest');
	check('webmanifest MIME correct',
		/application\/manifest\+json/.test(mani.headers.get('content-type') || ''),
		mani.headers.get('content-type'));
	// _headers 的正确不变量是「规则文件本身不能被当成静态资源读出来」，
	// 而不是「必须 404」。本地预览服务器会直接 404；但 Cloudflare Pages 上
	// 未匹配的路径会回落到 index.html（SPA 兜底，HTTP 200），此时 /_headers
	// 返回 200 是兜底行为、不是泄漏。用实际规则文件内容去比对才准，
	// 否则线上跑 verify 会出现假失败。
	const rulesFile = path.join(__dirname, '../../deploy/cloudflare/_headers');
	const rulesText = fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8') : '';
	const ruleLine = rulesText.split('\n').find(l => /^\s*[/*]/.test(l) && !/^\s*#/.test(l)) || '/*';
	const hdr = await http(BASE + '/_headers');
	const leaked = hdr.status === 200 && hdr.body.indexOf(ruleLine.trim()) !== -1
		&& /max-age=31536000|X-Content-Type-Options/.test(hdr.body);
	check('_headers rule file is not served as an asset', !leaked,
		'HTTP ' + hdr.status + (hdr.status === 200 ? ' (SPA fallback -> index.html)' : ''));

	// ---------- 渲染层：Chrome ----------
	// 本地预览时绕开代理（有些环境把 loopback 也塞进代理，会连不上）；
	// 测线上时默认直连 —— 很多环境的 HTTP(S)_PROXY 是本地 MITM 代理，
	// 静默套上去反而会让 Chrome 撞证书错误。确实需要代理就显式给 VERIFY_PROXY。
	const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
	const proxyArgs = isLocalBase
		? ['--no-proxy-server', '--proxy-bypass-list=<-loopback>']
		: (process.env.VERIFY_PROXY ? ['--proxy-server=' + process.env.VERIFY_PROXY] : []);

	const profile = path.join(os.tmpdir(), 'cdp-if-' + Date.now());
	const chrome = spawn(CHROME, [
		'--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
		...proxyArgs,
		'--window-size=1440,900', '--remote-debugging-port=' + PORT,
		'--user-data-dir=' + profile, 'about:blank',
	], { stdio: 'ignore' });

	let wsUrl = null;
	for (let i = 0; i < 80; i++) {
		try {
			const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
			const page = list.find(t => t.type === 'page');
			if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
		} catch (e) { /* 等就绪 */ }
		await sleep(250);
	}
	if (!wsUrl) throw new Error('DevTools endpoint not ready');

	const ws = new WebSocket(wsUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

	let id = 0;
	const pending = new Map();
	const errors = [];
	const requests = [];

	ws.onmessage = ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
			return;
		}
		if (msg.method === 'Runtime.exceptionThrown') {
			const d = msg.params.exceptionDetails;
			errors.push('exception: ' + (d.exception ? d.exception.description : d.text));
		}
		if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
			errors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
		}
		if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
			errors.push('log: ' + msg.params.entry.text);
		}
		if (msg.method === 'Network.responseReceived') {
			const r = msg.params.response;
			if (r.status >= 400) requests.push(r.status + ' ' + r.url);
		}
	};

	const send = (method, params) => new Promise((resolve, reject) => {
		const mid = ++id;
		pending.set(mid, { resolve, reject });
		ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
	});

	const evaluate = async expression => {
		const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) {
			throw new Error(r.exceptionDetails.exception
				? r.exceptionDetails.exception.description : r.exceptionDetails.text);
		}
		return r.result.value;
	};

	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
	};

	await send('Runtime.enable');
	await send('Log.enable');
	await send('Page.enable');
	await send('Network.enable');
	await send('Emulation.setDeviceMetricsOverride', {
		width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
	});

	// ---------- 首屏 ----------
	console.log('\n-- first paint --');
	await send('Page.navigate', { url: BASE + '/' });
	await sleep(5000);

	check('title contains brand name', new RegExp(esc(BRAND.name)).test(await evaluate('document.title')),
		await evaluate('document.title'));
	const wantLang = (BRAND.locale || 'en').split('-')[0];
	check('html lang = ' + wantLang, (await evaluate('document.documentElement.lang')) === wantLang,
		await evaluate('document.documentElement.lang'));
	check('no leftover {{TOKEN}} in DOM',
		!(await evaluate('!!document.body.innerHTML.match(/\\{\\{[A-Z0-9_]+\\}\\}/)')));
	check('no placeholder brand strings in DOM',
		!(await evaluate('/yourname|example\\.com|freeps/i.test(document.body.innerHTML)')));
	const cfg = await evaluate('JSON.stringify({lang: window.AppConfig && window.AppConfig.LANG})');
	check('runtime AppConfig.LANG = ' + wantLang, new RegExp('"lang":"' + wantLang + '"').test(cfg), cfg);

	const canvasOk = await evaluate(`(function(){
		var c = document.querySelector('canvas');
		return !!c && c.width > 100 && c.height > 100;
	})()`);
	check('editor canvas mounted and sized', !!canvasOk);
	const menuCount = await evaluate('document.querySelectorAll("#main_menu a").length');
	check('main menu bar rendered', menuCount > 5, 'items: ' + menuCount);

	await screenshot('home.png');

	// ---------- 菜单 Help → About ----------
	console.log('\n-- menu: Help -> About --');
	const opened = await evaluate(`(function(){
		var nav = document.getElementById('main_menu');
		if (!nav) return 'no #main_menu';
		var links = Array.prototype.slice.call(nav.querySelectorAll('a'));
		var help = links.filter(function(a){ return a.textContent.trim().toLowerCase() === 'help'; })[0];
		if (!help) return 'no Help item; got: ' + links.map(function(a){return a.textContent.trim();}).slice(0,10).join('|');
		help.click();
		return 'clicked Help';
	})()`);
	check('Help menu opens', opened === 'clicked Help', opened);
	await sleep(600);

	const about = await evaluate(`(function(){
		var nav = document.getElementById('main_menu');
		var links = Array.prototype.slice.call(nav.querySelectorAll('a'));
		var a = links.filter(function(x){ return /^about/i.test(x.textContent.trim()); })[0];
		if (!a) return 'no About item';
		a.click();
		return 'clicked About';
	})()`);
	check('About item present and clicked', about === 'clicked About', about);
	await sleep(1200);

	const expect = JSON.stringify({
		name: BRAND.name,
		repo: (BRAND.repository || '').replace(/^https?:\/\//, ''),
		email: BRAND.email,
		upstream: (BRAND.upstream && BRAND.upstream.name) || 'miniPaint',
	});
	const dlg = await evaluate(`(function(){
		var want = ${expect};
		var box = document.querySelector('.alertify, .popup, .dialog, .modal');
		var html = document.body.innerHTML;
		var text = document.body.innerText;
		return JSON.stringify({
			hasDialog: !!box,
			hasName: text.indexOf(want.name) !== -1,
			hasRepo: html.indexOf(want.repo) !== -1,
			hasEmail: html.indexOf(want.email) !== -1,
			hasUpstream: html.indexOf(want.upstream) !== -1,
			hasMIT: /MIT/.test(html)
		});
	})()`);
	const d = JSON.parse(dlg);
	check('About dialog rendered', d.hasDialog, dlg);
	check('About shows brand name', d.hasName, BRAND.name);
	check('About shows repository link', d.hasRepo, BRAND.repository);
	check('About shows contact email', d.hasEmail, BRAND.email);
	check('About keeps upstream attribution (' + (BRAND.upstream && BRAND.upstream.name) + ' + MIT)',
		d.hasUpstream && d.hasMIT);
	await screenshot('about.png');

	// ---------- 收尾 ----------
	check('no console errors / exceptions', errors.length === 0, errors.slice(0, 4).join(' || ') || 'clean');
	check('no failed network responses (>=400)', requests.length === 0, requests.slice(0, 4).join(' || ') || 'clean');

	ws.close();
	chrome.kill();

	const failed = results.filter(r => !r.pass);
	console.log('\n================ SUMMARY ================');
	console.log('passed: ' + (results.length - failed.length) + ' / ' + results.length);
	console.log('screenshots: ' + OUT);
	if (failed.length) {
		console.log('FAILED:');
		failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
		process.exit(1);
	}
	console.log('ALL CHECKS PASSED');
}

main().catch(err => {
	console.error('\nVERIFY CRASHED');
	console.error(err && err.message ? err.message : err);
	process.exit(1);
});
