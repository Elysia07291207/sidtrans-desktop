/* 旁译桌面版 · 面板
 *
 * 结构、按钮顺序、字号层级都沿用浏览器版浮层那一套（panel.css 就是它那份样式）。
 * 这里做的是「把渲染与状态接上主进程」：面板不再自己发请求、不再自己管方向，
 * 只负责显示 + 把她的动作转成一个消息。
 *
 * 三模式（翻译 / 做题 / 术语）+ 可选解析，跟扩展一致。
 */

const $ = (s) => document.querySelector(s);
const panel = $('.st-panel');
const ui = {
  dir: $('.st-dir'),
  engine: $('.st-engine'),
  shotSec: $('.st-shot-sec'),
  shot: $('.st-shot'),
  shotInfo: $('.st-shotinfo'),
  src: $('.st-src'),
  dst: $('.st-dst'),
  pending: $('.st-pending'),
  status: $('.st-status'),
  resTitle: $('.st-restitle'),
  copyBtn: $('.st-btn.primary'),
  explainBtn: $('.st-btn[data-act="explain"]'),
  input: $('.st-input'),
  toast: $('.st-toast'),
  modes: Array.prototype.slice.call(document.querySelectorAll('.st-mode'))
};

let S = { actionMode: 'translate', panelTheme: 'light', answerExplain: 'off' };
let cur = { text: '', result: null, mode: 'translate', explainOn: false };

/* ---------------- 渲染 ---------------- */

function toast(t, isErr) {
  ui.toast.textContent = t || '';
  ui.toast.className = 'st-toast' + (isErr ? ' is-err' : '');
  if (t) setTimeout(() => { if (ui.toast.textContent === t) ui.toast.textContent = ''; }, 2200);
}

function syncMode() {
  ui.modes.forEach(b => b.classList.toggle('on', b.dataset.mode === cur.mode));
  panel.setAttribute('data-mode', cur.mode);
}

function setPending(t) {
  ui.pending.textContent = t || '';
}

function cleanDir(d) {
  /* 主进程回的 dir 是「英 → 中」这种，直接用；没有就沿用上一次 */
  return d || ui.dir.textContent || '译';
}

/* 术语模式的三行拆法：跟浏览器版同一套「只认行首」的规矩 */
function splitTerm(t) {
  const out = { rows: [] };
  const lines = String(t || '').split('\n');
  const pick = (label) => {
    const re = new RegExp('^\\s*(?:' + label + ')\\s*[：:]\\s*(.*)$');
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1].trim();
    }
    return '';
  };
  const t0 = pick('译法') || pick('译名') || pick('译文');
  const alt = pick('备选') || pick('其他译法');
  const note = pick('说明') || pick('解释');
  if (t0) out.rows.push({ k: '译法', v: t0, big: true });
  if (alt) out.rows.push({ k: '备选', v: alt });
  if (note) out.rows.push({ k: '说明', v: note });
  if (!out.rows.length) out.rows.push({ k: '译法', v: String(t || '').trim(), big: true });
  return out;
}

function splitAnswer(t) {
  const lines = String(t || '').split('\n');
  let ans = '', unsure = '', explain = '';
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*解析\s*[：:]/.test(l) || /^\s*【解析】/.test(l) || /^\s*\*\*解析\*\*/.test(l)) {
      explain = lines.slice(i).join('\n').replace(/^\s*(解析\s*[：:]|【解析】|\*\*解析\*\*)\s*/, '');
      break;
    }
    if (!ans) { ans = l.trim(); continue; }
    if (!unsure && /^\s*u\b/i.test(l)) { unsure = l.trim(); continue; }
    rest.push(l);
  }
  if (rest.length) explain = (explain ? explain + '\n' : '') + rest.join('\n');
  return { ans, unsure, explain: explain.trim() };
}

