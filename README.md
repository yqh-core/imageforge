# ImageForge

Free online image editor that runs entirely in the browser. Open, retouch, layer, filter and
export images without uploading anything to a server — no install, no account, no ads.

Built on top of [miniPaint](https://github.com/viliusle/miniPaint) (MIT).

---

## Quick start

```bash
npm install          # 安装依赖
npm run ship         # = build + pack，一条命令产出可上线的 build/ 和 zip
npm run preview      # 本地预览，服务的就是 build/ 本身
```

打开 `http://127.0.0.1:4173/`。

开发时用：

```bash
npm run dev          # 只重新打包到 dist/bundle.js，带 source map
npm run serve        # webpack dev server，改代码自动重载
```

## All commands

| 命令 | 作用 |
| --- | --- |
| `npm run ship` | **上线用**。`build` + `pack` 两步跑完，产出 `build/` 与 `release/*.zip` |
| `npm run ship:cloudflare` | 同上，但按 Cloudflare 目标打包（去掉 `.gz`/`.br`，加入 `_headers`） |
| `npm run build` | webpack 生产打包 → 渲染页面 → 生成 `.gz` / `.br` 预压缩 |
| `npm run pack` | 从工程里挑出上线必需文件，产出 `build/` + zip，并做一次资源引用自检 |
| `npm run pack:cloudflare` | 按 Cloudflare 目标打包（`--target=cloudflare`） |
| `npm run build:only` | 只跑 webpack，不动页面与预压缩文件 |
| `npm run dev` | 开发构建，产出带 source map 的 bundle |
| `npm run serve` | 带热重载的开发服务器 |
| `npm run preview` | 静态预览服务器，默认服务 `build/`，会正确返回 `.gz` / `.br` |
| `npm run verify` | 用真实 Chrome 打开构建产物做验收（67 项：渲染 / 品牌 / 安全头 / 404 / PWA / 断网 / 控制台报错 + 截图） |
| `npm run probe` | 功能探测（16 项：真的画一笔、撤销重做、加图层、导出 PNG、切语言） |
| `npm run icons` | 从 `images/favicon.svg` 重新生成全部 PNG 图标 |

---

## 改品牌只改一个文件

**`brand.config.json`** 是全站品牌信息的唯一来源，改完重新 `npm run build` 即可。

```jsonc
{
  "name": "ImageForge",                        // 站点名、左上角 logo 文字、关于弹窗、PWA 名称
  "tagline": "Free online image editor",       // 浏览器标题后半段
  "description": "...",                        // SEO description / og:description / 关于弹窗
  "author": "ImageForge",
  "email": "yqhgry@gmail.com",                 // 关于弹窗里的邮箱
  "site": "https://online-drawing.pages.dev",  // 绝对域名：canonical / og:url / og:image / sitemap
  "repository": "https://github.com/yqh-core/imageforge",     // 关于弹窗 GitHub、导出 JSON 元信息
  "issues": "https://github.com/yqh-core/imageforge/issues",  // 菜单 Help → Report Issues
  "themeColor": "#2f7df6",
  "keywords": ["photo editor", "..."],
  "upstream": { "name": "miniPaint", "url": "...", "license": "MIT" }
}
```

`site` / `repository` / `issues` / `email` 四项会被写进 canonical、`og:url`、`og:image`、`sitemap.xml`
这类**绝对地址**——填错不会报错，只会静默指向别人的地址，所以换项目时务必先改这四项。
`npm run pack` 会在打包末尾检查它们是否仍为占位值并给出警告。

它同时驱动三个地方，所以不会出现"改了名字某处忘了改"：

| 消费方 | 位置 |
| --- | --- |
| 运行时（关于弹窗、菜单链接、导出 JSON 元信息） | `src/js/brand.js` 读取同一份 JSON |
| 构建期页面 | `scripts/lib/render.js` 把 `src/template/*` 渲染成根目录的 `index.html` / `manifest.webmanifest` / `robots.txt` / `sitemap.xml` |
| 站点清单 | 同上 |

> `index.html`、`404.html`、`service-worker.js`、`manifest.webmanifest`、`robots.txt`、`sitemap.xml`
> 都是**构建产物**，不要直接手改，改模板 `src/template/` 或品牌配置。
> 例外是 `favicon.ico`：它由 `npm run icons` 生成，和 `images/*.png` 一样要提交进仓库
> （生成它依赖的 sharp 是可选依赖，不能指望每台机器都能重跑）。

## 换 Logo

| 文件 | 用途 | 注意 |
| --- | --- | --- |
| `images/logo.svg` | 页面左上角 | **必须是纯黑单色**。深色主题会用 CSS `filter: invert()` 反成白色，带颜色会变形 |
| `images/logo-color.svg` | 关于弹窗 | 彩色版本，任意配色 |
| `images/favicon.svg` | favicon + PWA 图标源 | 改完跑 `npm run icons` 重新生成 `images/favicon.png`、`images/manifest/*.png` 与根目录 `favicon.ico` |

---

## 项目结构

```
ImageForge/
├── brand.config.json        品牌唯一真源
├── index.html               ← 构建产物（由 src/template/index.html 生成）
├── 404.html                 ← 构建产物；Cloudflare Pages 认它作自定义错误页
├── service-worker.js        ← 构建产物；PWA 离线缓存，含 bundle 指纹
├── favicon.ico              ← 由 npm run icons 生成（要提交，sharp 是可选依赖）
├── manifest.webmanifest     ← 构建产物
├── robots.txt / sitemap.xml ← 构建产物
├── package.json
├── package-lock.json        锁定依赖版本，务必一起提交（CI 用 npm ci）
├── .nvmrc                   Node 版本，Cloudflare 构建镜像按它选版本
├── .gitattributes           行尾规则；.nvmrc 与 _headers 被钉死为 LF
├── webpack.config.js        只负责「源码 → dist/bundle.js」
├── src/
│   ├── template/            页面模板（含 {{BRAND_*}} 占位符）—— 这是源文件，必须提交；
│   │                        根目录的 index.html 等才是构建产物，已被 .gitignore 忽略
│   ├── css/                 样式（打进 bundle）
│   └── js/
│       ├── brand.js         品牌运行时入口
│       ├── main.js          启动入口
│       ├── app.js           单例注册中心
│       ├── config.js        编辑器默认参数与工具定义
│       ├── config-menu.js   菜单结构（不含任何硬编码品牌链接）
│       ├── core/            base-layers / base-tools / base-gui / gui-* / service-worker
│       ├── actions/         撤销重做动作
│       ├── modules/         edit|effects|file|help|image|layer|tools|view
│       ├── tools/           各绘图工具
│       └── languages/       15 种语言包
├── scripts/
│   ├── build.js             构建编排：打包 → 渲染 → 预压缩
│   ├── pack.js              挑出上线文件 → build/ + zip（含资源引用自检）
│   ├── gen-icons.js         矢量源 → 全尺寸 PNG 图标 + favicon.ico（sharp 为可选依赖）
│   ├── serve.js             部署行为仿真预览服务器
│   └── lib/                 brand.js / render.js / zip.js
├── images/                  静态资源（构建产物直接引用，路径不可改）
├── vendor/Hermite-resize/   vendored 依赖，见 vendor/README.md
├── deploy/                  nginx.conf + cloudflare/_headers + DEPLOY.md
├── tools/translator/        语言包辅助工具
├── tools/verify/verify.js   Chrome 无头验收脚本（npm run verify）
├── tools/verify/features.js 功能探测：真的画一笔并数像素、撤销重做往返、加图层、
│                             导出 PNG 并验文件头与文件名、切语言（npm run probe）
├── examples/                嵌入集成示例
├── dist/                    bundle.js (+ .gz / .br)
├── build/                   ← npm run pack 产出，上传这个目录
└── release/                 ← npm run pack 产出的 zip
```

---

## 部署

**这是一个纯静态站点，没有任何服务端运行时。** 完整的部署说明见
[`deploy/DEPLOY.md`](deploy/DEPLOY.md)，nginx 可直接用 [`deploy/nginx.conf`](deploy/nginx.conf)。

最短路径：

```bash
npm run ship
# 然后把 build/ 里的全部内容拷到站点根目录 / 传上对象存储 / 交给托管平台
```

`build/` 是白名单产物，只有上线真正需要的文件（约 1.3–1.8 MB），`src/`、`scripts/`、
`node_modules/`、`vendor/`、`package.json` 都不会跟着上线。
`release/imageforge-site-*.zip` 是同一份内容的压缩包，方便直接上传或分发。

> **不要上传工程根目录。** 本机实测根目录共 15,967 个文件（`node_modules/` 占 15,599），
> 而 Cloudflare Pages 控制台拖拽上传的上限是 **1,000 个文件**，必然失败。
> 要上传的永远是 `build/`：按 Cloudflare 目标打包后是 **53 个文件**。

### Cloudflare Pages（Git 集成，推荐）

仓库已经按 Git 集成配好了，一次性设置之后 `git push` 就自动构建上线：

| 字段 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run ship:cloudflare` |
| Build output directory | `build` |
| Root directory | 留空（仓库根） |
| 环境变量 | **一个都不需要** |

Node 版本由仓库里的 `.nvmrc`（`22.16.0`）决定，不用在控制台设。

```bash
git push -u origin main
```

之后 push 到 `main` 触发生产部署，其它分支 / PR 触发预览部署。
完整说明、五个易踩点与排查见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md) 的 3.4 节。

不想走 Git 集成也可以本地上传：

```bash
npm run ship:cloudflare
# 方式 A：把 build/（或 release/*.zip）拖进 Workers & Pages → Create → Pages → Upload assets
# 方式 B：npx wrangler pages deploy build
```

⚠️ **Direct Upload 项目之后无法转成 Git 集成项目**，要自动部署就一开始选 Connect to Git。

这个打包目标相比默认只做两件事：去掉 `.gz` / `.br`（Cloudflare 边缘自动压缩，传了是浪费），
并加入 `build/_headers` 接管缓存与安全响应头。

入口是 `index.html`，所以 `https://你的域名/` 直接可用。

三个容易踩的坑：

1. **预压缩文件要用起来**，需要在 Nginx 开 `gzip_static on;`（brotli 需要 `brotli_static on;` + ngx_brotli 模块）。
   否则 `.gz` / `.br` 只是躺着不生效 —— 不影响功能，只是白白多传 4 倍体积。
2. **`index.html` 不能强缓存**。`dist/` 走 `immutable` 长缓存靠 URL 上的 `?v=<内容指纹>` 做失效，
   如果 html 也被长缓存，用户在指纹更新前会一直加载旧 bundle。
3. **建议上 HTTPS**。剪贴板粘贴（Ctrl+V）和摄像头相关能力在非安全上下文下会被浏览器禁用。

---

## 功能范围

完整的多图层图像编辑器：图层管理与混合、选区、画笔 / 铅笔 / 橡皮 / 魔术橡皮 / 填充、
形状与文字、渐变、克隆图章、裁剪与缩放、模糊 / 锐化 / 去色 / 凸出收缩等滤镜、
色相饱和度等色彩调整、参考线与标尺、GIF 动画帧、撤销重做、15 种界面语言。

所有处理都在浏览器本地完成，图片不会上传到任何服务器。

首次加载后应用本身可离线运行；以下能力需要联网：菜单里的 Search Images（走 Pixabay API）、
可选 Google 字体。

---

## 与上游的关系

本项目基于 [miniPaint](https://github.com/viliusle/miniPaint) v4.13.0 源码构建，遵循其 MIT 协议
（见 `MIT-LICENSE.txt`）。相对上游的主要改动：

- 品牌、页面、PWA 清单、图标全部替换为 ImageForge
- 品牌信息集中到 `brand.config.json`，源码中不再散落硬编码的名称 / 域名 / 邮箱
- 构建管线拆分为「打包 / 渲染页面 / 预压缩」三个独立步骤，并新增 `pack` 产出上线白名单目录
- 生产构建关闭 source map，产物体积下降
- 新增 `?v=` 内容指纹、预压缩产物、部署配置与文档
- 移除 `ads.txt` 与 AdSense 发布商 ID
- 修复上游 `index.html` 引用不存在的 `dist/manifest.json` 导致的静默 404
- 补齐 PWA：新增 service worker（装到桌面后断网也能打开）与品牌化 `404.html`，
  顺带修掉"任何路径都返回 200 + 首页"的软 404
- 移除上游内置的公开 demo key（Pixabay / Google Fonts），改为在
  `brand.config.json` 的 `services` 段配置；未配置时给出明确提示而不是静默失败

第三方库的版权声明随构建产物一起输出在 `dist/bundle.js.LICENSE.txt`。
