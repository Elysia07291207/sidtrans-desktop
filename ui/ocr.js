/* 旁译桌面版 · 取字宿主（藏起来的窗口）
 *
 * 这个页面唯一的职责：把 Tesseract 起起来、认字、把结果回给主进程。
 * 参数跟浏览器版一字不差地搬过来了，其中一条是必须的：
 *
 *   workerBlobURL: false
 *   —— Tesseract 默认用 Blob URL 建 Worker，在扩展里会被 CSP 挡掉，
 *      而且报错是 undefined（当时查了很久）。桌面这边虽然不撞 CSP，
 *      但 Worker 从 blob 起会丢源，加载本地核心脚本反而更绕；
 *      统一走真实 URL，行为最可预测。
 *
 * 中文识别会在字之间插空格，这里顺手清掉（跟扩展同一个函数）。
 */

/* 中文识别会在字之间插空格，清理那一步跟主进程/浏览器版共用同一份实现在 lib/ocrtext.js。
   语言列表也从那边来：那里写清了为什么是「先 eng 后 chi_sim」这个顺序。 */
import { tidyOcr, OCR_LANGS } from '../lib/ocrtext.js';

const stateEl = document.getElementById('state');
const ORIGIN = location.origin;

let worker = null;
let booting = null;
let progress = '';

function setState(t) { stateEl.textContent = t; }

function boot() {
  if (worker) return Promise.resolve(worker);
  if (booting) return booting;
  booting = (async () => {
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract 没加载上（vendor/tesseract/tesseract.min.js 不在？）');
    }
    const w = await Tesseract.createWorker(OCR_LANGS, 1, {
      workerPath: ORIGIN + '/vendor/tesseract/worker.min.js',
      corePath: ORIGIN + '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: ORIGIN + '/vendor/tesseract/lang',
      gzip: true,
      workerBlobURL: false,
      logger: (m) => {
        if (!m) return;
        progress = m.status || '';
        if (m.status === 'recognizing text' && m.progress != null) {
          progress = '认字 ' + Math.round(m.progress * 100) + '%';
        }
        setState(progress);
      }
    });
    worker = w;
    booting = null;
    setState('取字引擎就绪');
    window.st.ocrStatus('ready');
    return w;
  })().catch(e => {
    booting = null;
    worker = null;
    setState('取字引擎起不来：' + ((e && e.message) || e));
    window.st.ocrStatus('error', String((e && e.message) || e));
    throw e;
  });
  return booting;
}

window.st.onOcrRun(async (m) => {
  if (!m || m.id == null) return;
  try {
    const w = await boot();
    const r = await w.recognize(m.image);
    const text = tidyOcr(r && r.data && r.data.text);
    const conf = r && r.data && isFinite(r.data.confidence) ? Number(r.data.confidence) : null;
    window.st.ocrResult({ id: m.id, ok: true, text, conf, langs: OCR_LANGS.join(',') });
  } catch (e) {
    window.st.ocrResult({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
});

boot().catch(() => {});
