/* 旁译桌面版 · 出图标
 *
 * 自己写像素、自己编码 PNG（node 自带 zlib），不靠截图去生成——
 * 截图出来的到底带不带透明、边缘怎么处理，那样只能猜。这里每个尺寸都能验。
 *
 * 形状沿用浏览器版那枚「一页字」（同一套 32 单位坐标）：
 * 两个产品长得像一家人，托盘里一眼能认出来。4x~8x 超采样做抗锯齿。
 *
 * 用法： node scripts/make_icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'assets');

const WARM = [0x9B, 0x6B, 0x4D];    // 暖褐：纸
const CREAM = [0xFF, 0xF8, 0xF3];  // 奶油白：字

const SHAPES = [
  { x: 4, y: 5, w: 24, h: 22, r: 4.5, color: WARM },
  { x: 9.5, y: 12, w: 13, h: 3, r: 1.5, color: CREAM },
  { x: 9.5, y: 18, w: 8, h: 3, r: 1.5, color: CREAM }
];

function inside(x, y, s) {
  const x1 = s.x + s.w, y1 = s.y + s.h;
  if (x < s.x || x > x1 || y < s.y || y > y1) return false;
  const cx = Math.min(Math.max(x, s.x + s.r), x1 - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), y1 - s.r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= s.r * s.r;
}

function render(px, ss) {
  const rgba = new Uint8Array(px * px * 4);
  const unit = 32 / px;
  const n = ss * ss;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let r = 0, g = 0, b = 0, cov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) * unit;
          const uy = (y + (sy + 0.5) / ss) * unit;
          let col = null;
          for (const s of SHAPES) if (inside(ux, uy, s)) col = s.color;
          if (col) { r += col[0]; g += col[1]; b += col[2]; cov++; }
        }
      }
      const i = (y * px + x) * 4;
      if (cov) {
        rgba[i] = Math.round(r / cov);
        rgba[i + 1] = Math.round(g / cov);
        rgba[i + 2] = Math.round(b / cov);
        rgba[i + 3] = Math.round((cov / n) * 255);
      }
    }
  }
  return rgba;
}

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
function encodePng(px, rgba) {
  const stride = px * 4 + 1;
  const raw = Buffer.alloc(stride * px);
  for (let y = 0; y < px; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * px * 4, px * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const SIZES = [[16, 8], [24, 6], [32, 6], [48, 4], [256, 2]];
for (const [px, ss] of SIZES) {
  const rgba = render(px, ss);
  const buf = encodePng(px, rgba);
  fs.writeFileSync(path.join(OUT, `icon-${px}.png`), buf);
  /* 自检：着色类型必须是 6（RGBA=带透明通道），四角必须全透明 */
  const colorType = buf[25];
  const corner = [rgba[3], rgba[(px - 1) * 4 + 3], rgba[(px * (px - 1)) * 4 + 3], rgba[(px * px - 1) * 4 + 3]];
  console.log(`${px}px 着色类型=${colorType}${colorType === 6 ? '✓' : '✗'} 四角alpha=${corner.join(',')}${corner.every(v => v === 0) ? ' ✓' : ' ✗'} ${buf.length}B`);
}
/* 托盘与窗口默认读这两个名字，省得各处写尺寸 */
fs.copyFileSync(path.join(OUT, 'icon-32.png'), path.join(OUT, 'icon.png'));
console.log('写到 ' + OUT);
