# 鸿蒙侧功能对齐方案（EchoBridge for ArkTS）

> 目标：让 HAP 与 APK 行为一致 —— 搜索/榜单/歌单、播放、音效接管、下载落盘、本地播放、导入音源、toast。
> 前提：**不重写界面**。`app/` 里所有网络与文件能力都收敛在一层桥上，鸿蒙只要补一层同名 `EchoBridge`。

## 结论先行

Android 的“原生能力”一共就 16 个方法 + 9 个回调，全部由 `MainActivity` 的 `@JavascriptInterface` 和
`evaluateJavascript` 实现。鸿蒙对齐只需要两件事：

1. **ArkTS 对象挂到 `EchoBridge`**：`Web().javaScriptProxy({ object, name: 'EchoBridge', methodList, controller })`，
   方法签名与 Android 完全一致（同步调用，返回值同步拿）。
2. **原生 → 页面的回调**：`controller.runJavaScript(...)` 调用页面里已存在的三个对象
   `window.LXHttp` / `window.LXDownloadBridge` / `window.LXFilePick`。这三处在 `app/source-api.js`、
   `app/download.js`、`app/app.js` 里本来就是为 Android 写的，**不用改一行前端代码**。

也就是说，鸿蒙版的工作量全在 ArkTS 一层，前端零改动（连 `bridge-patch.js` 都能复用）。

## 桥的 ABI（从代码里抄出来的真实契约）

### JS → 原生（`EchoBridge.*`）

| 方法 | 签名 | 谁在用 |
|---|---|---|
| `mediaProxyBase()` | `→ string` | `engine.js` 判断能否走同源媒体代理 |
| `localMediaUrl(rel)` | `rel → string` | `app.js` 离线播放已下载文件 |
| `httpRequest(key,url,method,headersJson,body,timeout,binary)` | `→ void` | `source-api.js` 全部 HTTP（搜索/榜单/音源） |
| `cancelRequest(key)` | `→ void` | 超时/取消 |
| `downloadStart(key,url,headersJson,filename,mime,dir)` | `→ void` | `download.js` 流式下载 |
| `downloadCancel(key)` / `downloadClear(key)` / `downloadPartialSize(key)` | `→ void / void / long` | 暂停、删除临时分片、续传偏移 |
| `saveDownloadStart(name,mime)` / `saveDownloadChunk(b64)` / `saveDownloadFinish()` | `→ void` | 设置/备份导出（WAV 走 download，不走这里） |
| `saveText(name,text)` | `→ void` | `bridge-patch.js` 的 `<a download>` 拦截 |
| `pickScript()` / `pickScriptPull()` / `pickScriptAck()` | `→ void` | 导入自定义音源文件 |
| `toast(msg)` / `exitApp()` | `→ void` | 提示、退出 |

### 原生 → JS（`runJavaScript` 注入）

| 页面对象 | 回调 | 用途 |
|---|---|---|
| `LXHttp` | `onChunkStart(key,total)` / `onChunk(key,i,b64)` / `onResponse(key,err,code,msg,headersJson,body,isBinary)` | 分块回传大响应，峰值只有一块内存（APK 曾因整份 Base64 闪退，这里必须同样分块） |
| `LXDownloadBridge` | `onProgress(key,received,total)` / `onDone(key,name,path)` / `onError(key,msg)` | 下载进度与完成 |
| `LXFilePick` | `__onChunk(text)` / `__onDone(name)` / `__onFail(msg)` | 分块回传音源脚本文本（30 秒超时在 JS 侧） |

## 逐功能映射（Android → HarmonyOS）

### 1. HTTP / 搜索 / 榜单

- Android：`HttpURLConnection`，文本限 8 MB、二进制限 24 MB，分 180 KB 的 Base64 块回传。
- 鸿蒙：`@kit.NetworkKit` 的 `http.createHttp()` + `requestInStream(url, options, cb)`，
  监听 `headersReceive` / `dataReceive(ArrayBuffer)` / `dataEnd` / `error`；
  `util.Base64Helper.encodeToStringSync()` 转 Base64 后调 `LXHttp.onChunk`。
  超时用 `options.connectTimeout / readTimeout`，取消用 `httpRequest.destroy()`。
- 结论：**1:1 可复刻**，包括分块与体积上限。

### 2. 音效接管（关键功能，最容易被 CORS 卡住）

- 前端 `engine.js` 的 `_fetchBytes()` 只在“有桥 + 有 httpRequest”时走原生取字节 → Blob → Web Audio。
  这条路径**不需要 CORS 头**，所以鸿蒙只要把 `httpRequest` 的 binary 分支做对（`__base64:true`），
  音效就和 Android 一样稳；`mediaProxyBase()` 可以先返回空串（不启用代理）。
- Web Audio 在 ArkWeb 上是支持的（`AudioContext` / `decodeAudioData` 走 Chromium 内核），
  真机验证点：开启音效后切换播放是否无空档、EQ 是否生效。

### 3. 流式下载与落盘

- Android：`HttpURLConnection` 边读边写 `cacheDir/lx-dl/<key>.part`，支持 Range 续传，
  完成后写 MediaStore 的 `Download/LX Music`。
