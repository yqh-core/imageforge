/**
 * ImageForge - service worker（构建产物，请勿直接编辑本文件）
 *
 * 源文件是 src/template/service-worker.js，由 scripts/lib/render.js 把
 * BUILD_HASH 占位符换成 bundle 指纹后输出到站点根目录。改逻辑要改模板再
 * npm run build，否则下次构建会被覆盖回去。
 *
 * 它解决的是"PWA 只做了一半"的问题：manifest 声明了 8 个图标、页面能被安装到桌面，
 * 但没有 service worker 时，装完断网就打不开 —— 一个离线图片编辑器不能这样。
 *
 * 缓存策略按资源类型分开，不是一刀切：
 *   导航请求（HTML）   network-first
 *       站点每次发版都会换 index.html 里的 ?v= 指纹，但 HTML 本身 URL 不变。
 *       缓存优先会让用户永远停在旧页面（连着旧 bundle），所以必须优先走网络；
 *       只有断网/超时才回落到缓存，这时至少还能打开编辑器。
 *   带指纹的构建产物   cache-first（dist/*、images/*）
 *       内容变了 URL 就变，缓存命中即可信，没必要每次问服务器。
 *   其余同源 GET       network-first 并顺手入缓存
 *
 * 刻意不做的：
 *   - 不缓存跨域响应。图片搜索（pixabay）、在线字体（googleapis）都是 no-cors 的
 *     opaque 响应，存进缓存会以"约 7MB/条"的估算占用配额，几十张图就能撑满。
 *   - 不拦截非 GET 请求。
 *   - 不在 install 阶段 skipWaiting。新版本先进入 waiting，由页面决定何时切换，
 *     避免正在编辑的内容被"静默刷新"打断（见 src/js/core/service-worker.js）。
 */

const VERSION = '{{BUILD_HASH}}';
const CACHE_NAME = 'imageforge-' + VERSION;

/**
 * 首屏必需资源。列表刻意很短：install 阶段这里任何一个 404 都会让整个
 * SW 安装失败，于是"离线可用"整体失效 —— 宁可少缓存，也不要赌全员在位。
 * 其余资源在首次用到时由 fetch 处理器按需入缓存。
 */
const PRECACHE = [
	'./',
	'./index.html',
	'./manifest.webmanifest',
	'./favicon.ico',
	'./images/favicon.svg',
	'./images/logo.svg',
	'./dist/bundle.js?v={{BUILD_HASH}}',
];

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		// 用 allSettled 而不是 all：单个资源缺失不该让整个 SW 装不上，
		// 缺的那几个大不了首次访问时走网络。
		const results = await Promise.allSettled(PRECACHE.map(url => cache.add(url)));
		const failed = results
			.map((r, i) => (r.status === 'rejected' ? PRECACHE[i] : null))
			.filter(Boolean);
		if (failed.length) {
			console.warn('[sw] precache skipped:', failed.join(', '));
		}
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		const keys = await caches.keys();
		await Promise.all(
			keys.filter(k => k.startsWith('imageforge-') && k !== CACHE_NAME)
				.map(k => caches.delete(k))
		);
		// 接管当前已打开的页面，否则要等用户手动刷新才生效
		await self.clients.claim();
	})());
});

/** 页面确认后调用：立刻顶掉旧版本（配合 controllerchange 自动刷新） */
self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** 内容变了 URL 就变的部分，缓存命中即可信 */
const isImmutable = url =>
	/\/(dist|images)\//.test(url.pathname) || url.pathname.endsWith('.webmanifest');

async function staleWhileRevalidate(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);

	const network = fetch(request)
		.then(response => {
			if (response && response.ok) cache.put(request, response.clone());
			return response;
		})
		.catch(() => null);

	// 命中缓存就先返回（后台顺手更新），否则等网络
	if (cached) return cached;
	const response = await network;
	if (response) return response;
	throw new Error('offline and no cache: ' + request.url);
}

async function networkFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response && response.ok) cache.put(request, response.clone());
		return response;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		throw err;
	}
}

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	// 跨域一律放过：opaque 响应不值得缓存，也不该由本站 SW 决定其生死
	if (url.origin !== self.location.origin) return;

	// 导航请求：优先网络，断网时回落到缓存的 index.html
	if (request.mode === 'navigate') {
		event.respondWith(
			networkFirst(request).catch(async () => {
				const cache = await caches.open(CACHE_NAME);
				return (await cache.match('./index.html')) || Response.error();
			})
		);
		return;
	}

	event.respondWith(
		isImmutable(url) ? staleWhileRevalidate(request) : networkFirst(request)
	);
});