function renderResult() {
  const r = cur.result;
  syncMode();
  panel.setAttribute('data-theme', S.panelTheme === 'dark' ? 'dark' : 'light');
  ui.src.textContent = cur.text || '';

  ui.shotSec.classList.remove('on');
  ui.shot.removeAttribute('src');
  ui.shotInfo.textContent = '';
  ui.dst.className = 'st-dst';
  /* 清空结果区：术语模式是「一个个块拼出来」的，不清就会把上一轮叠在下面。
     （界面自检逮到过：切到术语时，上面会留一块空的和一句「翻译中…」。） */
  ui.dst.textContent = '';
  ui.explainBtn.textContent = cur.explainOn ? '收起解析' : '看解析';
  setPending('');

  if (!r) {
    ui.resTitle.textContent = cur.mode === 'answer' ? '答案' : (cur.mode === 'term' ? '术语' : '译文');
    ui.dst.className = 'st-dst is-pending';
    ui.dst.textContent = '把文字复制一下，或者拖个框取字。';
    ui.status.textContent = '';
    ui.engine.textContent = engineText();
    return;
  }

  if (r.pending) {
    ui.resTitle.textContent = cur.mode === 'answer' ? '答案' : (cur.mode === 'term' ? '术语' : '译文');
    ui.dir.textContent = cleanDir(r.dir);
    ui.status.textContent = r.source ? r.source : '';
    ui.dst.className = 'st-dst is-pending';
    ui.dst.textContent = '翻译中…';
    ui.engine.textContent = engineText();
    return;
  }

  if (r.ocr) {
    ui.shotSec.classList.add('on');
    if (r.ocr.shot) ui.shot.src = r.ocr.shot;
    const conf = (r.ocr.conf == null) ? null : Math.round(r.ocr.conf);
    ui.shotInfo.textContent = (r.ocr.diag ? r.ocr.diag + ' · ' : '') + (conf == null ? '' : '准度 ' + conf);
    ui.shotInfo.classList.toggle('is-warn', conf != null && conf < 50);
  }

  ui.dir.textContent = cleanDir(r.dir);

  if (!r.ok) {
    ui.dst.className = 'st-dst is-error';
    ui.dst.textContent = r.error || '出问题了';
    ui.status.textContent = '';
    ui.resTitle.textContent = '没成';
    ui.engine.textContent = engineText();
    return;
  }

  const meta = [];
  if (r.engine) meta.push(r.engine);
  if (r.ms != null) meta.push(r.ms + 'ms');
  if (r.cached) meta.push('缓存');
  ui.status.textContent = meta.join(' · ');
  ui.engine.textContent = engineText();

  if (cur.mode === 'answer') {
    ui.resTitle.textContent = '答案';
    const a = splitAnswer(r.answer || '');
    ui.dst.className = 'st-dst is-answer';
    ui.dst.textContent = a.ans || '';
    const bits = [];
    if (a.unsure) bits.push('没把握的空：' + a.unsure.replace(/^u\s*/i, ''));
    if (r.truncated) bits.push('这段没说完就被截断了');
    if (r.degraded) bits.push(r.degraded);
    setPending(bits.join('　'));
    if (a.explain) {
      const ex = document.createElement('div');
      ex.className = 'st-explain';
      ex.textContent = a.explain;
      ui.dst.appendChild(ex);
    }
  } else if (cur.mode === 'term') {
    ui.resTitle.textContent = '术语';
    const t = splitTerm(r.answer || '');
    ui.dst.className = 'st-dst is-term';
    t.rows.forEach(row => {
      if (row.big) {
        const wrap = document.createElement('div');
        wrap.className = 'st-tterm';
        const k = document.createElement('span');
        k.className = 'st-tk';
        k.textContent = row.k;
        const v = document.createElement('span');
        v.className = 'st-tv';
        v.textContent = row.v;
        wrap.appendChild(k); wrap.appendChild(v);
        ui.dst.appendChild(wrap);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'st-trow';
        const k = document.createElement('span');
        k.className = 'st-tk';
        k.textContent = row.k;
        const v = document.createElement('span');
        v.className = 'st-tx';
        v.textContent = row.v;
        wrap.appendChild(k); wrap.appendChild(v);
        ui.dst.appendChild(wrap);
      }
    });
  } else {
    ui.resTitle.textContent = '译文';
    ui.dst.className = 'st-dst';
    ui.dst.textContent = r.translated || '';
    const bits = [];
    if (r.truncated) bits.push('这段没译完（被长度截断），可以拆短一点再翻');
    if (r.degraded) bits.push(r.degraded);
    setPending(bits.join('　'));
  }
}

function engineText() {
  const names = { mymemory: '免费在线', openai: 'API', local: '本地服务' };
  return names[S.engine] || '';
}

/* ---------------- 取结果 ---------------- */

async function run(text, mode, explain) {
  const t = String(text == null ? cur.text : text);
  if (!t.trim()) { toast('没东西可翻', true); return; }
  cur.text = t;
  cur.mode = mode || cur.mode;
  if (explain != null) cur.explainOn = !!explain;
  cur.result = { pending: true, mode: cur.mode };
  renderResult();
  const r = await window.st.submit({ text: t, mode: cur.mode, explain: cur.explainOn ? 1 : 0, source: '面板' });
  cur.result = r;
  renderResult();
}

/* ---------------- 事件 ---------------- */

document.querySelector('.st-head').addEventListener('click', (e) => {
  const b = e.target.closest('.st-mode');
  if (!b) return;
  e.stopPropagation();
  cur.mode = b.dataset.mode;
  if (cur.text.trim()) run(cur.text, cur.mode);
  else { syncMode(); renderResult(); }
});

/* 面板拖动：跟球一样自己算位移（标题栏挂了 cursor:move 只是给个提示） */
let drag = null;
document.querySelector('.st-head').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  drag = { x: e.screenX, y: e.screenY };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag.x = e.screenX; drag.y = e.screenY;
  window.st.panelDrag(dx, dy);
});
window.addEventListener('mouseup', () => { drag = null; });

document.querySelector('.st-close').addEventListener('click', () => window.st.closePanel());

