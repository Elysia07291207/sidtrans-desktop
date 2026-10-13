/* 旁译桌面版 · 取词帮手（Node 侧）
 *
 * 「划词即译」这件事，Electron 自己做不到——它没有全局鼠标钩子。
 * 所以我们请一个 Windows 自带的小帮手（tools/pick-helper.ps1）来做：
 * 它盯着鼠标，发现「拖选松手 / 双击选词」就把选中文本打一行 JSON 到 stdout，
 * 这里读出来，交给主进程去翻。
 *
 * 为什么用 PowerShell 而不是装一个原生钩子模块：
 *   · 不装任何东西 —— PowerShell 与 .NET 的无障碍接口是 Windows 自带的
 *   · 不注入任何进程 —— 只用系统自己的接口读「焦点控件里选中的文本」
 * 代价是要单开一个进程，并且每 30ms 问一次鼠标状态（CPU 占用很小，但不为零）。
 */

import { spawn } from 'node:child_process';

export function createPickHelper({ script, log, onEvent }) {
  let child = null;
  let buf = '';
  let restarting = false;

  function handleLine(line) {
    let obj = null;
    try { obj = JSON.parse(line); } catch (e) {
      log('[取词] 看不懂帮手说的话，跳过：' + line.slice(0, 120));
      return;
    }
    try { onEvent(obj); } catch (e) { log('[取词] 处理出错：' + ((e && e.message) || e)); }
  }

  function start(opt) {
    if (child) return;
    opt = opt || {};
    const args = ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (opt.method && opt.method !== 'auto') args.push('-Method', String(opt.method));
    if (opt.minDrag != null) args.push('-MinDrag', String(opt.minDrag));
    if (opt.delayMs != null) args.push('-DelayMs', String(opt.delayMs));
    if (opt.needKey) args.push('-NeedKey', String(opt.needKey));
    if (opt.skipApps) args.push('-SkipApps', String(opt.skipApps));
    if (opt.doubleClick === false) args.push('-DoubleClick', '0');

    try {
      child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log('[取词] 起不来：' + ((e && e.message) || e));
      child = null;
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (line) handleLine(line);
      }
      /* 防呆：万一帮手吐出一行超长的东西，别把内存吃光 */
      if (buf.length > 1024 * 1024) buf = '';
    });
    child.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) log('[取词·帮手报错] ' + s.slice(0, 200));
    });
    child.on('exit', (code) => {
      log('[取词] 帮手退出（code=' + code + '）');
      child = null;
      /* 不是我们主动停的，就拉起来一次（只拉一次，防止疯狂重启） */
      if (code !== 0 && code !== null && !restarting) {
        restarting = true;
        setTimeout(() => { restarting = false; if (wantRunning) start(opt); }, 3000);
      }
    });
    child.on('error', (e) => {
      log('[取词] 帮手进程出错：' + ((e && e.message) || e));
      child = null;
    });
  }

  let wantRunning = false;

  function stop() {
    wantRunning = false;
    if (child) {
      try { child.kill(); } catch (e) {}
      child = null;
    }
  }

  return {
    start(opt) { wantRunning = true; start(opt); },
    stop,
    get running() { return !!child; }
  };
}
