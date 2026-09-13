/**
 * ImageForge - scripts/lib/zip.js
 *
 * 零依赖的最小 ZIP 写入器。
 *
 * 为什么不引 archiver / jszip：打包只需要「把确定的几十个文件塞进一个 zip」，
 * 为此多背一个依赖（以及它自己的一串传递依赖）不划算。这里只实现 store(0) 与
 * deflate(8) 两种方法 —— 覆盖需求，且产物能被 Windows 资源管理器 / macOS 归档
 * 工具 / unzip / 7-Zip 正常解压。
 *
 * 实现依据：PKWARE APPNOTE 4.3.0 的 local file header(4.3.7)、
 * central directory(4.3.12) 与 end of central directory(4.3.16)。
 */

const zlib = require('zlib');

// Node 22.2+ 自带 zlib.crc32；低版本回退到手算表。
const crc32 = typeof zlib.crc32 === 'function'
	? buf => zlib.crc32(buf) >>> 0
	: (() => {
		const table = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
			table[i] = c >>> 0;
		}
		return buf => {
			let c = 0xffffffff;
			for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
			return (c ^ 0xffffffff) >>> 0;
		};
	})();

// DOS 时间戳固定为 1980-01-01 00:00，避免同样的内容每次打包产生不同字节
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * @param {Array<{name: string, data: Buffer}>} entries 路径一律使用正斜杠
 * @returns {{buffer: Buffer, stored: number, deflated: number}}
 */
function createZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	let stored = 0;
	let deflated = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, 'utf8');
		const data = entry.data;
		const crc = crc32(data);

		const deflatedBuf = zlib.deflateRawSync(data, { level: 9 });
		// 已压缩过的内容（png / jpg / gz / br）deflate 后往往更大，那就原样存
		const useDeflate = deflatedBuf.length < data.length;
		const body = useDeflate ? deflatedBuf : data;
		const method = useDeflate ? 8 : 0;
		if (useDeflate) deflated++; else stored++;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);          // version needed
		local.writeUInt16LE(0x0800, 6);      // flag: 文件名为 UTF-8
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);          // extra field length

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);        // version made by
		central.writeUInt16LE(20, 6);        // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);        // extra
		central.writeUInt16LE(0, 32);        // comment
		central.writeUInt16LE(0, 34);        // disk number
		central.writeUInt16LE(0, 36);        // internal attrs
		central.writeUInt32LE(0, 38);        // external attrs
		central.writeUInt32LE(offset, 42);

		locals.push(local, nameBuf, body);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + body.length;
	}

	const centralBuf = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return { buffer: Buffer.concat([...locals, centralBuf, end]), stored, deflated };
}

module.exports = { createZip };
