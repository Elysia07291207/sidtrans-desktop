/* 旁译桌面版 · 离线自检（纯 node，不需要 Electron、不需要网络）
 *
 * 这条命令要在几秒内回答两个问题：
 *   1. 逻辑对不对？（引擎、降级、报错说人话、剪贴板闸门、缓存、坐标换算）
 *   2. 文件全不全？（引用的脚本/样式/OCR 依赖是不是真的在盘上）
 *
 * 为什么不「读一眼源码就算验过」：踩过的坑都不是读出来的——是跑出来的。
 * 这里每一项都真的调一次，拿回来的东西跟独立事实源比。
 *
 * 用法： node test/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  createEngine, humanEngineError, cacheKey, detectLang, pairFor, hkey, DEFAULT_SETTINGS
} from '../lib/engine.js';
import { buildTransSystem, PROMPT_PRESETS, ANSWER_SYS, ANSWER_EXPLAIN_SYS, TERM_SYS } from '../lib/prompts.js';
import { decide, looksLikeSecret, isUrlOnly, createClipWatcher, SKIP_TEXT } from '../lib/clipwatch.js';
import { createStore } from '../lib/store.js';
import { scaleRect } from '../lib/geometry.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const extra = fn();
    pass++;
    console.log('  ✓ ' + name + (extra ? '  ' + extra : ''));
  } catch (e) {
    fail++;
    failures.push(name + ' → ' + ((e && e.message) || e));
    console.log('  ✗ ' + name + '  → ' + ((e && e.message) || e));
  }
}
async function ta(name, fn) {
  try {
    const extra = await fn();
    pass++;
    console.log('  ✓ ' + name + (extra ? '  ' + extra : ''));
  } catch (e) {
    fail++;
    failures.push(name + ' → ' + ((e && e.message) || e));
    console.log('  ✗ ' + name + '  → ' + ((e && e.message) || e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '不相等') + '：' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); }
function has(s, sub, msg) { if (String(s).indexOf(sub) === -1) throw new Error((msg || '没包含') + '：' + sub); }

/* ---------------- 假 fetch：三件套（ok / status / text / json） ---------------- */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r === undefined || r === null) throw new Error('failed to fetch');
    if (r.throw) throw new Error(r.throw);
    return {
      ok: r.status ? (r.status >= 200 && r.status < 300) : true,
      status: r.status || 200,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {})),
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {}))
    };
  };
  f.calls = calls;
  return f;
}

const baseSettings = (over) => {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  return Object.assign(s, over || {});
};

function mkEngine(settings, handler) {
  const f = fakeFetch(handler);
  const cache = new Map();
  const e = createEngine({
    getSettings: () => settings,
    cache: { get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) },
    noteFail: () => {},
    fetchImpl: f
  });
  return { e, f, cache };
}

/* ============================================================ */
console.log('\n== 旁译桌面版 · 离线自检 ==\n');

console.log('[1] 语法与文件');
{
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === 'vendor' || name === '.git') continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(name)) files.push(p);
    }
  })(ROOT);

  let bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad.push(path.relative(ROOT, f) + ': ' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')); }
  }
  t(`${files.length} 个 js 文件语法通过`, () => { assert(!bad.length, bad.join(' | ')); return files.length + ' 个'; });

  t('package.json 能被 node 读成对象（不靠 PowerShell 读编码）', () => {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(p.type === 'module', 'type 必须是 module');
    assert(typeof p.main === 'string', 'main 缺失');
    assert(fs.existsSync(path.join(ROOT, p.main)), 'main 指向的文件不存在：' + p.main);
    return p.name + '@' + p.version;
  });

  /* 「清单引用的文件必须在产物里」这条在浏览器版被 icons\ 咬过一次，
     桌面版对应的是：网页里引的每个本地文件都得真的在盘上。 */
  t('ui/*.html 里引到的本地文件都在', () => {
    const dir = path.join(ROOT, 'ui');
    const missing = [];
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const ref = m[1];
        if (/^(https?:|data:|#)/.test(ref)) continue;
        n++;
        const abs = path.resolve(dir, ref);
        if (!fs.existsSync(abs)) missing.push(name + ' → ' + ref);
      }
    }
    assert(!missing.length, missing.join(', '));
    return n + ' 处引用';
  });

  t('main.js 的 import 都能解析到文件', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const missing = [];
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const abs = path.resolve(ROOT, m[1]);
      if (!fs.existsSync(abs)) missing.push(m[1]);
    }
    assert(!missing.length, missing.join(', '));
    return 'ok';
  });
}

