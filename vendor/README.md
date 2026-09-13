# vendor/Hermite-resize

这个目录是 [Hermite-resize](https://github.com/viliusle/Hermite-resize) v2.2.10 的源码副本，
由 `src/js/modules/image/resize.js` 通过 `import Hermite_class from 'hermite-resize'` 使用，
提供高质量 Hermite 滤波缩放。

## 为什么要 vendor 进仓库

上游 `package.json` 里原本把它声明成 git 依赖：

```json
"hermite-resize": "git+https://github.com/viliusle/Hermite-resize.git"
```

这有三个实际问题：

1. `npm install` 会现场 `git clone` GitHub，国内网络下经常长时间挂住甚至失败，
   表现为 `node_modules/hermite-resize` 是个空目录。
2. 依赖 GitHub 可达性，CI 与离线环境不可靠。
3. 没有版本 tag 锁定时，上游一次 push 就可能悄悄改变构建结果。

所以改为本地 vendored 并通过 `"hermite-resize": "file:vendor/Hermite-resize"` 引用。
`npm install` 不再需要访问 GitHub。

## 目录内容

只保留了运行需要的部分，去掉了 `.git/`、`test/`、`gulpfile.js`、`package-lock.json`：

```
Hermite-resize/
├── dist/hermite.npm.js   ← package.json 的 main 入口
├── src/
├── MIT-LICENSE.txt
├── README.md
└── package.json
```

## 升级方式

```bash
git clone --depth 1 https://github.com/viliusle/Hermite-resize.git /tmp/Hermite-resize
# 检查 diff 后覆盖本目录需要保留的文件，并同步 package.json 里的 version
```

许可证为 MIT，见 `MIT-LICENSE.txt`。
