/* 旁译桌面版 · 框选遮罩
 *
 * 这里显示的是**已经拍好的那张屏**（冻住的画面），不是透明层。
 * 所以框的时候画面不会动，也不会出现「把遮罩自己拍进去」那种事。
 * 报出去的坐标是这块屏幕上的逻辑坐标——主进程按「图宽 / 逻辑宽」的比例换算成像素。
 */

const shot = document.getElementById('shot');
const veil = document.getElementById('veil');
const box = document.getElementById('box');
const sizeEl = document.getElementById('size');
const hint = document.getElementById('hint');

let displayId = '';
let start = null;
let rect = null;

window.st.onOverlayImage((m) => {
  if (!m) return;
  displayId = m.displayId || '';
  shot.src = m.dataUrl;
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function paint(ev) {
  if (!start) return;
  const x = clamp(Math.min(start.x, ev.clientX), 0, window.innerWidth);
  const y = clamp(Math.min(start.y, ev.clientY), 0, window.innerHeight);
  const w = Math.abs(ev.clientX - start.x);
  const h = Math.abs(ev.clientY - start.y);
  const x2 = clamp(x + w, 0, window.innerWidth);
  const y2 = clamp(y + h, 0, window.innerHeight);
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
    hint.textContent = '框太小了，重新拖一个 · Esc 取消';
    return;
  }
  hint.textContent = '松手了，正在取字…';
  window.st.overlayRegion(rect, displayId);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.st.overlayCancel();
});

window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.st.overlayCancel(); });