- 鸿蒙：`requestInStream` + `fileIo.openSync(CREATE|READ_WRITE)` 分块 `writeSync`；
  `.part` 放 `context.cacheDir/lx-dl/`，续传用 `Range: bytes=<part>Size-`。
- **落盘位置是唯一需要改语义的地方**：鸿蒙没有等价 MediaStore。两条路：
  1. 先写应用沙箱 `context.filesDir/downloads/`，再 `picker.DocumentViewPicker.save()` 让用户选目录导出（合规、但多一步交互）；
  2. 直接写沙箱 + 在设置页展示真实路径，`localMediaUrl()` 负责把它变成本地可播地址。
  建议先做 2（体验接近 Android 的“下载即能播”），再补 1 的“导出到文件管理器”。

### 4. 本地文件播放（`localMediaUrl`）

- Android：`https://<in-app-host>/__local?p=<相对路径>`，由应用内 HTTPS 服务带 Range 吐文件，
  这样 `<audio>` 能拖动进度条。
- 鸿蒙：先试 `file://<沙箱绝对路径>`（`Web` 的 `fileAccess(true)` 打开后，
  同应用沙箱内的 file:// 资源通常可被媒体元素加载）；若 ArkWeb 拒绝跨源 file://，
  退而用 `onInterceptRequest` 拦一个自定义 scheme（如 `lxlocal://song/<name>`）返回
  `WebResourceResponse`，但**注意 WebResourceResponse 不支持 Range**，长音频拖动会退化。
- 最终兜底：把已经下好的文件按 `httpRequest binary` 取回来做 Blob（内存换兼容，30 MB 以内可接受）。
- 这一项必须真机验证后再定方案，不要先写死。

### 5. 导入音源（`pickScript`）

- Android：`ACTION_OPEN_DOCUMENT` → 读字节按 UTF-8 解码 → 512 KB 一块 `evaluateJavascript` 回传。
- 鸿蒙：`picker.DocumentViewPicker(context).select({ maxSelectNumber: 1, fileSuffixFilters: ['.js','.json','.txt'] })`
  → `fileIo.openSync(uri, READ_ONLY)` 读 `statSync(uri).size` → 同样 512 KB 分块 →
  `LXFilePick.__onChunk(text)`，最后 `__onDone(name)`；异常走 `__onFail(msg)`。
- `pickScriptAck()` 语义：通知原生“回调已被接收”，Android 用它避免重复投递，鸿蒙照抄一个布尔位即可。

### 6. 保存文本 / toast / 退出

- `saveText`：`fileIo` 写沙箱后 `toast('已保存到 …')`（`bridge-patch.js` 里也是这个提示）。
- `toast`：`@kit.ArkUI` 的 `promptAction.showToast({ message })`。
- `exitApp`：`context.terminateSelf()`（仅 UIAbility 上下文可用）。

### 7. 不需要移植的

`mediaProxyBase` 的 https 媒体代理、VPN 相关、`PickedProvider`（Android 的 ContentProvider 文件共享）——
鸿蒙没有对应概念，用第 4 项的方案替代。

## 实施顺序（每步都能独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | `javaScriptProxy` 骨架 + `httpRequest/cancelRequest` + `LXHttp` 回调 | 搜索出结果、榜单能刷、点歌能出声（原生播放） |
| P1 | `downloadStart/Cancel/Clear/PartialSize` + `LXDownloadBridge` | 下载页进度走完、文件落沙箱、`localMediaUrl` 能播 |
| P2 | `pickScript*` + `LXFilePick` | 导入自定义音源成功后能搜到该源的歌 |
| P3 | `saveText/toast/exitApp` + `bridge-patch.js` 注入 | 设置导出、备份导入生成文件 |
| P4 | 音效链路（binary 分支 + Blob + Web Audio） | 开音效后 EQ/混响生效，切换无空档 |

## 风险与待验证项（真机 / 模拟器）

1. **ArkWeb 的 `file://` 与媒体 Range**：决定第 4 项走哪条路，必须先测。
2. **`javaScriptProxy` 的线程模型**：JS 调用回 ArkTS 主线程，`httpRequest` 必须立即返回、把重活丢到
   `taskpool`/异步，否则会卡 UI（Android 那边也是新开线程）。
3. **`runJavaScript` 频率**：180 KB 一块 + 250 ms 进度，与 Android 同量级；若 ArkWeb 注入有明显延迟，
   改用 `createWebMessagePorts` 走 MessagePort 通道（前端要加一个监听，属于唯一可能需要动前端的地方）。
4. **`requestInStream` 的二进制上限**：仍需自己在 ArkTS 侧计数，超 24 MB 直接报错（与 APK 一致）。
5. **签名**：CI 只出未签名 HAP，装机和 v2raym-hos 一样需要本地签名（证书和 profile 不进 CI）。

## 工作量判断

- ArkTS 侧约 600–800 行（三个回调对象 + 16 个方法 + 分块编解码），前端代码改动预期为 **0 行**
  （除非第 4 项逼出 `file://` 不可用，需要把 `localMediaUrl` 换成自定义 scheme，那时 `app.js` 里只需
  认一个前缀，约 3 行）。
- 与 Android 的差异集中在“公共目录落盘”和“本地播放地址”两处，其余是纯 API 平移。
