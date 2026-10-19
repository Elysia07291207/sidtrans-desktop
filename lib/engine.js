/* 旁译桌面版 · 翻译引擎
 *
 * 从浏览器版 background.js 的 translate / engine* / humanEngineError 搬过来的。
 * 搬的时候只做了一件事：把 chrome.* 摘掉（桌面没有那套 API），
 * 换成注入进来的 fetch / 设置 / 缓存 / 日志。三段提示词原样留在 prompts.js。
 *
 * 为什么值得搬：
 *   · 「降级 + 报错说人话」这套是踩出来的（402 说充值、401 说换 key、
 *     两条路都断就直说是网络），重写一遍只会退步；
 *   · 缓存键那条规矩（凡影响结果的都进键）是错了三次才总结出来的。
 * 所以这里基本是原样搬家，不是重写。
 */

import {
  ANSWER_SYS, ANSWER_EXPLAIN_SYS, TERM_SYS, buildTransSystem,
  NOT_TEXT_RE, NOT_TEXT_MSG
} from './prompts.js';

export const DEFAULT_SETTINGS = {
  engine: 'mymemory',        // mymemory | openai | local
  targetMode: 'auto',        // auto（双向） | zh | en
  actionMode: 'translate',   // translate | answer | term
  answerExplain: 'off',      // off | on
  transStyle: 'daily',       // daily | lit
  panelTheme: 'light',       // light | dark
  sound: true,               // 浮层落座时响一声（合成，不用音频文件）
  maxLen: 8000,
  clip: {
    auto: true,              // 剪贴板变了就译（这是桌面版的主路径）
    paused: false,           // 临时暂停，不丢设置
    minLen: 2,
    maxLen: 2000,            // 自动翻译的上限：太长的多半是整篇文章，不该突然弹出来
    intervalMs: 700
  },
  orb: { x: null, y: null, size: 44 },
  /* 划词即译（实验，默认关）：拖选 / 双击选词之后自动取词。
     关着的理由：它会在别的程序里发一次 Ctrl+C 去读选中，属于「动了她的东西」——
     得她点头才开。 */
  pick: {
    enabled: false,
    method: 'auto',        // auto（先读选中，读不到才复制）| uia（只读选中）| clipboard（复制）
    needKey: '',           // '' | alt | ctrl | shift：拖选时得按住它才取词
    minLen: 3,
    maxLen: 2000,
    minDrag: 6,
    delayMs: 150,
    doubleClick: true,
    skipApps: 'explorer'   // 资源管理器里拖一下是拖文件，不是选字
  },
  shortcuts: { clip: 'Control+Alt+T', shot: 'Control+Alt+S', orb: 'Control+Alt+O' },
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    prompt: ''
  },
  local: { url: 'http://127.0.0.1:8787/translate' }
};

/* ---------- 语言判定：中日韩表意文字 vs 拉丁字母 ---------- */
export function detectLang(s) {
  const cjk = (String(s).match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && latin === 0) return 'unknown';
  return cjk >= latin ? 'zh' : 'en';
}

/* ---------- 方向：auto 就是「双向自动切换」 ---------- */
export function pairFor(src, mode) {
  if (mode === 'zh') return { from: src === 'zh' ? 'zh-CN' : 'en', to: 'zh-CN' };
  if (mode === 'en') return { from: src === 'zh' ? 'zh-CN' : 'en', to: 'en' };
  if (src === 'zh') return { from: 'zh-CN', to: 'en' };
  return { from: 'en', to: 'zh-CN' };
}

export function dirLabel(from, to) {
  const a = from === 'en' ? '英' : '中';
  const b = to === 'en' ? '英' : '中';
  return a + ' → ' + b;
}

/* ---------- 结果缓存的键 ----------
   同一段反复翻，不必反复花钱、反复等。
   ⚠️ 缓存键要把「会影响结果的东西」全带上。浏览器版在这上面栽过三次：
   漏过提示词/模型/地址，漏过解析开关——每次的症状都是「看着像没生效」。
   新增任何影响结果的设置项，先回来把它加进这里。 */
export function hkey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + s.length;
}

export function cacheKey(s, opt, mode, src) {
  const p = pairFor(src, s.targetMode);
  const oc = s.openai || {};
  return hkey([
    mode,
    s.transStyle || 'daily',
    s.engine,
    (mode === 'answer' && opt.explain) ? 'explain' : '',
    s.engine === 'openai' ? ((oc.baseUrl || '') + '|' + (oc.model || '') + '|' + (oc.prompt || '')) : '',
    s.engine === 'local' ? ((s.local && s.local.url) || '') : '',
    p.from, p.to, s.targetMode, String(opt.text || '')
  ].join('\u0001'));
}

/* ---------- 引擎 1：MyMemory（免费在线，无需 key） ---------- */
async function engineMyMemory(fetchImpl, text, from, to) {
  const url = 'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) + '&langpair=' + encodeURIComponent(from + '|' + to);
  const r = await fetchImpl(url, { method: 'GET' });
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const j = await r.json();
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t) throw new Error('MyMemory 没有返回译文');
  return { text: String(t), engine: 'MyMemory' };
}

