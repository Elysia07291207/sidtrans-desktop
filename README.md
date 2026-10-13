# 旁译桌面版 · SideTrans Desktop

一个**脱离浏览器的悬浮球**：在 Windows 上任何一个应用里复制一段文字，球自己发现剪贴板变了就翻；
想要哪块字，拖一个框，本地 OCR 取字再翻。

> **灵感与交互设计来自 [FlashTrans](https://github.com/chai1220/FlashTrans)（chai1220，MIT 许可）。**
> FlashTrans 用 Tauri + Rust 写了一个桌面划词翻译工具，它的「浮层落在选区旁边、不打断手上的事」
> 是整个旁译系列的起点。本版是在它基础上做的桌面实现（Electron），沿用它的交互想法，
> **没有使用它的代码**；它自己的 MIT 许可允许这样用，这里明确致谢。
> 更完整的来源与第三方组件说明见 [THIRD-PARTY.md](THIRD-PARTY.md)。

---

## 先说边界（这条最容易承诺错）

桌面版**做不到**「选中文字就自动弹出来」。

那需要在每个应用里做注入，或者走 Windows 无障碍（UI Automation）接口去读焦点控件里的选中文本——
前者要逐个应用适配，后者很多应用压根不提供。所以这里不承诺一个做不到的东西。

**可靠的两条路，都做了：**

1. **剪贴板（主路径）**：任意应用里 `Ctrl+C`，球发现剪贴板变了就翻。零注入，跨应用都行。
   代价是你要按一下复制。
2. **截屏取字**：拖一个框 → 本地 Tesseract 认字 → 再翻。图片里的字、画出来的字、选不中的字都走这条。

**留了口子但没做**：用 UI Automation 去拿焦点控件里选中的文字，能拿到的应用就用，拿不到就退回剪贴板。
这一步等前面两条稳了再说（见「还没做」）。

---

## 它能做什么

| 场景 | 怎么做 | 结果 |
|---|---|---|
| 任意应用里的文字 | 选中 → `Ctrl+C` | 球亮一下，面板给出译文 |
| 一段话太长不想等 | 直接按 `Ctrl+Alt+T` | 手动翻剪贴板里的内容（不看长度，也不拦密钥） |
| 图片 / 画出来的字 | `Ctrl+Alt+S` 拖框，或面板上的「截屏取字」 | 本地 OCR 取字 → 翻译，附「取到的那块」预览与准度 |
| 考前想让它当题做 | 面板切到「做题」 | 只给答案，另起一行标出没把握的空；想看解析再点一下 |
| 术语/笔译赛 | 面板切到「术语」 | 译法单独一行放大，下面是备选与说明 |
| 不想被打扰 | 托盘里勾「暂停（临时）」 | 球变灰，剪贴板翻译停下（设置不丢） |

面板上的三个模式、五颗提示词预设、浅色/深色主题、报错的说话方式，都跟浏览器版旁译是同一套——
不是重写的，是从它那儿搬过来的（见「复用」）。

**默认快捷键**：`Ctrl+Alt+T` 翻剪贴板 · `Ctrl+Alt+S` 截屏取字 · `Ctrl+Alt+O` 显示/隐藏球。
都在设置页里能改。

---

## 怎么跑起来

```powershell
# 在本项目目录下（就是含 package.json 的那一层）

npm install                     # 依赖（Electron + Tesseract）
# 如果 npm 没下 Electron 的二进制，手工补一次（本机遇到过 npm 的脚本策略拦住它）：
#   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules\electron\install.js

npm run vendor                  # 把 OCR 依赖从 node_modules 搬进 vendor/（十几兆，不入库）
```

起球有两条路：

1. **双击项目根目录的 `启动桌面版.cmd`**（推荐）。
   它会先把 Electron 运行时拷到 `%LOCALAPPDATA%\Programs\sidtrans-desktop\electron\`
   再从那儿启动——原因见下面第 0 条坑（Electron 不能在中文路径里跑）。
2. `npm start`。只在该项目路径**本身就是纯 ASCII** 时才管用。
```

自检三条，按能跑的程度分：

```powershell
npm run selftest                # ① 离线：语法/文件/引擎/剪贴板闸门/缓存/坐标（几秒，不需要网、不需要界面）
node test\ocr_engine.mjs        # ② OCR：真的跑一次 Tesseract，认中英两张图
node test\render_check.mjs      # ③ 界面：Edge 无头跑真实的 orb.html / panel.html，验控件与状态
npm run smoke                   # ④ 整机：真的 Electron 里跑球、面板、剪贴板、OCR（需正常桌面）
```

第 ④ 条要在**正常桌面环境**跑：它会真的开一个隐藏窗口、真的读剪贴板、真的 OCR。
在受限环境（无桌面会话 / 受限沙箱）里 Electron 可能起不来，那时只会看到它崩，不是代码的问题。

---

## 隐私与痕迹

- 球**只读**剪贴板，不写。唯一会写的一处是面板上的「复制译文 / 复制我写的」，那是你点的。
  写的时候程序自己记一笔，免得把刚复制的译文又当成新内容翻一遍（这个回环踩过）。
- 看着像密钥/令牌的整串（`gho_…`、长 hex、base64 混排、PEM 头）**默认不翻**，球上闪一句「这段像密钥，我没翻」。
  想关可以在托盘或设置里关。
- 出错日志只记「哪一步、什么错」，**不记内容**——不记你翻的是什么。
- 设置（含 API Key）只落在本机 `%APPDATA%\旁译桌面版\settings.json`，不进仓库、不外传。

---

## 复用：哪几块是从浏览器版搬过来的

搬的时候把 `chrome.*` 摘掉、换成注入进来的依赖，其余一字未改——那些文字是调出来的，重写只会退步。

| 复用 | 在哪 | 说明 |
|---|---|---|
| 三个引擎 + 自动降级 + 「报错说人话」 | `lib/engine.js` | 从 `background.js` 搬；402 说充值、401 说换 key、两条路都断就直说是网络 |
| 三套提示词 + 五颗预设 | `lib/prompts.js` | 从 `background.js` / `options.js` 搬；做题、做题+解析、术语、笔译赛风格 |
| 面板的样式与状态 | `ui/panel.css` | 从 `content.js` 的 CSS 常量搬，`.st-*` 那一整套，只去掉了 shadow DOM 的宿主选择器 |
| OCR 参数 | `ui/ocr.js` | 同一套 Tesseract 参数；`workerBlobURL:false` 是必须的那一条 |

---

## 文件地图

```
旁译桌面版\
├─ main.js                  主进程：球 / 面板 / 托盘 / 快捷键 / 剪贴板看守 / IPC / 自定义协议
├─ lib\
│  ├─ engine.js             引擎、降级、报错说人话、缓存键
│  ├─ prompts.js            三套模式提示词 + 五颗预设
│  ├─ clipwatch.js          剪贴板闸门（纯逻辑，可单独测）
│  ├─ store.js              设置 / 缓存 / 出错日志（明文 JSON，落在 userData）
│  ├─ ocr.js                OCR 宿主：藏起来的窗口 + 递图拿结果
│  ├─ ocrtext.js            OCR 结果清理 + 语言列表（含顺序，有实测依据）
│  ├─ capture.js            截屏取字：冻屏 → 框选 → 裁切
│  └─ geometry.js           坐标换算（纯函数）
├─ ui\                      orb / panel / settings / ocr / overlay 五个页面 + preload
├─ test\                    selftest.mjs（离线）/ ocr_engine.mjs / render_check.mjs / smoke.js（整机）
├─ scripts\                 make_icon.mjs（自己写像素出图标）/ sync_vendor.mjs / text_image.mjs
└─ assets\                  图标
```

---

## 已知的坑（都踩过，别再踩）

0. **桌面版不能放在带中文的路径下跑**（这是最致命的那个）。
   Electron 如果自己的 `electron.exe` 在非 ASCII 路径里（比如 `工作区\旁译桌面版\`），
   会在加载自身资源那一步**直接崩掉**，退出码 `-2147483645`（0x80000003），
   JS 一行都没跑到。实测：同一个二进制换到 `C:\elascii\electron.exe` 就一切正常。
   所以 `启动桌面版.cmd` 会把运行时先拷到 `%LOCALAPPDATA%\Programs\sidtrans-desktop\electron\`
   （纯 ASCII），再从那跑；项目本身（含中文路径）不用动。
   用 junction/符号链接绕不过去：系统会把路径还原成中文那份，照样崩。

1. **Tesseract 的语言顺序会决定第二个语言能不能加载**。实测：`eng+chi_sim` 中英都认得出；
   `chi_sim+eng` 时英文那张图准度从 50 掉到 18（第二个语言根本没加载上，还报了个乱码文件名）。
   所以 `lib/ocrtext.js` 里的 `OCR_LANGS` 是 `['eng','chi_sim']`——**改顺序前先跑 `test/ocr_engine.mjs`**。
2. **Electron 40+ 的剪贴板读取是异步的**（`clipboard.readText()` 返回 Promise）。
   当同步用会拿到 `[object Promise]`——症状是「复制了字它什么都不做」，
   而且不报错、不弹窗，从界面上看不出任何异常。写（`writeText`）也是 Promise。
   已修：看守 `await` 读值，并对「交回来的是 Promise」加了一道防守。
3. **判语言要用刚复制进来的那段，不是上一次翻过的那段**。
   拿错的那次，启动后第一次复制会被判成「没认出可翻的文字」直接跳过——同样是静默失败。
4. **`workerBlobURL: false` 不能省**（浏览器版被 CSP 挡过，报错还是个 `undefined`）。
5. **Electron 的窗口别用 `-webkit-app-region: drag`**：挂了它的元素收不到 click，球就点不动了。
   这里的拖拽是自己算位移的（位移小于 3px 算「点了」）。
6. **透明窗口的 `ready-to-show` 不一定会触发**：球曾因地在屏幕上不出现。
   现在除监听事件外还加了一个 1.5 秒的兑底，没显就手动 show。
7. **复制出去的译文要记一笔**，否则看守会当成新内容再翻一遍——回环，看着像自己抽风。
8. **截图先冻屏再框选**，不要「先框选再截屏」：那样遮罩自己会被拍进镜头。
9. **`.ps1` 改完要重新加 UTF-8 BOM**；`.cmd` 要 GBK + CRLF，而且里面如果写了中文路径，
   开头必须 `chcp 936`，否则路径会被当成乱码（我在这上面白跑过三次）。

---

## 还没做

- UI Automation 取焦点控件选中的文字（上面说的「可选加分」）
- 打包成 exe 分发（现在只能 `npm start` 跑源码）
- 离线引擎（`lib/engine.js` 里「本地服务」那个口子已经留着了）
- 开机自启、多显示器下的球位置记忆（现在只记一组坐标）
- 精修链（对面板上的译文做二次润色）

---

## 许可

MIT，见 [LICENSE](LICENSE)。署名与第三方组件见 [THIRD-PARTY.md](THIRD-PARTY.md)。
