/**
 * ImageForge - webpack.config.js
 *
 * 这里只负责"把源码编译成 dist/bundle.js"这一件事。
 * 页面渲染、静态资源预压缩由 scripts/build.js 编排，互不耦合。
 */

const webpack = require('webpack');
const path = require('path');

module.exports = (env, argv) => {
	const mode = (argv && argv.mode) || 'development';
	const isProduction = mode === 'production';

	return {
		mode: mode,
		entry: './src/js/main.js',
		output: {
			path: path.resolve(__dirname, 'dist'),
			filename: 'bundle.js',
			publicPath: '/dist/',
			clean: false,
		},
		resolve: {
			extensions: ['.js', '.css', '.json'],
		},
		module: {
			rules: [
				{
					test: /\.css$/,
					use: [
						// [perf 2026-10-29] style-loader(运行时注入) → MiniCssExtractPlugin：
						// CSS 拆为独立 dist/bundle.css + <head><link>，bundle.js 改 defer。
						// 消除 1.2MB 同步 bundle 的 1651ms 渲染阻塞；样式先于首绘就位，无 FOUC。
						require('mini-css-extract-plugin').loader,
						{
							loader: 'css-loader',
							options: { url: false },
						},
					],
				},
				{
					test: /\.js$/,
					exclude: /(node_modules|bower_components)/,
					use: ['babel-loader'],
				},
			],
		},
		plugins: [
			// [perf 2026-10-29] CSS 拆分：产出独立 dist/bundle.css（模板以 <link> 引入）
			new (require('mini-css-extract-plugin'))({
				filename: 'bundle.css',
			}),
			new webpack.ProvidePlugin({
				$: 'jquery',
				jQuery: 'jquery',
				'window.jQuery': 'jquery',
			}),
			new webpack.DefinePlugin({
				VERSION: JSON.stringify(require('./package.json').version),
			}),
		],
		// 生产包不产出 source map：体积更小，也避免源码被直接公开
		devtool: isProduction ? false : 'eval-cheap-module-source-map',
		performance: {
			hints: isProduction ? false : 'warning',
		},
		devServer: {
			static: {
				directory: path.resolve(__dirname, './'),
			},
			port: 8080,
			open: true,
		},
	};
};
