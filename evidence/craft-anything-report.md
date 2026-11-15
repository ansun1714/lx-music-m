# Craft Anything · Deep 静态取证与高保真复现报告（v3 / 最终）

> 调查模式：`analysis_mode=deep`、`clean_room=false`。**全程静态读取目标字节，未运行目标 APK、未动态插桩、未连接其服务端。**
> 目标：`E:/AI/原软件/lx-music.apk`，13,876,866 B，SHA-256 `9f63c064608bc304e873520f20927f30c8c821098c96fffe8c7cc68db4810ba0`，`target_id = t_9f63c064608b`。
> 用户约束（覆盖前两轮）：**推倒重来，与原版不一样！我要的是一样的功能和界面，并加上下载功能。用引用的技能 @skill:craft-anything @skill:reverse-engineer-anything 来实现。**

---

## 1. 结论摘要

1. 目标确认为 **LX Music Mobile 1.9.2 / 79003**（`cn.toside.music.mobile`，React Native + Hermes）。Hermes bundle 中文字符串为 **UTF-16LE**，需按 0/1 字节偏移对齐解码；`strings -el` 在本环境无效、UTF-8 扫描全是噪声。
2. 原版竖屏界面骨架 = **左侧抽屉（70% 宽 / ≤300dp）+ 42dp Header + PagerView 横向 5 页 + 底部 PlayerBar**；不是上一版的 15 项固定侧栏。
3. 原版 `NAV_MENUS` 只有 5 个启用项，另有**被注释掉的 `{ id: 'download', icon: 'download-2' }`**，`Home/Views/Download/index.js` 仅返回 `<Text>下载</Text>` 占位。用户要求的「歌曲下载」正好对应启用这个预留入口。
4. 原版「下载」类文案（`安装包已经下载完毕`、`已切换到后台下载…`）**只指软件更新安装包**，原版没有歌曲音频导出能力；歌曲下载是本轮明确的增量功能。
5. 原版内置 **16 套主题**，`createThemeColors` 从 primary 派生 **232 个** `c-primary-*` 变量；默认 `green`「绿意盎然」`rgb(77,175,124)`。图标为 **52 个 icomoon 字形**（0xe900–0xe933），文案为 **520 条 zh-cn**。
6. 交付 `LXMusic-v3.0.0.apk`（74,268 B，SHA-256 `f15cbe9e…c2403b881`）；**无任何权限声明**；冒烟 153/153、模拟器 CDP 端到端 35/35、实机产出 1,888,044 B 合法 WAV，logcat 无错误。

---

## 2. 证据账本

| id | 内容 | 置信度 |
|---|---|---|
| `ev_9945034932cb25266afde516d071cd588cfec260d411b1fde3b29c759f80bf25` | v1.9.2 源码树（949 entries）与 `DrawerNav/Header/Main/PlayerBar` 布局源码 | observed |
| `ev_1681c6cef5c05c3838e1ae01820a4fd57dc162bd4e54e8946b77d56a22d3384a` | APK 解出的 798 个条目与 `assets/index.android.bundle` 界面字符串 | observed |
| `ev_bd2ad9f27450b063ae6623eb3bc7d371740710a64eadd30d99ba60492e556f9c` | `createThemes.js` / `themes.ts` 的 16 套主题与 232 个派生颜色变量 | observed |
| `ev_0ae71d41c084ba788dff56ea24fe24ce0547ee8ce684d11585ae12a9673c854c` | `ui-contexts.txt`：90 关键词 / 322 行 Hermes UTF-16LE 上下文 | observed |
| `ev_cab9cc95b94e511f04b334912ae1acea13e179c942dbb73e0c154e13fdd30542` | `selection.json` → `icon-codes.json`：52 个图标名 → 码点 | observed |
| `ev_d494469c538104199c4c0a7a6cf6daa0dcc9915a7b588322647deea9e6f57cc9` | `src/lang/zh-cn.json` 520 条界面文案 | observed |

派生材料：`evidence/theme-summary.json`、`theme-green-colors.json`、`theme-green.css`、`evidence/orig-apk/`、`evidence/lx-src/`、`evidence/ui-contexts.txt`。

---

## 3. 观察 / 推导 / 推断

**Observed（直接读字节）**
- APK 内 `assets/fonts/icomoon.ttf` 13,112 B；`resources.arsc` 616,756 B；`classes.dex`；525 个 `res/*.xml`。
- `src/config/constant.ts` 的 `NAV_MENUS` 五项 + 注释掉的 download；`Main.tsx` 的 `viewMap` 仅 5 页。
- `zh-cn.json` 520 条；`selection.json` 52 个字形；`createThemes.js` 16 套主题。

**Derived（由观察计算）**
- `createThemeColors` 从 `rgb(77,175,124)` 生成 232 个 `c-primary-*` 变量；`buildActiveThemeColors` 别名映射 `c-font = c-850`、`c-font-label = c-450`、`c-content-background = c-primary-light-1000`。
- 从 Hermes bundle 按 UTF-16LE 对齐解码并抽取 90 个 UI 关键词，得到 322 行上下文（`evidence/ui-contexts.txt`）。

