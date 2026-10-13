/* 旁译桌面版 · 截屏取字
 *
 * 做法：**先把屏幕拍下来，再让人在冻住的那张图上框选**。
 *
 * 为什么不「先框选再截屏」：那样遮罩本身会被拍进镜头。浏览器版在这上面
 * 真栽过——浮层是屏幕上最大最清楚的一块字，被拍进去之后 OCR 会把上一轮的
 * 结果再念一遍。冻屏从根上避开这一类问题，而且框的时候画面不会动。
 *
 * 这个文件里有两部分：
 *   · scaleRect() —— 纯算术（逻辑坐标 → 图像像素），能直接拿 node 测；
 *   · createCapture() —— 真正开窗口、截屏、裁切的那部分（要 Electron）。
 */

import { BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage } from 'electron';
import { scaleRect, MIN_REGION } from './geometry.js';

/* 算术在 lib/geometry.js 里（那边不引 electron，能直接拿 node 测）；
   这里把它重新导出一次，调用方不必知道它住在哪。 */
export { scaleRect, MIN_REGION };

export function createCapture({ overlayUrl, log, onBeforePick }) {
  let overlays = [];
  let resolvePick = null;

  ipcMain.on('overlay:region', (_e, m) => {
    if (resolvePick && m) resolvePick({ kind: 'region', rect: m.rect, displayId: m.displayId });
  });
  ipcMain.on('overlay:cancel', () => {
    if (resolvePick) resolvePick({ kind: 'cancel' });
  });

  function closeOverlays() {
    const list = overlays; overlays = [];
    for (const w of list) {
      try { if (!w.isDestroyed()) w.destroy(); } catch (e) {}
    }
  }

  /* 拍下每块屏幕。返回 [{display, image, ratio}] */
  async function grabScreens() {
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map(d => Math.round(d.bounds.width * (d.scaleFactor || 1))));
    const maxH = Math.max(...displays.map(d => Math.round(d.bounds.height * (d.scaleFactor || 1))));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1280, maxW), height: Math.max(720, maxH) }
    });
    return displays.map((d, i) => {
      let src = sources.find(s => String(s.display_id) === String(d.id));
      if (!src) src = sources[i] || sources[0];
      const img = src ? src.thumbnail : null;
      const size = img && !img.isEmpty() ? img.getSize() : { width: 0, height: 0 };
      return {
        display: d,
        image: img,
        ratio: size.width ? size.width / d.bounds.width : (d.scaleFactor || 1),
        size
      };
    });
  }

  /* 打开遮罩，等她拖一个框。返回 {kind:'region', dataUrl, rect, shots} 或 {kind:'cancel'} */
  async function pick() {
    if (onBeforePick) onBeforePick();
    const shots = await grabScreens();
    const usable = shots.filter(s => s.image && !s.image.isEmpty());
    if (!usable.length) throw new Error('截屏没拿到画面（可能是权限或显卡驱动的问题）');

    for (const s of usable) {
      const w = new BrowserWindow({
        x: s.display.bounds.x,
        y: s.display.bounds.y,
        width: s.display.bounds.width,
        height: s.display.bounds.height,
        frame: false,
        transparent: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: null,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.loadURL(overlayUrl);
      w.webContents.once('did-finish-load', () => {
        w.webContents.send('overlay:image', {
          dataUrl: s.image.toDataURL(),
          displayId: String(s.display.id),
          width: s.display.bounds.width,
          height: s.display.bounds.height
        });
      });
      overlays.push(w);
    }

    const pickResult = await new Promise(resolve => {
      resolvePick = resolve;
      /* 兜底：万一渲染侧没回应（比如窗口没起来），别把她挂在这儿 */
      setTimeout(() => { if (resolvePick === resolve) resolve({ kind: 'timeout' }); }, 120000);
    });
    resolvePick = null;
    closeOverlays();

    if (!pickResult || pickResult.kind !== 'region') return pickResult || { kind: 'cancel' };

    const shot = usable.find(s => String(s.display.id) === String(pickResult.displayId)) || usable[0];
    const r = pickResult.rect;
    if (!r || r.w < MIN_REGION || r.h < MIN_REGION) return { kind: 'too-small' };

    const box = scaleRect(r, shot.ratio, shot.size.width, shot.size.height);
    const cropped = shot.image.crop(box);
    return {
      kind: 'region',
      dataUrl: cropped.toDataURL(),
      rect: box,
      region: r,
      display: { id: shot.display.id, w: shot.display.bounds.width, h: shot.display.bounds.height },
      ratio: shot.ratio,
      diag: '截图 ' + shot.size.width + '×' + shot.size.height + ' · 比例 ' + shot.ratio.toFixed(2)
        + ' · 裁 ' + box.width + '×' + box.height
    };
  }

  function reset() { closeOverlays(); if (resolvePick) resolvePick({ kind: 'cancel' }); }

  return { pick, reset, get open() { return overlays.length > 0; } };
}
