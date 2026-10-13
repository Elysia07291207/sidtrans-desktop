/* 旁译桌面版 · OCR 结果清理
 *
 * Tesseract 认中文时会在字与字之间插空格（"网 上 共 青 团"），
 * 直接显示很难看，也不像人写的中文。这里把汉字之间的空格去掉，
 * 真正的换行和英文单词之间的空格保留。
 *
 * 单独放一个文件是为了能被 node 直接测——它原来长在 ui/ocr.js 里，
 * 而那个文件一 import electron 就跑不动了。规则本身跟浏览器版一字不差。
 */

const CJK = '[\\u3400-\\u9fff\\u3040-\\u30ff\\uff00-\\uffef]';
const RE_CJK_SPACE = new RegExp('(' + CJK + ')\\s+(?=' + CJK + ')', 'g');

/* 识别用哪几个语言，以及**顺序**。
   顺序不是随手写的：实测（node 侧，中英两张图各跑一遍）
     eng+chi_sim → 英文图 conf 50、中文图 conf 92
     chi_sim+eng → 英文图 conf 18（第二个语言根本没加载上）、中文图 conf 91
   同一个 bug 在浏览器宿主里不一定触发，但两种顺序下中文结果一样好，
   那么选那个两边都不亏的。数据在 test/ocr_engine.mjs 里可复现。 */
export const OCR_LANGS = ['eng', 'chi_sim'];

export function tidyOcr(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .replace(RE_CJK_SPACE, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 准度太低的时候要说一句：结果只能当参考。
   浏览器版是这么做的，桌面版照旧——认错了却不吭声比认错更麻烦。 */
export function confNote(conf) {
  if (conf == null || !isFinite(conf)) return '';
  if (conf < 50) return '准度 ' + Math.round(conf) + '，结果只能当参考';
  return '准度 ' + Math.round(conf);
}