**Inferred（判断）**
- 原版预留 download 菜单但未挂载视图，推测为后续功能占位；本轮据此把它实现为完整的下载中心。
- 原版「下载」类文案指软件安装包更新而非音频文件，依据是 `version_tip_downloaded = 安装包已经下载完毕`、`version_tip_min = 已切换到后台下载…` 都出现在版本更新语境。

**Absence is not proof**：`ui-contexts.txt` 未逐条穷举全部界面字符串；Hermes 泛化短串扫描曾产生 61,777 个噪声串，已弃用，改以 v1.9.2 开源源码为精确界面依据。

---

## 4. 实现与差异矩阵

| 规格项 | 原版证据 | 本版实现 | 状态 |
|---|---|---|---|
| 品牌 / 标题 | `LX Music` | 抽屉头部 + `<title>` + 启动图标 | 对齐 |
| 骨架 | 抽屉 + 42dp Header + PagerView + PlayerBar | 同构；`styles.css` 固定 42px / 54px / 46×46 / 24px | 对齐 |
| 导航 | 5 项 | 5 项 + 启用第 6 项「下载」 | 对齐 + 增量 |
| 主题 | 16 套 / 232 派生变量 | `app/themes.js` 移植同一派生算法 | 对齐 |
| 图标 | 52 个 icomoon 字形 | 直接复用 APK 内字体 + `icons.css` | 对齐 |
| 文案 | 520 条 zh-cn | `app/i18n.js` 全量落地 | 对齐 |
| 搜索/歌单/排行榜/我的列表/设置 | 源码视图结构 | 6 个可横滑视图 + 全屏页（播放详情/评论/歌单详情/备份/同步/关于/缓存） | 对齐（数据为本地演示） |
| 歌曲下载 | **无**（仅更新安装包） | 真实 WAV / 队列 / 音质 / IndexedDB / MediaStore 落盘 / 离线播放 | **用户要求的增量** |
| 运行时 | React Native + Hermes | 独立 WebView + 原生 Java 外壳 | 实现载体不同 |

---

## 5. 验收证据

| 层 | 结果 |
|---|---|
| `node evidence/smoke-test.js` | **153 / 153**：冷启动顺序、6 视图、全屏页、主题、WAV 头字节级校验、队列状态机、Android 分块桥、离线播放、单文件版、无网络 API |
| `node evidence/device-check.js`（CDP） | **35 / 35**：真实 WebView 页面资源、抽屉、搜索、播放、下载落盘、统计刷新、深色主题、持久化 |
| 设备 WAV | `/sdcard/Download/LX Music/夜落之前 - 青屿乐团.wav` 1,888,044 B；Python `wave`：单声道 / 16-bit / 8000 Hz / 944,000 帧 / 118.0 s |
| APK | `apksigner verify` v1+v2+v3 true；`aapt dump permissions` 空；`versionName 3.0.0` / `versionCode 3` |
| 日志 | `logcat` 无 `FATAL EXCEPTION` / `Uncaught` / JS ERROR |
| 截图 | `evidence/apk-v3-home.png`、`-drawer.png`、`-search.png`、`-playing.png`、`-detail.png`、`-download.png`、`-dark.png` |

修复的 4 个问题：`deliverById`（保存到设备按钮拿到元数据而非 Blob）、离线拦截早于队列改写、下载统计卡片实时刷新、aapt2 中文路径改为 ASCII 工作目录。

---

## 6. 仍未闭合的 unknowns

1. 原版精确 build flavor / 渠道与自定义源协议细节未静态穷举。
2. 通知栏 MediaSession、前台服务、桌面歌词悬浮窗、蓝牙歌词、真实多端同步的原生行为未做等价实现（静态取证可确认存在，但未运行目标验证交互）。
3. 真实音源、真实曲库 / 歌词 / 评论 API 未接入；本版为本地演示数据。
4. REA 专用 MCP 工具在本会话未注册，`npx rea-agents` 探测超时；按其 skill 指引不阻塞任务，改用 craft-anything 证据账本 + APK 静态解压 + GitHub API/raw 源码 + aapt/Python 分析完成。

---

## 7. 合规边界

- 静态取证：不运行目标、不插桩、不连接其服务端；界面事实来自 APK 字节 + Apache-2.0 开源项目 `v1.9.2` 源码交叉验证。
- 实现代码独立编写（WebView + Java），不复制原版 RN 源码；按用户明确要求复用其品牌名、文案、配色定义与图标字体用于本地个人界面复现。
- v3.0.0 时无真实音源与网络请求、不声明任何权限；v3.1.0 起仅新增 INTERNET 权限，且只用于用户自行导入的 JS 音源（见第 8 节）。

---

## 8. 追加调查：自定义音源（v3.1.0）

### 8.1 用户新需求

> 「原版可以添加自己的音源，是自制音源导入，。咱们版本没有，它添加进上去，根据jS格式的音源来搜索歌曲。根据歌曲来源格式来提供下载，在线收听。」

