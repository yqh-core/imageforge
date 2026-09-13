# ImageForge 部署说明

## 一句话

**ImageForge 是纯静态站点，没有服务端运行时。** 构建完把文件丢到任意静态服务器 /
对象存储 / CDN 就能跑，入口是 `index.html`。不需要 Node、不需要数据库、不需要反向代理后端。

原项目 freePS 的 README 写的是"下载代码上传到服务器，home page 是 index.html" —— 这一点没变，
只是我们把构建、预压缩和缓存配置补齐了。

---

## 1. 构建并打包

```bash
npm install
npm run ship        # = npm run build && npm run pack
```

`npm run build` 做三件事：

1. webpack 生产打包 → `dist/bundle.js`（关闭 source map，体积比原版小约 10%）
2. 按 `brand.config.json` 渲染 → 根目录的 `index.html` / `manifest.webmanifest` / `robots.txt` / `sitemap.xml`
3. 生成预压缩产物 → `dist/bundle.js.gz`（约 297 KB）与 `dist/bundle.js.br`（约 238 KB）

`npm run pack` 再把「上线真正需要的文件」挑出来（白名单，不是把整个工程拷过去）：

```
build/                              ← 要上传的就是这个目录
release/imageforge-site-1.0.0.zip   ← 同一份内容的 zip
```

规模随目标不同：

| 目标 | 命令 | 文件数 | 目录体积 | zip |
| --- | --- | --- | --- | --- |
| generic（自建服务器） | `npm run ship` | 51 | 1.8 MB | 约 900 KB |
| cloudflare | `npm run ship:cloudflare` | 50 | 1.3 MB | 约 390 KB |

（差异原因见 3.4。无论哪个目标都远低于 Cloudflare 拖拽上传的 1,000 文件上限；
但工程根目录是 **15,967 个文件**，所以永远不要上传根目录。）

pack 阶段会做一次**资源引用自检**：把 `index.html` / `manifest.webmanifest` 里引用的每个
本地文件都验一遍在不在、在不在白名单里，任何一个是 404 风险就直接中止打包。
（原项目正是栽在这类问题上：它的 `index.html` 写着 `href="dist/manifest.json"`，
而 `dist/` 下没有这个文件，线上一直是一个静默 404。现在这种问题过不了构建。）

产物大小对照（bundle.js）：

| | 体积 |
| --- | --- |
| 原版 freePS | 1315 KB |
| ImageForge 未压缩 | 1186 KB |
| gzip | 297.5 KB |
| brotli | 238.0 KB |

## 2. 要上传什么

**`build/` 里的全部内容**，整个目录拷到站点根目录，入口是 `index.html`：

```
index.html                  ← 必须
manifest.webmanifest        ← 必须（PWA / 添加到主屏幕）
robots.txt                  ← 建议
sitemap.xml                 ← 建议
dist/                       ← 必须（bundle.js + LICENSE.txt；generic 目标另有 .gz / .br）
images/                     ← 必须（图标、logo、preview.jpg、manifest 图标）
_headers                    ← 仅 cloudflare 目标，Cloudflare 解析它、不对外提供
```

不要再手工挑文件了 —— 挑漏一个就是线上 404，这正是 `npm run pack` 存在的理由。
它已经把 `src/`、`scripts/`、`node_modules/`、`vendor/`、`tools/`、`examples/`、
`package.json`、`webpack.config.js`、`deploy/` 全部排除在外。

> `examples/` 是给本地开发看的 integration 示例。要一起上线就 `npm run pack -- --with-examples`。

> ⚠️ `images/` 目录**必须**保持相对 `index.html` 的原有路径。构建产物里大量使用
> `images/icons/*.svg` 这样的相对路径，改了目录层级会导致图标全部 404。

## 3. 部署方式

### 3.1 自己一台服务器（Nginx）

```bash
# 本地构建后上传（只传 build/，源码和依赖不会跟着上线）
npm run ship
rsync -av --delete build/ user@your-server:/var/www/imageforge/

# 服务器上启用站点
sudo cp deploy/nginx.conf /etc/nginx/conf.d/imageforge.conf
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/nginx.conf` 已经配好预压缩、缓存分层、安全响应头，改一下 `root` 与 `server_name` 就能用。

