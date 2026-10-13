/* 旁译桌面版 · 界面自检（Edge 无头，不用 Electron）
 *
 * 为什么要有这一条：Electron 那套冒烟（真窗口、真托盘、真快捷键）在受限环境里跑不动，
 * 而界面逻辑不能因此就「我看过了」。所以把「渲染」单独拉出来验：
 * 用 Edge 无头跑**真实的两份页面**（ui/orb.html、ui/panel.html）——
 * 不是另抄一份，是把它们取下来注进页面，再配一个桩 window.st。
 *
 * 结果怎么收回来：**不读 Edge 的 stdout**（这台机器上 --dump-dom 一个字节都不吐，
 * 实测过），改成页面自己 POST 回本地服务。收不到报告就报「收不到」，不假装通过。
 *
 * 它不能替 Electron 那条作证：真窗口、托盘、快捷键、剪贴板、取字宿主仍须在真实桌面跑
 * `npm run smoke`。这里验的是「控件与状态接得对不对」。
 *
 * 用法： node test/render_check.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
];
const PORT = 8793;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gz': 'application/gzip'
};

/* 桩 window.st：把主进程那一侧换成一个可编程的假货，
   页面里的面板/球用的是同一份真代码。 */
const STUB = `
window.__st = { submits: [] };
window.st = {
  onShow: function (cb) { window.st._show = cb; },
  onToast: function (cb) { window.st._toast = cb; },
  onSettings: function (cb) { window.st._settings = cb; },
  getSettings: async function () { return {
    engine: 'openai', targetMode: 'auto', actionMode: 'translate', answerExplain: 'off',
    transStyle: 'daily', panelTheme: 'light', openai: {}, local: {},
    clip: { auto: true, paused: false }, orb: { size: 44 }, shortcuts: {} }; },
  setSettings: async function (p) { return Object.assign({
    engine: 'openai', targetMode: 'auto', actionMode: 'translate', answerExplain: 'off',
    transStyle: 'daily', panelTheme: 'light', clip: {}, orb: {}, shortcuts: {} }, p); },
  submit: async function (p) {
    window.__st.submits.push(p);
    return { ok: true, mode: p.mode, translated: '[桩] ' + p.text, dir: '英 → 中', engine: 'stub', ms: 1 };
  },
  copy: async function () { return { ok: true }; },
  getLog: async function () { return []; }, clearLog: async function () { return { ok: true }; },
  ocr: async function () { return { ok: true, text: '', conf: 0 }; },
  openSettings: function () {}, closePanel: function () {}, shot: function () {}, translateClip: function () {},
  orbClick: function () {}, orbMenu: function () {}, orbDrag: function () {}, orbDragEnd: function () {},
  panelDrag: function () {}, ocrStatus: function () {}, ocrResult: function () {},
  onOcrRun: function () {}, onOverlayImage: function () {}, overlayRegion: function () {},
  overlayCancel: function () {}, onLog: function () {}
};
window.pushShow = function (p) { if (window.st._show) window.st._show(p); };
window.pushToast = function (t) { if (window.st._toast) window.st._toast(t); };
`;

/* 页面里真正跑的断言。
   ⚠️ 这里面**不写正则、不写反斜杠**：上一次就是被 `\\/` 坑了——
   它在模板字符串里逃成一个没被转义的斜杠，正则字面量提前收尾，
   整个内联脚本变成语法错误，于是「一条都没跑、也一条都没报」。
   拆字符串用 indexOf/split，比拼命数反斜杠可靠。 */
