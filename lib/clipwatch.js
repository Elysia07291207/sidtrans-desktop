/* 旁译桌面版 · 剪贴板看守
 *
 * 桌面版的主路径：任意应用里选中、按 Ctrl+C，我们读一次剪贴板就译。
 * 这条路的好处是「零注入」——不用往别人的进程里塞东西，跨应用都能用。
 * 坏处也很真实：剪贴板什么都可能装（密码、私聊、验证码），
 * 所以「发不发出去」这件事必须有一道闸门，而且要能一句话说清它为什么不开闸。
 *
 * 这一份是纯逻辑（不碰 Electron API），所以能直接拿 node 跑测试。
 * 读剪贴板、起窗口那些都在 main.js 里。
 */

/* 看着像密钥 / 令牌的：没有空格的一整串，长度够，且只由这些字符组成。
   命中就不自动翻——不是「我们不该看」，是「这种东西翻出来对她毫无用处，
   而一旦发出去就是她的风险」。她也可以关掉这道闸（clip.guard），
   但那要她明说。 */
export function looksLikeSecret(t) {
  const s = String(t).trim();
  if (!s) return false;
  /* PEM 头要放在「有空格就不算」那道判定之前——它自己带空格。
     （自检逮到过这一点：「-----BEGIN RSA PRIVATE KEY-----」因为带空格被判成普通句子） */
  if (/-----BEGIN [A-Z ]+-----/.test(s)) return true;
  if (/^(sk|pk|gho|ghp|ghs|github_pat|xox[baprs])[-_]/i.test(s)) return true;
  if (/\s/.test(s)) return false;
  if (s.length < 24) return false;
  const hex = /^[0-9a-f]+$/i.test(s);
  const b64 = /^[A-Za-z0-9+/_\-=]+$/.test(s);
  if (hex && s.length >= 32) return true;
  if (b64 && s.length >= 32 && /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return true;
  return false;
}

/* 单一 URL：翻不了，也不该翻（翻译一个网址没有意义） */
export function isUrlOnly(t) {
  return /^https?:\/\/\S+$/i.test(String(t).trim());
}

/* 闸门本身。输入「这段字 + 上一次的状态 + 设置」，输出「发还是不发、为什么」。
   把判定做成纯函数是为了能测：所有「什么时候不该翻」的规则都在这一张表里。 */
export function decide(text, state, opt) {
  const o = Object.assign({
    minLen: 2, maxLen: 2000, auto: true, paused: false,
    guard: true, ownWrites: new Set(), lastSeen: ''
  }, opt || {});
  const raw = String(text == null ? '' : text);
  const s = raw.trim();

  if (!s) return { action: 'skip', reason: 'empty' };
  if (s === o.lastSeen) return { action: 'skip', reason: 'unchanged' };
  if (o.ownWrites.has(s)) return { action: 'skip', reason: 'own-write' };
  if (o.paused) return { action: 'skip', reason: 'paused' };
  if (!o.auto) return { action: 'skip', reason: 'manual' };
  if (o.guard && looksLikeSecret(s)) return { action: 'skip', reason: 'secret' };
  if (isUrlOnly(s)) return { action: 'skip', reason: 'url' };
  if (s.length < o.minLen) return { action: 'skip', reason: 'too-short' };
  if (s.length > o.maxLen) return { action: 'skip', reason: 'too-long' };
  if (state && state.lang === 'unknown') return { action: 'skip', reason: 'no-text' };
  return { action: 'translate', reason: 'new-text' };
}

/* 跳过原因说人话：球上闪一下的那句提示，直接用这张表。
   注意语气——这些提示都是「我看见你了，我没动」，
   不是「你操作错了」。 */
export const SKIP_TEXT = {
  'empty': '',
  'unchanged': '',
  'own-write': '',
  'manual': '',
  'paused': '剪贴板翻译已暂停',
  'secret': '这段像密钥/令牌，我没翻',
  'url': '这是个网址，不用翻',
  'too-short': '',
  'too-long': '这段太长，我没自动翻（点球手动翻）',
  'no-text': '没认出可翻的文字'
};

/* 轮询式看守（Windows 上没有「剪贴板变化」事件可订阅，只能定时读）。
   readText 由外面注入，测试里可以喂一段假序列。

   ⚠️ tick 是异步的：Electron 40+ 把剪贴板读取换成了异步 Promise
   （`clipboard.readText()` 现在返回 Promise，不是字符串）。
   我一开始当同步用，结果拿到的是 `[object Promise]`——症状是「复制了字，它什么都做".
   所以这里一律 await；调 readText 的人只需把 Promise 交回来。 */
export function createClipWatcher({ readText, onDecide, intervalMs = 700, getOpt }) {
  let timer = null;
  let lastSeen = '';
  const ownWrites = new Set();
  let stats = { ticks: 0, translated: 0, skipped: 0 };

  function rememberOwnWrite(t) {
    const s = String(t == null ? '' : t).trim();
    if (!s) return;
    ownWrites.add(s);
    if (ownWrites.size > 20) ownWrites.delete(ownWrites.values().next().value);
  }

  async function tick() {
    stats.ticks++;
    let text = '';
    try { text = (await readText()) || ''; } catch (e) { return; }
    /* 防守：万一注入方又把 Promise 交回来（版本差异），别把 [object Promise] 当成正文 */
    if (text && typeof text.then === 'function') text = (await text) || '';
    /* getOpt 会把**当前这段**传进来：语言判定必须看现在要翻的这一段，
       不能看上一段。我之前拿上一次翻译过的文本去判语言，
       结果启动后第一次复制会被当成「没认出可翻的文字」直接跳过。 */
    const o = Object.assign({}, getOpt ? getOpt(text) : {}, { ownWrites, lastSeen });
    const d = decide(text, { lang: o.lang }, o);
    if (d.action === 'skip') {
      /* unchanged 是每轮都会发生的正常情形，不进统计，免得数字被灌水 */
      if (d.reason !== 'unchanged') stats.skipped++;
      if (d.reason === 'unchanged' || d.reason === 'empty') return;
      if (onDecide) onDecide(d, text);
      return;
    }
    lastSeen = String(text).trim();
    stats.translated++;
    if (onDecide) onDecide(d, text);
  }

  return {
    start() { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, intervalMs); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,                      /* 手敲一次：测试与「立即检查」用 */
    rememberOwnWrite,
    get lastSeen() { return lastSeen; },
    set lastSeen(v) { lastSeen = String(v == null ? '' : v).trim(); },
    get stats() { return Object.assign({}, stats); }
  };
}