console.log('\n[2] 引擎：判定、方向、提示词');
{
  t('语言判定：中日韩 vs 拉丁', () => {
    eq(detectLang('你好，世界'), 'zh');
    eq(detectLang('Hello world'), 'en');
    eq(detectLang('12345 -=-'), 'unknown');
    eq(detectLang('这是 hello 混排的一段话'), 'zh', '汉字多就算中文');
    return '4 例';
  });

  t('方向：auto 是双向，指定就单向', () => {
    eq(pairFor('zh', 'auto').to, 'en');
    eq(pairFor('en', 'auto').to, 'zh-CN');
    eq(pairFor('en', 'zh').from, 'en');
    eq(pairFor('zh', 'zh').from, 'zh-CN');
    eq(pairFor('en', 'en').to, 'en');
    return '5 例';
  });

  t('预设是「角色」，硬要求永远叠在后面', () => {
    const s = buildTransSystem({ prompt: PROMPT_PRESETS[2].text }, 'en', 'daily', 0, 0);
    has(s, '学术论文的翻译', '预设内容没进去');
    has(s, '只输出译文本身', '硬要求丢了');
    has(s, '[[NOT_TEXT]]', '乱码不硬翻的底线丢了');
    const bare = buildTransSystem({ prompt: '' }, 'zh-CN', 'daily', 0, 0);
    has(bare, '简体中文', '目标语言没写进去');
    return 'ok';
  });

  t('笔译赛风格只在 lit 时追加', () => {
    assert(buildTransSystem({}, 'en', 'lit', 0, 0).indexOf('笔译赛标准') !== -1, 'lit 没追加');
    assert(buildTransSystem({}, 'en', 'daily', 0, 0).indexOf('笔译赛标准') === -1, 'daily 不该有');
    return 'ok';
  });

  t('分段说明只在多段时出现，且带段号', () => {
    const s = buildTransSystem({}, 'en', 'daily', 2, 5);
    has(s, '第 2/5 段');
    assert(buildTransSystem({}, 'en', 'daily', 0, 0).indexOf('分段说明') === -1, '单段不该有分段说明');
    return 'ok';
  });

  t('三套模式提示词各不相同且都非空', () => {
    for (const [n, v] of [['ANSWER', ANSWER_SYS], ['ANSWER_EXPLAIN', ANSWER_EXPLAIN_SYS], ['TERM', TERM_SYS]]) {
      assert(v && v.length > 50, n + ' 太短');
    }
    assert(ANSWER_SYS !== ANSWER_EXPLAIN_SYS, '两套答案提示词不能一样');
    has(TERM_SYS, '译法：');
    return 'ok';
  });

  t('预设：五颗、id 不重、都有说明', () => {
    eq(PROMPT_PRESETS.length, 5);
    const ids = new Set(PROMPT_PRESETS.map(p => p.id));
    eq(ids.size, 5, 'id 有重的');
    PROMPT_PRESETS.forEach(p => { assert(p.name && p.hint, p.id + ' 少了名字或说明'); });
    return PROMPT_PRESETS.map(p => p.name).join('/');
  });
}

