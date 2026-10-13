/* 旁译桌面版 · 本地存储
 *
 * 三样东西，分三个文件，都是明文 JSON：
 *   settings.json  设置（含 API key —— 只落在本机，不进仓库）
 *   cache.json     翻译结果缓存（10 分钟，封顶 120 条）
 *   errlog.json    出错记录：只记「哪一步、什么错」，**绝不记内容**
 *
 * 不引第三方库：这点量自己读写就够，少一个依赖少一处要审的东西。
 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL = 10 * 60 * 1000;   /* 十分钟：跟浏览器版一致 */
const CACHE_MAX = 120;
const LOG_MAX = 60;

function readJson(file, fallback) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(t);
    return (v && typeof v === 'object') ? v : fallback;
  } catch (e) { return fallback; }
}

function writeJson(file, val) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    /* 先写临时文件再改名：写到一半被杀不会留下半截 JSON */
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(val, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    const bv = out[k], ov = over[k];
    if (bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv) && !Array.isArray(ov)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

export function createStore({ dir, defaults }) {
  const files = {
    settings: path.join(dir, 'settings.json'),
    cache: path.join(dir, 'cache.json'),
    log: path.join(dir, 'errlog.json')
  };
  let settings = deepMerge(defaults, readJson(files.settings, {}));

  function getSettings() { return settings; }

  function patchSettings(patch, { persist = true } = {}) {
    settings = deepMerge(settings, patch);
    if (persist) writeJson(files.settings, settings);
    return settings;
  }

  function replaceSettings(next, { persist = true } = {}) {
    settings = deepMerge(defaults, next);
    if (persist) writeJson(files.settings, settings);
    return settings;
  }

  /* ---- 缓存：内存里存一份，顺手落盘，重启后还在 ---- */
  let cache = readJson(files.cache, {});
  function cacheGet(key) {
    const it = cache[key];
    if (it && Date.now() - it.t < CACHE_TTL) return it.v;
    if (it) { delete cache[key]; }
    return null;
  }
  function cachePut(key, val) {
    const now = Date.now();
    const next = {};
    for (const k of Object.keys(cache)) if (now - cache[k].t < CACHE_TTL) next[k] = cache[k];
    const keys = Object.keys(next);
    if (keys.length >= CACHE_MAX) {
      keys.sort((a, b) => next[a].t - next[b].t).slice(0, keys.length - CACHE_MAX + 1).forEach(k => { delete next[k]; });
    }
    next[key] = { t: now, v: val };
    cache = next;
    writeJson(files.cache, cache);
  }
  function cacheClear() { cache = {}; writeJson(files.cache, cache); }

  /* ---- 出错记录：只记步骤与错误，不记内容 ---- */
  let log = readJson(files.log, []);
  function noteFail(step, detail, extra) {
    log.push(Object.assign({
      t: Date.now(),
      step: String(step || '?'),
      d: String(detail == null ? '' : detail).slice(0, 240)
    }, extra || {}));
    log = log.slice(-LOG_MAX);
    writeJson(files.log, log);
  }
  function getLog() { return log.slice(); }
  function clearLog() { log = []; writeJson(files.log, log); }

  return {
    files, getSettings, patchSettings, replaceSettings,
    cache: { get: cacheGet, put: cachePut, clear: cacheClear },
    noteFail, getLog, clearLog
  };
}
