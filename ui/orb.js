/* 旁译桌面版 · 悬浮球
 *
 * 一个球要做的事只有三件：被点开面板、被右键出菜单、被拖着走。
 * 拖动是自己算的（不走 -webkit-app-region）——挂了 app-region 的元素
 * 收不到 click，球就点不动了；自己算位移可以同时保住「拖」和「点」。
 */

const ball = document.getElementById('ball');
const toastEl = document.getElementById('toast');

let dragging = false;
let moved = 0;
let lastX = 0, lastY = 0;
let pendingClick = false;

ball.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true; moved = 0;
  lastX = e.screenX; lastY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  if (!dx && !dy) return;
  lastX = e.screenX; lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (moved > 3) {
    if (pendingClick) { clearTimeout(pendingClick); pendingClick = null; }
    window.st.orbDrag(dx, dy);
  }
});

window.addEventListener('mouseup', (e) => {
  if (!dragging || e.button !== 0) return;
  dragging = false;
  if (moved > 3) {
    window.st.orbDragEnd();
    return;
  }
  /* 位移够小才算「点」——手抖一两像素不该被当成拖动，也不该吞掉这一下 */
  pendingClick = setTimeout(() => { pendingClick = null; window.st.orbClick(); }, 40);
});

ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (pendingClick) { clearTimeout(pendingClick); pendingClick = null; }
  window.st.orbMenu();
});

function setToast(t) {
  toastEl.textContent = t || '';
  toastEl.classList.toggle('on', !!t);
}

window.st.onToast((t) => {
  setToast(t);
  if (t) {
    ball.classList.add('busy');
  } else {
    ball.classList.remove('busy');
  }
});

window.st.onShow(() => { ball.classList.add('busy'); });

function paint(s) {
  if (!s) return;
  if (s.orb && s.orb.size) ball.style.setProperty('--size', s.orb.size + 'px');
  ball.classList.toggle('paused', !!(s.clip && (s.clip.paused || !s.clip.auto)));
}

window.st.onSettings(paint);
window.st.getSettings().then(paint);