即：补齐 v3.0.0 缺失的自定义音源导入，并让 JS 音源真正驱动搜索、在线收听、按来源格式下载。

### 8.2 新增证据

| 证据 | 内容 |
|---|---|
| `ev_7e9e3ce837ea985e162077b3aa5e51b2add681344caddbca3059c0ee6fccf3fc` | APK `assets/script/user-api-preload.js` 439–478 行：`globalThis.lx` 的 `request(url,options,callback)` 与 `sendNativeRequest` 原生调用契约 |
| `ev_3482a4e4b2ec3675c5339ef4b6d7880466b477e6f448e53751b163a9c65390ed` | `evidence/custom-source-forensics.md`：preload 协议、官方文档、界面文案与源码入口、需求差异分析 |
| 官方文档 | `https://lyswhut.github.io/lx-music-doc/mobile/custom-source` → `https://lxmusic.toside.cn/mobile/custom-source`：脚本头 `@name/@description/@version/@author/@homepage`、示例脚本、`lx` API、可用宿主 API、移动版差异 |
| v1.9.2 源码 | `src/types/user_api.d.ts`、`Setting/settings/Basic/Source.tsx`、`UserApiEditModal/{index,ImportBtn,List,ScriptImportExport,ScriptImportOnline}.tsx` |

### 8.3 关键判断

1. 原版移动版 user-api **v2.0.0** 的 `actions` 只有 `musicUrl / lyric / pic`（`supportActions` 中非 `local` 源固定 `['musicUrl']`），脚本只给内置 SDK 检索到的歌曲补 URL；**搜索与歌曲下载不属于原版协议**。用户要求的搜索/下载必须作为兼容扩展实现。
2. 原版的「下载」文案（`安装包已经下载完毕`、`已切换到后台下载`）属软件更新语境，与歌曲音频下载无关 —— 与 v3.0.0 的 `fnd_5` 一致。
3. 因此实现策略：`EVENT_NAMES`、`lx.on/send/request/utils` 完全兼容原版脚本；新增可选 `search / songList / leaderboard / downloadUrl` 动作与 `{mime,ext,filename}` 返回格式；原版脚本导入后可直接使用。
4. Android 必须新增 INTERNET 权限与原生 HTTP 桥（`lx.request` 不受跨域限制是原版协议语义），并把 `shouldInterceptRequest` 从「全部返回 404」改为「只接管 app.echo.local」，否则在线 `<audio>` 无法加载。

### 8.4 交付与验收

- 新增 `app/source-api.js`（lx 兼容层 + md5/base64/受限作用域 + HTTP 桥）、`app/sources.js`（导入/管理/搜索/媒体解析 + 内置离线示例音源 + HTTP 模板）。
- 修改 `app/data.js`（external 曲目池）、`engine.js`（`stream` 在线播放）、`download.js`（按 `mime/ext` 原样保存，失败回退 WAV）、`app.js`（设置分组、管理页、来源下拉、异步搜索、在线播放）、`styles.css`、`index.html`。
- Android：`INTERNET` 权限、`usesCleartextTraffic`、`MIXED_CONTENT_ALWAYS_ALLOW`、`EchoBridge.httpRequest/cancelRequest`、分块 `LXHttp.onChunk`、`saveText` MIME 推断。
- **冒烟 200/200**（新增 47 项）、**设备 CDP 54/54**（新增 19 项）；原生 HTTP 桥实测 `ok:200`；音源曲目 `engine.mode='stream'`；按音源格式落盘 WAV 96,044 B / 6000 Hz / 8.0 s，与内置回退 1,888,044 B / 8000 Hz / 118.0 s 明显不同，证明未重新编码；logcat 无错误。
- APK `LXMusic-v3.1.0.apk` 90,652 B，SHA256 `b47404728025173aa55091758b3cb46448ac839fa14a9e4b62cfeaa7a9d084f7`，versionCode 4，v1+v2+v3 签名，唯一权限 INTERNET。
- 新增截图 `apk-v3-userapi.png` / `apk-v3-api-search.png` / `apk-v3-api-playing.png` / `apk-v3-api-download.png`。

### 8.5 修正的旧结论

- v3.0.0 报告第 7 节「不声明任何权限」「无真实音源与网络请求、无自定义源脚本运行时」在 v3.1.0 已被本需求覆盖：仅新增 INTERNET 权限，且只用于用户导入的音源。
- unknown #1「自定义源协议细节未静态穷举」已闭合：preload 脚本 + 官方文档 + 源码类型定义三方交叉验证完成。
- unknown #3「真实音源未接入」部分闭合：运行时与协议已就绪，但真实合法音源脚本仍由用户提供，内置仍为演示数据。

---

## 9. 追加调查：本地音源导入无反应（v3.1.1）

### 9.1 用户反馈

> 经过安装真机实测，在自定义音源管理中添加本地音乐源，选中音源文件，点击添加没反应。

### 9.2 复现与取证（v3.1.0 + CDP 探针）