const CHECKS = `
const OUT = document.getElementById('out');
let pass = 0, fail = 0, reported = false;
function ok(n, extra) { pass++; OUT.textContent += '  ✓ ' + n + (extra ? '  ' + extra : '') + '\\n'; }
function bad(n, why) { fail++; OUT.textContent += '  ✗ ' + n + '  → ' + why + '\\n'; }
function t(n, fn) { try { var e = fn(); ok(n, e); } catch (e) { bad(n, (e && e.message) || e); } }
async function ta(n, fn) { try { var e = await fn(); ok(n, e); } catch (e) { bad(n, (e && e.message) || e); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function need(c, m) { if (!c) throw new Error(m); }

/* 取出两个标记之间的内容（不写正则） */
function between(s, a, b) {
  const i = s.indexOf(a);
  if (i < 0) throw new Error('找不到 ' + a);
  const j = s.indexOf(b, i + a.length);
  if (j < 0) throw new Error('找不到 ' + b);
  return s.slice(i + a.length, j);
}

/* 只去掉那一条会砸到测试页自身的 html,body 重置（它带 overflow:hidden，
   会把输出剪没）。#ball / .st-* 这些真正的被验对象一个字节没动。 */
function stripGlobal(css) {
  const i = css.indexOf('html, body');
  if (i < 0) return css;
  const j = css.indexOf('}', i);
  return j < 0 ? css : css.slice(0, i) + css.slice(j + 1);
}

function report() {
  if (reported) return;
  reported = true;
  OUT.textContent += '\\n== 界面自检：' + pass + ' 通过 / ' + fail + ' 失败 ==\\n';
  fetch('/report', { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: OUT.textContent });
}

async function loadScript(src) {
  await new Promise(function (r, j) {
    const s = document.createElement('script');
    s.src = src;
    s.onload = r;
    s.onerror = function () { j(new Error('脚本没加载上：' + src)); };
    document.head.appendChild(s);
  });
}

async function main() {
  /* ---------- 球 ---------- */
  const orbHtml = await (await fetch('/ui/orb.html')).text();
  const orbStyle = stripGlobal(between(orbHtml, '<style>', '</style>'));
  const orbBody = between(orbHtml, '<body>', '</body>');
  const orbHost = document.createElement('div');
  orbHost.className = 'host';
  orbHost.innerHTML = '<style>' + orbStyle + '</style>' + orbBody;
  document.body.appendChild(orbHost);
  await loadScript('/ui/orb.js');
  await sleep(60);

  t('球：是个正圆、上面有字', function () {
    const b = document.getElementById('ball');
    need(b, '没有 #ball');
    const cs = getComputedStyle(b);
    need(cs.borderTopLeftRadius === '50%', '不是圆的：' + cs.borderTopLeftRadius);
    need(b.textContent.trim().length > 0, '球上没有字');
    return cs.width + ' · ' + b.textContent.trim();
  });

  await ta('球：提示条能亮能灭', async function () {
    window.pushToast('这段像密钥/令牌，我没翻');
    await sleep(30);
    const el = document.getElementById('toast');
    need(el.classList.contains('on'), '提示没亮');
    need(el.textContent.indexOf('密钥') !== -1, '文案不对：' + el.textContent);
    window.pushToast('');
    await sleep(30);
    need(!el.classList.contains('on'), '提示没灭');
    return 'ok';
  });

  /* ---------- 面板 ---------- */
  const panelHtml = await (await fetch('/ui/panel.html')).text();
  const panelCss = stripGlobal(await (await fetch('/ui/panel.css')).text());
  const wrapInner = between(panelHtml, '<div id="wrap">', '<script');
  document.body.insertAdjacentHTML('beforeend', '<style>' + panelCss + '</style><div id="wrap">' + wrapInner + '</div>');
  await loadScript('/ui/panel.js');
  await sleep(80);

  t('面板：首屏不是空的（先告诉她怎么用）', function () {
    const d = document.querySelector('.st-dst');
    need(d && d.textContent.trim().length > 0, '首屏是空的');
    return '「' + d.textContent.trim().slice(0, 18) + '…」';
  });

  await ta('面板：译文在前、原文在后，引擎与耗时也显示', async function () {
    window.pushShow({ text: 'Hello world', result: { ok: true, mode: 'translate', translated: '你好，世界', dir: '英 → 中', engine: 'stub', ms: 12 } });
    await sleep(60);
    const dst = document.querySelector('.st-dst');
    const src = document.querySelector('.st-src');
    const status = document.querySelector('.st-status');
    need(dst.textContent === '你好，世界', '译文不对：' + dst.textContent);
    need(src.textContent === 'Hello world', '原文不对：' + src.textContent);
    need(status.textContent.indexOf('12ms') !== -1, '耗时没显示：' + status.textContent);
    need(status.textContent.indexOf('stub') !== -1, '引擎名没显示：' + status.textContent);
    const resSec = document.querySelector('.st-res-sec');
    need(resSec.compareDocumentPosition(src.closest('.st-sec')) & Node.DOCUMENT_POSITION_FOLLOWING, '结果区该排在原文前面');
    return 'ok';
  });

  await ta('面板：切到做题 → 答案大号字、没把握的空另说一句', async function () {
    document.querySelector('.st-mode[data-mode="answer"]').click();
    await sleep(40);
    need(document.querySelector('.st-panel').getAttribute('data-mode') === 'answer', '模式没切');
    window.pushShow({ text: '1. A 2. B', result: { ok: true, mode: 'answer', answer: 'BDACA CADCB\\nu 3', dir: '答题' } });
    await sleep(60);
    const d = document.querySelector('.st-dst');
    need(d.className.indexOf('is-answer') !== -1, '没换成答案样式：' + d.className);
    need(d.textContent.indexOf('BDACA') !== -1, '答案不对：' + d.textContent);
    need(parseFloat(getComputedStyle(d).fontSize) >= 20, '答案字号没放大：' + getComputedStyle(d).fontSize);
    const pend = document.querySelector('.st-pending').textContent;
    need(pend.indexOf('没把握') !== -1, '没把握的空没提示：' + pend);
    return getComputedStyle(d).fontSize + ' · ' + pend;
  });

  await ta('面板：做题的解析单独一段，不抢答案那一眼', async function () {
    window.pushShow({ text: 'q', result: { ok: true, mode: 'answer', answer: 'AB\\nu\\n解析：\\n1. 选 A。看搭配。', dir: '答题' } });
    await sleep(60);
    const ex = document.querySelector('.st-explain');
    need(ex, '解析没渲染出来');
    need(ex.textContent.indexOf('选 A') !== -1, '解析内容不对：' + ex.textContent);
    need(parseFloat(getComputedStyle(ex).fontSize) < 20, '解析不该用答案那号大字');
    return getComputedStyle(ex).fontSize;
  });

  await ta('面板：术语三行拆得开（译法单独一行、放大）', async function () {
    document.querySelector('.st-mode[data-mode="term"]').click();
    await sleep(40);
    window.pushShow({
      text: '全过程人民民主',
      result: { ok: true, mode: 'term', answer: '译法：whole-process democracy\\n备选：whole-process democracy / people\\u2019s democracy\\n说明：指民主贯穿决策到监督的全链条。', dir: '术语' }
    });
    await sleep(60);
    const big = document.querySelector('.st-tterm .st-tv');
    const rows = Array.prototype.slice.call(document.querySelectorAll('.st-trow .st-tx')).map(function (e) { return e.textContent; });
    need(big, '译法行没有');
    need(big.textContent.indexOf('whole-process') !== -1, '译法不对：' + JSON.stringify(big.textContent));
    need(document.querySelectorAll('.st-tterm').length === 1, '术语块叠了 ' + document.querySelectorAll('.st-tterm').length + ' 个（重画没清干净）');
    need(parseFloat(getComputedStyle(big).fontSize) >= 18, '译法没放大：' + getComputedStyle(big).fontSize);
    need(rows.length >= 2, '备选/说明没拆出来：' + JSON.stringify(rows));
    return rows.length + ' 行';
  });

  await ta('面板：失败了要说人话（红字 + 原因）', async function () {
    document.querySelector('.st-mode[data-mode="translate"]').click();
    await sleep(40);
    window.pushShow({ text: 'x', result: { ok: false, mode: 'translate', error: 'API 账户余额不足（402）。去服务商那边充值。' } });
    await sleep(60);
    const d = document.querySelector('.st-dst');
    need(d.className.indexOf('is-error') !== -1, '没换成报错样式：' + d.className);
    need(d.textContent.indexOf('余额不足') !== -1, '文案不对：' + d.textContent);
    return 'ok';
  });

  await ta('面板：取字那一块会显示（图 + 准度）', async function () {
    window.pushShow({
      text: '识别的字',
      result: { ok: true, mode: 'translate', translated: 't', dir: '中 → 英', ocr: { conf: 92, diag: '截图 1920×1080 · 裁 200×80', shot: 'data:image/png;base64,iVBORw0KGgo=' } }
    });
    await sleep(60);
    const sec = document.querySelector('.st-shot-sec');
    need(sec.classList.contains('on'), '取字块没显示');
    const info = document.querySelector('.st-shotinfo').textContent;
    need(info.indexOf('92') !== -1, '准度没显示：' + info);
    need(info.indexOf('截图') !== -1, '诊断信息没显示：' + info);
    return info;
  });

  await ta('面板：写作框 Ctrl+Enter 按当前模式处理', async function () {
    const box = document.querySelector('.st-input');
    box.value = '框里的字也要能翻';
    const before = window.__st.submits.length;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await sleep(80);
    need(window.__st.submits.length > before, '没提交');
    const last = window.__st.submits[window.__st.submits.length - 1];
    need(last.text === '框里的字也要能翻', '提交的文本不对：' + last.text);
    return '提交了 ' + last.mode;
  });

  await ta('面板：暗色主题只换颜色、不动字号', async function () {
    const p = document.querySelector('.st-panel');
    const lightBg = getComputedStyle(p).backgroundColor;
    const lightFs = getComputedStyle(document.querySelector('.st-dst')).fontSize;
    if (window.st._settings) {
      window.st._settings({ panelTheme: 'dark', engine: 'openai', targetMode: 'auto', actionMode: 'translate', clip: {}, orb: {}, shortcuts: {} });
    }
    window.pushShow({ text: 'x', result: { ok: true, mode: 'translate', translated: 'y', dir: '英 → 中' } });
    await sleep(60);
    const darkBg = getComputedStyle(p).backgroundColor;
    const darkFs = getComputedStyle(document.querySelector('.st-dst')).fontSize;
    need(p.getAttribute('data-theme') === 'dark', '主题没切：' + p.getAttribute('data-theme'));
    need(darkBg !== lightBg, '底色没换：' + darkBg);
    need(darkFs === lightFs, '字号被改了：' + lightFs + ' → ' + darkFs);
    return lightBg + ' → ' + darkBg;
  });
}

main().then(report).catch(function (e) { bad('主体跑挂了', (e && e.message) || e); report(); });
`;

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>render-check</title>
<script>fetch('/report', { method: 'POST', body: 'BOOT：页面已加载' }).catch(function () {});</script>
<style>
body{font:13px/1.7 "Microsoft YaHei",system-ui;margin:0;padding:12px;background:#fff;color:#222}
#out{white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;position:relative;z-index:9;background:#fff}
.host{position:absolute;left:-9999px;top:0;width:600px}
</style>
<script>${STUB}</script>
</head><body>
<div id="out"></div>
<script>
${CHECKS}
</script>
</body></html>`;

/* ---------------- 跑 ---------------- */
console.log('\n== 旁译桌面版 · 界面自检（Edge 无头）==\n');

const edge = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!edge) {
  console.log('找不到 Edge。这条跳过；界面仍可在真实桌面用 npm run smoke 验。');
  process.exit(0);
}

const tmpHtml = path.join(ROOT, 'test', '_render.html');
fs.writeFileSync(tmpHtml, PAGE, 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sidtrans-edge-'));

const bodies = [];
let settle = null;
const done = new Promise(r => { settle = r; });

const srv = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(204); res.end();
      bodies.push(body);
      /* BOOT 只是「页面活着」的信号，等真正的报告 */
      if (body.indexOf('界面自检：') !== -1 && settle) { const f = settle; settle = null; f(body); }
    });
    return;
  }
  const p = decodeURIComponent(req.url.split('?')[0]);
  const abs = path.resolve(ROOT, p.replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});

await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--user-data-dir=' + userData,
  'http://127.0.0.1:' + PORT + '/test/_render.html'
], { stdio: 'ignore' });

const timeout = new Promise(r => setTimeout(() => r(null), 90000));
const text = await Promise.race([done, timeout]);

try { child.kill('SIGKILL'); } catch (e) {}
srv.close();
try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}

let fail = 1;
if (!text) {
  console.log('等 90 秒没收到完整报告。已收到的片段：');
  if (!bodies.length) console.log('  （一条都没有 —— 页面压根没跑起来）');
  else bodies.forEach(b => console.log('  ' + b.slice(0, 200)));
  console.log('\n这不是断言失败，是尺子没亮：先确认 Edge 能无头启动，再重跑这条。');
} else {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  const m = /(\d+) 通过 \/ (\d+) 失败/.exec(text);
  fail = m ? parseInt(m[2], 10) : 1;
}

console.log(fail ? '\n界面自检未通过\n' : '\n界面自检全绿\n');
process.exit(fail ? 1 : 0);