console.log('\n[3] 引擎：翻译、降级、报错说人话');
{
  const oaStub = (answer) => fakeFetch((url, init) => {
    if (url.indexOf('/chat/completions') === -1) return { status: 404, body: 'no' };
    const body = JSON.parse(init.body);
    return { body: { choices: [{ message: { content: answer }, finish_reason: 'stop' }], _sys: body.messages[0].content } };
  });

  await ta('OpenAI 兼容接口：拿到译文', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', prompt: '' } });
    const { e } = mkEngine(st, (url, init) => ({ body: { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] } }));
    const r = await e.translate('hello', {});
    eq(r.ok, true);
    eq(r.translated, '你好');
    eq(r.dir, '英 → 中');
    return r.ms + 'ms';
  });

  await ta('模型说「这不是文字」时，不当成译文端上去', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e } = mkEngine(st, () => ({ body: { choices: [{ message: { content: '[[NOT_TEXT]]' }, finish_reason: 'stop' }] } }));
    const r = await e.translate('WEHESIeIeEald#E', {});
    eq(r.ok, false);
    eq(r.notText, true);
    has(r.error, '不像正常');
    return '有话说';
  });

  await ta('被长度截断的译文会被标出来', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e } = mkEngine(st, () => ({ body: { choices: [{ message: { content: 'half sentence' }, finish_reason: 'length' }] } }));
    const r = await e.translate('半句话', {});
    eq(r.truncated, true);
    return 'ok';
  });

  await ta('主引擎挂了 → 自动退到免费引擎，并如实说', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e } = mkEngine(st, (url) => {
      if (url.indexOf('mymemory') !== -1) return { body: { responseData: { translatedText: '免费译文' } } };
      return { status: 500, body: 'boom' };
    });
    const r = await e.translate('hello', {});
    eq(r.ok, true);
    eq(r.translated, '免费译文');
    has(r.degraded, '免费引擎');
    return r.degraded;
  });

  await ta('两条路都断 → 报「网络」而不是「余额不足」', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e } = mkEngine(st, () => undefined);   /* 全抛 failed to fetch */
    let err = null;
    try { await e.translate('hello', {}); } catch (e2) { err = e2; }
    assert(err, '应该抛错');
    eq(err.bothFailed, true);
    const msg = humanEngineError(err, 'translate');
    has(msg, '网络');
    assert(msg.indexOf('余额不足') === -1, '不该说成余额不足');
    return '说清了';
  });

  await ta('做题/术语没有免费替代，报错时会说清', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e } = mkEngine(st, () => ({ status: 429, body: 'rate' }));
    let err = null;
    try { await e.translate('1. A 2. B', { mode: 'answer' }); } catch (e2) { err = e2; }
    const msg = humanEngineError(err, 'answer');
    has(msg, '限流');
    has(msg, '没有免费替代');
    return 'ok';
  });

  t('报错对照表逐条验', () => {
    const cases = [
      ['API HTTP 402：insufficient balance', '余额不足'],
      ['API HTTP 401：unauthorized', 'API Key'],
      ['API HTTP 403：forbidden', '权限'],
      ['API HTTP 404：model not found', '地址或模型名'],
      ['API HTTP 429：too many', '限流'],
      ['API HTTP 503：bad gateway', '服务商那边'],
      ['API HTTP 418：teapot', 'HTTP 418'],
      ['没有填 API Key', '没有填 API Key'],
      ['failed to fetch', '连不上'],
      ['MyMemory HTTP 502', '免费引擎']
    ];
    for (const [raw, expect] of cases) {
      const m = humanEngineError(new Error(raw), 'translate');
      assert(m.indexOf(expect) !== -1, raw + ' → 期望包含「' + expect + '」，实得「' + m + '」');
    }
    return cases.length + ' 条';
  });

  t('缓存键：凡影响结果的都进键', () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'a', apiKey: 'k', model: 'm', prompt: '' } });
    const opt = { text: 'same text', explain: 0 };
    const k0 = cacheKey(st, opt, 'translate', 'en');
    const s2 = JSON.parse(JSON.stringify(st)); s2.transStyle = 'lit';
    const s3 = JSON.parse(JSON.stringify(st)); s3.engine = 'local';
    const s4 = JSON.parse(JSON.stringify(st)); s4.openai.prompt = 'role';
    const s5 = JSON.parse(JSON.stringify(st)); s5.targetMode = 'zh';
    const s6 = JSON.parse(JSON.stringify(st)); s6.openai.model = 'm2';
    const other = [
      ['风格', cacheKey(s2, opt, 'translate', 'en')],
      ['引擎', cacheKey(s3, opt, 'translate', 'en')],
      ['提示词', cacheKey(s4, opt, 'translate', 'en')],
      ['方向', cacheKey(s5, opt, 'translate', 'en')],
      ['模型', cacheKey(s6, opt, 'translate', 'en')],
      ['解析开关', cacheKey(st, { text: 'same text', explain: 1 }, 'answer', 'en')],
      ['模式', cacheKey(st, opt, 'answer', 'en')],
      ['文本', cacheKey(st, { text: 'other text', explain: 0 }, 'translate', 'en')]
    ];
    for (const [name, k] of other) assert(k !== k0, name + ' 没进缓存键');
    assert(cacheKey(st, { text: 'same text', explain: 0 }, 'translate', 'en') === k0, '同输入应当同键');
    /* 解析开关只在做题模式下影响结果，所以它必须只在那条路上分开 */
    assert(cacheKey(st, { text: 'same text', explain: 1 }, 'answer', 'en') !== cacheKey(st, { text: 'same text', explain: 0 }, 'answer', 'en'), '做题模式下解析开关没进键');
    return other.length + 2 + ' 项都分开了';
  });

  await ta('命中缓存就不重复请求', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    const { e, f } = mkEngine(st, () => ({ body: { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] } }));
    await e.translate('hello', {});
    const r2 = await e.translate('hello', {});
    eq(r2.cached, true);
    eq(f.calls.length, 1, '第二次不该再请求');
    return '1 次请求';
  });

  await ta('做题模式：只走答题提示词、答案原样回来', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    let sys = '';
    const { e } = mkEngine(st, (url, init) => {
      sys = JSON.parse(init.body).messages[0].content;
      return { body: { choices: [{ message: { content: 'BDACA\nu 3' }, finish_reason: 'stop' }] } };
    });
    const r = await e.translate('1. A 2. B', { mode: 'answer' });
    eq(r.ok, true);
    eq(r.mode, 'answer');
    eq(r.answer, 'BDACA\nu 3');
    eq(r.dir, '答题');
    has(sys, '答题助手');
    assert(sys.indexOf('你是专业翻译') === -1, '做题不该用翻译那套');
    return 'ok';
  });

  await ta('术语模式走术语提示词', async () => {
    const st = baseSettings({ engine: 'openai', openai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } });
    let sys = '';
    const { e } = mkEngine(st, (url, init) => {
      sys = JSON.parse(init.body).messages[0].content;
      return { body: { choices: [{ message: { content: '译法：x\n备选：y\n说明：z' }, finish_reason: 'stop' }] } };
    });
    await e.translate('全过程人民民主', { mode: 'term' });
    has(sys, '术语助手');
    return 'ok';
  });

  await ta('本地服务引擎：读 text/translated/result 哪个都行', async () => {
    const st = baseSettings({ engine: 'local', local: { url: 'http://127.0.0.1:9/translate' } });
    const { e } = mkEngine(st, () => ({ body: { translated: '本地译文' } }));
    const r = await e.translate('hello', {});
    eq(r.translated, '本地译文');
    return 'ok';
  });
}