**关于 `gzip_static`**：nginx 官方包默认带 `--with-http_gzip_static_module`，
所以 `gzip_static on;` 开箱可用，服务器会直接返回构建时生成的 `.gz`，不再现场压缩。
`brotli_static` 需要自行编译 `ngx_brotli` 模块，没装就把那三行注释掉 —— 功能完全不受影响。

### 3.2 对象存储 + CDN（阿里云 OSS / 腾讯云 COS / AWS S3 + CloudFront）

1. 把第 2 节的文件整目录上传，设置 `index.html` 为默认首页（静态网站托管）。
2. 预压缩产物在对象存储上**默认不会自动生效**（它不像 nginx 会做 `.gz` → `Content-Encoding` 映射），
   两种处理：
   - 直接上传**未压缩**的 `dist/bundle.js`，让 CDN 开启自动压缩（推荐，最省事）；
   - 或者不传 `.gz`，仅依赖 CDN 的在线压缩能力。
3. 上传后配置缓存规则：`dist/*` → `max-age=31536000, immutable`；
   `*.html` 与 `manifest.webmanifest` → `no-cache`。

### 3.3 托管平台（最省事）

| 平台 | 构建命令 | 发布目录 |
| --- | --- | --- |
| **Cloudflare Pages**（Git 集成） | `npm run ship:cloudflare` | `build` |
| **Netlify / Vercel** | `npm run ship` | `build` |
| **GitHub Pages** | 构建后把 `build/` 推到 `gh-pages` 分支；或在 Actions 里跑 `npm run ship` 再 `actions/deploy-pages` | — |

统一的规则：**构建命令必须是 `ship` / `ship:cloudflare`，不能是 `build`** ——
`build` 只在 `dist/` 里产出 bundle 和四个页面文件，不产出 `build/` 这个发布目录。

这些平台会自动做 Brotli/Gzip，所以 `.gz` / `.br` 传上去也不会被用到；
`--target=cloudflare` 打包会直接把它们去掉（见 3.4）。

> **子路径部署**（例如 `https://example.com/imageforge/`）：
> 本项目所有资源引用都是**相对路径**，放到子目录可以直接工作。
> 但 `manifest.webmanifest` 的 `start_url` / `scope` 已设为 `.`，也是相对当前目录，同样没问题。
> 唯一要改的是 `brand.config.json` 里的 `site`，它会被写进 canonical / og:url / sitemap 的绝对地址。

### 3.4 Cloudflare Pages

#### 文件数限制（这是最容易踩的一条）

| 上传方式 | 文件数上限 | 单文件上限 |
| --- | --- | --- |
| 控制台**拖拽**上传 | **1,000** | 25 MiB |
| **Wrangler** CLI 上传 | 20,000 | 25 MiB |

本项目按 Cloudflare 目标打包后是 **50 个文件 / 约 1.3 MB**，最大单文件 `dist/bundle.js`
约 1.2 MB —— 两条限制都远没碰到（占用 5%）。

**但是：千万不要把工程目录整个拖进去。** 工程根目录本机实测 **15,967 个文件**，
其中 `node_modules/` 一个就占 15,599 个，必然超限失败。要上传的**只有 `build/`**。

#### 方式 A / B：本地上传（Direct Upload）

```bash
npm run ship:cloudflare     # = build + pack --target=cloudflare
```

```bash
# 方式 A：控制台拖拽
#   Workers & Pages → Create application → Pages → Upload assets
#   把 build/ 目录（或 release/imageforge-site-1.0.0-cloudflare.zip）拖进去

# 方式 B：Wrangler CLI（可以先本地登录，适合反复发版）
npx wrangler login
npx wrangler pages deploy build
```

访问地址是 `https://<项目名>.pages.dev`。

> ⚠️ **Direct Upload 项目无法在之后转成 Git 集成项目。** 建项目时就要选对：
> 想自动部署就直接走下面的方式 C，别先拖拽。

#### 方式 C：Git 集成（推荐 —— 推送即自动部署）

一次性配置，之后 `git push` 自动构建上线，本地不用保留工程。