在模拟器 WebView 里注入 `HTMLElement.prototype.click` / `change` / `FileReader.readAsText` 探针后点击「本地导入」：

```
[0.0s] {"clicks":1,"changes":0,"files":-1,"read":0,"load":0,"err":"",
        "size":-1,"textLen":null,"apis":"1->1","toasts":[],"errors":[]}
```

同时 `dumpsys activity` 的前台 Activity 始终是 `com.lxmusic.replica/.MainActivity`，
`onShowFileChooser` 从未被调用。结论：

1. **根因**：`pickFile()` 用 `document.createElement('input')` 后未 `appendChild` 就 `.click()`。
   Android WebView 会忽略游离元素的 click；桌面浏览器允许，所以既有冒烟测试（DOM shim）与
   桌面单文件版从未暴露该问题。
2. **第二隐患**：`PickedProvider` 为 `exported="false"`，WebView 渲染进程是独立 UID，
   即使选择器弹出，`content://` 回传也会被拒；原 `FileReader` 无 `onerror`，同样静默。
3. **第三隐患**：选择文件会让应用进入后台，WebView 可能被系统回收，页面重建后回调丢失。

### 9.3 修复策略（不依赖 WebView 文件选择器）

- 新增原生桥 `EchoBridge.pickScript()`：Java 自己 `ACTION_OPEN_DOCUMENT`，`onActivityResult`
  直接读字节 → UTF-8 解码 → 分块 `evaluateJavascript` 回传（单块 120,000 字符）。
- 结果暂存进程内，`pickScriptPull()` 供页面重建后取回，`pickScriptAck()` 去重。
- JS `window.LXFilePick` 统一承接，取消/失败/空文件/超时全部有 toast。
- 浏览器回退路径：`<input>` 必须挂 DOM、不用 `display:none`、补 `onerror` 与清理。
- 兼容性：`PickedProvider` 改 `exported="true"` + `grantUriPermission`；脚本头兼容 `// @name`；
  导入失败给出具体原因（空文件 / 无头部注释 / 无 `@name` / 过短）。

### 9.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **216 / 216**（新增 16 项回归） |
| 真机文件导入 | **11 / 11**：选择器弹出 → 选中 `真机导入测试.js` → 返回 → 音源 1→2、名称正确、`origin=local:真机导入测试.js`、已持久化、可搜索 |
| 全量设备回归 | **54 / 54**（无连带回归） |
| 日志 | 无 FATAL / Uncaught / JS ERROR / SecurityException |
| APK | `LXMusic-v3.1.1.apk` 94,748 B，SHA256 `dea3f323cf6e4801ac9c90dfee94d009e24fcfa99214113d174286e0d16c6382`，versionCode 5 |

### 9.5 可复用的诊断工具

- `evidence/repro-file-pick.js`：CDP 探针，输出 `clicks/changes/readAsText/apis/toasts`，可直接判定断链位置。
- `evidence/pick-file-ui.py`：系统文件选择器 uiautomator 自动化（`Show roots → Downloads → 精确点文件名`）。
- `evidence/fixtures/真机导入测试.js`：最小合法 user-api 脚本。
- `evidence/device-pick-check.js`：设备端文件导入验收（11 项）。

---

## 10. 追加调查：主界面搜索/排行榜不走音源（v3.2.0）

### 10.1 用户反馈

> 音源确实可以导进去了，能启用。但是回到主界面进行搜索和排行榜等，它不使用音源提供的路径来进行搜索。
> 音源提供给平台验证，搜索平台我可以选择在主界面选择。另外将测试的音乐和歌曲全部清掉使用。

### 10.2 代码级根因

| # | 位置 | 问题 |
|---|---|---|
| 1 | `source-menu` | 只列出 `SR.supports(a,'search')` 为真的音源。原版 user-api v2.0.0 脚本只有 `musicUrl` → 用户的音源**不出现在下拉里**，无法作为搜索平台选择 |
| 2 | `doSearch` | `useApi = SR.hasSearch() && (isApi \\|\\| src==='all')`；无 search 音源时静默走 `D.tracks`，用户看到的是 48 首演示曲 |
| 3 | `viewLeaderboard` | 直接 `trackList(D.tracks.slice(0,20))`，从未调用音源；`sources.js` 也没有 `leaderboard` |
| 4 | `trackRow` | 来源列用 `D.sourceName(tr.source)`，音源曲目显示 `api:api_xxx` 而非音源名 |
| 5 | `play-all` | `playFrom(D.tracks[0].id, ...)`，空库时直接抛异常 |

### 10.3 修复

