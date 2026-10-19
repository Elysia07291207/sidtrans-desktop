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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { createStore } from './lib/store.js';
import { createEngine, DEFAULT_SETTINGS, detectLang } from './lib/engine.js';
import { createClipWatcher, SKIP_TEXT, looksLikeSecret } from './lib/clipwatch.js';
import { createOcrHost } from './lib/ocr.js';
import { createCapture } from './lib/capture.js';
import { createPickHelper } from './lib/pickhelper.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'sidtrans';
const APP_ORIGIN = SCHEME + '://app';
const pageUrl = (p) => APP_ORIGIN + '/' + p;
const PRELOAD = path.join(ROOT, 'ui', 'preload.cjs');
const IS_SMOKE = process.argv.some(a => a.startsWith('--smoke'));
/* ⚠️ 打包之后，能跑的代码在 asar 里（静态资源通过自定义协议用 fs 读，没问题），
   但 PowerShell 脚本得是**真实路径**——asar 里的东西 PowerShell 读不了。
   所以 tools/ 额外放一份在 resources/ 下（electron-builder 的 extraResources）。 */
const PICK_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'tools', 'pick-helper.ps1')
  : path.join(ROOT, 'tools', 'pick-helper.ps1');

/* 数据目录固定成一个 ASCII 名字，别跟着 productName 走。
   两个理由：① 中文路径在不同工具链里反复出问题（今天 Tesseract 就栽在这上面），
   ② “设置文件到底在哪”这件事不该随 productName 改一个字就搬家。
   必须在使用它之前定下来，所以放在模块顶部。 */
app.setPath('userData', path.join(app.getPath('appData'), 'sidtrans-desktop'));

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

/* 出错记录：只记步骤与错误，不记内容。
   同时落一份到 %APPDATA%\sidtrans-desktop\run.log（滚动，封顶 256KB）：
   从前只往控制台写，结果她那边出了事我什么都看不见——只能靠她复述。
   ⚠️ 只记步骤与计数，**绝不记内容**（不记她翻的是什么、选中了什么）。 */
function log(...a) {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch (e) {}
  try {
    const f = path.join(app.getPath('userData'), 'run.log');
    /* 用本地时间：她跟我对时间对的是墙上那个钟（ISO 是 UTC，看着会差 8 小时） */
    const stamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(f, stamp + ' ' + line + '\n');
    const st = fs.statSync(f);
    if (st.size > 256 * 1024) {
      /* 滚动：只留最后那段，不让她机器上无端长出一个大文件 */
      const keep = fs.readFileSync(f, 'utf8').split('\n').slice(-800).join('\n');
      fs.writeFileSync(f, keep);
    }
  } catch (e) {}
  if (IS_SMOKE) {
    try { fs.appendFileSync(path.join(ROOT, 'test', '_smoke-last.txt'), '     · ' + line + '\n'); } catch (e) {}
  }
}
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
let ocrHost = null, capture = null, pickHelper = null;
let lastPick = '';
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
    /* focusable:false —— 关键：球不能抢焦点。
       否则她点一下球，前台就从她正在看的应用变成我们——
       取词那一刻问「前台控件里选了什么」就问错了对象。
       鼠标事件照常收得到，只是窗口不激活。 */
    focusable: false,
    maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  orbWin.setAlwaysOnTop(true, 'screen-saver');
  orbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  orbWin.loadURL(pageUrl('ui/orb.html'));
  orbWin.once('ready-to-show', () => { try { orbWin.show(); } catch (e) {} });
  /* 兑底：透明窗口的 ready-to-show 在某些版本上不触发（实测遇到过球不出来的情形）。
     过一秒半再看一眼，还没显就手动显——球不出来的话，整个东西就白做了。 */
  setTimeout(() => {
    try { if (orbWin && !orbWin.isDestroyed() && !orbWin.isVisible()) orbWin.show(); } catch (e) {}
  }, 1500);
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
      backgroundThrottling: false,
      /* 面板是程序弹出来的，没有点击手势；不放开这条，落座那一声永远不开声 */
      autoplayPolicy: 'no-user-gesture-required'
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
    sound: s.sound !== false,
    maxLen: s.maxLen,
    clip: Object.assign({}, s.clip),
    shortcuts: Object.assign({}, s.shortcuts),
    orb: Object.assign({}, s.orb),
    pick: Object.assign({}, s.pick),
    openai: { baseUrl: s.openai.baseUrl, model: s.openai.model, prompt: s.openai.prompt, hasKey: !!s.openai.apiKey },
    local: { url: s.local.url }
  };
}

