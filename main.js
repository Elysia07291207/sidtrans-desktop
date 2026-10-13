/* 旁译桌面版 · SideTrans Desktop
 *
 * 一个脱离浏览器的悬浮球：任意应用里 Ctrl+C，球自己发现剪贴板变了就译；
 * 想要哪块字就拖个框，本地 OCR 取字再译。
 *
 * ⚠️ 先说清楚边界（写在这里是因为这是最容易承诺错的一件事）：
 *   桌面版**做不到**「选中就自动弹」。那需要在每个应用里注入或走无障碍接口，
 *   而这两条路在 Windows 上都覆盖不全（有的应用不给，有的应用给了也不稳）。
 *   所以主路径是剪贴板：零注入、跨应用都行，代价是她得按一下 Ctrl+C。
 *
 * 灵感与交互设计来自 FlashTrans（chai1220/FlashTrans，MIT）——
 * 它的划词即译思路是整个旁译系列的起点，这一版是在它基础上做的桌面实现。
 */

import { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, screen, nativeImage, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { createStore } from './lib/store.js';
import { createEngine, DEFAULT_SETTINGS, detectLang } from './lib/engine.js';
import { createClipWatcher, SKIP_TEXT, looksLikeSecret } from './lib/clipwatch.js';
import { createOcrHost } from './lib/ocr.js';
import { createCapture } from './lib/capture.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'sidtrans';
const APP_ORIGIN = SCHEME + '://app';
const pageUrl = (p) => APP_ORIGIN + '/' + p;
const PRELOAD = path.join(ROOT, 'ui', 'preload.cjs');
const IS_SMOKE = process.argv.some(a => a.startsWith('--smoke'));

/* 自定义协议：给所有窗口一个正常的源。
   这不是花活——Tesseract 的 Worker 在 file:// 下会被浏览器内核挡掉
   （「Script at 'file:///…' cannot be accessed from origin 'null'」），
   扩展那边也遇到过同类的墙。给它们一个标准且安全的源，Worker 才起得来。 */
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false }
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function serveLocal(reqPath) {
  /* 路径穿越挡一下：解析完必须还在项目目录里 */
  const clean = decodeURIComponent(reqPath.split('?')[0].split('#')[0]).replace(/^\/+/, '');
  const abs = path.resolve(ROOT, clean);
  if (!abs.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('not found: ' + clean, { status: 404 });
  const buf = fs.readFileSync(abs);
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    }
  });
}

/* ------------------------------------------------------------ 单实例 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const store = createStore({
  dir: path.join(app.getPath('userData')),
  defaults: DEFAULT_SETTINGS
});

/* 出错记录：只记步骤与错误，不记内容。控制台也打一份，方便我看。 */
function log(...a) { if (!IS_SMOKE) console.log('[旁译桌面版]', ...a); }
const noteFail = (step, detail, extra) => {
  store.noteFail(step, detail, extra);
  if (!IS_SMOKE) console.log('[旁译桌面版·错]', step, detail);
};

const engine = createEngine({
  getSettings: () => store.getSettings(),
  cache: store.cache,
  noteFail,
  fetchImpl: (...a) => globalThis.fetch(...a)
});

let orbWin = null, panelWin = null, tray = null, settingsWin = null;
let ocrHost = null, capture = null;
let lastResult = null;
let lastText = '';
let quitting = false;

/* ------------------------------------------------------------ 悬浮球 */
const ORB_MARGIN = 12;

