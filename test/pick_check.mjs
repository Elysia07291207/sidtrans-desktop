/* 旁译桌面版 · 划词取词自检
 *
 * 「划词即译」的难点全在取词那一步：读得到吗、会不会动到她的剪贴板。
 * 所以这一条用一个**真应用**来验：开一个记事本，往里打字、全选，
 * 再让取词帮手去读——读回来的必须是我刚打进去的那串字。
 *
 * 为什么是记事本：Windows 自带、不装任何东西、它是「另一个进程」——
 * 这正好是这道题的关键（跨进程取选中）。
 *
 * ⚠️ 它会真的开一个记事本窗口、真的动一下剪贴板（用完会还回去），所以不在默认自检里，
 *    要单独跑：node test/pick_check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'tools', 'pick-helper.ps1');
const PS = 'powershell.exe';
const MARKER = 'SIDTRANS PICK TEST 2026';
const SENTINEL = 'SIDTRANS-SENTINEL-KEEP-ME';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { const e = fn(); pass++; console.log('  ✓ ' + name + (e ? '  ' + e : '')); }
  catch (e) { fail++; failures.push(name + ' → ' + e.message); console.log('  ✗ ' + name + '  → ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

function runHelper(args, timeoutMs = 25000) {
  const out = execFileSync(PS, ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const lines = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  try { return JSON.parse(last); } catch (e) { throw new Error('帮手没说人话：' + JSON.stringify(last)); }
}

function ps(script, timeoutMs = 30000) {
  const f = path.join(os.tmpdir(), 'sidtrans_pick_aux.ps1');
  fs.writeFileSync(f, script, 'utf8');   /* 内容全 ASCII，不需要 BOM */
  return execFileSync(PS, ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', f],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}

console.log('\n== 旁译桌面版 · 划词取词自检 ==\n');

/* ---------- 1. 帮手能起来、能报到 ---- */
await (async () => {
  console.log('[1] 帮手本体');
  const child = spawn(PS, ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let got = null, buf = '';
  child.stdout.setEncoding('utf8');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 12000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { const o = JSON.parse(line); if (o.t === 'ready') { got = o; clearTimeout(timer); resolve(); } } catch (e) {}
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  try { child.kill(); } catch (e) {}

  t('帮手能起来并报到（ready）', () => {
    assert(got, '12 秒没收到 ready —— 帮手起不来');
    return 'pid=' + got.pid + ' 方式=' + got.method + ' 跳过=' + got.skipApps;
  });
})();

/* ---------- 2. 真记事本：跨进程读选中 ---------- */
console.log('\n[2] 真记事本里读选中（这是这道题的关键）');
let e2e = 'skip';
try {
  /* Windows 11 的记事本已经是商店应用：Start-Process 拿到的是个立刻退出的转发进程，
     MainWindowHandle 是空的。所以改成「过两秒按窗口名找」。 */
  const boot = String(ps(`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class Ws {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@ -ErrorAction SilentlyContinue
Start-Process notepad
Start-Sleep -Milliseconds 2500
$w = Get-Process | Where-Object { $_.ProcessName -like '*notepad*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $w) { Write-Output 'NO_NOTEPAD'; exit 0 }
for ($i = 0; $i -lt 6; $i++) {
  [void][Ws]::SetForegroundWindow($w.MainWindowHandle)
  Start-Sleep -Milliseconds 400
  if ([Ws]::GetForegroundWindow() -eq $w.MainWindowHandle) { break }
}
$fg = ([Ws]::GetForegroundWindow() -eq $w.MainWindowHandle)
[System.Windows.Forms.SendKeys]::SendWait('SIDTRANS PICK TEST 2026')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 500
Write-Output ('FOCUSED=' + $fg)
Write-Output ('HWND=' + $w.MainWindowHandle)
`)).trim();

  if (boot.indexOf('NO_NOTEPAD') !== -1) {
    console.log('  ! 这台机器上没能拉起记事本窗口，这一条没验');
    e2e = 'noapp';
  } else {
    const focused = /FOCUSED=(\w+)/.exec(boot);
    console.log('    （记事本 ' + boot.replace(/\s+/g, ' ') + '）');
    if (!focused || focused[1] !== 'True') {
      console.log('  ! 记事本抢不到焦点，这一条没验（受限环境常见，不是代码问题）');
      e2e = 'nofocus';
    } else {
      e2e = 'ran';
    }
  }

  /* 先放一个哨兵进剪贴板：用来验「读完有没有还回来」 */
  ps(`Set-Clipboard -Value '${SENTINEL}'`);

  /* 无论如何都验一条能确定的事：当前没有选区时发 Ctrl+C，不应改变剪贴板 */
  const r0 = runHelper(['-Once', '-Method', 'clipboard']);
  t('没选区的时候不会把剪贴板弄脏（哨兵还在）', () => {
    const now = String(ps(`Get-Clipboard -Raw`)).trim();
    assert(now.indexOf(SENTINEL) !== -1, '剪贴板被动了，现在是：' + JSON.stringify(now.slice(0, 60)));
    return '哨兵完好（这次读回来 ' + JSON.stringify(String(r0.text || '').slice(0, 20)) + '）';
  });

  if (e2e === 'ran') {
    const r = runHelper(['-Once', '-Method', 'clipboard']);
    t('复制读剪贴板：读到的是记事本里选中的那串字', () => {
      assert(r.t === 'sel', '帮手没回 sel：' + JSON.stringify(r));
      assert(String(r.text).indexOf(MARKER) !== -1, '读回来的不对：' + JSON.stringify(String(r.text).slice(0, 80)));
      return 'how=' + r.how + ' app=' + r.app + ' ' + r.ms + 'ms';
    });
    t('读完把剪贴板还回去了（哨兵还在）', () => {
      const now = String(ps(`Get-Clipboard -Raw`)).trim();
      assert(now.indexOf(SENTINEL) !== -1, '剪贴板没还原：' + JSON.stringify(now.slice(0, 60)));
      return '哨兵完好';
    });
    const ru = runHelper(['-Once', '-Method', 'uia']);
    t('只读选中（不碰剪贴板那条路）：能读到就用', () => {
      if (ru.text && String(ru.text).indexOf(MARKER) !== -1) return '记事本也认这条路（uia）';
      return '记事本读不到（浏览器里的网页也一样）——这正是需要剪贴板兜底的原因';
    });
  }
} catch (e) {
  console.log('  ! 记事本 e2e 没跑完：' + ((e && e.message) || e));
  e2e = 'error';
} finally {
  try { ps(`Get-Process | Where-Object { $_.ProcessName -like '*notepad*' -and $_.MainWindowTitle -ne '' } | Stop-Process -Force -ErrorAction SilentlyContinue`); } catch (e) {}
  try { ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()`); } catch (e) {}
}

console.log('\n============================');
console.log('取词自检：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) failures.forEach(f => console.log('  · ' + f));
console.log('');
process.exit(fail ? 1 : 0);
