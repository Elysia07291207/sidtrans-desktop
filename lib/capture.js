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

export function createCapture({ overlayUrl, preload, log, onBeforePick }) {
  let overlays = [];
  let resolvePick = null;
  let safetyTimer = null;

  function finish(result) {
    if (!resolvePick) return;
    const f = resolvePick;
    resolvePick = null;
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    f(result);
  }

  ipcMain.on('overlay:region', (_e, m) => {
    if (m) finish({ kind: 'region', rect: m.rect, displayId: m.displayId });
  });
  ipcMain.on('overlay:cancel', () => finish({ kind: 'cancel' }));

  function closeOverlays(reason) {
    const list = overlays; overlays = [];
    log('[遮罩] 关窗（' + (reason || '?') + '）共 ' + list.length + ' 个');
    for (const w of list) {
      try { if (!w.isDestroyed()) w.destroy(); } catch (e) {}
    }
  }

  /* 把遮罩收掉，让调用方拿到「取消了」 */
  function cancel(reason) {
    closeOverlays(reason || 'cancel');
    finish({ kind: 'cancel' });
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
          /* ⚠️ 这里必须是真 preload。曾经传成 null，结果遮罩里的 window.st 不存在：
             照片送不进来（黑屏），ESC 也报不出去（按了没反应，只能重启）。 */
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      /* 出口二：键盘事件在**主进程**就能截到，不经渲染侧。
         渲染侧的脚本哪怕挂了，ESC 也一定能退。 */
      w.webContents.on('before-input-event', (ev, input) => {
        if (!input) return;
        if (input.key === 'Escape' || (input.type === 'keyDown' && input.key === 'Esc')) {
          ev.preventDefault();
          cancel('主进程收到 Esc');
        }
      });
      w.webContents.on('render-process-gone', (_e, d) => {
        log('[遮罩] 渲染进程挂了：' + JSON.stringify(d && d.reason));
        cancel('渲染进程挂了');
      });
      /* 遮罩页里的报错平时看不见（它盖着全屏、也没控制台），所以都引到日志里。
         曾经因为页面脚本根本没跑，白白转了两圈才找到。 */
      w.webContents.on('console-message', (_e, level, msg, line, src) => {
        log('[遮罩·控制台] ' + msg + '  (' + src + ':' + line + ')');
      });
      w.webContents.on('did-fail-load', (_e, code, desc, url) => {
        log('[遮罩] 加载失败 ' + code + ' ' + desc + ' ' + url);
      });
      w.webContents.on('preload-error', (_e, p, err) => {
        log('[遮罩] preload 报错 ' + p + ' :: ' + (err && err.message));
      });
      w.webContents.on('did-finish-load', () => log('[遮罩] 页面加载完了'));
      w.loadURL(overlayUrl);
      w.webContents.once('did-finish-load', () => {
        try { w.focus(); } catch (e) {}
        let dataUrl = '';
        try { dataUrl = s.image.toDataURL(); } catch (e) { log('[遮罩] toDataURL 失败：' + e.message); }
        log('[遮罩] 开了 display=' + s.display.id + ' 窗 ' + s.display.bounds.width + '×' + s.display.bounds.height
          + ' 图 ' + s.size.width + '×' + s.size.height + ' dataURL ' + Math.round(dataUrl.length / 1024) + 'KB');
        w.webContents.send('overlay:image', {
          dataUrl: dataUrl,
          displayId: String(s.display.id),
          width: s.display.bounds.width,
          height: s.display.bounds.height
        });
      });
      w.on('closed', () => {
        /* 窗口被别的途径关掉（Alt+F4 等）也要算取消，不能把她挂在这儿 */
        if (overlays.indexOf(w) !== -1) cancel('窗口被关');
      });
      overlays.push(w);
    }

    const pickResult = await new Promise(resolve => {
      resolvePick = resolve;
      /* 出口四：兜底。她可能没拖、也没按 ESC（去看别的东西了）——
         遮罩不能无限期霸着屏幕。90 秒后自己收掉，并说一声。 */
      safetyTimer = setTimeout(() => {
        closeOverlays();
        finish({ kind: 'timeout' });
      }, 90000);
    });
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

  function reset() { cancel(); }

  return {
    pick, reset, cancel,
    get open() { return overlays.length > 0; },
    /* 给自检用：它得能摸到遮罩窗口去验「截图送到没有」「Esc 退不退」 */
    get windows() { return overlays.slice(); }
  };
}