console.log('\n[4] 剪贴板闸门');
{
  t('像密钥的一串认得出来', () => {
    const yes = [
      'gho_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
      'a'.repeat(40),
      'AbCdEf0123456789AbCdEf0123456789',
      '-----BEGIN RSA PRIVATE KEY-----',
      'sk-' + 'x'.repeat(40)
    ];
    const no = ['Hello world', 'abc', '这是一段中文', 'The quick brown fox jumps over the lazy dog.'];
    for (const v of yes) assert(looksLikeSecret(v), '该判成密钥：' + v.slice(0, 20));
    for (const v of no) assert(!looksLikeSecret(v), '不该判成密钥：' + v.slice(0, 20));
    return yes.length + ' 正 / ' + no.length + ' 反';
  });

  t('单个网址不翻', () => {
    assert(isUrlOnly('https://example.com/a?b=1'));
    assert(!isUrlOnly('看这个 https://example.com'));
    return 'ok';
  });

  t('闸门表：每种「不发」的情形都对得上', () => {
    const o = { minLen: 2, maxLen: 10, auto: true, paused: false, guard: true, ownWrites: new Set(), lastSeen: '' };
    const cases = [
      ['', o, {}, 'empty'],
      ['hello', Object.assign({}, o, { lastSeen: 'hello' }), {}, 'unchanged'],
      ['hello', Object.assign({}, o, { ownWrites: new Set(['hello']) }), {}, 'own-write'],
      ['hello', Object.assign({}, o, { paused: true }), {}, 'paused'],
      ['hello', Object.assign({}, o, { auto: false }), {}, 'manual'],
      ['gho_' + 'a'.repeat(30), o, {}, 'secret'],
      ['https://a.b', o, {}, 'url'],
      ['a', o, {}, 'too-short'],
      ['x'.repeat(20), o, {}, 'too-long'],
      ['hello', o, { lang: 'unknown' }, 'no-text'],
      ['hello', o, {}, 'new-text']
    ];
    for (const [text, opt, state, expect] of cases) {
      const d = decide(text, state, opt);
      eq(d.reason, expect, JSON.stringify(text).slice(0, 16));
    }
    return cases.length + ' 例';
  });

  t('跳过原因都有话说（该静默的保持静默）', () => {
    has(SKIP_TEXT['secret'], '密钥');
    has(SKIP_TEXT['too-long'], '太长');
    eq(SKIP_TEXT['unchanged'], '');
    eq(SKIP_TEXT['manual'], '');
    return 'ok';
  });

  await ta('看守：串行喂文本，只翻新内容，自己写的不回环', async () => {
    let text = 'first message';
    const seen = [];
    const w = createClipWatcher({
      /* 故意用 async：Electron 40+ 的剪贴板读取就是 Promise，
         当同步用的话会拿到 [object Promise]——那样「复制了字它什么都不做」。 */
      readText: async () => text,
      intervalMs: 10,
      getOpt: (t) => ({ minLen: 2, maxLen: 200, auto: true, paused: false, guard: true, lang: detectLang(t || '') }),
      onDecide: (d, txt) => seen.push(d.action + ':' + d.reason + ':' + txt)
    });
    await w.tick();                 /* 第一次：新内容 → 翻 */
    await w.tick();                 /* 没变 → 不动，而且不该每次都来通报一声 */
    text = 'second message';
    await w.tick();
    w.rememberOwnWrite('my own translation');
    text = 'my own translation';
    await w.tick();                 /* 自己写的 → 不动 */
    eq(w.stats.translated, 2, '应该只翻了两次');
    eq(seen.length, 3, '未变化的轮次应当静默（每 0.7 秒通报一次就是刷屏）：' + JSON.stringify(seen));
    eq(seen[2], 'skip:own-write:my own translation');
    assert(seen.every(s => s.indexOf('unchanged') === -1), 'unchanged 不该被通报');
    return JSON.stringify(w.stats);
  });

  await ta('看守：语言判定看的是「刚复制进来的这段」，不是上一段', async () => {
    /* 踩过：拿上一次翻过的文本去判语言，启动后第一次复制就被当成「没认出可翻的文字」跳过了 */
    const seen = [];
    let text = 'Hello there';
    const w = createClipWatcher({
      readText: async () => text,
      intervalMs: 10,
      /* 这份 getOpt 故意「用参数里的 t」——正是主进程那份的写法 */
      getOpt: (t) => ({ minLen: 2, maxLen: 200, auto: true, paused: false, guard: true, lang: detectLang(t || '') }),
      onDecide: (d) => seen.push(d.reason)
    });
    await w.tick();
    eq(seen[0], 'new-text', '第一次复制就该翻：' + JSON.stringify(seen));
    return 'ok';
  });

  await ta('看守：读出来是 Promise 也不会把 [object Promise] 当正文', async () => {
    let text = 'promise based read';
    const got = [];
    const w = createClipWatcher({
      readText: () => Promise.resolve(text),
      intervalMs: 10,
      getOpt: (t) => ({ minLen: 2, maxLen: 200, auto: true, paused: false, guard: true, lang: detectLang(t || '') }),
      onDecide: (d, txt) => got.push(txt)
    });
    await w.tick();
    eq(w.lastSeen, 'promise based read', '没把 Promise 解开');
    assert(got[0].indexOf('object Promise') === -1, '把 [object Promise] 当成正文了');
    return w.lastSeen;
  });
}