- 搜索平台下拉列出**全部已启用音源**，不支持的标注「· 仅解析播放」；默认 `api:all`。
- `doSearch` 三态提示（指定源不支持 / 全部不支持 / 无音源），不再静默回退；搜索中清空旧结果。
- 歌曲行来源改用 `tr.sourceLabel`。
- `sources.js` 新增 `leaderboard()` / `hasLeaderboard()` / `boardProviders()`；排行榜视图、`contextIds`、`play-board` 全部改为音源驱动，支持切换榜单与音源、加载态与来源说明。
- 清空演示音乐：`tracks / SONGLISTS / HOT_WORDS / LYRICS / COMMENTS` 全空；不再预置示例音源；`DATA_VERSION=2` 迁移清理 `kw_*` 引用；`LXDownload.purgeDemo()` 清下载任务与 IndexedDB blob。
- 播放条空队列文案由「播放完毕」改为「未在播放」。

### 10.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **234 / 234**（新增空库、无音源提示、搜索平台下拉、仅解析源、排行榜加载/切换、迁移清理等 13 项） |
| 设备端到端 | **64 / 64**（新增空库、无音源提示、下拉、排行榜曲目/来源/播放、切换榜单 10 项） |
| 搜索平台切换专项 | **8 / 8**（甲 3 首 / 乙 2 首 / 仅 musicUrl 源提示且 0 结果 / 聚合 5 首） |
| 设备清理 | `Download/LX Music` 已清空，应用数据已 `pm clear`；安装包不含任何音乐 |
| 日志 | 无 FATAL / Uncaught / JS ERROR / SecurityException |
| APK | `LXMusic-v3.2.0.apk` 98,844 B，SHA256 `34217b20a1efb9d307b6c0f249a7cc39c4c0ceae86b381657dba4beeac22f9f0`，versionCode 6 |

### 10.5 边界

- 原版移动版 SDK 内置的搜索/排行榜由官方服务器提供，自定义音源协议本身不含这两项；本版的 `search` / `leaderboard` 是**扩展动作**，需要用户音源脚本自行实现并返回列表。
- 只实现 `musicUrl` 的原版脚本仍可正常导入与解析播放，但无法成为「搜索平台」—— 界面会明确说明，而不是假装可用。

---

## 11. 追加调查：平台化重构（v3.3.0，依据 lxserver 源码）

### 11.1 用户澄清

> 音源只是用来给各个平台做验证，相当于各平台的账号。选酷狗搜索，酷狗验证我提供的音源是否合规，
> 合规的才提供搜索、在线收听和下载。主界面应该提供各平台选择。

### 11.2 源码依据

仓库 `XCQ0607/lxserver`（LX Music 同步服务端 + Web 播放器），静态阅读：

- `src/modules/utils/musicSdk/index.js`：平台注册 `kw / kg / tx / wy / mg / xm`，每个平台自带 `musicSearch / leaderboard / songList / hotSearch / lyric / pic / comment`。
- `src/modules/utils/musicSdk/kw/index.js` / `kg/index.js`：`getMusicUrl(songInfo, type)` 完全委托 `apis(source).getMusicUrl(...)`。
- `src/modules/utils/musicSdk/api-source.js`：`apis(source)` 从已加载自定义源里按 **`sources` 的 key** 取 `getMusicUrl`；缺源时抛「未找到支持该平台的自定义源」。
- `src/server/sources/userApi.ts`：vm2 沙箱加载脚本，解析元信息，`send(inited, { sources })` 的 key 即平台 id。

**结论**：平台负责检索与元数据，音源按平台声明提供播放地址——即「音源 = 平台账号」。v3.2.0 把音源当搜索源是理解错误。

### 11.3 实现

- 新增 `app/platform.js`：5 个平台；酷我 / 酷狗 / 咪咕 内置搜索（HTTP，走原生桥）；酷狗内置 24 个榜单；网易 / QQ 需签名，回退到音源。
- `app/sources.js`：新增 `platformProviders / forPlatform / verifyPlatform`，按脚本 `sources` 的 key 自动匹配平台；`resolveMedia` 优先用 `track.platform` 作为脚本 `source`，并把平台原始字段 `_raw` 作为 `musicInfo` 传给脚本。
- `app/app.js`：搜索页 / 排行榜页顶部平台选择条；搜索与榜单按平台路由；播放入口在「平台没有音源提供服务」时明确提示；设置页新增「平台账号（音源验证）」，显示每个平台由哪个音源提供地址、验证状态、自动匹配/手动指定；导入音源后 toast 直接告知可服务哪些平台。
- 移除 v3.2.0 的「音源作为搜索源」下拉。

### 11.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **248 / 248** |
| 设备端到端 | **72 / 72** |
| 酷我搜索 | 真机「周杰伦」→ **30 首真实歌曲**，说明「来自酷我音乐内置接口」 |
| 酷狗榜单 | TOP500 → **100 首**，可播放 |
| 播放 / 下载 | 平台曲目经音源 `musicUrl` 在线收听；按返回格式落盘 `Download/LX Music` |
| 日志 | 无 FATAL / Uncaught / JS ERROR |
| APK | `LXMusic-v3.3.0.apk` 102,940 B，SHA256 `afeeb320ebceb1709b826e06f12d6354d9607e2deb55556de5189ef001c9c62d`，versionCode 7 |

### 11.5 边界

