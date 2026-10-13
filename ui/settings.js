/* 旁译桌面版 · 设置页
 *
 * 预设与提示词直接从 lib/prompts.js 读——跟主进程用的是同一份，
 * 不在这里再抄一遍（抄一遍就一定会漂移，这是浏览器版教会的事）。
 *
 * 保存的写法也跟浏览器版一致：先合并嵌套、再写，别让没动的字段被静默丢掉。
 */

import { PROMPT_PRESETS } from '../lib/prompts.js';

const $ = (id) => document.getElementById(id);
const ENGINE_HINT = {
  mymemory: '免费接口，不用注册、不用 key，开箱即用。适合应急；量大时会有速率限制，长句质量一般。',
  openai: '任何 OpenAI 兼容接口（DeepSeek / Kimi / 硅基流动 / 本地 Ollama…）。质量最好，需要自己填 key。',
  local: '指向本机的翻译服务。全程离线，文本不出本机 —— 比赛、断网、隐私场景用这个。'
};

let S = null;

function flash(t, isErr) {
  const m = $('msg');
  m.textContent = t || '';
  m.className = 'msg' + (isErr ? ' err' : '');
  if (t) setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 2400);
}

function paintPreset() {
  const cur = ($('oa-prompt').value || '').trim();
  const hit = PROMPT_PRESETS.find(p => p.text.trim() === cur);
  [...$('promptPreset').querySelectorAll('button')].forEach(b => {
    b.classList.toggle('on', !!hit && b.dataset.p === hit.id);
  });
  $('presetHint').textContent = hit
    ? hit.hint
    : (cur ? '这是你自己写的（或者改过的），保持原样不再当预设。' : '当前提示词是空的：只用程序自带的那套。');
}

function paintSegs() {
  [['targetMode', S.targetMode], ['engine', S.engine], ['actionMode', S.actionMode],
   ['transStyle', S.transStyle], ['panelTheme', S.panelTheme], ['answerExplain', S.answerExplain],
   ['pickMethod', (S.pick && S.pick.method) || 'auto'], ['pickNeedKey', (S.pick && S.pick.needKey) || '']]
    .forEach(([id, val]) => {
      const box = $(id);
      if (!box) return;
      [...box.querySelectorAll('button')].forEach(b => b.classList.toggle('on', b.dataset.v === val));
    });
}

function paint() {
  $('clipAuto').checked = !!(S.clip && S.clip.auto);  $('clipGuard').checked = !(S.clip && S.clip.guard === false);
  $('clipMin').value = (S.clip && S.clip.minLen) || 2;
  $('clipMax').value = (S.clip && S.clip.maxLen) || 2000;
  $('orbSize').value = (S.orb && S.orb.size) || 44;
  $('oa-base').value = S.openai.baseUrl || '';
  $('oa-key').value = '';
  $('oa-key').placeholder = S.openai.hasKey ? '（已保存，留空就是不改）' : 'sk-…';
  $('oa-model').value = S.openai.model || '';
  $('oa-prompt').value = S.openai.prompt || '';
  $('lc-url').value = S.local.url || '';
  const pk = S.pick || {};
  $('pickOn').checked = !!pk.enabled;
  $('pickDouble').checked = pk.doubleClick !== false;
  $('pickMin').value = pk.minLen || 3;
  const sc = S.shortcuts || {};
  $('sc-clip').value = sc.clip || '';
  $('sc-shot').value = sc.shot || '';
  $('sc-orb').value = sc.orb || '';
  paintSegs();
  paintPreset();
  $('engineHint').textContent = ENGINE_HINT[S.engine] || '';
  $('box-openai').classList.toggle('hide', S.engine !== 'openai');
  $('box-local').classList.toggle('hide', S.engine !== 'local');
  document.body.dataset.theme = S.panelTheme === 'dark' ? 'dark' : 'light';
}

function buildPresetButtons() {
  const box = $('promptPreset');
  box.innerHTML = '';
  PROMPT_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.dataset.p = p.id;
    b.textContent = p.name;
    b.title = p.hint;
    box.appendChild(b);
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    const p = PROMPT_PRESETS.find(x => x.id === b.dataset.p);
    if (!p) return;
    $('oa-prompt').value = p.text;
    paintPreset();
    flash('已套用「' + p.name + '」，记得点保存');
  });
  $('oa-prompt').addEventListener('input', paintPreset);
}