console.log('\n[5] 设置与存储');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidtrans-store-'));
  t('嵌套设置合并：改一个字段不会把同组其它字段冲掉', () => {
    const s = createStore({ dir, defaults: DEFAULT_SETTINGS });
    s.patchSettings({ openai: { model: 'new-model' } });
    const g = s.getSettings();
    eq(g.openai.model, 'new-model');
    eq(g.openai.baseUrl, DEFAULT_SETTINGS.openai.baseUrl, 'baseUrl 被冲掉了');
    eq(g.engine, DEFAULT_SETTINGS.engine);
    return 'ok';
  });

  t('落盘之后重开还是那些设置', () => {
    const s = createStore({ dir, defaults: DEFAULT_SETTINGS });
    s.patchSettings({ panelTheme: 'dark', clip: { maxLen: 1234 } });
    const s2 = createStore({ dir, defaults: DEFAULT_SETTINGS });
    eq(s2.getSettings().panelTheme, 'dark');
    eq(s2.getSettings().clip.maxLen, 1234);
    eq(s2.getSettings().clip.auto, DEFAULT_SETTINGS.clip.auto, '没写过的字段要回到默认');
    return 'ok';
  });

  t('缓存：写进去读得出来，过期的读不出来', () => {
    const s = createStore({ dir, defaults: DEFAULT_SETTINGS });
    s.cache.put('k1', { ok: true, translated: 'v' });
    eq(s.cache.get('k1').translated, 'v');
    /* 手工把时间戳改成 11 分钟前，再开一个 store 读盘 */
    const f = path.join(dir, 'cache.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.k2 = { t: Date.now() - 11 * 60 * 1000, v: { ok: true } };
    fs.writeFileSync(f, JSON.stringify(raw), 'utf8');
    const s2 = createStore({ dir, defaults: DEFAULT_SETTINGS });
    eq(s2.cache.get('k1').translated, 'v', '没过期的该在');
    eq(s2.cache.get('k2'), null, '过期的该被扔掉');
    return 'ok';
  });

  t('出错记录：只留最近 60 条、单条截断', () => {
    const s = createStore({ dir, defaults: DEFAULT_SETTINGS });
    for (let i = 0; i < 70; i++) s.noteFail('step' + i, 'x'.repeat(400));
    const log = s.getLog();
    eq(log.length, 60, '应该只留 60 条');
    eq(log[0].step, 'step10');
    assert(log[0].d.length <= 240, '单条该截断');
    return log.length + ' 条';
  });

  t('临时目录用完就删', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    return 'ok';
  });
}