- 内置接口是平台公开 Web 接口，可能随平台调整失效；失效时回退音源并说明原因。
- 网易 / QQ 需要签名加密，本版未内置。
- 不内置任何音乐数据；曲库来自平台接口或用户音源。

---

## 12. web 播放器下载能力对齐（v3.4.0）

### 12.1 参考

`XCQ0607/lxserver` 的 `public/music/js/download/download_manager.js`（88 KB）与 `sync_download.js`：
并发队列、Fetch + ReadableStream 流式、暂停/继续、失败重试、全局速度、歌词检查、服务端任务同步。

### 12.2 本版实现

- **原生流式下载**：`EchoBridge.downloadStart(key,url,headers,filename,mime)` → Java `HttpURLConnection`
  16KB buffer 边读边写 `.part`，每 250ms 回调进度；完成后写 MediaStore `Download/LX Music`。
- **暂停续传**：`downloadCancel` 保留 `.part`，`resume` 时发 `Range: bytes=<len>-`。
- **状态与展示**：`received/total/speed/eta`，下载页显示 `已下载/总大小 · 速度 · 剩余时间 · 百分比`。
- **失败重试**：错误原因落库，「重试失败 (N)」批量重试。
- **歌词**：下载完成调音源 `lyric`，写同名 `.lrc`（`saveText` 支持 `.lrc` 的 text/plain）。
- **同名音源导入 = 更新**：修复重复导入导致 `forPlatform` 取到旧脚本的问题。
- 小文件（`data:`/`blob:`）仍走内存 blob + 分块桥，保留应用内离线播放。

### 12.3 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **262 / 262** |
| 设备端到端 | **72 / 72**（无回归） |
| 流式下载专项 | **12 / 12**：酷我「发如雪」→ 进度 100% / 速度 9.7 MB/s → **4,096,044 B** 与源文件逐字节一致 → `Download/LX Music/发如雪 - 周杰伦.wav` |
| 字节校验 | Python `wave`：单声道 / 16-bit / 8000 Hz / 2,048,000 帧 / 256.0 秒 |
| APK | `LXMusic-v3.4.0.apk` 111,132 B，SHA256 `4eb014b3763413a787800cee940b9bfe7a1be8adfbb35c5b1164645600c33381`，versionCode 8 |

### 12.4 不做的部分

服务端代理下载、ID3 标签与封面嵌入（需要服务端 ffmpeg）、投屏、PWA 离线缓存、管理员后台。

---

## 13. 下载品质选择（v3.5.0）

### 13.1 需求

> 在搜索到的歌曲后隐藏菜单下的下载功能，根据我提供的音源解析有各种音质的选择，
> 最高可以达到母带。让我主动来选各种不同的品质下载。

### 13.2 源码依据

`XCQ0607/lxserver` 的 `public/music/js/player/quality.js`：

- 优先级 `master > atmos_plus > atmos > hires > flac24bit > flac > 320k > 192k > 128k`
- 平台可选表：`tx`/`wy` 到 master，`kw`/`kg` 到 hires，`mg` 到 flac
- 可用性从 `songInfo.types / qualitys` 读取；`getNextLowerQuality()` 逐级降级

### 13.3 实现

- 新增 `app/quality.js`（`LXQuality`）：9 档、中文名、平台可选表、`fromTrack / selectable / best / downgradeChain / normalize`。
- 歌曲隐藏菜单「下载」→「下载…」→ 品质二级菜单（9 档 + 返回，可用档标注、未声明灰显可尝试）。
- `download.js`：`j.quality` 就是用户所选档；`resolveMedia` 以 `{type, quality, musicInfo}` 调音源；
  解析失败按 `downgradeChain(pref, track, 3)` 逐档降级，`deliveredQuality` 记录实际档位，任务行显示 `母带音质 → 无损音质`；
  全档失败如实报错，不再合成占位音轨。
- 批量下载同样先选品质；下载页与设置页的音质下拉统一为 9 档。

### 13.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **287 / 287**（新增 25 项） |
| 设备端到端 | **75 / 75**（新增 3 项） |
| 品质专项 | **19 / 19**：菜单 9 档 → 选母带 → 音源收到 `master` → `MASTER测试 - 歌手.wav`；再选 320k → `320K测试 - 歌手.wav` |
| APK | `LXMusic-v3.5.0.apk` 115,228 B，SHA256 `2f2261a092d1a012c5845b6793f7fd2aa889d6b3196d16d5edc8f5e25e76cc6c`，versionCode 9 |

### 13.5 边界

母带/空间音频/高解析度是否有资源取决于用户导入的音源脚本；平台公开接口通常只声明到 flac24bit / hires，
因此菜单里这些档位显示为灰色，允许用户主动尝试。

---

## 14. 网易 / QQ 搜索补齐（v3.6.0）

### 14.1 用户反馈

> 音源绑定各个平台，但是在网易和 QQ 平台无法搜索音乐。请参考官方开源源码，是如何验证搜索的。
> 并附真实音源脚本（星海音乐源 v3.2.19）。

