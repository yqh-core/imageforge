/**
 * ImageForge —— 深度功能探测（Headless Chrome + CDP）
 *
 * 与 verify.js 的分工：
 *   verify.js  回答「页面能打开吗、品牌对吗、安全头在吗」—— 验收。
 *   本脚本     回答「编辑器真的能用吗」—— 功能体检。
 *
 * 它会真的去操作：新建画布、选工具、在画布上拖鼠标画一笔、加图层、上滤镜、
 * 撤销重做、导出文件、切语言。每一步都记 console 报错，最后按「能不能用」分级汇报。
 *
 * 零第三方依赖：Node 内置 fetch + WebSocket 直连 CDP。
 *
 * 用法：
 *   node tools/verify/features.js                       # 测本地 http://127.0.0.1:4173
 *   BASE=https://<项目>.pages.dev node tools/verify/features.js
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
	darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
	linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
};

function resolveChrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const candidates = DEFAULT_CHROME[process.platform] || [];
	return candidates.find(p => p && fs.existsSync(p)) || null;
}

const CHROME = resolveChrome();
const BASE = process.env.BASE || 'http://127.0.0.1:4173';

// 调试端口交给 Chrome 自己挑，从 DevToolsActivePort 读回来。
// 写死端口会有一个很隐蔽的坏法：上一轮没干净退出时残留的 Chrome 还占着那个端口，
// 新一轮 fetch /json/list 连上的是**旧实例**，于是拿到一个陌生页面，之后一直等不到回应。
// 这个坑实测踩过：脚本挂在语言那一段，26 分钟没有任何输出。
let PORT = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 提到模块作用域：收尾逻辑（包括崩溃路径）都要能碰到它们
let chrome = null;
let ws = null;
let profile = '';

if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }

const results = [];
const note = (ok, name, detail) => {
	results.push({ ok, name, detail });
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}` + (detail ? `  -> ${detail}` : ''));
};

/**
 * 扫掉历史遗留的 Chrome 临时 profile。
 *
 * teardown 会删自己那一份，但进程被强杀时（Ctrl-C、任务管理器、CI 超时中断）它没机会跑，
 * 于是 os.tmpdir() 里会慢慢积起几百 MB 的僵尸 profile —— 实测一次就积了 11 个 / 409MB。
 * 与其靠人记得手动清，不如每次启动时自愈一遍。
 *
 * 只动 `cdp-` 前缀、且 STALE_MS 内没被碰过的目录：正在跑的实例会持续往 profile 里写文件
 * （SingletonLock、DevToolsActivePort…），mtime 一直是新的，所以不会误伤隔壁正在跑的验证。
 */
const PROFILE_STALE_MS = 12 * 3600 * 1000;
function sweepStaleProfiles(maxAgeMs) {
	const dir = os.tmpdir();
	let names = [];
	try { names = fs.readdirSync(dir).filter(n => n.indexOf('cdp-') === 0); } catch (e) { return; }
	let removed = 0;
	for (const n of names) {
		const p = path.join(dir, n);
		try {
			const st = fs.statSync(p);
			if (!st.isDirectory()) continue;
			if (Date.now() - st.mtimeMs < maxAgeMs) continue;
			fs.rmSync(p, { recursive: true, force: true });
			removed++;
		} catch (e) { /* 正被占用或权限不足：跳过，下次再说 */ }
	}
	if (removed) console.log('>> swept ' + removed + ' stale chrome profile(s) from ' + dir);
}

