/* 旁译桌面版 · Electron 冒烟自检
 *
 * 这个文件跑在**真的应用里**（main.js 用 --smoke 唤起它），不是另写一个壳。
 * 这一点很重要：另写一个壳只能证明「壳能跑」，证明不了应用能跑。
 *
 * 三块（都可单独跑）：
 *   ui   —— 球在不在、面板能不能把结果画出来、剪贴板真的读得到吗、
 *           复制出去的东西会不会被自己再翻一遍（回环）
 *   ocr  —— 藏起来的窗口里画一张有字的图 → 交给真的 Tesseract → 认回来对不对
 *   all  —— 两块都跑
 *
 * 翻译引擎换成**本机桩服务**（127.0.0.1 上的小 HTTP 服务），
 * 这样整条链路离线可复现，不靠网络、不花额度、不会因为一次抖动变红。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboard } from 'electron';

/* Windows 上 electron.exe 是 GUI 子系统程序，控制台里看不到它的 stdout。
   所以每行同时写一份到文件，由 test/run_smoke.ps1 最后打出来。
   （这也是「尺子不能坏」的一种：看不到输出的自检等于没跑。） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGFILE = path.join(HERE, '_smoke-last.txt');
function say(line) {
  try { console.log(line); } catch (e) {}
  try { fs.appendFileSync(LOGFILE, line + '\n', 'utf8'); } catch (e) {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, step = 80, what = '条件' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) { last = e && e.message; }
    await sleep(step);
  }
  throw new Error('等不到：' + what + (last ? ('（最后一次：' + JSON.stringify(last).slice(0, 120) + '）') : ''));
}

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let text = '';
        try { text = JSON.parse(body).text || ''; } catch (e) {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '[桩] ' + text, engine: 'stub' }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

export async function runSmoke(ctx) {
  try { fs.writeFileSync(LOGFILE, '', 'utf8'); } catch (e) {}
  const which = (process.argv.find(a => a.startsWith('--smoke=')) || '--smoke=all').split('=')[1];
  const results = [];
  const ok = (name, extra) => results.push({ ok: true, name, extra });
  const bad = (name, extra) => results.push({ ok: false, name, extra });

  const check = async (name, fn) => {
    try {
      const extra = await fn();
      ok(name, extra);
      say('  ✓ ' + name + (extra ? '  ' + extra : ''));
    } catch (e) {
      bad(name, String((e && e.message) || e));
      say('  ✗ ' + name + '  → ' + ((e && e.message) || e));
    }
  };

  say('\n== 旁译桌面版 · Electron 冒烟（' + which + '）==');

  /* ⚠️ 冒烟会动两个「属于她」的东西：设置（要指到桩服务）与剪贴板（要真的喂给它读）。
     两头都先存下来，结束时原样还回去——自检不该在地的机器上留下痕迹。 */
  const settingsBackup = JSON.parse(JSON.stringify(ctx.store.getSettings()));
  let clipBackup = '';
  /* Electron 40+ 的剪贴板读取是异步的，得 await */
  try { clipBackup = (await clipboard.readText()) || ''; } catch (e) {}

  try {
  /* ---------------- ui ---------------- */
  if (which === 'ui' || which === 'all') {
    const stub = await startStub();
    ctx.store.replaceSettings({
      engine: 'local',
      local: { url: 'http://127.0.0.1:' + stub.port + '/translate' },
      actionMode: 'translate',
      clip: { auto: true, paused: false, guard: true, minLen: 2, maxLen: 500 },
      shortcuts: { clip: '', shot: '', orb: '' }   /* 冒烟时不抢她的快捷键 */
    });
    ctx.store.cache.clear();

    say('\n[ui]');
    await check('球起来了并且是可见的', async () => {
      const w = await waitFor(() => {
        const x = ctx.orbWin;
        return (x && !x.isDestroyed()) ? x : null;
      }, { what: '球窗口' });
      /* 给 ready-to-show 留时间（透明窗口在某些版本上不触发它，主进程里有兜底） */
      await waitFor(() => w.isVisible(), { timeout: 15000, what: '球变成可见' });
      return w.getBounds().width + '×' + w.getBounds().height;
    });

    await check('球上真的画出了东西（容器有尺寸、有圆）', async () => {
      const w = ctx.orbWin;
      const r = await w.webContents.executeJavaScript(`(() => {
        const b = document.getElementById('ball');
        if (!b) return null;
        const cs = getComputedStyle(b);
        return { w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, r: cs.borderTopLeftRadius, text: b.textContent };
      })()`);
      if (!r || r.w < 20) throw new Error('球没有尺寸：' + JSON.stringify(r));
      if (r.r !== '50%') throw new Error('球不是圆的：border-radius=' + r.r);
      return r.w + 'px 圆';
    });

    await check('面板能开、能画出结果', async () => {
      ctx.showPanel({ text: 'Hello stub world', result: { ok: true, mode: 'translate', translated: '你好，桩世界', dir: '英 → 中', engine: 'stub', ms: 3 } });
      const w = await waitFor(() => ctx.panelWin, { what: '面板窗口' });
      await waitFor(async () => !w.webContents.isLoading(), { what: '面板加载完' });
      const got = await waitFor(async () => {
        const r = await w.webContents.executeJavaScript(`(() => {
          const d = document.querySelector('.st-dst');
          const s = document.querySelector('.st-src');
          return { dst: d ? d.textContent : '', cls: d ? d.className : '', src: s ? s.textContent : '' };
        })()`);
        return (r && r.dst) ? r : null;
      }, { what: '面板渲染出译文' });
      if (got.dst !== '你好，桩世界') throw new Error('译文不对：' + got.dst);
      if (got.src !== 'Hello stub world') throw new Error('原文不对：' + got.src);
      if (!w.isVisible()) throw new Error('面板没显示');
      return '译文/原文都对';
    });

    await check('剪贴板真的读得到（走真实 API，不是桩）', async () => {
      await clipboard.writeText('旁译冒烟测试剪贴板');
      await ctx.watcher.tick();
      const t0 = Date.now();
      while (ctx.watcher.lastSeen !== '旁译冒烟测试剪贴板' && Date.now() - t0 < 3000) await sleep(60);
      if (ctx.watcher.lastSeen !== '旁译冒烟测试剪贴板') throw new Error('看守没读到剪贴板：' + JSON.stringify(ctx.watcher.lastSeen));
      return '看守看见了';
    });

    await check('复制 → 自动翻 → 面板跟着变（整条主路径）', async () => {
      await clipboard.writeText('Second sentence for smoke.');
      await ctx.watcher.tick();
      const w = ctx.panelWin;
      const got = await waitFor(async () => {
        const r = await w.webContents.executeJavaScript(`document.querySelector('.st-src').textContent`);
        return r === 'Second sentence for smoke.' ? r : null;
      }, { what: '面板原文更新为新的剪贴板内容' });
      /* 原文一更新就读译文是抢跑：那一刻面板还写着「翻译中…」。
         等译文真的落地再断言（等的是期望本身，不是拍一个固定秒数）。 */
      const dst = await waitFor(async () => {
        const v = await w.webContents.executeJavaScript(`document.querySelector('.st-dst').textContent`);
        return v === '[桩] Second sentence for smoke.' ? v : null;
      }, { what: '译文换成桩返回的内容（原文：' + got + '）' });
      return '原文 + 译文都对';
    });

    await check('像密钥的一串不自动翻（闸门生效）', async () => {
      const before = ctx.watcher.lastSeen;
      await clipboard.writeText('gho_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6');
      await ctx.watcher.tick();
      await sleep(300);
      if (ctx.watcher.lastSeen !== before) throw new Error('它把密钥那串也当成新内容了');
      if (ctx.watcher.stats.translated < 2) throw new Error('前面的翻译没记账');
      return '按住了';
    });

    await check('复制出去的译文不会被自己再翻一遍（回环）', async () => {
      const before = ctx.watcher.stats.translated;
      /* 走真实的复制通道：它应该记住这一次是自己写的 */
      await ctx.copyText('[桩] Second sentence for smoke.');
      await ctx.watcher.tick();
      await sleep(200);
      if (ctx.watcher.stats.translated !== before) throw new Error('自己写的被当成新内容翻了一遍');
      return '没有回环';
    });

    await check('切到做题模式：面板换标题、答案用大号字', async () => {
      const w = ctx.panelWin;
      await w.webContents.executeJavaScript(`document.querySelector('.st-mode[data-mode="answer"]').click()`);
      await sleep(120);
      const mode = await w.webContents.executeJavaScript(`document.querySelector('.st-panel').getAttribute('data-mode')`);
      if (mode !== 'answer') throw new Error('模式没切过去：' + mode);
      ctx.showPanel({ text: '1. A 2. B', result: { ok: true, mode: 'answer', answer: 'AB\nu 2', dir: '答题' } });
      const got = await waitFor(async () => {
        const r = await w.webContents.executeJavaScript(`(() => { const d=document.querySelector('.st-dst');
          return { t: d.textContent, c: d.className, fs: getComputedStyle(d).fontSize }; })()`);
        return (r && r.t === 'AB') ? r : null;
      }, { what: '答案渲染' });
      if (!/is-answer/.test(got.c)) throw new Error('没有用答案那套样式：' + got.c);
      if (parseFloat(got.fs) < 20) throw new Error('答案字号没放大：' + got.fs);
      return 'AB / ' + got.fs;
    });

    /* 术语模式的三行拆法很容易悄悄坏掉（键名一变就退化成一整块），值得单独看一眼 */
    await check('术语模式：译法单独成行、说明跟在后面', async () => {
      const w = ctx.panelWin;
      ctx.showPanel({ text: '全过程人民民主', result: { ok: true, mode: 'term', answer: '译法：whole-process people\u2019s democracy\n备选：whole-process democracy\n说明：指民主贯穿决策到监督的全链条。', dir: '术语' } });
      const got = await waitFor(async () => {
        const r = await w.webContents.executeJavaScript(`(() => {
          const big = document.querySelector('.st-tterm .st-tv');
          const rows = [...document.querySelectorAll('.st-trow .st-tx')].map(e => e.textContent);
          return big ? { big: big.textContent, rows } : null;
        })()`);
        return r;
      }, { what: '术语渲染' });
      if (got.big.indexOf('whole-process') === -1) throw new Error('译法行不对：' + got.big);
      if (got.rows.length < 2) throw new Error('备选/说明没拆出来：' + JSON.stringify(got.rows));
      return '3 行都拆出来了';
    });

    /* 设置页也要能打开、能读到设置（设置页是 ESM 引用 lib/prompts.js，路径错了会白屏） */
    await check('设置页能加载，预设五颗都在', async () => {
      const { BrowserWindow } = await import('electron');
      const w = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { preload: ctx.ROOT + '\\ui\\preload.cjs', contextIsolation: true, sandbox: false } });
      try {
        await w.loadURL(ctx.pageUrl('ui/settings.html'));
        const r = await waitFor(async () => {
          const v = await w.webContents.executeJavaScript(`(() => {
            const b = document.querySelectorAll('#promptPreset button');
            return { n: b.length, names: [...b].map(x => x.textContent), engine: document.getElementById('engine').children.length };
          })()`);
          return (v && v.n) ? v : null;
        }, { what: '设置页渲染' });
        if (r.n !== 5) throw new Error('预设不是五颗：' + r.n);
        return r.names.join('/');
      } finally { try { w.destroy(); } catch (e) {} }
    });

    stub.srv.close();
  }

  /* ---------------- 遮罩（框选取字） ----------------
     这一块曾经是个硬伤：遮罩盖住全屏、按 ESC 毫无反应，她只能重启。
     所以现在两条都验：能看见冻住的屏幕（不是黑屏），以及每条退路都能退。 */
  if (which === 'overlay' || which === 'all') {
    say('\n[遮罩]');

    /* 每个检查都要自己收尾：抛了也得把遮罩关掉。
       之前没做，第一个检查一挂就留了一层遮罩盖在屏幕上，还把后面几个检查带偏了。 */
    const withOverlay = async (fn) => {
      try { return await fn(); }
      finally { try { ctx.capture.cancel('自检收尾'); } catch (e) {} await sleep(300); }
    };

    await check('遮罩能开、桥是通的、冻住的屏幕送进去了（不是一块黑）', () => withOverlay(async () => {
      const p = ctx.capture.pick();
      const w = await waitFor(() => (ctx.capture.windows[0] || null), { what: '遮罩窗口' });
      /* 先看指示灯：桥没通就是根因，不用再猜图的事 */
      const flag = await waitFor(async () => {
        const f = await w.webContents.executeJavaScript('window.__ov || null');
        return f || null;
      }, { what: '遮罩里的指示灯', timeout: 8000 });
      if (!flag.stOk) throw new Error('桥没通：' + JSON.stringify(flag));
      const n = await waitFor(async () => {
        const f = await w.webContents.executeJavaScript('window.__ov');
        return (f && f.gotImage) ? f.imgLen : null;
      }, { what: '截图 dataURL 送进遮罩', timeout: 15000 });
      return 'dataURL ' + Math.round(n / 1024) + 'KB · 桥通';
    }));

    await check('按 Esc 能退（走真键盘路径）', () => withOverlay(async () => {
      const p = ctx.capture.pick();
      const w = await waitFor(() => (ctx.capture.windows[0] || null), { what: '遮罩窗口' });
      await sleep(600);
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      /* 别在后面再发 keyUp：keyDown 已经把窗口收了，再碰它就是「Object has been destroyed」 */
      const r = await Promise.race([p, sleep(8000).then(() => null)]);
      if (!r) throw new Error('Esc 之后 8 秒还没退——遮罩可能又卡住了');
      if (r.kind !== 'cancel') throw new Error('Esc 没被当成取消：' + JSON.stringify(r));
      if (ctx.capture.open) throw new Error('遮罩窗口还开着');
      return 'Esc 退出正常';
    }));

    await check('不靠键盘：右上角「取消」按钮也能退', () => withOverlay(async () => {
      const p = ctx.capture.pick();
      const w = await waitFor(() => (ctx.capture.windows[0] || null), { what: '遮罩窗口' });
      await sleep(600);
      await w.webContents.executeJavaScript(`document.getElementById('cancel').click()`);
      const r = await Promise.race([p, sleep(8000).then(() => null)]);
      if (!r || r.kind !== 'cancel') throw new Error('取消按钮没生效：' + JSON.stringify(r));
      if (ctx.capture.open) throw new Error('遮罩窗口还开着');
      return '按钮退出正常';
    }));
  }

  /* ---------------- ocr ---------------- */
  if (which === 'ocr' || which === 'all') {
    say('\n[ocr]');
    await check('藏起来的窗口里画张图，真的 Tesseract 能认回来', async () => {
      await ctx.ocrHost.warmup();
      const w = await waitFor(() => ctx.ocrHost.window, { what: '取字宿主窗口' });
      /* 画布上写死一行字——这是「独立事实源」：字是我们自己放进去的，
         识别结果必须跟它对得上，不是拿实现去证明实现。 */
      const dataUrl = await w.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas');
        c.width = 900; c.height = 170;
        const x = c.getContext('2d');
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = '#000000';
        x.font = 'bold 74px Arial, sans-serif';
        x.fillText('HELLO SIDTRANS 2026', 24, 116);
        return c.toDataURL('image/png');
      })()`);
      if (!dataUrl || dataUrl.length < 2000) throw new Error('图没画出来');
      const r = await ctx.ocrHost.ocrImage(dataUrl);
      const text = String(r.text || '');
      const hitHello = /HELLO/i.test(text);
      const hitYear = /2026/.test(text);
      if (!hitHello || !hitYear) throw new Error('认出来的不对：' + JSON.stringify(text.slice(0, 80)) + ' conf=' + r.conf);
      return 'conf=' + Math.round(r.conf) + ' 「' + text.replace(/\s+/g, ' ').slice(0, 40) + '」';
    });
  }

  } catch (e) {
    bad('冒烟主体崩了', String((e && e.message) || e));
    say('  ✗ 冒烟主体崩了 → ' + ((e && e.message) || e));
  } finally {
    /* 把她机器上的东西还回去 */
    try { ctx.store.replaceSettings(settingsBackup); } catch (e) {}
    try { await clipboard.writeText(clipBackup); } catch (e) {}
    say('  （设置与剪贴板已还原）');
  }

  /* ---------------- 收尾 ---------------- */
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  say('\n== 冒烟结果：' + pass + ' 通过 / ' + fail + ' 失败 ==');
  if (fail) {
    for (const r of results.filter(x => !x.ok)) say('  失败：' + r.name + ' → ' + r.extra);
  }
  return fail ? 1 : 0;
}
