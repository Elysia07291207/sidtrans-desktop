/* 旁译桌面版 · 预加载脚本
 *
 * 渲染侧（球 / 面板 / 设置 / 取字宿主 / 框选遮罩）都只能通过这里的 st.* 说话。
 * 保持窄口子：没有 fs、没有 shell、没有任意 ipc 通道名，
 * 将来要把这个外壳交给别人用，也不会因为一处疏忽漏出整台机器。
 */
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => {
  if (typeof cb !== 'function') return;
  ipcRenderer.on(ch, (_e, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('st', {
  /* 主 → 渲染 */
  onShow: (cb) => on('st:show', cb),
  onToast: (cb) => on('st:toast', cb),
  onSettings: (cb) => on('st:settings', cb),
  onLog: (cb) => on('st:show-log', cb),
  onOverlayImage: (cb) => on('overlay:image', cb),

  /* 渲染 → 主（要回值的走 invoke） */
  getSettings: () => ipcRenderer.invoke('st:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('st:set-settings', patch),
  submit: (p) => ipcRenderer.invoke('st:submit', p),
  copy: (text) => ipcRenderer.invoke('st:copy', text),
  ocr: (dataUrl) => ipcRenderer.invoke('st:ocr', dataUrl),
  getLog: () => ipcRenderer.invoke('st:get-log'),
  clearLog: () => ipcRenderer.invoke('st:clear-log'),

  /* 单向动作 */
  orbClick: () => ipcRenderer.send('st:orb-click'),
  orbMenu: () => ipcRenderer.send('st:orb-menu'),
  orbDrag: (dx, dy) => ipcRenderer.send('st:orb-drag', { dx, dy }),
  orbDragEnd: () => ipcRenderer.send('st:orb-drag-end'),
  panelDrag: (dx, dy) => ipcRenderer.send('st:panel-drag', { dx, dy }),
  closePanel: () => ipcRenderer.send('st:panel-close'),
  openSettings: () => ipcRenderer.send('st:open-settings'),
  shot: () => ipcRenderer.send('st:shot'),
  translateClip: () => ipcRenderer.send('st:translate-clip'),

  /* 取字宿主专用 */
  ocrStatus: (state, error) => ipcRenderer.send('ocr-status', { state, error }),
  ocrResult: (m) => ipcRenderer.send('ocr-result', m),
  onOcrRun: (cb) => on('ocr-run', cb),

  /* 框选遮罩专用 */
  overlayRegion: (rect, displayId) => ipcRenderer.send('overlay:region', { rect, displayId }),
  overlayCancel: () => ipcRenderer.send('overlay:cancel')
});