**1. 先把仓库推上去**（本机没有 GitHub 凭据，这一步需要你在自己的终端执行）：

```bash
cd D:/work/ImageForge
git push -u origin main
```

首次推送会要认证，两种任选：

- **HTTPS + Token**：GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens，勾 `Contents: Read and write`；推送时用户名填 GitHub 用户名、密码填 token。
- **SSH**：配好 key 后把 remote 换成 `git@github.com:yqh-core/imageforge.git`。

仓库可以是**私有**的，Cloudflare 读取私有仓库没有额外限制。

**2. 建项目**：Workers & Pages → Create → Pages → **Connect to Git** → 选 `yqh-core/imageforge`。

**3. 构建配置**，只有这几项：

| 字段 | 填什么 |
| --- | --- |
| Framework preset | **None** |
| Build command | `npm run ship:cloudflare` |
| Build output directory | `build` |
| Root directory | 留空（仓库根） |

**4. 环境变量：一个都不需要。** Node 版本由仓库里的 `.nvmrc` 决定，见下面 ①。

**5. 保存并部署。** 之后的分工：

- push 到 `main` → **生产部署** → `https://online-drawing.pages.dev`
- push 到其它分支或开 PR → **预览部署** → 独立的临时 `*.pages.dev` 地址，不污染生产

#### Git 集成模式下必须知道的五件事

**① Node 版本由 `.nvmrc` 决定，不用在控制台设。**
仓库里提交了 `.nvmrc`，内容是 `22.16.0` —— 正好是 Cloudflare 当前 v3 构建镜像的默认版本。
钉住它是防镜像默认版本随 LTS 升级漂移，导致某天构建无缘无故失败。
（等效写法是设 `NODE_VERSION` 环境变量，二选一；我们选了进版本控制的那种。）
另注：v3 构建系统**不再**从 `package.json` 的 `engines` 字段推断版本，
所以 `engines.node` 只对本地开发有意义，Cloudflare 不看它。

> ⚠️ 新项目默认应当落在 v3 构建镜像上，建完项目顺便确认一眼。
> 若显示 v2，建议切到 v3：v1 镜像将于 **2026-09-15** 被强制迁移到 v3，
> v2 于 **2027-02-23** 迁移。`.nvmrc` 在三个镜像下都生效，提前切不会影响构建。

**② `build/` 在 `.gitignore` 里 —— 这是对的，别改成提交。**
Cloudflare 每次构建都重新跑 `npm run ship:cloudflare` 生成 `build/`，
它取的是构建产物目录，和 git 里有没有这个目录无关。把 `build/` 提交进去只会让仓库越滚越大。

**③ 依赖安装走 `npm ci`。** 仓库里有 `package-lock.json`（lockfileVersion 3），
Cloudflare 用它做可复现安装。所以 **`package-lock.json` 必须一起提交**，
以后改依赖记得连它一起 commit，否则版本会漂。

**④ 不要在仓库里放 `wrangler.toml` 来接管配置。**
Cloudflare 文档说得很直白：Wrangler 配置文件里一旦出现 `pages_build_output_dir`，
**它就成为配置的唯一来源，仪表盘上相同字段会变成只读**。
对纯静态站这只有坏处 —— 构建命令本来就只能填在仪表盘上，
多一个配置文件只是多一个能把配置改坏的地方。要用 wrangler 本地部署（方式 B），
用命令行参数传目录就够了。

**⑤ 构建耗时与依赖缓存。** 依赖会被 Cloudflare 缓存，首次构建慢、之后快。
`sharp` 被放进了 `optionalDependencies`（没在 `devDependencies`），正是为这个场景：
它只用于本地重新生成图标 PNG，构建路径完全不碰它，
所以哪怕某个平台装不上它的本地二进制，也**不会**连带把部署搞挂。

#### 构建命令为什么是 `npm run ship:cloudflare`，不是 `npm run build`

- `build` 只产出 `dist/bundle.js` 和四个页面文件，**不产出 `build/`**，
  而「构建输出目录」必须真实存在 —— 填 `npm run build` 会让 Cloudflare 报输出目录不存在。
