/**
 * ImageForge - service worker 注册（页面侧）
 *
 * 与 src/template/service-worker.js 是一对：那边负责缓存，这边负责注册和更新时机。
 *
 * 更新策略刻意做成"提示 + 用户确认"，而不是静默刷新：
 * 编辑器里可能正有一张没保存的图，如果新版本一装好就自动 reload，
 * 用户会莫名其妙丢内容。所以新版本装好后先停在 waiting，弹一条提示，
 * 用户点了才 postMessage 让它顶上来（随后 controllerchange 触发一次 reload）。
 *
 * 首次访问不提示：那时 navigator.serviceWorker.controller 还是 null，
 * SW 刚 claim 属于正常首次接管，不是"发现新版本"。
 */

import alertify from 'alertifyjs';

/**
 * 注册入口。
 *
 * 只有 https 与 localhost 才有 serviceWorker（浏览器硬限制），
 * dev 模式下 webpack-dev-server 也不会产出 service-worker.js，
 * 这两种情况都静默跳过 —— 注册失败不该在控制台刷红字，更不该影响编辑器本身。
 */
export function registerServiceWorker() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

	const host = window.location.hostname;
	const isSecure = window.location.protocol === 'https:'
		|| host === 'localhost'
		|| host === '127.0.0.1';
	if (!isSecure) return;

	const register = () => {
		navigator.serviceWorker
			.register('service-worker.js', { scope: './' })
			.then(handleRegistration)
			.catch(err => {
				// 最常见的是 404（还没 build / dev 模式），不值得打断用户
				console.warn('[sw] registration skipped:', err && err.message);
			});
	};

	// 首屏之后再注册，避免和 bundle、字体的下载抢带宽
	if (document.readyState === 'complete') {
		// 已经在 load 之后了，让出一帧再注册，不占当前任务
		setTimeout(register, 0);
	} else {
		window.addEventListener('load', () => setTimeout(register, 0));
	}
}

function handleRegistration(registration) {
	if (!registration) return;

	// 长开不刷新的标签不会自动检查更新 —— 浏览器只在导航时比对 SW 字节。
	// 编辑器恰恰是"开着放一整天"的那类页面，所以自己定时问一次。
	// update() 很轻：只下载 service-worker.js 比对字节，没变化就什么都不发生。
	setInterval(() => {
		registration.update().catch(() => { /* 断网时问不到，下个周期再试 */ });
	}, 60 * 60 * 1000);

	// 老页面里已经有 SW 在管，且现在有个装好的新版在等 —— 直接提示
	if (registration.waiting && navigator.serviceWorker.controller) {
		promptToUpdate(registration.waiting);
	}

	registration.addEventListener('updatefound', () => {
		const installing = registration.installing;
		if (!installing) return;

		installing.addEventListener('statechange', () => {
			if (installing.state !== 'installed') return;
			// 有 controller = 这不是首次接管，而是真的来了个新版本
			if (navigator.serviceWorker.controller) promptToUpdate(installing);
		});
	});
}

let refreshing = false;

/** 新 SW 接管后刷新一次。加 refreshing 防止 controllerchange 反复触发导致刷新循环。 */
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (refreshing) return;
		refreshing = true;
		window.location.reload();
	});
}

function promptToUpdate(worker) {
	if (!worker) return;
	try {
		// wait = 0 表示不自动消失，等用户点；点了才让它顶上来
		alertify.notify('A new version is ready. Click to reload.', 'message', 0, () => {
			worker.postMessage({ type: 'SKIP_WAITING' });
		});
	} catch (err) {
		// 提示只是锦上添花，弹不出来就让它在下次刷新时自然生效
		console.warn('[sw] update prompt failed:', err && err.message);
	}
}

export default registerServiceWorker;
