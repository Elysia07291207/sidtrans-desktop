/* 旁译桌面版 · OCR 引擎自检（纯 node，真的跑 Tesseract）
 *
 * 为什么要跑这一条：OCR 是三块里唯一「靠读代码看不出来」的东西——
 * 依赖装没装全、训练数据能不能被读、识别出来到底对不对，只有跑一次才知道。
 *
 * 图的来源是自己画的点阵字（scripts/text_image.mjs）：图里写了什么我确定，
 * 识别结果必须跟它对得上。这是「独立事实源」，不是拿实现证明实现。
 *
 * ⚠️ 这一条验的是**引擎与语言数据**。它不能替 Electron 里那条（藏窗口 + 自定义协议）
 * 作证——那条得在真实桌面环境跑 `npm run smoke`。
 *
 * 用法： node test/ocr_engine.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { textImage } from '../scripts/text_image.mjs';
import { tidyOcr, confNote, OCR_LANGS } from '../lib/ocrtext.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG = path.join(ROOT, 'vendor', 'tesseract', 'lang');

/* 归一化相似度：1 - 编辑距离 / 最长长度。
   拿它当尺子是因为点阵字对 OCR 不友好，个别字母看错是正常的，
   而「引擎没起来 / 语言数据没加载」会让这个数直接掉到 0.2 上下。 */