/* ------------------------------------------------------------ 剪贴板路径 */
const watcher = createClipWatcher({
  /* ⚠️ Electron 40+ 的剪贴板读取是异步的（返回 Promise），这里原样交回去，
     由看守 await。当同步用会拿到 [object Promise]——那样的话「复制了字它什么都不做」。 */
  readText: () => {
    try { return clipboard.readText(); } catch (e) { return ''; }
  },
  intervalMs: (store.getSettings().clip && store.getSettings().clip.intervalMs) || 700,
  getOpt: (text) => {
    const s = store.getSettings();
    return {
      auto: !!(s.clip && s.clip.auto),
      paused: !!(s.clip && s.clip.paused),
      minLen: (s.clip && s.clip.minLen) || 2,
      maxLen: (s.clip && s.clip.maxLen) || 2000,
      guard: (s.clip && s.clip.guard !== false),
      /* 判语言要用「刚复制进来的这段」，不是上一次翻过的那段 */
      lang: detectLang(text || '')
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
    /* 已经在框选了就不要再叠一层 */
    if (capture.open) return null;
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

/* ------------------------------------------------------------ 划词即译（取词帮手） */

/* 我们自己的窗口句柄：她要在面板里选字，不该再触发一次翻译 */
function hwndOf(win) {
  try {
    if (!win || win.isDestroyed()) return '';
    const b = win.getNativeWindowHandle();
    return String(b.length >= 8 ? b.readBigInt64LE(0) : b.readInt32LE(0));
  } catch (e) { return ''; }
}
function ourHwnds() {
  return [orbWin, panelWin, settingsWin].map(hwndOf).filter(Boolean);
}

function onPickEvent(ev) {
  if (!ev) return;
  if (ev.t === 'ready') {
    log('[取词] 帮手就绪 pid=' + ev.pid + ' 方式=' + ev.method
      + (ev.needKey ? ' 需按住 ' + ev.needKey : '') + (ev.skipApps ? ' 跳过 ' + ev.skipApps : ''));
    return;
  }
  if (ev.t === 'err') { log('[取词] 帮手报错：' + ev.msg); return; }
  if (ev.t !== 'sel') return;

  const s = store.getSettings();
  const p = s.pick || {};
  const text = String(ev.text == null ? '' : ev.text).trim();
  if (!text) {
    /* 拖选没取到也要记一笔：不然日志里只有成功的记录，看不出「这个应用到底行不行」 */
    log('[取词] 拖选没取到（uia=' + (ev.uia || '-') + ' 复制=' + (ev.chord || '无') + ' 前台=' + (ev.app || '?') + '）');
    return;
  }
  if (ourHwnds().indexOf(String(ev.hwnd)) !== -1) return;  /* 在我们自己的窗口里选的，不管 */
  if (text.length < (p.minLen || 3)) return;
  if (text.length > (p.maxLen || 2000)) { toastOrb('这段太长，划词没取（按 Ctrl+Alt+T 手动翻）'); return; }
  if (text === lastPick) return;                        /* 同一段不重复翻 */
  if (p.guard !== false && looksLikeSecret(text)) { toastOrb('这段像密钥/令牌，我没翻'); return; }

  lastPick = text;
  log('[取词] 取到 ' + text.length + ' 字（' + (ev.how || '?') + ' · ' + (ev.app || '?') + ' · ' + ev.ms + 'ms'
    + (ev.restored ? ' · 剪贴板已还原' : '') + '）');
  translateAndShow(text, { source: '划词' });
}

/* 手动试一次：拿当前前台应用读一次选中，把结果说出来。

   ⚠️ 这个入口踩过一个坑：点托盘菜单那一瞬间，前台窗口会变成旁译自己，
   于是它去问「旁译的窗口里选了什么」——当然什么都没有。她的日志里就是三条
   「前台=electron」。所以现在改成：**先给她 3 秒去切回目标应用选好字**，
   再读；而且结果写进面板（看得见、留得住），不再只靠一个 2.2 秒的小气泡。 */
/* 取词失败时把「到底哪一种」说清楚。
   之前只说「没读到选中」，她分不清是「自己没选中」还是「这个应用读不到」——
   这两件事该怎么办完全不同，所以得分开说。 */
function pickFailReason(r) {
  const parts = [];
  if (r.uia === 'no-pattern') parts.push('· 直接读选中：这个控件不支持读选中（浏览器、自绘界面多是这类）');
  else if (r.uia === 'no-sel') parts.push('· 直接读选中：支持，但当时没有选中内容');
  else if (r.uia === 'err') parts.push('· 直接读选中：接口报错');
  if (r.chord) parts.push('· 复制读剪贴板：' + r.chord + ' 复制到了东西，但里面没有文字（像是图片或文件）');
  else parts.push('· 复制读剪贴板：Ctrl+C 和 Ctrl+Insert 都按了，剪贴板没动静');
  return parts.join('\n');
}

async function tryOnePick() {
  try {
    hidePanel();                                  /* 面板可能挡着她要看的东西 */
    toastOrb('3 秒后取词：切到目标应用，选中一段字');
    await new Promise(r => setTimeout(r, 3000));
    toastOrb('读一次…');

    const out = execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass',
      '-File', PICK_SCRIPT, '-Once', '-Method', 'auto', '-Handle', '0'],
      { encoding: 'utf8', timeout: 25000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const lines = String(out || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    let r = null;
    try { r = JSON.parse(lines[lines.length - 1]); } catch (e) {}

    if (!r || r.t !== 'sel') {
      log('[取词] 试一次：没回话 ' + (lines.slice(-1)[0] || ''));
      toastOrb('取词没回话');
      showPanel({ text: '', result: { ok: false, mode: 'translate', error: '取词测试：帮手没回话。日志里有记录。' } });
      return;
    }

    const text = String(r.text || '').trim();
    log('[取词] 试一次：' + (text ? ('取到 ' + text.length + ' 字，走 ' + r.how)
      : ('没取到（uia=' + (r.uia || '-') + ' chord=' + (r.chord || '无') + '）'))
      + ' · 前台=' + (r.app || '?') + (r.restored ? ' · 剪贴板已还原' : ''));

    if (!text) {
      toastOrb('没取到字（前台：' + (r.app || '?') + '）');
      /* 写进面板：把「哪一种情况 + 下一步怎么办」说清，而不是只闪一下 */
      const why = pickFailReason(r);
      const hint = (r.uia === 'no-sel' || (!r.chord && r.uia !== 'no-pattern'))
        ? '\n→ 看着像是没选中：把字选好，再点一次这个菜单项。'
        : '\n→ 这个应用两条路都不走。要是它本来就没什么可选的字（游戏、视频播放器这类），那就正常；\n'
          + '　 要试就在真文字上试：浏览器、Word、记事本。——另外，选中 → Ctrl+C 那条旧路一直都能用。';
      showPanel({
        text: '',
        result: {
          ok: false, mode: 'translate',
          error: '取词测试：没读到字。\n当时前台：' + (r.app || '未知') + '\n' + why + hint
        }
      });
      return;
    }

    toastOrb('取到了 ' + text.length + ' 字（' + (r.how === 'uia' ? '直接读选中' : '走剪贴板') + '）');
    translateAndShow(text, { source: '取词试一次' });
  } catch (e) {
    toastOrb('取词试一次失败：' + String((e && e.message) || e).slice(0, 40));
    log('[取词] 试一次出错：' + ((e && e.message) || e));
    showPanel({ text: '', result: { ok: false, mode: 'translate', error: '取词测试失败：' + String((e && e.message) || e) } });
  }
}

function applyPickSetting() {
  const s = store.getSettings();
  const p = s.pick || {};
  if (p.enabled) {
    if (!pickHelper) {
      pickHelper = createPickHelper({
        script: PICK_SCRIPT,
        log: (m) => log(m),
        onEvent: onPickEvent
      });
    }
    if (!pickHelper.running) {
      pickHelper.start({
        method: p.method || 'auto',
        minDrag: p.minDrag != null ? p.minDrag : 6,
        delayMs: p.delayMs != null ? p.delayMs : 150,
        needKey: p.needKey || '',
        skipApps: p.skipApps || 'explorer',
        doubleClick: p.doubleClick !== false
      });
    }
  } else if (pickHelper) {
    pickHelper.stop();
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
    {
      label: '划词即译（实验）', type: 'checkbox', checked: !!(s.pick && s.pick.enabled),
      click: (mi) => {
        store.patchSettings({ pick: { enabled: mi.checked } });
        applyPickSetting();
        refreshTray();
        toastOrb(mi.checked ? '划词即译已开' : '划词即译已关');
      }
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
    applyPickSetting();
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
  ipcMain.on('st:test-pick', () => { tryOnePick(); });
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
   又翻一遍——回环，而且看上去像自己抽风。
   writeText 在各版本里可能是同步也可能返回 Promise，所以 await 一下两种都兼容。 */
async function copyToClipboard(text) {
  const t = String(text == null ? '' : text);
  try {
    await clipboard.writeText(t);
    watcher.rememberOwnWrite(t);
    watcher.lastSeen = t;
    lastClipText = t;
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* 「翻译剪贴板」是明确的手动动作：
   这时候不再问长度、也不再拦密钥——她按了就是她要翻。
   闸门只在自动那条路上生效。 */
async function manualFromClipboard() {
  let t = '';
  try { t = (await clipboard.readText()) || ''; } catch (e) {}
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
  bind((s.shortcuts || {}).shot, () => {
    /* 出口五：框选遮罩开着的时候，再按一次这个快捷键 = 取消。
       键盘焦点万一不在遮罩上，她还有这个办法脱身。 */
    if (capture && capture.open) { capture.cancel(); toastOrb('已取消框选'); return; }
    shotAndOcr();
  }, 'shot');
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
    /* ⚠️ 这个 preload 必须传。漏了的话遮罩里的 window.st 不存在：
       照片送不进来（黑屏）、ESC 也报不出来（按了没反应）。 */
    preload: PRELOAD,
    log: (m) => log(m),
    onBeforePick: () => hidePanel()
  });

  registerIpc();
  createOrb();
  createTray();
  rebindShortcuts();
  applyPickSetting();
  /* 启动时先把剪贴板「当前的内容」记为已看过。
     不然第一次轮询会把她启动前就放在剪贴板里的东西当成「新内容」翻一遍，
     面板会凭空弹出来——而那不是她此刻的动作。只该翻「启动之后她新复制的」。 */
  try {
    const seed = (await clipboard.readText()) || '';
    watcher.lastSeen = seed;
    lastClipText = String(seed).trim();
    log('[剪贴板] 起手记住现有内容 ' + String(seed).length + ' 字（不会自动翻它）');
  } catch (e) {}
  watcher.start();

  /* OCR 引擎在后台悄悄预热：第一次真要取字时就不用等模型加载 */
  setTimeout(() => { ocrHost.warmup(); }, 2500);

  if (IS_SMOKE) {
    const { runSmoke } = await import('./test/smoke.js');
    const code = await runSmoke({
      app, store, engine, ocrHost, capture, watcher,
      get orbWin() { return orbWin; },
      get panelWin() { return panelWin; },
      showPanel, hidePanel, translateAndShow, manualFromClipboard, shotAndOcr, tryOnePick, applyPickSetting,
      /* 自检要用它：开发时是项目里的那份，打包后在 resources 下 */
      PICK_SCRIPT,
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
  try { pickHelper && pickHelper.stop(); } catch (e) {}
  try { ocrHost && ocrHost.destroy(); } catch (e) {}
  try { capture && capture.reset(); } catch (e) {}
});
