/* 旁译桌面版 · 框选遮罩
 *
 * 这里显示的是**已经拍好的那张屏**（冻住的画面），不是透明层。
 * 所以框的时候画面不会动，也不会出现「把遮罩自己拍进去」那种事。
 * 报出去的坐标是这块屏幕上的逻辑坐标——主进程按「图宽 / 逻辑宽」的比例换算成像素。
 *
 * ⚠️ 这个窗口会盖住她整个屏幕，所以它必须有好几条退路。
 *    曾经只有一条（渲染侧报「我按了 ESC」），而那个 preload 传错成 null，
 *    结果按 ESC 毫无反应、遮罩收不掉，她只能重启。现在的退路：
 *      1) 主进程的 before-input-event —— 键盘在主进程就能截到，脚本挂了也有效
 *      2) 这里的 ESC 处理（本地 window.close()，不依赖与主进程的通信）
 *      3) 右上角看得见的「取消」按钮
 *      4) 主进程 90 秒兜底自动收掉
 *      5) 再按一次 Ctrl+Alt+S 也会取消（主进程里接的）
 *    所以下面所有跟主进程的通信都写成「能用就用，不能用自己也退得掉」。
 */

const shot = document.getElementById('shot');
const veil = document.getElementById('veil');
const box = document.getElementById('box');
const sizeEl = document.getElementById('size');
const hint = document.getElementById('hint');
const cancelBtn = document.getElementById('cancel');

/* ⚠️ 这里的局部变量不能叫 st：preload 已经用 contextBridge 在 window 上放了一个 st，
   而顶层 `const st` 会与那个不可配置的全局属性撞名——整份脚本第一行就 SyntaxError 挂掉。
   （报错是「Identifier 'st' has already been declared」。后果：图送不进来、ESC 本地退路也不执行，
   看上去就是「黑屏 + 按 ESC 没反应」。） */
const bridge = window.st || {};
let displayId = '';
let start = null;
let rect = null;
let closed = false;

/* 自检指示灯：外面看一眼就知道「桥通不通、图到没到」 */
window.__ov = { stOk: typeof bridge.onOverlayImage === 'function', cancelOk: typeof bridge.overlayCancel === 'function', gotImage: false, imgLen: 0 };

function cancelNow() {
  if (closed) return;
  closed = true;
  try { if (bridge.overlayCancel) bridge.overlayCancel(); } catch (e) {}
  /* 无论上报成没成，窗口自己先关 —— 绝不能让它留在屏幕上 */
  try { window.close(); } catch (e) {}
}

cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelNow(); });

if (bridge.onOverlayImage) {
  bridge.onOverlayImage((m) => {
    if (!m) return;
    displayId = m.displayId || '';
    shot.src = m.dataUrl;
    window.__ov.gotImage = true;
    window.__ov.imgLen = (m.dataUrl || '').length;
  });
} else {
  window.__ov.error = 'window.st.onOverlayImage 不存在（preload 没生效？）';
}

/* 照片没到就别只留一块黑：说清楚，并且确保取消按钮是亮的 */
setTimeout(() => {
  if (!shot.src) {
    hint.textContent = '截图没拿到 · 按 Esc 或点右上角「取消」退出';
    document.body.style.cursor = 'default';
  }
}, 2000);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function paint(ev) {
  if (!start) return;
  const x = clamp(Math.min(start.x, ev.clientX), 0, window.innerWidth);
  const y = clamp(Math.min(start.y, ev.clientY), 0, window.innerHeight);
  const x2 = clamp(Math.max(start.x, ev.clientX), 0, window.innerWidth);
  const y2 = clamp(Math.max(start.y, ev.clientY), 0, window.innerHeight);
  rect = { x, y, w: x2 - x, h: y2 - y };
  box.style.display = 'block';
  box.style.left = rect.x + 'px';
  box.style.top = rect.y + 'px';
  box.style.width = rect.w + 'px';
  box.style.height = rect.h + 'px';
  sizeEl.textContent = Math.round(rect.w) + ' × ' + Math.round(rect.h);
  veil.style.display = 'none';
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target === cancelBtn) return;
  start = { x: e.clientX, y: e.clientY };
  veil.style.display = 'block';
  paint(e);
});

window.addEventListener('mousemove', (e) => { if (start) paint(e); });

window.addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  paint(e);
  start = null;
  if (!rect || rect.w < 8 || rect.h < 8) {
    /* 手滑点了一下不算拖框：清掉，别让她莫名其妙进到一个空选取里 */
    rect = null;
    box.style.display = 'none';
    veil.style.display = 'block';
    hint.textContent = '框太小了，重新拖一个 · Esc 或右上角「取消」退出';
    return;
  }
  hint.textContent = '松手了，正在取字…';
  closed = true;
  try { if (bridge.overlayRegion) bridge.overlayRegion(rect, displayId); } catch (e) {}
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancelNow(); }
});

window.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelNow(); });