console.log('\n[6] 截图坐标换算');
{
  t('逻辑坐标 × 比例 = 图像像素', () => {
    const r = scaleRect({ x: 10, y: 20, w: 100, h: 50 }, 1.5, 3000, 2000);
    eq(JSON.stringify(r), JSON.stringify({ x: 15, y: 30, width: 150, height: 75 }));
    return JSON.stringify(r);
  });

  t('拖到画面外会被夹回图里，且至少 1 像素', () => {
    const r = scaleRect({ x: -30, y: -5, w: 40, h: 40 }, 2, 800, 600);
    eq(r.x, 0);
    eq(r.y, 0);
    assert(r.width > 0 && r.height > 0, '不能是 0');
    const r2 = scaleRect({ x: 790, y: 590, w: 100, h: 100 }, 2, 800, 600);
    assert(r2.x + r2.width <= 800, '右边超界了：' + JSON.stringify(r2));
    assert(r2.y + r2.height <= 600, '下边超界了：' + JSON.stringify(r2));
    return 'ok';
  });
}

console.log('\n[7] OCR 依赖（vendor）');
{
  t('vendor 里的四个文件都在、大小对得上', () => {
    let out = '';
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync_vendor.mjs'), '--check'], { encoding: 'utf8' });
    } catch (e) {
      throw new Error('缺文件 —— 先跑 npm run vendor（' + String(e.stdout || e.message).trim().split('\n').pop() + '）');
    }
    const line = out.trim().split('\n').pop();
    return line;
  });
}

console.log('\n============================');
console.log('自检结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  · ' + f));
}
console.log('');
process.exit(fail ? 1 : 0);