function createOrb() {
  const s = store.getSettings();
  const size = Math.max(32, Math.min(96, (s.orb && s.orb.size) || 44));
  const box = size + ORB_MARGIN;
  const wa = screen.getPrimaryDisplay().workArea;
  const x = (s.orb && s.orb.x != null) ? s.orb.x : (wa.x + wa.width - box - 24);
  const y = (s.orb && s.orb.y != null) ? s.orb.y : (wa.y + Math.round(wa.height * 0.32));

  orbWin = new BrowserWindow({
    x, y, width: box, height: box,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  orbWin.setAlwaysOnTop(true, 'screen-saver');
  orbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  orbWin.loadURL(pageUrl('ui/orb.html'));
  orbWin.once('ready-to-show', () => orbWin.show());
  orbWin.on('closed', () => { orbWin = null; });

  /* 球挪走了，记住位置；面板跟着它走 */
  orbWin.on('moved', () => { saveOrbPos(); if (panelWin && panelWin.isVisible()) placePanel(); });
}

function saveOrbPos() {
  if (!orbWin || orbWin.isDestroyed()) return;
  const [x, y] = orbWin.getPosition();
  store.patchSettings({ orb: { x, y } });
}

function orbBox() {
  if (!orbWin || orbWin.isDestroyed()) return { x: 0, y: 0, w: 0, h: 0 };
  const b = orbWin.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/* ------------------------------------------------------------ 面板 */
function createPanel() {
  panelWin = new BrowserWindow({
    width: 430, height: 560,
    frame: false, transparent: true, resizable: true, skipTaskbar: true,
    alwaysOnTop: true, show: false, hasShadow: false, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  panelWin.loadURL(pageUrl('ui/panel.html'));
  panelWin.on('closed', () => { panelWin = null; });
  panelWin.on('blur', () => { /* 不自动关：她可能要点别的地方对照着看 */ });
}

/* 面板贴在球旁边；右边放不下就翻到左边；上下夹进工作区 */
function placePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  const box = orbBox();
  const pb = panelWin.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: box.x, y: box.y });
  const wa = disp.workArea;
  let x = box.x + box.w + 8;
  if (x + pb.width > wa.x + wa.width) x = box.x - pb.width - 8;
  if (x < wa.x) x = Math.min(wa.x + 8, wa.x + wa.width - pb.width - 8);
  let y = box.y;
  if (y + pb.height > wa.y + wa.height) y = wa.y + wa.height - pb.height - 8;
  if (y < wa.y) y = wa.y + 8;
  panelWin.setPosition(Math.round(x), Math.round(y));
}

function showPanel(payload) {
  if (!panelWin || panelWin.isDestroyed()) createPanel();
  if (payload) {
    if (payload.text != null) lastText = String(payload.text);
    if (payload.result != null) lastResult = payload.result;
  }
  const send = () => {
    if (!panelWin || panelWin.isDestroyed()) return;
    panelWin.webContents.send('st:show', {
      text: lastText,
      result: lastResult,
      settings: publicSettings()
    });
  };
  if (panelWin.webContents.isLoading()) panelWin.webContents.once('did-finish-load', send);
  else send();
  placePanel();
  panelWin.show();
  panelWin.setAlwaysOnTop(true, 'screen-saver');
}

function hidePanel() { if (panelWin && !panelWin.isDestroyed()) panelWin.hide(); }

function togglePanel() {
  if (panelWin && panelWin.isVisible()) hidePanel();
  else showPanel();
}

/* ------------------------------------------------------------ 设置快照（给界面用，key 不外传） */
function publicSettings() {
  const s = store.getSettings();
  return {
    engine: s.engine,
    targetMode: s.targetMode,
    actionMode: s.actionMode,
    answerExplain: s.answerExplain,
    transStyle: s.transStyle,
    panelTheme: s.panelTheme,
    maxLen: s.maxLen,
    clip: Object.assign({}, s.clip),
    shortcuts: Object.assign({}, s.shortcuts),
    orb: Object.assign({}, s.orb),
    openai: { baseUrl: s.openai.baseUrl, model: s.openai.model, prompt: s.openai.prompt, hasKey: !!s.openai.apiKey },
    local: { url: s.local.url }
  };
}

/* ------------------------------------------------------------ 剪贴板路径 */
const watcher = createClipWatcher({
  readText: () => {
    try { return clipboard.readText() || ''; } catch (e) { return ''; }
  },
  intervalMs: (store.getSettings().clip && store.getSettings().clip.intervalMs) || 700,
  getOpt: () => {
    const s = store.getSettings();
    const t = lastClipText;
    return {
      auto: !!(s.clip && s.clip.auto),
      paused: !!(s.clip && s.clip.paused),
      minLen: (s.clip && s.clip.minLen) || 2,
      maxLen: (s.clip && s.clip.maxLen) || 2000,
      guard: (s.clip && s.clip.guard !== false),
      lang: detectLang(t)
    };
  },
  onDecide: (d, text) => { onClipDecision(d, text); }
});

let lastClipText = '';
let orbToastTimer = null;

function onClipDecision(d, text) {
  if (d.action === 'skip') {
    const msg = SKIP_TEXT[d.reason];
    if (msg) toastOrb(msg);
    return;
  }
  lastClipText = String(text).trim();
  translateAndShow(lastClipText, { source: '剪贴板' });
}

function toastOrb(msg) {
  if (!orbWin || orbWin.isDestroyed()) return;
  orbWin.webContents.send('st:toast', msg);
  clearTimeout(orbToastTimer);
  orbToastTimer = setTimeout(() => {
    if (orbWin && !orbWin.isDestroyed()) orbWin.webContents.send('st:toast', '');
  }, 2200);
}

/* ------------------------------------------------------------ 一次翻译 */
let translating = false;

async function translateAndShow(text, opt = {}) {
  const s = store.getSettings();
  const mode = opt.mode || s.actionMode || 'translate';
  const t = String(text || '').slice(0, 20000);
  if (!t.trim()) {
    lastResult = { ok: false, error: '没有内容可翻', mode, text: '' };
    showPanel({ text: t, result: lastResult });
    return lastResult;
  }
  lastText = t;
  translating = true;
  /* 先亮出来一行「正在翻」，不让她对着空面板猜 */
  showPanel({ text: t, result: { ok: false, pending: true, mode, dir: opt.source || '' } });
  try {
    const r = await engine.translate(t, { mode, explain: opt.explain || store.getSettings().answerExplain === 'on' ? 1 : 0 });
    lastResult = Object.assign({ mode, source: opt.source || '' }, r);
  } catch (e) {
    noteFail(opt.source || 'translate', String((e && e.message) || e), { mode });
    lastResult = { ok: false, mode, error: engine.humanEngineError(e, mode), source: opt.source || '' };
  }
  translating = false;
  showPanel({ text: t, result: lastResult });
  return lastResult;
}

/* ------------------------------------------------------------ 截屏取字 */
async function shotAndOcr() {
  try {
    const got = await capture.pick();
    if (!got || got.kind === 'cancel') return null;
    if (got.kind === 'timeout') { toastOrb('框选等太久了，重来一次吧'); return null; }
    if (got.kind === 'too-small') { toastOrb('这个框太小了，字取不出来'); return null; }
    toastOrb('认字中…');
    const r = await ocrHost.ocrImage(got.dataUrl);
    const text = String(r.text || '').trim();
    lastResult = Object.assign({}, lastResult || {}, { ocr: { conf: r.conf, diag: got.diag, shot: got.dataUrl } });
    if (!text) {
      lastResult = { ok: false, mode: 'translate', error: '这块里没认出文字。换个再大一点的框试试。', ocr: { conf: r.conf, diag: got.diag, shot: got.dataUrl } };
      showPanel({ text: '', result: lastResult });
      return lastResult;
    }
    toastOrb('');
    return await translateAndShow(text, { source: '截屏取字', ocr: { conf: r.conf, diag: got.diag, shot: got.dataUrl } });
  } catch (e) {
    noteFail('shot', String((e && e.message) || e));
    toastOrb('取字没成：' + String((e && e.message) || e).slice(0, 40));
    return null;
  }
}

/* ------------------------------------------------------------ 托盘 */
function trayMenu() {
  const s = store.getSettings();
  return Menu.buildFromTemplate([
    { label: '旁译桌面版', enabled: false },
    { type: 'separator' },
    { label: '显示 / 隐藏面板', click: () => togglePanel() },
    { label: '翻译剪贴板（' + s.shortcuts.clip + '）', click: () => manualFromClipboard() },
    { label: '截屏取字（' + s.shortcuts.shot + '）', click: () => shotAndOcr() },
    { type: 'separator' },
    {
      label: '剪贴板自动翻译', type: 'checkbox', checked: !!(s.clip && s.clip.auto),
      click: (mi) => { store.patchSettings({ clip: { auto: mi.checked } }); refreshTray(); }
    },
    {
      label: '暂停（临时）', type: 'checkbox', checked: !!(s.clip && s.clip.paused),
      click: (mi) => { store.patchSettings({ clip: { paused: mi.checked } }); toastOrb(mi.checked ? '剪贴板翻译已暂停' : '剪贴板翻译继续'); refreshTray(); }
    },
    {
      label: '躲开密钥/令牌', type: 'checkbox', checked: (s.clip && s.clip.guard !== false),
      click: (mi) => { store.patchSettings({ clip: { guard: mi.checked } }); refreshTray(); }
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

function refreshTray() { if (tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu()); }

function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('旁译桌面版 · SideTrans Desktop');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => togglePanel());
}

/* ------------------------------------------------------------ 设置窗口 */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 720, height: 760, minWidth: 640, minHeight: 520,
    title: '旁译桌面版 · 设置',
    backgroundColor: '#F8F3EB',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL(pageUrl('ui/settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ------------------------------------------------------------ IPC */
function registerIpc() {
  ipcMain.handle('st:get-settings', () => publicSettings());

  ipcMain.handle('st:set-settings', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return publicSettings();
    store.patchSettings(patch);
    rebindShortcuts();
    refreshTray();
    if (orbWin && !orbWin.isDestroyed()) {
      orbWin.webContents.send('st:settings', publicSettings());
      const size = Math.max(32, Math.min(96, (store.getSettings().orb && store.getSettings().orb.size) || 44));
      const box = size + ORB_MARGIN;
      const b = orbWin.getBounds();
      orbWin.setBounds({ x: b.x, y: b.y, width: box, height: box });
    }
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('st:settings', publicSettings());
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('st:settings', publicSettings());
    return publicSettings();
  });

  ipcMain.handle('st:submit', async (_e, p) => {
    p = p || {};
    const r = await translateAndShow(p.text, { mode: p.mode, explain: p.explain, source: p.source || '面板' });
    return r;
  });

  ipcMain.handle('st:copy', (_e, text) => copyToClipboard(text));

  ipcMain.handle('st:ocr', async (_e, dataUrl) => {
    try { return await ocrHost.ocrImage(String(dataUrl || '')); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.on('st:orb-click', () => togglePanel());
  ipcMain.on('st:orb-menu', () => {
    if (tray && !tray.isDestroyed()) tray.popUpContextMenu(trayMenu());
  });
  ipcMain.on('st:orb-drag', (_e, d) => {
    if (!orbWin || orbWin.isDestroyed() || !d) return;
    const [x, y] = orbWin.getPosition();
    orbWin.setPosition(Math.round(x + (d.dx || 0)), Math.round(y + (d.dy || 0)));
  });
  ipcMain.on('st:orb-drag-end', () => saveOrbPos());
  ipcMain.on('st:panel-drag', (_e, d) => {
    if (!panelWin || panelWin.isDestroyed() || !d) return;
    const [x, y] = panelWin.getPosition();
    panelWin.setPosition(Math.round(x + (d.dx || 0)), Math.round(y + (d.dy || 0)));
  });
  ipcMain.on('st:panel-close', () => hidePanel());
  ipcMain.on('st:open-settings', () => openSettings());
  ipcMain.on('st:shot', () => shotAndOcr());
  ipcMain.on('st:translate-clip', () => manualFromClipboard());
  ipcMain.handle('st:clip-state', () => {
    const s = store.getSettings();
    return { auto: !!(s.clip && s.clip.auto), paused: !!(s.clip && s.clip.paused), stats: watcher.stats };
  });
  ipcMain.on('st:open-log', () => {
    if (!settingsWin || settingsWin.isDestroyed()) openSettings();
    settingsWin.webContents.send('st:show-log', store.getLog());
  });
  ipcMain.handle('st:get-log', () => store.getLog());
  ipcMain.handle('st:clear-log', () => { store.clearLog(); return { ok: true }; });
}

/* 往剪贴板写东西（复制译文 / 复制我写的）。
   写的时候必须记一笔：否则看守会以为「剪贴板变新的了」，把刚复制出去的译文
   又翻一遍——回环，而且看上去像自己抽风。 */
function copyToClipboard(text) {
  const t = String(text == null ? '' : text);
  try {
    clipboard.writeText(t);
    watcher.rememberOwnWrite(t);
    watcher.lastSeen = t;
    lastClipText = t;
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* 「翻译剪贴板」是明确的手动动作：
   这时候不再问长度、也不再拦密钥——她按了就是她要翻。
   闸门只在自动那条路上生效。 */
function manualFromClipboard() {
  let t = '';
  try { t = clipboard.readText() || ''; } catch (e) {}
  t = String(t).trim();
  if (!t) { toastOrb('剪贴板里没有文字'); return null; }
  lastClipText = t;
  watcher.lastSeen = t;
  return translateAndShow(t, { source: '剪贴板' });
}

/* ------------------------------------------------------------ 快捷键 */
function rebindShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.getSettings();
  const bind = (acc, fn, name) => {
    if (!acc) return;
    try {
      const ok = globalShortcut.register(acc, fn);
      if (!ok) noteFail('shortcut', '注册失败：' + acc, { name });
    } catch (e) { noteFail('shortcut', String((e && e.message) || e), { name, acc }); }
  };
  bind((s.shortcuts || {}).clip, () => manualFromClipboard(), 'clip');
  bind((s.shortcuts || {}).shot, () => shotAndOcr(), 'shot');
  bind((s.shortcuts || {}).orb, () => {
    if (!orbWin) createOrb();
    else if (orbWin.isVisible()) orbWin.hide();
    else orbWin.show();
  }, 'orb');
}

/* ------------------------------------------------------------ 启动 */
app.on('second-instance', () => { if (orbWin) { orbWin.show(); } });

app.whenReady().then(async () => {
  protocol.handle(SCHEME, (req) => {
    try {
      const u = new URL(req.url);
      return serveLocal(u.pathname);
    } catch (e) { return new Response('bad request', { status: 400 }); }
  });

  ocrHost = createOcrHost({
    pageUrl: pageUrl('ui/ocr.html'),
    preload: PRELOAD,
    log: (m) => log(m)
  });
  capture = createCapture({
    overlayUrl: pageUrl('ui/overlay.html'),
    log: (m) => log(m),
    onBeforePick: () => hidePanel()
  });

  registerIpc();
  createOrb();
  createTray();
  rebindShortcuts();
  watcher.start();

  /* OCR 引擎在后台悄悄预热：第一次真要取字时就不用等模型加载 */
  setTimeout(() => { ocrHost.warmup(); }, 2500);

  if (IS_SMOKE) {
    const { runSmoke } = await import('./test/smoke.js');
    const code = await runSmoke({
      app, store, engine, ocrHost, capture, watcher,
      get orbWin() { return orbWin; },
      get panelWin() { return panelWin; },
      showPanel, hidePanel, translateAndShow, manualFromClipboard, shotAndOcr,
      copyText: copyToClipboard,
      publicSettings, pageUrl, ROOT
    });
    quitting = true;
    app.exit(code);
    return;
  }
});

app.on('window-all-closed', () => { /* 托盘常驻，关窗口不退出 */ });

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { watcher.stop(); } catch (e) {}
  try { ocrHost && ocrHost.destroy(); } catch (e) {}
  try { capture && capture.reset(); } catch (e) {}
});
