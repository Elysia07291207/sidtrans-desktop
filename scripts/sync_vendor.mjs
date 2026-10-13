/* 旁译桌面版 · 把 OCR 依赖搬进 vendor/
 *
 * OCR 那套东西（Tesseract 的 JS + wasm 核心 + 中英训练数据）体积十几兆，
 * 不该进仓库。所以：依赖走 npm 装，这个脚本负责从 node_modules 里
 * 把「运行时真正要加载的那几个文件」搬到 vendor/tesseract/。
 * vendor/ 在 .gitignore 里，跟浏览器版把 lang/ 排除在外是同一个道理。
 *
 * 用法：
 *   node scripts/sync_vendor.mjs          # 拷贝（缺什么补什么）
 *   node scripts/sync_vendor.mjs --check  # 只检查，不写；缺文件就退出非 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'vendor', 'tesseract');
const CHECK = process.argv.includes('--check');

/* 每一项：[源，目标相对路径]。
   目标路径必须跟 ui/ocr.js 里写的三处（workerPath / corePath / langPath）对得上。 */
const FILES = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz', 'lang/chi_sim.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz']
];

let missing = 0, copied = 0, ok = 0;

for (const [src, rel] of FILES) {
  const from = path.join(NM, src);
  const to = path.join(OUT, rel);
  if (!fs.existsSync(from)) {
    console.log('✗ 依赖不在：' + src + '（先 npm install）');
    missing++;
    continue;
  }
  const size = fs.statSync(from).size;
  if (CHECK) {
    if (fs.existsSync(to) && fs.statSync(to).size === size) { ok++; console.log('✓ ' + rel + '  ' + size + 'B'); }
    else { missing++; console.log('✗ ' + rel + ' 缺失或大小不符（源 ' + size + 'B）'); }
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
  console.log('→ ' + rel + '  ' + size + 'B');
}

if (CHECK) {
  console.log(`\nvendor 检查：${ok} 就位 / ${missing} 缺`);
  process.exit(missing ? 1 : 0);
}
console.log(`\n拷贝完成：${copied} 个文件，${missing} 个缺失 → ` + OUT);
process.exit(missing ? 1 : 0);