/* ---------- 引擎 2：OpenAI 兼容接口（BYOK） ---------- */
async function engineOpenAI(fetchImpl, text, from, to, cfg, part, total, mode, style, explain) {
  if (!cfg || !cfg.baseUrl) throw new Error('没有配置 API 地址');
  if (!cfg.apiKey) throw new Error('没有填 API Key');
  const answering = mode === 'answer';
  const terming = mode === 'term';
  let sys;
  if (answering) {
    sys = explain ? ANSWER_EXPLAIN_SYS : ANSWER_SYS;
  } else if (terming) {
    sys = TERM_SYS;
  } else {
    sys = buildTransSystem(cfg, to, style, part, total);
  }
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text }
    ],
    temperature: (answering || terming) ? 0 : 0.2,
    stream: false
  };
  /* ⚠️ 不要在这里卡 max_tokens。
     卡过 400，本意是「答案就几个字，别多吐」——但「会思考」的模型思考也算在
     max_tokens 里：实测 400 和 2000 都被思考吃光，finish_reason=length、content 空。
     这条在浏览器版上真实咬过人（「翻译正常、做题失败」的根源），照搬保留。 */
  const r = await fetchImpl(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  if (!r.ok) throw new Error('API HTTP ' + r.status + '：' + raw.slice(0, 140));
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new Error('API 返回不是 JSON：' + raw.slice(0, 140)); }
  const ch0 = j.choices && j.choices[0];
  const t0 = ch0 && ch0.message && ch0.message.content;
  if (!t0) {
    /* 正文空、思考非空 = 预算全花在思考上了。说清楚，别让她以为是自己配错了。 */
    const think = ch0 && ch0.message && ch0.message.reasoning_content;
    if (ch0 && ch0.finish_reason === 'length' && think) {
      throw new Error('模型把回复长度全用在思考上了，正文一个字没留下（换个不带思考的模型，或者把这一段拆短些）');
    }
    throw new Error('API 没有返回内容');
  }
  const raw0 = String(t0).trim();
  /* finish_reason=length 的意思是「模型还没写完就被截断了」。
     以前不看它：正文有字就当完整结果端上去——半句译文看上去跟完整译文一模一样。 */
  const truncated = !!(ch0 && ch0.finish_reason === 'length');
  if (NOT_TEXT_RE.test(raw0)) return { text: '', notText: true, engine: cfg.model || 'API' };
  const t = raw0.replace(NOT_TEXT_RE, '').trim();
  if (!t) throw new Error('API 没有返回内容');
  return { text: t, engine: cfg.model || 'API', truncated: truncated };
}

/* ---------- 引擎 3：本地服务（离线，POST {text,from,to}） ---------- */
async function engineLocal(fetchImpl, text, from, to, cfg) {
  if (!cfg || !cfg.url) throw new Error('没有配置本地服务地址');
  const r = await fetchImpl(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text, from: from, to: to })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error('本地引擎 HTTP ' + r.status + '：' + raw.slice(0, 140));
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new Error('本地引擎返回不是 JSON'); }
  const t = j.text || j.translated || j.result || j.translation;
  if (!t) throw new Error('本地引擎没有返回译文');
  return { text: String(t), engine: j.engine || '本地模型' };
}

/* ---------- 报错说人话 ----------
   她看到的不是状态码，是「接下来该干嘛」。
   原始返回体不丢（诊断日志里记着），屏幕上只留一句能照做的。
   做题 / 术语没有免费替代——这两条路本来就没退路，得说清楚。 */
export function humanEngineError(err, mode) {
  const raw = String((err && err.message) || err || '');
  const noFree = (mode === 'answer' || mode === 'term')
    ? '　（做题和术语没有免费替代，得先让 API 能用。）' : '';
  if (err && err.bothFailed) {
    return 'API 和免费引擎都没通。多半是网络或代理的问题——先确认这台机器能正常打开网页。' + noFree;
  }
  const mc = /API HTTP (\d{3})/.exec(raw);
  const code = mc ? parseInt(mc[1], 10) : 0;
  const low = raw.toLowerCase();
  if (code === 402 || low.indexOf('insufficient balance') !== -1 ||
      low.indexOf('insufficient_quota') !== -1 || low.indexOf('余额') !== -1) {
    return 'API 账户余额不足（402）。去服务商那边充值；只想翻译的话，把引擎切成「免费在线」也能用。' + noFree;
  }
  if (code === 401) return 'API Key 不对或已失效（401）。去设置里换一个。' + noFree;
  if (code === 403) return '这个 Key 没权限或该模型没开（403）。去设置里看一眼。' + noFree;
  if (code === 404) return 'API 地址或模型名不对（404）。核对设置里的接口地址与模型。' + noFree;
  if (code === 429) return '请求太密被限流了（429）。等十几秒，或者把「最长划词」调小一点。' + noFree;
  if (code >= 500) return '服务商那边出问题了（HTTP ' + code + '）。不是你的错，过一会儿再试。' + noFree;
  if (code) return 'API 返回 HTTP ' + code + '。原始信息：' + raw.replace(/^API HTTP \d+[：:]?/, '').slice(0, 120);
  if (/没有配置 API 地址|没有填 API Key/.test(raw)) return raw;
  if (/failed to fetch|networkerror|network error|load failed|连接|timed ?out|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return '连不上 API 地址。检查网络或代理；只想翻译的话，把引擎切成「免费在线」。' + noFree;
  }
  if (/MyMemory HTTP \d+/.test(raw)) {
    return '免费引擎那边也不通（' + /MyMemory HTTP \d+/.exec(raw)[0] + '）。等会儿再试，或者把引擎切到 API。';
  }
  return raw.slice(0, 160) + noFree;
}

