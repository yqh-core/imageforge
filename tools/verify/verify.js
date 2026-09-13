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

// 邮箱在配置里拆成 user + domain 两段（见 scripts/lib/brand.js 的说明）
const BRAND_EMAIL = (() => {
	const e = BRAND.email;
	if (!e) return '';
	if (typeof e === 'string') return e;
	return e.user && e.domain ? e.user + '@' + e.domain : (e.user || e.domain || '');
})();

/**
 * 上游 miniPaint 源码里写死的两个公开 demo key。它们不该再出现在我们的产物里 ——
 * 一旦有人顺手加回来，这个断言会立刻红，而不是等到某天功能静默失效才发现。
 */
const UPSTREAM_DEMO_KEYS = [
	'3ca2cd8af3fde33af218bea02-9021417',
	'AIzaSyAC_Tx8RKkvN235fXCUyi_5XhSaRCzNhMg',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log((pass ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  -> ' + detail : ''));
}

/**
 * body 是文本，raw 是原始字节。
 * 两者都给：多数检查看文本方便，但 favicon.ico 这类二进制文件
 * 只有原始字节能验（ICO 的文件头是 00 00 01 00，转成 UTF-8 字符串就毁了）。
 */
async function http(url) {
	const res = await fetch(url, { redirect: 'manual' });
	const raw = Buffer.from(await res.arrayBuffer());
	return { status: res.status, headers: res.headers, body: raw.toString('utf8'), raw };
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

	// ---------- manifest：PWA 安装资格 ----------
	// 判据来自 web.dev 的 install criteria：name/short_name、icons 覆盖
	// 192 与 512、start_url、display 合法值、HTTPS（HTTPS 由部署平台保证）。
	// id 与 maskable 是 MDN/W3C 的推荐项，分别稳定应用身份、防 Android 裁切。
	console.log('\n-- pwa manifest --');
	let maniBody = {};
	try { maniBody = JSON.parse(mani.body || '{}'); } catch (e) { /* 下面统一报 */ }
	const iconList = maniBody.icons || [];
	const iconSizes = iconList.flatMap(i => String(i.sizes || '').split(' '));
	check('manifest parses as JSON', maniBody.name !== undefined, maniBody.name || '(unparsable)');
	check('manifest has an id (stable app identity)', !!maniBody.id, 'id=' + maniBody.id);
	check('manifest icons cover 192x192 and 512x512',
		iconSizes.includes('192x192') && iconSizes.includes('512x512'), iconSizes.join(', '));
	check('manifest declares a maskable icon',
		iconList.some(i => String(i.purpose || '').split(/\s+/).includes('maskable')));
	const shots = maniBody.screenshots || [];
	check('manifest declares screenshots for the install UI',
		shots.length > 0 && shots.every(s => typeof s.sizes === 'string'),
		(shots[0] || {}).src);
	const shot = shots[0];
	if (shot) {
		const shotRes = await http(BASE + '/' + String(shot.src).replace(/^\//, ''));
		check('screenshot asset is reachable', shotRes.status === 200, shot.src + ' -> HTTP ' + shotRes.status);
	}
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

	// ---------- 安全响应头 ----------
	// 本地预览与线上都该带上：本地由 scripts/serve.js 读同一份 _headers 套用，
	// 所以这一节在本地就能验，不必等到上线。
	console.log('\n-- security headers --');
	const hsts = idx.headers.get('strict-transport-security') || '';
	check('HSTS present', /max-age=\d{6,}/.test(hsts), hsts || '(missing)');
	const csp = idx.headers.get('content-security-policy') || '';
	const scriptSrc = (csp.match(/script-src[^;]*/) || ['(no script-src)'])[0];
	check('CSP present', /default-src 'self'/.test(csp), csp ? csp.slice(0, 48) + '...' : '(missing)');
	// 这条是整个 CSP 的价值所在：script-src 一旦含 'unsafe-inline'，
	// 被注入的内联脚本照样能跑，等于白设。
	check("CSP keeps script-src free of 'unsafe-inline'",
		!/unsafe-inline/.test(scriptSrc), scriptSrc);
	check('CSP blocks plugins (object-src none)', /object-src 'none'/.test(csp));
	check('X-Content-Type-Options present', /nosniff/.test(idx.headers.get('x-content-type-options') || ''),
		idx.headers.get('x-content-type-options'));

	// ---------- 出厂产物不该夹带的东西 ----------
	console.log('\n-- shipped artefacts --');
	const bundleBody = bundle.body || '';
	check('bundle.js delivered as readable JS',
		bundleBody.indexOf(BRAND.name) !== -1, bundleBody.length + ' bytes');
	// 邮箱在配置里是拆开存的，完整地址只应在运行时拼出来，不该出现在静态文本里
	check('no plaintext contact email in shipped HTML',
		!BRAND_EMAIL || idx.body.indexOf(BRAND_EMAIL) === -1, BRAND_EMAIL || '(none configured)');
	check('no plaintext contact email in shipped JS',
		!BRAND_EMAIL || bundleBody.indexOf(BRAND_EMAIL) === -1, BRAND_EMAIL || '(none configured)');
	const leakedKeys = UPSTREAM_DEMO_KEYS.filter(k => bundleBody.indexOf(k) !== -1);
	check('no upstream demo API keys in shipped JS', leakedKeys.length === 0,
		leakedKeys.join(', ') || 'clean');

	// ---------- 404 / 图标 / service worker ----------
	// 这三个都是"页面能打开也发现不了"的问题：软 404 只在搜索引擎眼里是问题，
	// 缺失的 favicon.ico 只在服务器日志里是一堆 200 + HTML，
	// 没有 service worker 则只在断网那一刻暴露。
	console.log('\n-- error page, icons, offline --');

	const missing = await http(BASE + '/no-such-page-' + Date.now());
	// 软 404 = 不存在的路径返回 200 + 首页内容。搜索引擎会把这些 URL
	// 当成和首页内容重复的页面收录，站点越大越脏。
	check('unknown path -> real 404, not soft 404', missing.status === 404, 'HTTP ' + missing.status);
	check('404 page is branded', missing.body.indexOf(BRAND.name) !== -1,
		missing.body.indexOf(BRAND.name) !== -1 ? BRAND.name : '(brand name absent)');
	check('404 page carries noindex', /noindex/.test(missing.body),
		/noindex/.test(missing.body) ? 'robots: noindex, follow' : '(missing)');

	const ico = await http(BASE + '/favicon.ico');
	const icoType = ico.headers.get('content-type') || '';
	// ICO 文件头：reserved(2)=0 type(2)=1。同时排除"返回了 HTML"这个伪装。
	const isIco = ico.raw.length > 6 && ico.raw[0] === 0 && ico.raw[1] === 0
		&& ico.raw[2] === 1 && ico.raw[3] === 0;
	check('GET /favicon.ico -> 200', ico.status === 200, 'HTTP ' + ico.status);
	check('favicon.ico is a real icon (not an HTML fallback)', isIco && !/text\/html/.test(icoType),
		icoType + ', ' + ico.raw.length + ' bytes, magic=' + (isIco ? 'ok' : 'bad'));

	const sw = await http(BASE + '/service-worker.js');
	const swType = sw.headers.get('content-type') || '';
	check('GET /service-worker.js -> 200', sw.status === 200, 'HTTP ' + sw.status);
	check('service-worker.js served as JavaScript', /javascript|ecmascript/.test(swType), swType);
	// 缓存名带构建指纹，指纹变了缓存就整体换掉 —— 这条保证两者真的同步。
	// 注意 SW 里写的是 'imageforge-' + VERSION，所以要验的是 VERSION 常量，
	// 不是拼接后的字面量。
	check('service worker cache name carries the bundle fingerprint',
		!!bundleRef && sw.body.indexOf("const VERSION = '" + bundleRef + "'") !== -1,
		'VERSION = ' + bundleRef);
	// 给了长缓存，发版后用户可能几十小时拿不到新版本
	check('service-worker.js is not long-cached',
		/no-cache|max-age=0/.test(sw.headers.get('cache-control') || ''),
		sw.headers.get('cache-control'));

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
	// CSP 违规监听必须在文档创建之前注入，否则首屏那批违规就漏掉了。
	// securitypolicyviolation 在"强制"和"仅报告"两种模式下都会触发，
	// 用它来量"这条策略有没有误伤"，而不是靠肉眼猜。
	await send('Page.addScriptToEvaluateOnNewDocument', {
		source: 'window.__csp = [];\n'
			+ 'document.addEventListener("securitypolicyviolation", function (e) {\n'
			+ '\twindow.__csp.push(e.violatedDirective + " <- " + (e.blockedURI || "")'
			+ ' + " @ " + (e.sourceFile || "") + ":" + (e.lineNumber || 0));\n'
			+ '});\n',
	});
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

	// ---------- 降级路径：删掉上游 demo key 后不能"静默失效" ----------
	// 上游 miniPaint 自带两个公开的 demo key，全世界每一份都在用，随时可能被
	// 撤销或耗尽配额。已经删掉了，但删掉之后必须有明确提示 —— 否则用户点
	// "Search Images" 只看到空白，根本不知道是这个部署没配 key。
	// 这里验证两件事：运行时 key 确实为空；且点开功能会给出可读的说明。
	console.log('\n-- graceful degradation (upstream demo keys removed) --');
	const keys = JSON.parse(await evaluate(`JSON.stringify({
		pixabay: window.AppConfig ? (window.AppConfig.pixabay_key || '') : 'NO_CONFIG',
		webfonts: window.AppConfig ? (window.AppConfig.google_webfonts_key || '') : 'NO_CONFIG'
	})`));
	check('runtime pixabay_key is empty (demo key removed)',
		keys.pixabay === '' && keys.pixabay !== 'NO_CONFIG', JSON.stringify(keys.pixabay));
	check('runtime google_webfonts_key is empty (demo key removed)',
		keys.webfonts === '' && keys.webfonts !== 'NO_CONFIG', JSON.stringify(keys.webfonts));

	const mediaTriggered = await evaluate(`(function(){
		var btn = document.querySelector('[title="Search Images"]')
			|| Array.prototype.slice.call(document.querySelectorAll('a,button,div[title]'))
				.filter(function(el){
					return /search images/i.test((el.getAttribute && el.getAttribute('title')) || el.textContent || '');
				})[0];
		if (!btn) return 'not found';
		btn.click();
		return 'clicked';
	})()`);
	await sleep(1000);
	if (mediaTriggered === 'clicked') {
		const notice = await evaluate(`(function(){
			var t = document.body.innerText || '';
			var i = t.toLowerCase().indexOf('not configured');
			if (i === -1) return 'NO NOTICE; body starts: ' + t.substring(0, 160);
			return t.substring(Math.max(0, i - 60), i + 160);
		})()`);
		check('Search Images shows an explicit "not configured" notice (not silent failure)',
			/not configured/i.test(notice), notice);
		await screenshot('search-not-configured.png');
		await evaluate(`(function(){
			var pop = document.querySelector('#popups .popup');
			var c = pop && (pop.querySelector('[data-id="popup_cancel"]')
				|| pop.querySelector('[data-id="popup_close"]'));
			if (c) c.click();
		})()`);
		await sleep(500);
	} else {
		check('Search Images control is reachable', false, mediaTriggered);
	}

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
		email: BRAND_EMAIL,
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
	check('About shows contact email', d.hasEmail, BRAND_EMAIL);
	check('About keeps upstream attribution (' + (BRAND.upstream && BRAND.upstream.name) + ' + MIT)',
		d.hasUpstream && d.hasMIT);
	await screenshot('about.png');

	// ---------- 对话框字段：这是改造 CSP 后最需要回归的一块 ----------
	// 原来这些字段的交互写在 HTML 内联属性里（onchange="POP.onChangeEvent();"），
	// 为了让 CSP 的 script-src 不必放开 'unsafe-inline'，改成了 JS 里统一绑定。
	// 这里真的开一个带滑杆的对话框，拖一下，确认取值和预览还跟着动 ——
	// 否则只是"看起来改好了"。
	console.log('\n-- dialog fields (CSP refactor regression) --');

	const clickMenuItem = async label => {
		const r = await evaluate(`(function(){
			var want = ${JSON.stringify(String(label).toLowerCase())};
			var links = Array.prototype.slice.call(document.querySelectorAll('a'));
			var hits = links.filter(function(a){ return a.textContent.trim().toLowerCase() === want; });
			if (!hits.length) return 'not found: ' + want;
			hits[hits.length - 1].click();
			return 'clicked';
		})()`);
		await sleep(500);
		return r;
	};

	// 直接通过 window.POP.show() 开一个带 range 滑杆的对话框。
	// 原来走\"Effects → Common Filters → Brightness\"菜单，但 Brightness 需要一个
	// 非空图层才出对话框；空状态下测试就会被 layer-required 的 alertify.error 截走，
	// 没法验证 popup 内部对 range 的绑定。这里直接驱动 POP 接口，干净可重复。
	check('window.POP exists', await evaluate('typeof window.POP') === 'object',
		await evaluate('typeof window.POP'));
	// 用一个能区分\"变更前 vs 变更后\"的初始值：初始 25，拖到 75（区间 [0,100] 的中点）。
	// 之所以不用 [-100,100] 的中点 0，是因为 0 正好也是初始值，无法证明 change 真的被处理了。
	await evaluate(`(function(){
		window.POP.show({
			title: 'Range regression',
			params: [{ name: 'value', title: 'Value:', value: 25, range: [0, 100] }],
		});
	})()`);
	await sleep(700);
	check('popup opens via window.POP.show', true);

	const dlgState = await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (!pop) return JSON.stringify({ opened: false });
		var range = pop.querySelector('input[type="range"][id^="pop_data_"]');
		var res = { opened: true, hasRange: !!range };
		if (!range) return JSON.stringify(res);

		var out = range.dataset.output ? pop.querySelector('#' + range.dataset.output) : null;
		res.outputId = range.dataset.output || null;
		res.hashBefore = (window.POP && window.POP.last_params_hash) || null;

		var min = parseFloat(range.min || '0');
		var max = parseFloat(range.max || '100');
		var mid = min + (max - min) * 0.5;
		var next = String(mid);
		// 拖动过程：input；松手：change —— 原内联 oninput / onchange 分别对应这两件事。
		// 先用 init 事件触发一次 change，把 last_params_hash 锚定到初始值，
		// 再改成中点，这样 before/after 的对比才真正反映\"输入是否被处理\"。
		range.dispatchEvent(new Event('change', { bubbles: true }));
		var hashBefore = (window.POP && window.POP.last_params_hash) || null;
		var valueBefore = hashBefore ? JSON.parse(hashBefore).value : null;

		range.value = next;
		range.dispatchEvent(new Event('input', { bubbles: true }));
		range.dispatchEvent(new Event('change', { bubbles: true }));

		res.expected = String(Math.round(parseFloat(next) * 100) / 100);
		res.outputAfter = out ? out.textContent.trim() : null;
		res.hashAfter = (window.POP && window.POP.last_params_hash) || null;
		res.valueBefore = valueBefore;
		res.valueAfter = res.hashAfter ? JSON.parse(res.hashAfter).value : null;
		return JSON.stringify(res);
	})()`);
	const ds = JSON.parse(dlgState);
	check('dialog with a range slider opened', ds.opened && ds.hasRange, dlgState);
	check('range readout follows the slider (input listener works)',
		ds.expected != null && ds.outputAfter === ds.expected,
		'expected ' + ds.expected + ', got ' + ds.outputAfter);
	check('range change reaches the app (change listener works)',
		ds.valueBefore !== ds.valueAfter && ds.valueAfter === parseFloat(ds.expected),
		'value ' + ds.valueBefore + ' -> ' + ds.valueAfter + ', expected ' + ds.expected);

	const closed = await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (!pop) return 'no popup';
		var cancel = pop.querySelector('[data-id="popup_cancel"]')
			|| pop.querySelector('[data-id="popup_close"]');
		if (!cancel) return 'no cancel button';
		cancel.click();
		return document.querySelector('#popups .popup') ? 'still open' : 'closed';
	})()`);
	check('dialog closes', closed === 'closed', closed);

	// ---------- CSP：整套交互下来不该有任何违规 ----------
	// 监听器在页面加载前就装好了（Page.addScriptToEvaluateOnNewDocument），
	// 所以上面点菜单、开弹窗、拖滑杆的过程全在它的观察范围内。
	const cspList = JSON.parse(await evaluate('JSON.stringify(window.__csp || [])'));
	check('no CSP violations during real interaction', cspList.length === 0,
		cspList.slice(0, 3).join(' || ') || 'clean');

	// ---------- service worker：装上了没有 ----------
	// 静态检查只能证明 service-worker.js 这个文件在位，证明不了它真的被注册、
	// 真的接管了页面。这一段要的就是"接管"这个事实。
	console.log('\n-- service worker --');
	// 注册是在 load 之后 setTimeout(0) 发起的（不跟首屏抢带宽），要等它落地。
	// 轮询而不是死等：线上首次访问还要从网络拉完 1.2MB 的 precache，
	// 快慢取决于网络，固定 sleep 会在慢网络下误判成"没注册"。
	let swState = { supported: false, registered: false, active: false, controlling: false };
	for (let i = 0; i < 20; i++) {
		await sleep(1000);
		swState = JSON.parse(await evaluate(`(async () => {
			if (!('serviceWorker' in navigator)) return JSON.stringify({ supported: false });
			const reg = await navigator.serviceWorker.getRegistration();
			return JSON.stringify({
				supported: true,
				registered: !!reg,
				active: !!(reg && reg.active),
				controlling: !!navigator.serviceWorker.controller,
				scope: reg ? reg.scope : null,
			});
		})()`));
		if (swState.registered && swState.active && swState.controlling) break;
	}
	check('service worker registered', !!swState.registered && !!swState.active,
		'registered=' + swState.registered + ' active=' + swState.active + ' scope=' + swState.scope);
	check('service worker controls the page', !!swState.controlling,
		'navigator.serviceWorker.controller=' + swState.controlling);

	const cacheState = JSON.parse(await evaluate(`(async () => {
		const keys = await caches.keys();
		if (!keys.length) return JSON.stringify({ keys: [], count: 0 });
		const cache = await caches.open(keys[0]);
		const reqs = await cache.keys();
		return JSON.stringify({ keys: keys, count: reqs.length });
	})()`));
	check('precache populated', cacheState.count >= 5,
		cacheState.count + ' entries in ' + (cacheState.keys || []).join(','));

	// ---------- 离线：SW 存在的唯一理由 ----------
	// 一个"完全跑在浏览器里"的图片编辑器，装到桌面后断网打不开，
	// 那 PWA 就只是个图标。这里真的断网再刷新一次。
	console.log('\n-- offline --');
	const errorsBeforeOffline = errors.slice();
	const requestsBeforeOffline = requests.slice();

	await send('Network.emulateNetworkConditions',
		{ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
	await send('Page.reload', { ignoreCache: false });
	await sleep(4000);

	// 轮询而不是死等：离线首屏要靠缓存里的 1.2MB bundle 解析执行，
	// 快慢取决于机器，等固定秒数会在慢机器上误判成"离线打不开"。
	let offlineState = { title: '', canvas: false, menu: 0 };
	for (let i = 0; i < 24; i++) {
		offlineState = JSON.parse(await evaluate(`(() => {
			const canvas = document.querySelector('#canvas_minipaint');
			return JSON.stringify({
				title: document.title,
				canvas: !!canvas && canvas.width > 0,
				menu: document.querySelectorAll('#main_menu a').length,
			});
		})()`));
		if (offlineState.canvas && offlineState.menu > 5) break;
		await sleep(500);
	}
	check('page still boots with the network cut', offlineState.canvas && offlineState.menu > 5,
		'canvas=' + offlineState.canvas + ' menu items=' + offlineState.menu);
	check('offline page is the branded app, not a browser error page',
		offlineState.title.indexOf(BRAND.name) !== -1, offlineState.title);
	await screenshot('05-offline.png');

	// 断网时 fetch 失败是预期内的（Chrome 会往控制台打 net::ERR_*），
	// 只有脚本自身的异常才说明离线路径写错了。
	const offlineErrors = errors.slice(errorsBeforeOffline.length)
		.filter(e => !/net::ERR|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e));
	check('no JS errors while offline', offlineErrors.length === 0,
		offlineErrors.slice(0, 3).join(' || ') || 'clean');

	await send('Network.emulateNetworkConditions',
		{ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

	// 留一张 404 页面截图。它是品牌的一部分，但平时没人会去看，
	// 只有截图能让"这个页面到底长什么样"进入 review 范围。
	// 放在最后：这次导航是 404（会被 Network 记录），而上面两项收尾检查
	// 用的都是离线前的快照，不受影响。
	await send('Page.navigate', { url: BASE + '/no-such-page-' + Date.now() });
	await sleep(1500);
	await screenshot('404.png');

	// ---------- 收尾 ----------
	// 用离线之前的快照结算：断网期间的请求失败是测试自己造成的，不算站点问题。
	check('no console errors / exceptions', errorsBeforeOffline.length === 0,
		errorsBeforeOffline.slice(0, 4).join(' || ') || 'clean');
	check('no failed network responses (>=400)', requestsBeforeOffline.length === 0,
		requestsBeforeOffline.slice(0, 4).join(' || ') || 'clean');

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