静态检查该脚本：`availablePlatforms = ['wy','tx','kg','kw','mg','qs']`，
但每个 `sources[p] = { actions: ['musicUrl','lyric','pic'], qualitys: MUSIC_QUALITIES[p] }`
—— **没有 `search`**。它遵循原版约定，只提供播放地址。v3.5.0 的网易/QQ 恰好没有内置搜索，
只做「让音源提供 search」的回退，因此必然搜不出结果。

### 14.2 源码依据（XCQ0607/lxserver）

- `musicSdk/wy/musicSearch.js`：`eapiRequest('/api/search/song/list/page', {...})`，
  结果 `data.resources[].baseInfo.simpleSongData`。
- `wy/utils/crypto.js`：`eapi` = `AES-128-ECB(key='e82ckenh8dichen8')`，
  明文 `url-36cd479b6b5-json-36cd479b6b5-md5('nobody'+url+'use'+json+'md5forencrypt')`，输出大写 hex；
  请求 `POST http://interface.music.163.com/eapi/batch`，form 仅 `params`。
- `musicSdk/tx/musicSearch.js`：`signRequest({ comm, 'music.search.SearchCgiService': {...} })`，
  结果 `req.data.body.song.list`。
- `tx/utils/crypto.js`：`zzcSign` = SHA1 hex → 按 `PART_1/2_INDEXES` 取字符 + 与 `SCRAMBLE_VALUES` XOR
  → base64 去 `/+=` → `zzc{p1}{b64}{p2}` 小写。
- `wy|tx/quality.js`：由 `maxbr / l / h / sq / hr / jm` 与 `size_*` 推导可用档位。

结论：**搜索是平台职责**，靠内置加密接口；音源不参与搜索，只解析地址。

### 14.3 实现

- 新增 `app/net-crypto.js`：纯 JS 的 MD5 / SHA1 / AES-128-ECB（PKCS7、大写 hex）/ zzcSign，
  与 Node `crypto` 逐项对齐（固定向量测试）。
- `app/platform.js`：`http()` 支持 `form` 与 `body`；新增 `wySearch` / `txSearch` 与字段映射；
  `ADAPTERS` 加入 wy/tx，`hasBuiltinSearch` 变 true。
- `app/quality.js`：新增 `sourceQualitys(track)`，把「该曲目绑定音源」声明的档位并入可用列表，
  音源声明 `master` 时菜单直接标可用。
- `app/sources.js`：`resolveMedia` 记录音源原始错误，导出 `lastError(track)`。
- `app/app.js` / `app/download.js`：播放与下载失败时把音源原话显示出来。

### 14.4 验收（真机，星海音乐源 v3.2.19）

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **325 / 325** |
| 设备专项 | **42 / 42**（`evidence/device-wy-tx-check.js`） |
| 网易搜索 | 「周杰伦」→ 20 首 / 0.5s，说明「来自网易云音乐内置接口」 |
| QQ 搜索 | 「周杰伦」→ 30 首 / 1.0s（发如雪/晴天/兰亭序） |
| 网易在线收听 | `engine.mode='stream'` |
| 网易下载 | 3,820,077 B MP3，`Download/LX Music/想你就写信 (Live) - 周杰伦、李硕、张鑫.mp3` |
| QQ 取链 | 音源后端返回「仅对认证用户开放 / 触发人机验证」，界面如实显示 |
| 全量回归 | 75 / 75，logcat 无错误 |
| APK | `LXMusic-v3.6.0.apk` 123,420 B，SHA256 `b1ea30ee07a1e10039cd1ccd1f39842364e373b16adbaac098b52d8a288942a4`，versionCode 10 |

### 14.5 边界

- 网易/QQ 搜索接口是平台公开 Web 接口（网易走 http + eapi 加密，QQ 走 zzcSign），
  平台调整时可能失效；失效会回退到音源 search 并在界面说明。
- QQ 的**播放/下载**取决于音源是否配置卡密或 CHKSZ apikey，本版不内置任何账号凭证。
  失败时透传音源原话，用户可据此补配置后同名重导。

---

## 15. 下载音质手选 + 播放器歌词 / 音效 / 下载（v3.7.0）

### 15.1 用户要求

> 下载页面音质最高级别选项让手动选，最高可设母带，或者把限制去掉。
> 播放器参考官方 web 播放器，加音效设置、当前播放音乐下载、歌词显示。

### 15.2 病因：为什么「选了母带却不是母带」

`qualityFor()` 原实现走 `Q.best(track, 偏好)`——从偏好往下找**曲目声明可用的第一个档位**。
平台接口一般只声明到 `flac`，于是下拉里选了「母带」，入队时被改写成 `flac`，
表现就像「最高档被限制」。

### 15.3 实现

- `qualityFor()` 直接返回偏好档；单曲 / 批量 / 详情页下载共用；真正的降级交给
  `downgradeChain(pref, track, 3)` 并标注「母带音质 → 无损音质」。