function similarity(a, b) {
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  if (!m || !n) return 0;
  const d = new Array(n + 1);
  for (let j = 0; j <= n; j++) d[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[n] / Math.max(m, n);
}

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { const e = fn(); pass++; console.log('  ✓ ' + name + (e ? '  ' + e : '')); }
  catch (e) { fail++; failures.push(name + ' → ' + e.message); console.log('  ✗ ' + name + '  → ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

console.log('\n== 旁译桌面版 · OCR 引擎自检 ==\n');

console.log('[1] 中文空格清理（纯逻辑，跟浏览器版同一套规矩）');
{
  t('汉字之间的空格去掉', () => { const r = tidyOcr('网 上 共 青 团 建'); assert(r === '网上共青团建', r); return r; });
  t('英文单词之间的空格留着', () => { assert(tidyOcr('hello   world') === 'hello world'); return 'ok'; });
  t('换行留着，连续空行收到一处', () => { assert(tidyOcr('a\n\n\n\nb') === 'a\n\nb'); return 'ok'; });
  t('中英混排：中文之间收紧、英文不动', () => { const r = tidyOcr('这是 一段 hello world 混排'); assert(r === '这是一段 hello world 混排', r); return r; });
  t('低准度会说出来', () => { assert(confNote(32).indexOf('只能当参考') !== -1); assert(confNote(92).indexOf('参考') === -1); return confNote(92) + ' / ' + confNote(32); });
}

console.log('\n[2] 依赖与语言数据');
{
  t('训练数据在盘上（且不是空的）', () => {
    const files = ['chi_sim.traineddata.gz', 'eng.traineddata.gz'];
    for (const f of files) {
      const p = path.join(LANG, f);
      assert(fs.existsSync(p), '缺 ' + f + '（先跑 npm run vendor）');
      assert(fs.statSync(p).size > 100 * 1024, f + ' 太小，可能是坏的');
    }
    return fs.statSync(path.join(LANG, 'chi_sim.traineddata.gz')).size + 'B + ' + fs.statSync(path.join(LANG, 'eng.traineddata.gz')).size + 'B';
  });

  t('自己画的图，宽高对得上', () => {
    const img = textImage('HELLO 2026', 8);
    assert(img.width > 300 && img.height > 80, '尺寸不对：' + img.width + '×' + img.height);
    assert(img.buffer.slice(0, 4).toString('hex') === '89504e47', '不是 PNG');
    return img.width + '×' + img.height;
  });
}

console.log('\n[3] 真的认一次（Tesseract，本地 WASM）');
{
  const en = textImage('HELLO SIDTRANS 2026', 10);
  /* 中文那张是固定样本：一句真中文 + 一句真英文 + 一个年份（旁译项目里一直拿它当尺子，
     浏览器侧的历史记录是 conf 92）。它同时能验两件事——中文模型在、拉丁字母也没瞎。 */
  const zhPath = path.join(ROOT, 'test', 'fixtures', 'zh.png');
  const t0 = Date.now();
  let worker = null;
  let tmpDir = null;
  try {
    /* node 跑的时候语言数据走本地文件系统，而且它要的是**解压后**的 .traineddata。
       先自己解到临时目录再指过去：验的就是我们 vendor 的那两个文件本身，
       不是路径处理的各种脾气。临时目录用系统 TEMP（纯 ASCII），避开中文路径。 */
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidtrans-tess-'));
    for (const lang of OCR_LANGS) {
      const gz = fs.readFileSync(path.join(LANG, lang + '.traineddata.gz'));
      fs.writeFileSync(path.join(tmpDir, lang + '.traineddata'), zlib.gunzipSync(gz));
    }

    worker = await createWorker(OCR_LANGS, 1, {
      langPath: tmpDir,
      cachePath: tmpDir,
      gzip: false,
      logger: () => {}
    });
    t('引擎起得来（要的两个语言都在）', () => {
      assert(OCR_LANGS.length === 2 && OCR_LANGS.indexOf('eng') !== -1 && OCR_LANGS.indexOf('chi_sim') !== -1,
        '语言列表不对：' + JSON.stringify(OCR_LANGS));
      return OCR_LANGS.join('+') + ' · ' + (Date.now() - t0) + 'ms';
    });

    /* —— 中文图（外部固定样本） —— */
    const rz = await worker.recognize(fs.readFileSync(zhPath));
    const ztext = tidyOcr(rz && rz.data && rz.data.text);
    const zconf = rz && rz.data && rz.data.confidence;
    t('中文图：中文与英文都认得出来', () => {
      if (zconf < 60) throw new Error('准度太低：' + Math.round(zconf));
      assert(ztext.indexOf('你好世界') !== -1, '没认到「你好世界」：' + JSON.stringify(ztext.slice(0, 60)));
      assert(ztext.indexOf('Hello World 2026') !== -1, '没认到英文那半句：' + JSON.stringify(ztext.slice(0, 60)));
      return 'conf=' + Math.round(zconf) + ' · 「' + ztext.replace(/\s+/g, ' ').slice(0, 42) + '」';
    });

    /* —— 英文图（自己画的，独立事实源） —— */
    const re = await worker.recognize(en.buffer);
    const etext = tidyOcr(re && re.data && re.data.text);
    const econf = re && re.data && re.data.confidence;
    t('英文图：跟图里放的字对得上（相似度 ≥ 0.7）', () => {
      const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const sim = similarity(norm(en.text), norm(etext));
      if (sim < 0.7) throw new Error('相似度只有 ' + sim.toFixed(2) + '：' + JSON.stringify(etext.replace(/\s+/g, ' ').slice(0, 50)));
      if (econf < 40) throw new Error('准度太低：' + Math.round(econf));
      return '相似度 ' + sim.toFixed(2) + ' · conf=' + Math.round(econf) + ' · 「' + etext.replace(/\s+/g, ' ').slice(0, 32) + '」';
    });

    console.log('     （两张图跑完 ' + (Date.now() - t0) + 'ms）');
  } catch (e) {
    fail++;
    failures.push('OCR 跑不起来 → ' + ((e && e.message) || e));
    console.log('  ✗ OCR 跑不起来  → ' + ((e && e.message) || e));
  } finally {
    try { if (worker) await worker.terminate(); } catch (e) {}
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

console.log('\n============================');
console.log('OCR 自检：' + pass + ' 通过 / ' + fail + ' 失败\n');
if (fail) failures.forEach(f => console.log('  · ' + f));
process.exit(fail ? 1 : 0);
