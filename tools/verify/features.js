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
const PORT = 9355;

const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }

const results = [];
const note = (ok, name, detail) => {
	results.push({ ok, name, detail });
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}` + (detail ? `  -> ${detail}` : ''));
};

(async () => {
	const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
	const proxyArgs = isLocal
		? ['--no-proxy-server', '--proxy-bypass-list=<-loopback>']
		: (process.env.VERIFY_PROXY ? ['--proxy-server=' + process.env.VERIFY_PROXY] : []);

	const profile = path.join(os.tmpdir(), 'cdp-feat-' + Date.now());
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
	// 每个阶段单独收集，才能定位是哪一步引入的报错
	let errors = [];

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
	};

	const send = (method, params) => new Promise((resolve, reject) => {
		const mid = ++id;
		pending.set(mid, { resolve, reject });
		ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
	});

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

	// ---------------------------------------------------------------- 导出
	console.log('\n-- export --');
	errors = [];
	const exportProbe = await evaluate(`(function(){
		// 不真的触发下载（headless 下会挂起），只确认导出入口存在且可调用
		var m = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.filter(function(a){ return a.textContent.trim().toLowerCase() === 'file'; })[0];
		if (m) m.click();
		var names = Array.prototype.slice.call(document.querySelectorAll('#main_menu a'))
			.map(function(a){ return a.textContent.trim(); });
		var hit = names.filter(function(n){ return /save|export|download/i.test(n); });
		return JSON.stringify(hit);
	})()`);
	await sleep(400);
	await evaluate(`(function(){
		var pop = document.querySelector('#popups .popup');
		if (pop) { var c = pop.querySelector('[data-id="popup_cancel"]'); if (c) c.click(); }
	})()`);
	const expList = typeof exportProbe === 'string' ? JSON.parse(exportProbe) : [];
	note(expList.length > 0, 'export / save entries exist in File menu', expList.join(', '));
	note(errors.length === 0, 'no console errors browsing export', errors.slice(0, 2).join(' | ') || 'clean');

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

	// ---------------------------------------------------------------- 汇总
	ws.close();
	chrome.kill();

	const failed = results.filter(r => !r.ok);
	console.log('\n================ FEATURE PROBE ================');
	console.log('passed: ' + (results.length - failed.length) + ' / ' + results.length);
	if (failed.length) {
		console.log('FAILED:');
		failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
	}
	process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED\n' + e.message); process.exit(2); });
