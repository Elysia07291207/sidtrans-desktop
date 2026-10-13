/* 旁译桌面版 · 文字图（给自检造「一张有字的图」用）
 *
 * 为什么要自己画字：OCR 的自检需要一个**独立事实源**——
 * 图里写了什么，必须是我放进去的，而不是拿实现去证明实现。
 * 所以这里带一套极小的 5×7 点阵字，把字符串画成一张黑白 PNG。
 * 只包含自检要用的字符，多一个都不写。
 */

import { encodePng } from './lib_png.mjs';

/* 5 列 × 7 行，'1' 是黑 */
const FONT = {
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

/* 把 text 画成 PNG。scale = 一个点阵像素放大到多少设备像素。
   返回 { buffer, width, height, expected: '把空格去掉后的大写原文' } */
export function textImage(text, scale = 10) {
  const up = String(text).toUpperCase();
  const glyphs = up.split('').map(ch => {
    const g = FONT[ch];
    if (!g) throw new Error('点阵字里没有这个字符：' + JSON.stringify(ch));
    return g;
  });

  const GLYPH_W = 5, GLYPH_H = 7, GAP = 1;
  const unitW = glyphs.length * (GLYPH_W + GAP) - GAP;
  const pad = 3;                       /* 留白：贴着边 OCR 容易切边 */
  const width = (unitW + pad * 2) * scale;
  const height = (GLYPH_H + pad * 2) * scale;
  const rgba = new Uint8Array(width * height * 4);

  /* 先铺白 */
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
  }
  const black = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255;
  };

  glyphs.forEach((g, gi) => {
    const ox = (pad + gi * (GLYPH_W + GAP)) * scale;
    const oy = pad * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (g[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            black(ox + col * scale + dx, oy + row * scale + dy);
          }
        }
      }
    }
  });

  return { buffer: encodePng(width, height, rgba), width, height, scale, text: up };
}

/* 自检用：点阵表里到底有哪些字符 */
export const CHARS = Object.keys(FONT).sort().join('');