/* 每一段按钮组：点一下只改本地状态，保存时才落盘 */
[['targetMode'], ['engine'], ['actionMode'], ['transStyle'], ['panelTheme'], ['answerExplain'],
 ['pickMethod'], ['pickNeedKey']]
  .forEach(([id]) => {
    const box = $(id);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      if (id === 'pickMethod') { S.pick = Object.assign({}, S.pick, { method: b.dataset.v }); paint(); return; }
      if (id === 'pickNeedKey') { S.pick = Object.assign({}, S.pick, { needKey: b.dataset.v }); paint(); return; }
      S[id] = b.dataset.v;
      paint();
    });
  });

function collect() {
  const patch = {
    engine: S.engine,
    targetMode: S.targetMode,
    actionMode: S.actionMode,
    transStyle: S.transStyle,
    panelTheme: S.panelTheme,
    answerExplain: S.answerExplain,
    clip: {
      auto: $('clipAuto').checked,
      guard: $('clipGuard').checked,
      minLen: Math.max(1, Math.min(200, parseInt($('clipMin').value, 10) || 2)),
      maxLen: Math.max(50, Math.min(20000, parseInt($('clipMax').value, 10) || 2000))
    },
    orb: { size: Math.max(32, Math.min(96, parseInt($('orbSize').value, 10) || 44)) },
    shortcuts: {
      clip: $('sc-clip').value.trim(),
      shot: $('sc-shot').value.trim(),
      orb: $('sc-orb').value.trim()
    },
    openai: {
      baseUrl: $('oa-base').value.trim(),
      model: $('oa-model').value.trim(),
      prompt: $('oa-prompt').value
    },
    local: { url: $('lc-url').value.trim() },
    pick: {
      enabled: $('pickOn').checked,
      method: (S.pick && S.pick.method) || 'auto',
      needKey: (S.pick && S.pick.needKey) || '',
      minLen: Math.max(1, Math.min(50, parseInt($('pickMin').value, 10) || 3)),
      doubleClick: $('pickDouble').checked
    }
  };
  /* Key 只在真的填了才写：留空 = 「不改」，不然每次保存都会把它抹掉 */
  const k = $('oa-key').value.trim();
  if (k) patch.openai.apiKey = k;
  return patch;
}

$('save').addEventListener('click', async () => {
  const next = await window.st.setSettings(collect());
  S = next;
  paint();
  flash('已保存');
});

async function probe(text, label) {
  const out = $('probeOut');
  out.classList.remove('hide');
  out.textContent = label;
  /* 先落盘再试，保证试的就是她刚填的配置 */
  await window.st.setSettings(collect());
  const r = await window.st.submit({ text, mode: 'translate', source: '设置页试翻' });
  if (r && r.notText) { out.textContent = '没有硬翻，回的是：\n' + r.error; return; }
  if (!r || !r.ok) { out.textContent = '失败：' + ((r && r.error) || '没有回应'); return; }
  out.textContent = '[' + r.dir + ' · ' + r.engine + ' · ' + r.ms + 'ms]\n' + (r.translated || '');
}

$('test').addEventListener('click', () => probe('The quick brown fox jumps over the lazy dog.', '翻译中…'));
$('testJunk').addEventListener('click', () => probe('WEHESIeIeEald#E ow=-z=S5F', '拿一串验证码去试…'));

$('logShow').addEventListener('click', async () => {
  const out = $('logOut');
  out.classList.remove('hide');
  const log = await window.st.getLog();
  out.textContent = log && log.length ? JSON.stringify(log, null, 2) : '（还没有记录）';
});

$('logClear').addEventListener('click', async () => {
  await window.st.clearLog();
  $('logOut').classList.add('hide');
  flash('日志已清空');
});

window.st.onSettings((s) => { S = s; paint(); });

(async () => {
  buildPresetButtons();
  S = await window.st.getSettings();
  paint();
})();
