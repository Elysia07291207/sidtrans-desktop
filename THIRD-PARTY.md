# 来源与第三方组件

## 灵感与交互来源

旁译桌面版的**交互想法**来自 [FlashTrans](https://github.com/chai1220/FlashTrans)（作者 chai1220，**MIT 许可**）：
一个用 Tauri + Rust 写的桌面翻译程序——划词、浮层落在选区旁边、不打断手上的事。

这一版的定位与它的差别：

| | FlashTrans | 旁译（浏览器版） | 旁译桌面版（本仓库） |
|---|---|---|---|
| 形态 | 桌面程序（Tauri） | 浏览器扩展（页面内浮层） | 桌面悬浮球（Electron） |
| 取词 | 全局热键 + 置顶小窗 | 页面内划词 | 剪贴板 / 截屏取字 |
| 会不会抢焦点 | 会 | 不抢（待在页面里） | 不抢（球在旁边） |

**本仓库不含 FlashTrans 的代码**，是照着它的交互重新实现的。它的 MIT 许可允许这样使用，
这里明确保留署名与许可声明。

## 构建产物里打包的第三方组件

本仓库的**源码**不含第三方代码。`scripts/sync_vendor.mjs` 会把下面这些从 `node_modules`
搬进 `vendor/`（`vendor/` 不入库，跟浏览器版把语言数据排除在外是同一个道理）：

| 组件 | 许可 | 用途 |
|---|---|---|
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | 本地 OCR 引擎（WASM） |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | Apache-2.0 | wasm 内核 |
| [@tesseract.js-data/chi_sim, eng](https://github.com/naptha/tessdata) | Apache-2.0 | 中英文字识别模型 |
| [Electron](https://github.com/electron/electron) | MIT | 桌面外壳（作为开发依赖，打包时随产物分发） |

## 测试用的固定样本

- `test/fixtures/zh.png` —— 一句中文 + 一句英文 + 一个年份的小图。
  它是旁译项目一直用来当 OCR 尺子的那张样本（浏览器侧的历史记录是准度 92），
  本仓库沿用同一张，好让两边的数字能直接对上。
- `scripts/text_image.mjs` 里的 5×7 点阵字是自写的，只覆盖自检要用的字符，
  用于「自己画一张有字的图，再看 OCR 能不能认回来」——这样图里是什么由我确定，
  不拿实现去证明实现。

## 授权

本项目 MIT，见 [LICENSE](LICENSE)。上面的第三方组件各自遵循自己的许可。
