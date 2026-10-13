/* 旁译桌面版 · OCR 宿主
 *
 * Tesseract.js 要一个「有 DOM 的上下文」才能起 Worker——这条在扩展那边
 * （MV3 的 service worker 里起不来，得放离屏文档）已经踩过一次。
 * 桌面版同理：主进程没有 DOM，所以我们开一个**藏起来的窗口**当宿主，
 * 主进程只负责递图、拿结果。
 *
 * 对外只有 ocrImage(dataUrl) → { ok, text, conf, langs }，跟浏览器版一致。
 * 参数也一致，其中 workerBlobURL:false 是必须的（见 ui/ocr.js 里的注释）。
 */

import { BrowserWindow, ipcMain } from 'electron';

export function createOcrHost({ pageUrl, preload, log, firstRunTimeoutMs = 90000, runTimeoutMs = 45000 }) {
  let win = null;
  let booting = null;
  let ready = false;
  let seq = 0;
  const pending = new Map();
  const diag = { ok: false, error: null, bootedAt: 0, langs: 'chi_sim,eng', runs: 0 };

  ipcMain.on('ocr-status', (_e, m) => {
    if (!m) return;
    if (m.state === 'ready') {
      ready = true; diag.ok = true; diag.error = null; diag.bootedAt = Date.now();
      log && log('[ocr] 宿主就绪');
    } else if (m.state === 'error') {
      ready = false; diag.ok = false; diag.error = String(m.error || '未知');
      log && log('[ocr] 宿主出错：' + diag.error);
    }
  });

  ipcMain.on('ocr-result', (_e, m) => {
    if (!m || m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'OCR 失败'));
  });

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 480, height: 320,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,   /* 藏起来的窗口别被降频，否则 OCR 会慢到离谱 */
        offscreen: false
      }
    });
    win.on('closed', () => { win = null; ready = false; });
    win.webContents.on('render-process-gone', (_e, d) => {
      win = null; ready = false;
      diag.ok = false; diag.error = 'OCR 宿主进程挂了：' + (d && d.reason);
      log && log('[ocr] ' + diag.error);
    });
    win.loadURL(pageUrl);
    return win;
  }

  function waitReady(timeoutMs) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (ready) { clearInterval(iv); resolve(); return; }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error('OCR 引擎起不来（等了 ' + Math.round(timeoutMs / 1000) + ' 秒）'
            + (diag.error ? '：' + diag.error : '')));
        }
      }, 200);
    });
  }

  async function ocrImage(dataUrl) {
    ensureWindow();
    await waitReady(booting ? firstRunTimeoutMs : firstRunTimeoutMs);
    const id = ++seq;
    const w = ensureWindow();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('OCR 超时（' + Math.round(runTimeoutMs / 1000) + ' 秒没结果）'));
      }, runTimeoutMs);
      pending.set(id, {
        resolve: (m) => { clearTimeout(timer); diag.runs++; resolve({ ok: true, text: m.text, conf: m.conf, langs: m.langs, engine: 'Tesseract(本地)' }); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      w.webContents.send('ocr-run', { id, image: dataUrl });
    });
  }

  function warmup() {
    booting = true;
    try { ensureWindow(); } catch (e) { /* 起不来就算了，第一次真用的时候还会再试 */ }
    return waitReady(firstRunTimeoutMs).catch(() => {});
  }

  function destroy() {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    win = null; ready = false;
  }

  return { ocrImage, warmup, destroy, get diag() { return Object.assign({}, diag); }, get window() { return win; } };
}
