/* 旁译桌面版 · 几何换算（纯函数，不碰 Electron）
 *
 * 单独放一个文件是为了能被 node 直接测：capture.js 里那部分要 import electron，
 * 一旦引进来，纯 node 的自检就跑不动了。算术归算术，窗口归窗口。
 */

/* 逻辑坐标 → 图像像素。截图返回的图不一定是显示器的物理分辨率
   （desktopCapturer 可能给缩略图），所以必须按「图宽 / 显示器逻辑宽」这个比例换算，
   不能拿 devicePixelRatio 硬乘。
   区域还要夹回图像范围内：从边缘往外拖会算到负数或超出边界。 */
export function scaleRect(rect, ratio, imgW, imgH) {
  const x = Math.round(rect.x * ratio);
  const y = Math.round(rect.y * ratio);
  const w = Math.round(rect.w * ratio);
  const h = Math.round(rect.h * ratio);
  const x0 = Math.max(0, Math.min(x, imgW - 1));
  const y0 = Math.max(0, Math.min(y, imgH - 1));
  const x1 = Math.max(x0 + 1, Math.min(x0 + w, imgW));
  const y1 = Math.max(y0 + 1, Math.min(y0 + h, imgH));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* 太小的框多半是手滑，取不出字 */
export const MIN_REGION = 8;