- `ship:cloudflare` = `build` + `pack --target=cloudflare`，一步产好 `build/`，
  并且带上 `_headers`、去掉这个平台用不到的 `.gz` / `.br`。

#### 这个目标改了什么

`npm run ship:cloudflare` 相比默认的 `npm run ship` 只有两处差异：

1. **去掉 `dist/*.gz` 与 `dist/*.br`**。Cloudflare 边缘会按 `Accept-Encoding` 自己压缩，
   上传预压缩产物是纯粹浪费（去掉后上传体积从 1.8 MB 降到 1.3 MB）。对自建 Nginx 就不能这么做，
   因为那边要靠 `gzip_static` 直接返回这些文件。
2. **加入 `build/_headers`**，来源是 `deploy/cloudflare/_headers`。这是 Cloudflare 版的
   `deploy/nginx.conf` 响应头段，负责：

   | 路径 | 响应头 |
   | --- | --- |
   | `/*` | `X-Content-Type-Options` / `Referrer-Policy` / `Permissions-Policy` |
   | `/`、`/index.html`、`/manifest.webmanifest` | `Cache-Control: public, max-age=0, must-revalidate` |
   | `/dist/*` | `Cache-Control: public, max-age=31536000, immutable` |
   | `/images/*` | `Cache-Control: public, max-age=2592000` |

   `_headers` 会被 Cloudflare 解析成响应头，**文件本身不会被当作静态资源对外提供**。
   规则上限 100 条，我们用了 6 条。

   为什么 `/` 和 `/index.html` 两条都写：根路径在 Cloudflare 上会被解析到 `index.html`，
   而规则是按请求路径匹配的，只写一条在某些解析时机下会漏掉。

#### Cloudflare 上尤其要注意的两点

1. **`index.html` 的 `Cache-Control` 不能省**。`dist/bundle.js` 的文件名是稳定的，
   缓存失效完全靠 `index.html` 里 `dist/bundle.js?v=<内容指纹>` 这个 URL 变化。
   html 一旦被缓存住，用户会一直加载指向旧 bundle 的旧页面 —— 表现为"我明明更新了，用户还是旧版"。
2. **没设 `X-Frame-Options` 是刻意的**。`examples/` 里的集成示例需要用 iframe 嵌入本应用。
   要防点击劫持就自己加上，但你会失去嵌入能力。

## 4. 上线前检查清单

通用：

- [x] `brand.config.json` 的 `site` / `repository` / `issues` / `email` 已填真实值
      （`online-drawing.pages.dev` / `yqh-core/imageforge` / `yqhgry@gmail.com`）
- [ ] 改完 brand 配置后重新跑过 `npm run ship`（`index.html` 是构建产物，改配置必须重新构建）
- [ ] `npm run preview` 本地确认页面正常、菜单与"关于"弹窗显示的是新品牌
- [ ] 已启用 HTTPS（剪贴板写入与摄像头取图在非安全上下文下会被浏览器禁用）
- [ ] `index.html` 没有被设置长缓存
- [ ] 如果要用 Google AdSense，需要**自己**新建并上传 `ads.txt`（原项目的已被移除）

走 **Git 集成**的话再确认（见 3.4 方式 C）：

- [ ] 建项目时选的是 **Connect to Git**（Direct Upload 项目之后**无法**转成 Git 集成）
- [ ] 构建命令 `npm run ship:cloudflare`、输出目录 `build`、Framework preset `None`
- [ ] 构建镜像确认是 **v3**（v1 于 2026-09-15、v2 于 2027-02-23 强制迁移到 v3）
- [ ] 生产分支是 `main`，且确实是你想要的那个分支
- [ ] 仓库里提交了 `.nvmrc` 和 `package-lock.json`（Node 版本与依赖可复现性都靠它们）
- [ ] 在干净克隆上跑过 `npm ci && npm run ship:cloudflare` 并通过
      —— 这一条等价于"Cloudflare 会做的事"，过了就不会在 CI 上翻车

走**本地上传**（Direct Upload）的话确认：