/* ---------- 工厂：把外部依赖注进来，浏览器/桌面/测试三处都能用同一份逻辑 ---------- */
export function createEngine({ getSettings, cache, noteFail, fetchImpl } = {}) {
  const F = fetchImpl || globalThis.fetch;
  const getS = getSettings || (() => DEFAULT_SETTINGS);
  const C = cache || { get: () => null, put: () => {} };
  const note = noteFail || (() => {});

  async function translate(text, opt) {
    opt = opt || {};
    const s = getS();
    const mode = (opt.mode === 'answer' || opt.mode === 'term') ? opt.mode : 'translate';
    /* 方向按整篇定：调用方会把整篇的语言判断传下来，
       免得某一段里数字多了自己翻个方向、整篇中英混杂。 */
    const src = opt.srcHint || detectLang(text);
    const p = pairFor(src, s.targetMode);
    const ck = cacheKey(s, Object.assign({ text: text }, opt), mode, src);
    const hit = C.get(ck);
    if (hit) return Object.assign({}, hit, { cached: true });

    let out, degraded = '';
    const t0 = Date.now();
    try {
      if (s.engine === 'openai') {
        out = await engineOpenAI(F, text, p.from, p.to, s.openai, opt.partIndex || 0, opt.partCount || 0,
          mode, s.transStyle, mode === 'answer' && !!opt.explain);
      } else if (s.engine === 'local') {
        out = await engineLocal(F, text, p.from, p.to, s.local);
      } else {
        out = await engineMyMemory(F, text, p.from, p.to);
      }
    } catch (err) {
      /* 主引擎挂了（断网 / 额度用完 / 服务抖）。考场上这是致命的，不能就这么干等。
         翻译还能退到免费引擎；做题和术语没有免费替代，如实报错。 */
      note('engine', (err && err.message) || err, { mode: mode, engine: s.engine, host: opt.host || '' });
      if (s.engine === 'openai' && mode === 'translate') {
        try {
          const alt = await engineMyMemory(F, text, p.from, p.to);
          out = { text: alt.text, engine: alt.engine };
          degraded = 'DeepSeek 不通，已自动换免费引擎';
        } catch (err2) {
          note('fallback-fail', (err2 && err2.message) || err2, { mode: mode, engine: s.engine, host: opt.host || '' });
          /* 两条路都断了。只报第一条会把「网络全断」说成「余额不足」，
             说得比实情更具体——两个事实都留着，让 humanEngineError 能看出是这种情形。 */
          const e2 = new Error('两条路都不通｜API：' + ((err && err.message) || err) +
            '｜免费引擎：' + ((err2 && err2.message) || err2));
          e2.bothFailed = true;
          throw e2;
        }
      } else {
        throw err;
      }
    }
    const ms = Date.now() - t0;

    let res;
    if (mode === 'answer' || mode === 'term') {
      /* 做题/术语里也要认「这不是文字」这个标记：以前只翻译那条看它，
         这几个模式下模型要是回了标记，会直接拿去当答案（空答案）。 */
      if (out && out.notText) {
        res = { ok: false, mode: mode, notText: true, error: NOT_TEXT_MSG, dir: dirLabel(p.from, p.to), from: p.from, to: p.to, ms: ms };
      } else {
        res = {
          ok: true, mode: mode, answer: out.text, engine: out.engine, truncated: !!out.truncated,
          dir: mode === 'answer' ? '答题' : '术语', src: src, from: p.from, to: p.to, ms: ms, degraded: degraded
        };
      }
    } else if (out && out.notText) {
      res = { ok: false, notText: true, error: NOT_TEXT_MSG, src: src, from: p.from, to: p.to, dir: dirLabel(p.from, p.to), ms: ms };
    } else {
      res = {
        ok: true, src: src, from: p.from, to: p.to, dir: dirLabel(p.from, p.to), translated: out.text,
        engine: out.engine, ms: ms, degraded: degraded, truncated: !!out.truncated
      };
    }
    /* 只缓存成功的：失败要么是环境问题，要么下次还得再试 */
    if (res.ok) C.put(ck, res);
    return res;
  }

  return { translate, humanEngineError };
}