(async () => {
	const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
	const proxyArgs = isLocal
		? ['--no-proxy-server', '--proxy-bypass-list=<-loopback>']
		: (process.env.VERIFY_PROXY ? ['--proxy-server=' + process.env.VERIFY_PROXY] : []);

	// 兜底闸门：即使有哪个等待绕过了单次调用超时，也不允许无限期挂着。
	// 线上跑一轮（含 1.2MB precache）约 5 分钟，15 分钟足够宽裕。
	const WATCHDOG_MS = Number(process.env.PROBE_TIMEOUT || 15 * 60 * 1000);
	setTimeout(() => {
		console.error('PROBE WATCHDOG: exceeded ' + Math.round(WATCHDOG_MS / 60000)
			+ ' minutes, aborting instead of hanging');
		process.exit(3);
	}, WATCHDOG_MS).unref();

	profile = path.join(os.tmpdir(), 'cdp-feat-' + Date.now());
	// 阈值可用 PROFILE_STALE_MS 覆盖：给个极大值就变成空转，便于验证这段逻辑本身
	sweepStaleProfiles(Number(process.env.PROFILE_STALE_MS || PROFILE_STALE_MS));
	chrome = spawn(CHROME, [
		'--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
		...proxyArgs,
		'--window-size=1440,900', '--remote-debugging-port=0',
		'--user-data-dir=' + profile, 'about:blank',
	], { stdio: 'ignore' });

	let wsUrl = null;
	for (let i = 0; i < 120; i++) {
		try {
			const portFile = path.join(profile, 'DevToolsActivePort');
			if (fs.existsSync(portFile)) {
				PORT = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || PORT;
			}
			if (PORT) {
				const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
				const page = list.find(t => t.type === 'page');
				if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
			}
		} catch (e) { /* 等就绪 */ }
		await sleep(250);
	}
	if (!wsUrl) throw new Error('DevTools endpoint not ready (port ' + PORT + ')');

	ws = new WebSocket(wsUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

	let id = 0;
	const pending = new Map();
	// 每个阶段单独收集，才能定位是哪一步引入的报错
	let errors = [];
	// 页面弹过的原生对话框（alert/confirm/beforeunload）
	const dialogs = [];
	// 单次 CDP 调用的上限。没有这个上限，任何"页面不回应"都会变成永久挂起 ——
	// 一个会挂死的测试脚本比一个会失败的更糟：它既不报错也不结束。
	const CALL_TIMEOUT = Number(process.env.CDP_TIMEOUT || 30000);

	ws.onmessage = ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
			return;
		}
		// 原生对话框会把渲染进程的 JS 冻住，之后所有 Runtime.evaluate 都不返回。
		// 必须主动 accept 掉，否则脚本静默挂死（这就是上面那个 26 分钟的现场）。
		if (msg.method === 'Page.javascriptDialogOpening') {
			dialogs.push(msg.params.type + ': ' + msg.params.message);
			send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
	};

	// 用函数声明而不是 const 箭头：onmessage 里要在它被赋值之前就能引用
	function send(method, params) {
		return new Promise((resolve, reject) => {
			const mid = ++id;
			const timer = setTimeout(() => {
				pending.delete(mid);
				reject(new Error('CDP call timed out after ' + CALL_TIMEOUT + 'ms: ' + method));
			}, CALL_TIMEOUT);
			pending.set(mid, {
				resolve: v => { clearTimeout(timer); resolve(v); },
				reject: e => { clearTimeout(timer); reject(e); },
			});
			ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
		});
	}

	const evaluate = async expression => {
		const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) {
			return { __error: r.exceptionDetails.exception
				? r.exceptionDetails.exception.description : r.exceptionDetails.text };
		}
		return r.result.value;
	};

	// 真实鼠标事件（不只是 element.click）—— 画布绘制必须走 Input 域
	const mouse = async (type, x, y, extra) => {
		await send('Input.dispatchMouseEvent', Object.assign({
			type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
			clickCount: 1,
		}, extra || {}));
	};
	const drag = async (x1, y1, x2, y2, steps) => {
		steps = steps || 8;
		await mouse('mousePressed', x1, y1);
		for (let i = 1; i <= steps; i++) {
			await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
			await sleep(16);
		}
		await mouse('mouseReleased', x2, y2);
	};

	await send('Runtime.enable');
	await send('Log.enable');
	await send('Page.enable');
	await send('Emulation.setDeviceMetricsOverride', {
		width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
	});

	console.log('base: ' + BASE + '\n');
	await send('Page.navigate', { url: BASE + '/' });
	await sleep(5000);

	// ---------------------------------------------------------------- 核心绘制
	console.log('\n-- core editing: draw on canvas --');
	errors = [];
	// 先新建一张确定尺寸的画布，避免默认状态干扰
	await evaluate(`(function(){
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return a.textContent.trim().toLowerCase() === 'file'; })[0];
		if (m) m.click();
	})()`);
	await sleep(400);
	await evaluate(`(function(){
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			// 菜单项文本是 "New\n...Shortcut Key: ..."，不能用 $ 精确结尾
			.filter(function(a){ return /^new[\s\S]*$/i.test(a.textContent.trim())
				&& !/new layer/i.test(a.textContent); })[0];
		if (m) m.click();
	})()`);
	await sleep(900);
	// New 会弹对话框，填尺寸后确认
	await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (!pop) return;
		var ok = pop.querySelector('[data-id="popup_ok"]') || pop.querySelector('[data-id="popup_finish"]');
		if (ok) ok.click();
	})()`);
	await sleep(900);

	const canvasBox = await evaluate(`(function(){
		var c = document.getElementById('canvas_minipaint');
		if (!c) return 'no canvas';
		var r = c.getBoundingClientRect();
		return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
	})()`);
	if (typeof canvasBox !== 'string' || canvasBox === 'no canvas') {
		note(false, 'canvas measurable', String(canvasBox));
	} else {
		const box = JSON.parse(canvasBox);
		note(box.w > 50 && box.h > 50, 'canvas has a usable size',
			Math.round(box.w) + 'x' + Math.round(box.h));

		// 选画笔
		await evaluate(`(function(){
			var b = Array.prototype.slice.call(document.querySelectorAll('[data-tool], #tools_container a'))
				.filter(function(n){ return /brush/i.test(n.getAttribute('title')||n.getAttribute('data-tool')||''); })[0];
			if (b) b.click();
		})()`);
		await sleep(400);

		const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
		await drag(cx - 120, cy - 60, cx + 120, cy + 60, 10);
		await sleep(900);

		// 画布上真的有像素吗
		const painted = await evaluate(`(function(){
			var c = document.getElementById('canvas_minipaint');
			var ctx = c.getContext('2d');
			var d = ctx.getImageData(0, 0, c.width, c.height).data;
			var n = 0;
			for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
			return JSON.stringify({ total: d.length / 4, opaque: n });
		})()`);
		const paint = typeof painted === 'string' ? JSON.parse(painted) : { opaque: 0 };
		note(paint.opaque > 0, 'brush actually paints pixels on canvas',
			paint.opaque + ' non-transparent px');

		await send('Page.captureScreenshot', { format: 'png' }).then(r => {
			const out = process.env.OUT || path.join(process.cwd(), '.verify');
			fs.mkdirSync(out, { recursive: true });
			fs.writeFileSync(path.join(out, 'feat-draw.png'), Buffer.from(r.data, 'base64'));
		});

		// 撤销：画完能撤掉
		const beforeUndo = paint.opaque;
		await evaluate(`(function(){
			var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
				.filter(function(a){ return a.textContent.trim().toLowerCase() === 'edit'; })[0];
			if (m) m.click();
		})()`);
		await sleep(400);
		await evaluate(`(function(){
			var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
				// 同上：文本后面跟着快捷键说明，不能锚定到行尾
				.filter(function(a){ return /^undo/i.test(a.textContent.trim()); })[0];
			if (m) m.click();
		})()`);
		await sleep(900);
		const afterUndo = await evaluate(`(function(){
			var c = document.getElementById('canvas_minipaint');
			var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
			var n = 0; for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
			return n;
		})()`);
		note(afterUndo !== beforeUndo, 'Undo changes the canvas',
			beforeUndo + ' -> ' + afterUndo + ' px');
	}
	note(errors.length === 0, 'no console errors during core editing',
		errors.slice(0, 3).join(' | ') || 'clean');

	// ---------------------------------------------------------------- 撤销 / 重做
	// 上面只测了 Undo。单向的撤销测不出"撤了拉不回来"—— 那个按钮照样绿。
	console.log('\n-- undo / redo round trip --');
	errors = [];
	const redoClicked = await evaluate(`(function(){
		// 上一步点了 Undo，Edit 的下拉已经被关掉了，得重新打开
		var edit = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return a.textContent.trim().toLowerCase() === 'edit'; })[0];
		if (!edit) return 'no edit menu';
		edit.click();
		return 'edit opened';
	})()`);
	await sleep(500);
	const redoHit = await evaluate(`(function(){
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return /^redo/i.test(a.textContent.trim()); })[0];
		if (!m) return 'no redo entry';
		m.click();
		return 'clicked';
	})()`);
	await sleep(900);
	const afterRedo = await evaluate(`(function(){
		var c = document.getElementById('canvas_minipaint');
		var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		var n = 0; for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
		return n;
	})()`);
	note(typeof afterRedo === 'number' && afterRedo > 0, 'Redo brings the undone stroke back',
		redoClicked + ' / ' + redoHit + ' -> ' + afterRedo + ' px');

	// ---------------------------------------------------------------- 图层
	console.log('\n-- layers --');
	errors = [];
	const layerBefore = await evaluate(`document.querySelectorAll('#layers > .item').length`);
	const layerClicked = await evaluate(`(function(){
		var b = document.getElementById('insert_layer');
		if (!b) return 'no insert_layer button';
		b.click();
		return 'clicked';
	})()`);
	await sleep(700);
	const layerAfter = await evaluate(`document.querySelectorAll('#layers > .item').length`);
	note(typeof layerAfter === 'number' && layerAfter === layerBefore + 1,
		'Insert layer adds exactly one row to the layers panel',
		layerBefore + ' -> ' + layerAfter + ' (' + layerClicked + ')');
	note(errors.length === 0, 'no console errors adding a layer',
		errors.slice(0, 2).join(' | ') || 'clean');

	// ---------------------------------------------------------------- 导出
	// 之前这里只确认"File 菜单里有 Export 这一项" —— 那是存在性检查。
	// 导出链路（canvas.toBlob → FileSaver → <a download>）任意一环断掉它都是绿的。
	// 现在真的点完整个导出流程，并把交给下载机制的 blob 取回来验 PNG 文件头和尺寸。
	console.log('\n-- export --');
	errors = [];
	await evaluate(`(function(){
		if (window.__exportBlobs) return 'already hooked';
		window.__exportBlobs = [];
		window.__exportNames = [];
		var origBlob = URL.createObjectURL;
		URL.createObjectURL = function(o){
			var url = origBlob.call(URL, o);
			window.__exportBlobs.push({ url: url, size: (o && o.size) || 0, type: (o && o.type) || '' });
			return url;
		};
		// 文件名要从 <a download> 上读。注意 file-saver 走的是
		// a.dispatchEvent(new MouseEvent('click'))，不是 a.click() ——
		// 只挂 click 会一个文件名都抓不到（这不是假设，是实测踩到的）。
		var origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
		HTMLAnchorElement.prototype.dispatchEvent = function(ev){
			if (this.download && ev && ev.type === 'click') window.__exportNames.push(this.download);
			return origDispatch.apply(this, arguments);
		};
		var origClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function(){
			if (this.download) window.__exportNames.push(this.download);
			return origClick.apply(this, arguments);
		};
		return 'hooked';
	})()`);

	await evaluate(`(function(){
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return a.textContent.trim().toLowerCase() === 'file'; })[0];
		if (m) m.click();
	})()`);
	await sleep(500);
	const exportOpened = await evaluate(`(function(){
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return /^export/i.test(a.textContent.trim()); })[0];
		if (!m) return 'no export entry';
		m.click();
		return 'clicked';
	})()`);
	await sleep(1400);
	const exportOk = await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (!pop) return 'no popup appeared';
		var ok = pop.querySelector('[data-id="popup_ok"]');
		if (!ok) return 'no ok button';
		ok.click();
		return 'clicked ok';
	})()`);

	// toBlob 是异步的，固定 sleep 等于赌它在慢机器上也来得及 —— 轮询到落地为止
	let exported = { blobs: 0 };
	for (let i = 0; i < 20; i++) {
		await sleep(400);
		exported = JSON.parse(await evaluate(`(async function(){
			var list = window.__exportBlobs || [];
			if (!list.length) return JSON.stringify({ blobs: 0 });
			var b = list[list.length - 1];
			var buf = await (await fetch(b.url)).arrayBuffer();
			var u8 = new Uint8Array(buf);
			var png = Array.prototype.join.call(u8.slice(0, 8), ',') === '137,80,78,71,13,10,26,10';
			var w = 0, h = 0;
			if (png) { var dv = new DataView(buf); w = dv.getUint32(16); h = dv.getUint32(20); }
			return JSON.stringify({ blobs: list.length, size: b.size, type: b.type,
				png: png, w: w, h: h, names: window.__exportNames || [] });
		})()`));
		if (exported.blobs && exported.size > 0) break;
	}
	note(exported.blobs > 0, 'Export hands a file to the download machinery',
		exportOpened + ' / ' + exportOk + ' -> ' + exported.blobs + ' blob(s)');
	note(exported.png === true && exported.size > 1000,
		'exported PNG has a valid header and a non-trivial size',
		exported.size + ' bytes  ' + exported.w + 'x' + exported.h + '  ' + exported.type);
	note((exported.names || []).some(n => /\.png$/i.test(n)),
		'exported file is named *.png',
		(exported.names || []).join(', ') || '(no download attribute seen)');

	// 关掉可能还开着的弹窗，别把状态留给下一段
	await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (pop) { var c = pop.querySelector('[data-id="popup_cancel"]'); if (c) c.click(); }
	})()`);
	note(errors.length === 0, 'no console errors during export', errors.slice(0, 2).join(' | ') || 'clean');

	// ---------------------------------------------------------------- 工具遍历
	// 放在最后：逐个激活所有工具会改变当前工具、并可能弹出对话框，
	// 属于"弄脏状态"的操作。放前面会让后面的绘制测到脏状态，得出假结论。
	console.log('\n-- tools --');
	const tools = await evaluate(`(function(){
		var nodes = document.querySelectorAll('${'#tools_container > *, #tools_container [title]'}');
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			out.push(nodes[i].getAttribute('title') || nodes[i].id || '');
		}
		return JSON.stringify({ count: nodes.length, titles: out.slice(0, 60) });
	})()`);
	const toolInfo = typeof tools === 'string' ? JSON.parse(tools) : { count: 0, titles: [] };
	note(toolInfo.count > 5, 'toolbar renders controls', toolInfo.count + ' controls');

	errors = [];
	const toolErrs = await evaluate(`(function(){
		var nodes = document.querySelectorAll('${'#tools_container > *, #tools_container [title]'}');
		var bad = [];
		for (var i = 0; i < nodes.length && i < 60; i++) {
			try { nodes[i].click(); }
			catch (e) { bad.push((nodes[i].getAttribute('title')||i) + ': ' + e.message); }
			// 有些工具激活会弹对话框（如 Search Images），关掉避免堆积
			var pop = document.querySelector('#popups .popup');
			if (pop) {
				var c = pop.querySelector('[data-id="popup_cancel"]') || pop.querySelector('[data-id="popup_close"]');
				if (c) { try { c.click(); } catch (e) {} }
			}
		}
		return JSON.stringify(bad);
	})()`);
	await sleep(800);
	const badTools = typeof toolErrs === 'string' ? JSON.parse(toolErrs) : ['?'];
	note(badTools.length === 0, 'activating every tool throws nothing',
		badTools.length ? badTools.slice(0, 3).join(' | ') : toolInfo.count + ' tools ok');
	note(errors.length === 0, 'no console errors while switching tools',
		errors.slice(0, 3).join(' | ') || 'clean');

	// ---------------------------------------------------------------- 语言切换
	// locale 这条链是全链路接过的（<html lang> → manifest → 编辑器界面默认语言），
	// 语言包通过 require.context 打进 bundle，路径错了不会报错、只会静默留在英文。
	// 放最后：切完界面文案会变，前面的选择器都按英文写的。
	console.log('\n-- language --');
	errors = [];
	const breadcrumb = ['Tools', 'Language', '简体中文'];
	const langSteps = [];
	for (const label of breadcrumb) {
		await sleep(500);
		langSteps.push(await evaluate(`(function(){
			var want = ${JSON.stringify(label)};
			var hit = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
				.filter(function(a){ return a.textContent.trim() === want; })[0];
			if (!hit) return want + ': not found';
			hit.click();
			return want + ': clicked';
		})()`));
	}
	await sleep(1200);
	const switched = await evaluate(`(function(){
		var first = document.querySelector('#main_menu a');
		return JSON.stringify({
			label: first ? first.textContent.trim() : '',
			htmlLang: document.documentElement.lang,
		});
	})()`);
	const langState = typeof switched === 'string' ? JSON.parse(switched) : { label: '' };
	note(langState.label !== '' && langState.label !== breadcrumb[0],
		'switching to another language re-labels the menu bar',
		breadcrumb.join(' > ') + '  ->  first menu item now "' + langState.label + '"');
	note(errors.length === 0, 'no console errors while switching language',
		errors.slice(0, 2).join(' | ') || 'clean (' + langSteps.join(' / ') + ')');
	await send('Page.captureScreenshot', { format: 'png' }).then(r => {
		const out = process.env.OUT || path.join(process.cwd(), '.verify');
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, 'feat-language.png'), Buffer.from(r.data, 'base64'));
	});

	// 切回英文收尾：截图和后续人工排查都在默认语言下更省事
	for (const label of ['工具', '语言', 'English']) {
		await sleep(400);
		await evaluate(`(function(){
			var want = ${JSON.stringify(label)};
			var hit = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
				.filter(function(a){ return a.textContent.trim() === want; })[0];
			if (hit) hit.click();
		})()`);
	}

	// ---------------------------------------------------------------- 汇总
	await teardown();

	const failed = results.filter(r => !r.ok);
	console.log('\n================ FEATURE PROBE ================');
	console.log('passed: ' + (results.length - failed.length) + ' / ' + results.length);
	if (failed.length) {
		console.log('FAILED:');
		failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
	}
	// 原生对话框会把渲染进程冻住。出现了不一定是错（beforeunload 就属正常），
	// 但它在 CDP 下会把 await 挂死，所以至少要说出来。
	if (dialogs.length) {
		console.log('\nNOTE: ' + dialogs.length + ' native dialog(s) appeared (auto-accepted to keep going)');
		dialogs.slice(0, 5).forEach(d => console.log('  - ' + d));
	}
	process.exit(failed.length ? 1 : 0);
})().catch(async e => {
	console.error('PROBE CRASHED\n' + e.message);
	await teardown();
	process.exit(2);
});

/**
 * 收尾：杀掉整棵 Chrome 进程树并删掉临时 profile。
 * 只 kill 那个父进程是不够的 —— 子进程会活下来继续占着调试端口，
 * 下一轮就会连到它上面（这就是写死端口时那个 26 分钟挂死的成因）。
 */
async function teardown() {
	try { ws.close(); } catch (e) { /* 已经断了 */ }
	if (chrome && chrome.pid) {
		if (process.platform === 'win32') {
			await new Promise(res => {
				spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
					.on('close', res).on('error', res);
			});
		} else {
			try { chrome.kill('SIGKILL'); } catch (e) { /* 已经退出 */ }
		}
	}
	try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
}