- 下载页与设置页的音质下拉只显示中文名（9 档），窄屏不再截断。
- 新增 `app/lyrics.js`（`LXLyr`）：解析 `[mm:ss(.xx)]` / 多标签 / `[offset:]` / 翻译行 / 逐字标签，
  `indexAt` 二分定位，渲染可点击行，`sync` 高亮并滚动到中间。
- `sources.js` 的 `lyric()` 改为按 `trackSource` 找音源（平台曲目也能取），
  兼容「先取链才有歌词缓存」的音源，并缓存结果；`normalizeMedia` 保留 `lyric` / `cover`。
- 新增 `app/sound-effects.js`（`LXSound`）：10 段 EQ（31–16k，peaking Q=1.4，±12dB）、
  9 个官方预设、4 档混响（程序生成 IR）、3D 环绕（PannerNode）、总开关保留配置、localStorage 持久化。
- `engine.js` 接入音效链：`gain → EQ → 干/湿 → panner → destination`；
  `<audio>` 走 `createMediaElementSource`，`el.volume` 固定 1，音量统一由 gain 控制；
  `play()` 前 resume suspended 的 AudioContext。
- 详情页改版：封面 / 标题 / 歌名信息 / 可滚动歌词区 + 底部「下载 / 音效 / 歌词」三个按钮；
  `effects` 全屏页提供预设、混响、环绕与 10 段滑块。

### 15.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **366 / 366**（新增 41 项） |
| 播放器专项 | **37 / 37**（真机） |
| 全量设备回归 | 75 / 75 |
| 网易 / QQ 专项 | 42 / 42（无回归） |
| 真机要点 | AudioContext running；音效链 mounted；歌词 5 行解析并高亮到第三行；音效页 9 预设 / 10 滑块 / 混响 / 环绕可操作；关闭音效保留配置；下载页选母带后任务 `quality=master` |
| APK | `LXMusic-v3.7.0.apk` 131,612 B，SHA256 `05ab4c23b184294a5c67121a92055edecb59f00483e4ad2f71df61a5f4cafb22`，versionCode 11 |

### 15.5 未移植

变调（pitch-shifter 的 FFT 相位声码器）、可视化（visualizer）、官方混响 IR 音频文件。

---

## 16. 真机无声修复 + 默认音源 / 更新标签（v3.8.0）

### 16.1 用户反馈

> 搜索完歌曲点击播放，要么不加载，要么播放但没声音。
> 音源再加一个更新标签；把各个平台单独绑定去掉；音源后面加一个默认设置，
> 搜索歌曲、切平台就用默认音源。

### 16.2 无声根因（实测）

v3.7.0 为了做音效，无条件把每个 `<audio>` 接进 Web Audio（`createMediaElementSource`）。
`MediaElementSource` 要求媒体带 CORS 头，否则浏览器把输出置零。
实测网易 CDN 返回 `Access-Control-Allow-Origin: *`（所以正常），
QQ/酷狗等不带该头就会「在播放但没声音」。此外每个 MediaElementSource 无法撤销，
长播会累积拖垮 WebView（表现为后来越来越难加载）。

### 16.3 实现

- `engine.graphEnabled()`：只有音效开启且 EQ/混响/环绕非空才接管；
- `_createEl()` 按需创建，不接管时 `mediaSrc=null`、`el.volume=音量`，走原生播放；
- `syncAudioGraph()` + `rebuild()`：音效开关/参数变化时，仅在状态不一致时换新 `<audio>`
  （MediaElementSource 不可撤销）；
- 接管时对 http(s) 设 `crossOrigin='anonymous'`，服务器不支持则 error →
  强制原生重载 + `onGraphFallback` 提示并关音效。
- 音源管理：删除逐平台 `bindings`（设置页「平台账号」组、bind-platform 等动作），
  改为全局 `defaultId`（`lx_default_api_v1`），`forPlatform` 先看默认音源是否声明该平台；
  新增「设为默认 / 取消默认」「更新」（在线源按原地址重拉，走同名更新）。

### 16.4 验收

| 项目 | 结果 |
|---|---|
| 逻辑冒烟 | **377 / 377** |
| 播放器专项 | **41 / 41** |
| 全量设备回归 | **76 / 76** |
| 网易 / QQ 专项 | **42 / 42** |
| 真机要点 | 关闭音效 `mediaSrc=null` 且 `readyState>=2`；开启后 `mediaSrc` 存在、ctx `running`、不打断播放；关闭后回退原生 |
| APK | `LXMusic-v3.8.0.apk` 131,612 B，SHA256 `5a4cb21c58799d2eace7fb5c3d1344871ff5fea575d34396067b836ec6abbb8d`，versionCode 12 |

### 16.5 事故与教训

本次删除「平台绑定」代码时按字符串索引切片，把 `bind-platform` 与 `set-api-source`
之间的 180 行（含 41 个动作：搜索、播放、列表、菜单）一并删掉，导致搜索无反应、点歌不加载。
从上一个 APK 的 `assets/index.html` 提取完整 `onClick` 段，按动作名对比缺失项后回填修复。
以后修改 `switch` 分支必须按 case 名定位，禁止按区间删除。
