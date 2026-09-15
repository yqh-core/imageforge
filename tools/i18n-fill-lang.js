/**
 * 按 empty.json 的键序重建目标语言包，并补齐缺失词条。
 *
 * 用法: node tools/i18n-fill-lang.js <code>      例: node tools/i18n-fill-lang.js zh
 *
 * - 键序对齐 empty.json（当前 UI 真正使用的键集合）
 * - 已有的翻译原样保留
 * - 缺失的从本文件 FILL 表补齐（用 trim 后的键匹配，避开尾随空格的坑）
 * - empty.json 之外的旧键视为废弃，不再写入
 */
const fs = require('fs');
const path = require('path');

const code = process.argv[2];
if (!code) {
	console.error('用法: node tools/i18n-fill-lang.js <code>');
	process.exit(1);
}

const dir = path.join(__dirname, '..', 'src', 'js', 'languages');
const base = JSON.parse(fs.readFileSync(path.join(dir, 'empty.json'), 'utf8'));
const file = path.join(dir, code + '.json');
const cur = JSON.parse(fs.readFileSync(file, 'utf8'));

// 待补词条：键用 trim 后的形式，避免尾随空格导致匹配不上
const FILL = {
	zh: {
		'Application markup may have changed,': '应用标记可能已更改，',
		'Can not use this tool on current layer: image already takes all area.': '无法在当前图层上使用此工具：图像已占满整个区域。',
		'Canvas Size': '画布尺寸',
		'Canvas size': '画布尺寸',
		'Close': '关闭',
		'Convert layer to raster': '将图层转换为栅格',
		'Ctrl + C': 'Ctrl + C',
		'Ctrl+P': 'Ctrl+P',
		'Duplicate layer': '复制图层',
		'Enable guides:': '启用参考线：',
		'English (UK)': '英语（英国）',
		'Error loading the list of fonts from Google.': '从 Google 加载字体列表失败。',
		'Error registering service worker': '注册 Service Worker 失败',
		'Error: unsupported attribute type:': '错误：不支持的属性类型：',
		'Exit confirmation:': '退出确认：',
		'Export': '导出',
		'Fit window': '适应窗口',
		'Full Screen': '全屏',
		'Greek': '希腊语',
		'Guides': '参考线',
		'Guides enabled.': '参考线已启用。',
		'Hide': '隐藏',
		'Horizontal:': '水平：',
		'Insert': '插入',
		'Insert guides': '插入参考线',
		'Insert new layer': '插入新图层',
		'KeyU': 'U 键',
		'Landscape': '横向',
		'Layer is empty.': '图层为空。',
		'Layout:': '布局：',
		'Move layer down': '下移图层',
		'Move layer up': '上移图层',
		'New Bezier Layer': '新建贝塞尔图层',
		'New Polygon Layer': '新建多边形图层',
		'Next': '下一步',
		'Portrait': '纵向',
		'Position:': '位置：',
		'Remove all': '全部移除',
		'Resized:': '已调整尺寸：',
		'Ruler': '标尺',
		'Safe search:': '安全搜索：',
		'Search for Font': '搜索字体',
		'Search:': '搜索：',
		'Separated (original types)': '分开保存（原始类型）',
		'Shapes (H)': '形状 (H)',
		'Shift + S': 'Shift + S',
		'Show': '显示',
		'Tag Image File Format': '标签图像文件格式 (TIFF)',
		'The quick brown fox jumps over the lazy dog.': '敏捷的棕色狐狸跳过那只懒狗。',
		'Thick guides:': '粗参考线：',
		'Type:': '类型：',
		'Units': '单位',
		'Update': '更新',
		'Update guides': '更新参考线',
		'Vertical:': '垂直：',
		'View': '视图',
	},
};

const fill = FILL[code];
if (!fill) {
	console.error('没有 ' + code + ' 的待补词条表，请在 FILL 中添加。');
	process.exit(1);
}
const fillMap = new Map(Object.entries(fill).map(([k, v]) => [k.trim(), v]));

const out = {};
let kept = 0;
let patched = 0;
let stillMissing = [];

for (const key of Object.keys(base)) {
	if (key in cur) {
		out[key] = cur[key];
		kept++;
		continue;
	}
	const hit = fillMap.get(key.trim());
	if (hit != null) {
		out[key] = hit;
		patched++;
	} else {
		out[key] = '';
		stillMissing.push(key);
	}
}

const dropped = Object.keys(cur).filter((k) => !(k in base));

fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('基准键数 : ' + Object.keys(base).length);
console.log('保留原译 : ' + kept);
console.log('本次补齐 : ' + patched);
console.log('仍缺     : ' + stillMissing.length + (stillMissing.length ? ' -> ' + JSON.stringify(stillMissing) : ''));
console.log('废弃旧键 : ' + dropped.length + ' (已移除)');
