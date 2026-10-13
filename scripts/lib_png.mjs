/* 旁译桌面版 · 最小 PNG 编码器（RGBA / 8bit，node 自带 zlib）
 *
 * 抽出来共用：出图标要它，自检里造「一张有字的图」也要它。
 * 为什么自己写而不找个库：这两处都需要「我知道图里每个像素是什么」，
 * 拿一个不受控的生成器反而没法拿它当验证的依据。
 */

import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, c]);
}

/* rgba：Uint8Array 或 Buffer，长度 = w*h*4 */
export function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;   /* filter: none */
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    /* bit depth */
  ihdr[9] = 6;    /* color type 6 = RGBA */
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* 读一张 PNG 的宽高（只解 IHDR，够用来核尺寸） */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504E47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