- [ ] 上传的是 **`build/`**（50 个文件），不是工程根目录（15,967 个文件，必然超限）
- [ ] 用的是 `npm run ship:cloudflare`，所以 `build/_headers` 在位、没有多余的 `.gz` / `.br`

## 5. 缓存失效机制

构建会给 script 标签带上内容指纹：

```html
<script src="dist/bundle.js?v=94a3642d0f"></script>
```

指纹是 `dist/bundle.js` 的 sha256 前 10 位。静态服务器忽略查询串、仍然命中 `dist/bundle.js`，
所以：

- 浏览器把 `dist/bundle.js?v=94a3642d0f` 当作独立 URL → 可以设 `immutable` 长缓存；
- 下次 `npm run build` 产出内容不同的 bundle → 指纹变化 → `index.html` 里的 URL 变化 → 自动失效；
- `index.html` 本身设 `no-cache`，保证用户能及时拿到新指纹。

⚠️ 因此两条规则必须同时成立，否则会出现"用户永远停在旧版本"：
`dist/` 长缓存 **且** `index.html` 不缓存。

## 6. 本地验证部署行为

```bash
npm run ship        # 先产出 build/
npm run preview     # http://127.0.0.1:4173/
```

`npm run preview` **默认服务 `build/`**，也就是你即将上传的那份文件本身 ——
所以"本地看起来正常"和"上线后别人看起来正常"是同一件事，不存在只在本地好的情况。
（`build/` 还没生成时会自动回退到工程根目录；加 `--source` 可强制服务工程根目录。）

这个服务器是刻意按生产静态服务器的行为写的，用来在上线前验证：

- 浏览器请求 `Accept-Encoding: br/gzip` 时是否命中预压缩产物
  （**仅 generic 目标**；cloudflare 目标没有 `.gz` / `.br`，会直接返回原始 bundle ——
  这是对的，压缩交给 Cloudflare 边缘做）
- `Cache-Control` 头是否符合预期
- `.webmanifest` 是否返回正确的 MIME（`application/manifest+json`）
- 目录请求是否回落到 `index.html`

用它打开页面正常，基本就等价于上线正常。

## 7. 常见问题

**页面白屏 / 只有文字没有样式**
`dist/bundle.js` 没上传或路径不对。检查浏览器 Network 里 `dist/bundle.js?v=...` 是否 404。

**图标全部不显示**
`images/` 目录没有按原层级上传。这些是相对页面路径引用，不能被移动到别处或改名。

**改了 `brand.config.json` 但页面没变**
`index.html` 是构建产物，必须重新 `npm run build`。

**菜单 Help → Report Issues 点开是 404**
`brand.issues` 指向的仓库不存在（或还是私有仓库，未公开前点开就是 404）。
核对 `brand.config.json` 后重新 `npm run build`。

**上传了 `.gz` 但传输体积没变小**
服务器没开 `gzip_static`（nginx）或对象存储不识别预压缩文件。见 3.1 / 3.2。

**"Search Images" 搜不出结果**
该功能调用 Pixabay API，需要外网可达；另外 `src/js/config.js` 里的 `config.pixabay_key`
是公开写在客户端代码里的示例 key，有配额限制，正式使用建议换成自己的 key。

**干净克隆上构建报 `缺少上线必需的文件: index.html`**
`.gitignore` 里忽略「构建产物」的模式**必须锚定到仓库根目录**。写成 `index.html` 这种
不带 `/` 前缀的模式，git 会在**任意层级**匹配，于是连 `src/template/index.html` 这些
**模板源文件**一起被忽略掉 —— 模板没进版本库 → 干净克隆里没有模板 → 渲染步骤一个文件都产不出
→ `pack` 阶段报缺 `index.html`。本机开发时因为文件已在磁盘上，完全看不出异常，
只有干净克隆才会暴露。本项目已改成 `/index.html`、`/manifest.webmanifest`、
`/robots.txt`、`/sitemap.xml`。

排查方法（任何「本地能构建、CI 不能」的问题都先用这条）：

```bash
git status --ignored --porcelain | grep '^!!'   # 看还有哪些该提交的文件被忽略了
```

**复制到剪贴板无效**
`navigator.clipboard` 只在 HTTPS 或 `localhost` 下可用。