document.querySelector('.st-foot').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const r = cur.result || {};
  if (act === 'copy-dst') {
    const t = cur.mode === 'answer' ? (r.answer || '') : (cur.mode === 'term' ? (r.answer || '') : (r.translated || ''));
    if (!t) { toast('还没有结果', true); return; }
    const ok = await window.st.copy(t);
    toast(ok && ok.ok ? '已复制' : '复制失败', !(ok && ok.ok));
  } else if (act === 'copy-mine') {
    const t = ui.input.value.trim();
    if (!t) { toast('写框是空的', true); return; }
    const ok = await window.st.copy(t);
    toast(ok && ok.ok ? '已复制' : '复制失败', !(ok && ok.ok));
  } else if (act === 'dst-to-write') {
    ui.input.value = r.translated || r.answer || '';
    ui.input.focus();
  } else if (act === 'src-to-write') {
    ui.input.value = cur.text || '';
    ui.input.focus();
  } else if (act === 'as-question') {
    run(cur.text || ui.input.value, 'answer');
  } else if (act === 'explain') {
    cur.explainOn = !cur.explainOn;
    await run(cur.text, cur.mode, cur.explainOn);
  } else if (act === 'retrans') {
    run(cur.text, cur.mode, cur.explainOn);
  } else if (act === 'shot') {
    window.st.shot();
  } else if (act === 'from-clip') {
    window.st.translateClip();
  }
});

ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.st.closePanel(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const t = ui.input.value.trim();
    if (!t) { toast('写框是空的', true); return; }
    run(t, cur.mode, cur.explainOn);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.st.closePanel();
});

/* ---------------- 反馈：落座的动效 + 一个合成的声音 ---------------- */
/* 跟浏览器版同一套：声音是算出来的，包里不多一个音频文件。 */
let AC = null, lastSfxAt = 0, soundOn = true;
const SFX = {
  seat: { f0: 1240, f1: 780,  dur: 0.10, gain: 0.052, type: 'triangle', click: 0.020 },
  done: { f0: 1320, f1: 1320, dur: 0.15, gain: 0.042, type: 'sine',     click: 0 },
  fail: { f0: 340,  f1: 226,  dur: 0.17, gain: 0.048, type: 'sine',     click: 0 }
};

function audioCtx() {
  if (AC) return AC;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    AC = new C();
  } catch (e) { AC = null; }
  return AC;
}

function sfx(name) {
  if (!soundOn) return;
  const spec = SFX[name];
  if (!spec) return;
  const now = Date.now();
  if (now - lastSfxAt < 70) return;
  lastSfxAt = now;
  try {
    const c = audioCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    const t = c.currentTime + 0.002;
    const g = c.createGain();
    g.connect(c.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(spec.gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
    const o = c.createOscillator();
    o.type = spec.type;
    o.frequency.setValueAtTime(spec.f0, t);
    if (spec.f1 !== spec.f0) o.frequency.exponentialRampToValueAtTime(spec.f1, t + spec.dur * 0.9);
    o.connect(g);
    o.start(t);
    o.stop(t + spec.dur + 0.02);
    if (spec.click > 0) {
      const n = Math.max(1, Math.floor(c.sampleRate * 0.012));
      const buf = c.createBuffer(1, n, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
      const src = c.createBufferSource();
      src.buffer = buf;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 2200;
      const ng = c.createGain(); ng.gain.value = spec.click;
      src.connect(hp); hp.connect(ng); ng.connect(c.destination);
      src.start(t);
    }
  } catch (e) {}
}

/* 面板每次都重新填内容，所以入场动效每次都算新的一次 */
function popIn() {
  if (!panel) return;
  try {
    panel.style.transition = 'none';
    panel.style.transformOrigin = '50% 8%';
    panel.style.transform = 'translateY(6px) scale(.965)';
    void panel.offsetHeight;
    panel.style.transition = 'transform .26s cubic-bezier(.22,1.25,.36,1)';
    panel.style.transform = 'translateY(0) scale(1)';
  } catch (e) {}
}

/* ---------------- 来自主进程的推送 ---------------- */

window.st.onShow((p) => {
  if (!p) return;
  if (p.settings) applySettings(p.settings);
  /* 只有“真的换了内容”才响；同一条结果陆续回填的那几次不响 */
  if (!(p.result && p.result.pending)) { popIn(); sfx('seat'); }
  if (p.result && p.result.pending) {
    cur.text = p.text || '';
    cur.mode = p.result.mode || cur.mode;
    cur.result = p.result;
    renderResult();
    return;
  }
  cur.text = p.text || '';
  cur.result = p.result || null;
  if (p.result && p.result.mode) cur.mode = p.result.mode;
  if (p.result && p.result.explain) cur.explainOn = true;
  renderResult();
});

function applySettings(s) {
  S = Object.assign({}, S, s || {});
  soundOn = !(s && s.sound === false);
  if (!cur.text && s && s.actionMode) cur.mode = s.actionMode;
  renderResult();
}

window.st.onSettings(applySettings);

/* 首屏：先把当前状态画出来，别让面板空着 */
(async () => {
  const s = await window.st.getSettings();
  applySettings(s);
  cur.mode = (s && s.actionMode) || 'translate';
  renderResult();
})();
