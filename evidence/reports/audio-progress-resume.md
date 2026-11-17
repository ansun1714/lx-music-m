# 音效 / 歌词 主线进度存档（明日续点）

- 存档时间：2026-11-17（晚，诊断日志导出轮）
- 仓库：`E:\AI\重构软件`，远端 `ansun1714/lx-music-m`，HEAD = `154e24f`（已推送，Release `hap-latest` 已出包）
- 本轮产物 HAP：`C:\temp\LXMusic-hap-new.hap`，637,542 B，未签名，SHA-256 `84537b0eb582312c8e371308f392662204f61b14337b79639cb9cc308d595ce6`（对应 `154e24f`）
- 取包注意：Release 现在挂两个资产，`SHA256SUMS.txt`（93 B，排在 assets[0]）和 `entry-default-unsigned.hap`；必须按 `name -like '*.hap'` 过滤，不要取校验和文件。

## 0. 2026-11-17 真机复测结论（最新）

**音效：用户确认效果可以了。**

用户本轮新报（`eaa13a6` 之前的版本）：
1. **播放中播放/暂停按钮状态不一致**：歌曲在跑，按钮仍显示三角。
   - 根因：界面 `S.playing` 只是本地镜像，只在 toggle/playFrom/onEnded/onError 时更新；引擎真实状态不回写，`onTick` 也没对账。
   - `eaa13a6`：引擎加 `onStateChange`；`onTick` 比对镜像与 `engine.playing`，不一致以引擎为准并 `renderPlayer()`。
2. **退后台后灵动岛点暂停停不掉**。
   - JS 侧根因：250ms 定时器发现 `el.paused` 就立刻 `el.play()` 自愈，把系统/灵动岛暂停抢回去。
   - `eaa13a6`：`_pauseMiss` 计数，连续两拍仍暂停才认定外部暂停 → 置 `playing=false`、记 offset、清定时器、`onStateChange(false)`。
   - `07cc58e`：给 `<audio>` 元素补 `pause`/`play` 事件监听，外部暂停/恢复**即时**同步内部状态（不等轮询），并加 `self.el === el` 守卫避免旧元素事件误触发；旧元素回调不再污染当前状态。
   - **遗留（原生侧缺口，未动）**：`EchoBridge.ets` / `module.json5` 未注册 AVSession、未配后台 continuous task。若真机上系统控件根本没把指令送到 ArkWeb 的 `<audio>`（事件监听收不到 pause），则需原生建 AVSession、写当前曲目信息、桥内把系统播放/暂停事件回调 JS。
3. **切歌进度没从头开始**：下一首仍从当前位置继续。
   - `07cc58e`：`load()` 加加载代际 `_loadGen`；`_playViaBuffer` 的解码成功/失败/取字节回调按代际丢弃已切歌的旧结果（旧 AudioBuffer/Blob 不再替换当前曲目）；`load()` 主动 `onTick(0,duration)` 把进度条/时间归零。
4. **歌词**：网易基本正常；酷我偶发刷不出，但概率比旧版大多了；咪咕/酷狗/腾讯仍未通，腾讯按用户要求暂不测。

## 0b. 上一轮（`0d0b2ea`）已闭环项

自检已接上图：`ctx=running ac=true snd=true bound=true healthy=true media=true mounted=true el=true playing=true`，`graphHost=f_sandroid.tx.kugou.com / m801.music.126.net`，`lite=true pending=false lastError=(无)`。

- **中途开总开关静音**：`attachEl()` 对活动元素（`!el.paused && readyState>=2`）拒绝直接补挂，改走已验证的 Blob 重建路径；切歌带音效回归确认。
- **酷我歌词**：空结果/非 JSON 延迟 700ms 重试一次；`lyricPending` 进行中缓存消除并发竞态；`clearLyric` 同步清 pending。

## 0c. 2026-11-17 晚：应用内诊断日志导出（已出包 `154e24f`，待真机验证）

**背景**：hdc 直连仍不通，改在 APP 内汇总日志并导出文件，用户回传分析。

- hdc 现状：便携 hdc `Ver 3.1.0e` 与 SDK 15 `E:\dev\ohos\sdk\15\toolchains\hdc.exe` 均 `list targets [Empty]`；PnP 仅 `HUAWEI Pura 70 Pro+`（WPD，OK，`USB\VID_12D1&PID_1101\33Z0224703029804`）；隐藏/历史项里 `HDC Device` PID_5000、`HDC Interface` PID_1101&MI_00、Remote NDIS PID_108A、MTP PID_107E 状态均 **Unknown**（驱动未绑定/未启动）；ARP WLAN 段无华为设备 MAC，无线 hdc 未建立。
- 待排障新现象（未抓到真机日志，根因未确认）：
  1. 换木兰/星海音源后 QQ 歌曲能在线播放，但**切歌偶发「音频加载失败」**，多切几次可播——竞态/资源释放类嫌疑；相关代码 `engine.js` `_createEl` error 监听、`stop()` 旧元素摘 src、`_playViaBuffer`/`_swapViaBlob` 异步回调；`app.js` `onError` 仅 toast + `S.playing=false`，无自动重试。
  2. **QQ 歌曲歌词返回空**：截图诊断「平台内置/kw: 返回空」「星海音乐源/tx: 返回空(null)」；`platformLyric(track)` 按 `track.platform` 选 wy/kw/mg/kg 分支，tx 无内置实现；需核对木兰/星海曲目 `platform/apiSource` 字段映射与 tx 歌词接口是否缺失。
- 落地改动（仅 `app/app.js`，未动原生桥，复用现有 `saveText`/`exportDownload`，`Index.ets` methodList 无需补）：
  - `devLog` 环形缓冲 500 条；`LXdlog` 同时写缓冲 + hilog + console；补 `window.onerror` / `unhandledrejection` 捕获进缓冲。
  - `buildDiagnosticLog()` 分段汇总：头部（时间/UA/队列/当前曲目/音源错误/播放位置）、引擎自检、音效状态、音源列表（name/id/status/enabled/builtin/platforms）、歌词诊断 `SR.lyricDiag()`、音源运行日志 `SR.logs()`、错误日志 `S.errorLog`、同步日志、下载任务 `DL.all()`、诊断缓冲。
  - 设置 → 其他缓存管理：新增「诊断日志 · 导出」行，`data-act="log-export"`；`exportDiagnostic()` 先 `saveText('lx-diag-<时间戳>.txt', text)` 落沙箱 `downloads/`，再 `exportDownload(name,'text/plain')` 拷到用户可访问目录；无桥环境降级 Blob 下载。
- 本地注意：`node evidence/build-standalone.js` / `inject-bridge-patch.js` 在本机对 `app/` 目录写文件报 EPERM（受控文件夹访问拦 node.exe）；CI 在 Linux 重新内联打包，不影响出包。`node --check app.js` 通过，离线基线仍 **PASS=11 FAIL=0**。
- 待真机验证：导出文件能打开、中文不乱码、各分段有内容；复现切歌失败 / 歌词空后再导出回传，据此定位根因。

## 一、当前测试状态（严格按任务书口径）

| 项 | 状态 |
|---|---|
| 离线回归 `evidence/audio-graph-tests.js` | **PASS=11 FAIL=0 TOTAL=11** |
| `node --check`（engine/sources/lyrics/app） | PASS |
| HARMONY_REAL_DEVICE_TEST | **PENDING**（`eaa13a6` 未真机验证；hdc 本轮探测 `[Empty]`） |
| ANDROID_EMULATOR_TEST | NOT_AVAILABLE（未探测 SDK/AVD） |
| ANDROID_REAL_DEVICE_TEST | PENDING |
| 腾讯平台 | 用户明确暂不测 |

## 二、真机上已被截图证实的现象（上一版 `2a139bb`）

### 音效，三类不同报错并行存在
1. `音效取字节失败: 响应过大（超过 24MB）` —— FLAC / 高码率整段超原生桥 `LIMIT_BINARY`。
2. `音效取字节失败: Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.` —— 分片各自带 `=` 填充，拼接后整体 atob 抛错。
3. 07:23–07:24 三张自检：`ctx=running ac=true snd=true mounted=true el=true playing=true`，但 `media=false bound=false healthy=false`，**且 `graphHost=- lite=false lastError=(无)`** —— 无任何取字节/解码错误，说明接图在更早一步被静默跳过。

统一特征：`mode=stream`，`mounted=true`，`bound=false`。

### 歌词
- 网易：已出词，时间节点**用户确认正确**，但高亮行在显示区偏上，用户估算「向上偏 8~9 行才进视口」。
- 酷我 `平台内置/kw: 返回空`；咪咕 `平台内置/mg: 接口返回的不是 JSON`；酷狗 `平台内置/kg: 暂未实现 krc 解密`。

## 三、`c8b3d57` 已做但未验证的修复

1. `app/engine.js` `_swapViaBlob` 内 `lite.then` 回调：`this._graphUrl / this._graphLite` → `self._*`（非严格模式下 `this` 非引擎实例，诊断字段写不上实例，是 `graphHost=-` 的直接原因之一）。
2. `app/engine.js` 新增 `attachEl()`：链就绪后对被 `forceNative` 创建、尚无 `mediaSrc` 的现有 `<audio>` 补挂 `createMediaElementSource`；`app/app.js` `syncAudioGraph` 在 rebuild 前先调它。
3. 自检新增 `pending=`（`blobPending`），`getAudioStatus` 透出。
4. `app/sources.js` 咪咕分支 `httpJson` → `http` 取文本：先判 JSON 解析 `lyric` / `data.lyric`，否则含 `/\[[0-9]+:/` 就直接当 LRC 用。
5. `app/lyrics.js` `sync` 滚动定位：`offsetTop` → `getBoundingClientRect` 视口坐标换算，中心系数 0.55。

## 四、明日续点（第一步就是真机复测，不是再改码）

### 4.1 装机前置
- 设备在线判断：`C:\Users\maoxu\Desktop\鸿蒙软件\HapInstaller-Portable-v1.0.0\tools\hdc.exe` 先 `kill` 再 `list targets`（避免 SDK 15 的 hdc 抢设备）。本轮为 `[Empty]`，先确认手机连上、USB 调试授权、`hdc` 能列出序列号。
- 装机：`cu.switch_desktop("main")` → `list_apps()` 取 `鸿蒙安装助手.exe#...` → `launch_app` → 连接检测 (723,138)（1600×900 归一化）→ 安装包路径框 (293,238) → 签名并安装 (277,809)。
- 包已在 `C:\temp\LXMusic-hap-new.hap`（628,244 B，`c8b3d57`），不需要重新出包；若要重建，流程见第六节。

### 4.2 音效：先分类，再改码
开一次播放 + 音效，进「音效设置 → 音频图自检 → 检测」，按新字段读结论：

| 自检结果 | 判读 | 下一步 |
|---|---|---|
| `bound=true` `media=true` | 修好了 | 进听感验证（重低音/教堂/环绕是否真的有差别） |
| `pending=true` 且长时间不变 | Blob 取字节已发起但没回（原生桥 hang 或超限） | 抓 hilog `[audio]` + `JS[audio]`，看 `graph fetch lite=? host=?` 与原生侧 chunk 计数 |
| `pending=false` `graphHost=-` | 连取字节都没发起 → `_swapViaBlob` 没被调用 | 查 `play()` 里 `_wantBlob` 消费路径，确认 `_blobPending` 是否被 `load()`/`stop()` 提前清掉 |
| `pending=false` `graphHost` 有值 `bound=false` | 字节取到了，挂在 `_cloneFrom`/`_swapToGraphable` 失败 | 看 `lastError`，重点怀疑 ArkWeb 跨域元素补挂被污染（静音、不报错） |
| `lastError=响应过大` | 128k 降级地址被音源忽略，仍回高码率 | 在「强制低码率」与「内存可控前提上调上限」之间取舍（见第五节未决问题） |
| 无任何字段变化、`ctx=none` | 音效链根本没建（手势未触发 `prepareGraph`） | 查 `fx-toggle` 手势路径 |

必须抓的证据：`hdc shell hilog -r` 清日志 → 复测 → `hdc shell hilog -x` 导出，过滤 `[audio]` / `JS[audio]` / `LXMusicBridge` / `A00D00`；崩溃看 `AppFreeze` / `THREAD_BLOCK_6S`。

### 4.3 歌词：三家分别验
- 网易：看高亮行是否居中。若仍偏 8~9 行 → **不是定位偏移，是时间基准问题**（高亮超前/滞后），下一轮改用「当前播放时间 ± 一屏内匹配」而不是纯 scroll 系数；同时校 `[offset:±ms]` 的加减方向（当前是 `t = 原始 - offset/1000`，未真机校正）。
- 咪咕：本版已改文本兜底，看是否仍「不是 JSON」；若解析出字但无时间戳，说明拿到的是纯文本歌词而非 LRC。
- 酷我：newh5 接口仍「返回空」，需查 rid 取值（`MUSICRID` 去 `MUSIC_` 前缀、`_raw.rid=DC_TARGETID||MUSICRID`）与是否需 cookie/Referer；可用 `hdc shell` 侧无法直连外网时改在 JS 里打点记录 statusCode。
- 酷狗：krc 未实现（去头 + Base64 + zlib 解压，缺解压器）。要么补一个纯 JS inflate，要么标注为已知缺口不再尝试。

## 五、未决问题（需要你拍板或真机数据支撑）

1. 24MB 上限可否放宽、放宽到多少。任务书第七条要求保留「原有 24MB 缓存限制」，需先判断它和音效取字节上限是否同一约束。
2. 若 128k 降级地址始终被音源忽略，选「强制低码率」还是「调上限」。
3. `evidence/reports/` 与 `evidence/audio-graph-tests.js` 随功能一起入库，是否长期保留这一做法。

## 六、续跑命令备忘

```powershell
# 提交推送（git 不在 PATH）
Set-Location 'E:\AI\重构软件'
& 'C:\Program Files\Git\cmd\git.exe' add -A
& 'C:\Program Files\Git\cmd\git.exe' commit -m "..." 
& 'C:\Program Files\Git\cmd\git.exe' fetch origin main; & 'C:\Program Files\Git\cmd\git.exe' rebase origin/main; & 'C:\Program Files\Git\cmd\git.exe' -c http.version=HTTP/1.1 push origin main

# 离线回归（改完必跑）
node evidence/audio-graph-tests.js     # 基线 PASS=11 FAIL=0

# 出包等待：轮询 releases/tags/hap-latest，按 body 里「源码提交」匹配 commit；
# 资产按 `name -like '*.hap'` 过滤取下载 URL（现在还有 SHA256SUMS.txt 排前面，93 B），
# Accept: application/octet-stream 下载到 C:\temp\LXMusic-hap-new.hap（覆盖，不留历史版本）
```

## 七、提交链

`153229a`（Blob 失败降级 buffer）→ `227dff3`（128k 地址 + 咪咕/酷我兜底）→ `2a139bb`（逐块 Base64、兜底顺序、酷我新接口、kg 标注）→ `c8b3d57`（lite.then 的 this、attachEl、pending、咪咕文本兜底、视口坐标滚动）→ `0d0b2ea`（活动元素拒绝补挂改走 Blob 重建；酷我重试一次；歌词进行中缓存）→ `345f1c4`（docs 存档 [skip ci]）→ `eaa13a6`（播放状态回写镜像；识别外部暂停后不再重放抢回，清定时器）→ `07cc58e`（切歌代际守卫丢旧回调、进度归零；元素 pause/play 事件即时同步）→ `154e24f`（应用内诊断日志环形缓冲 + 汇总导出；全局异常/未处理拒绝入缓冲）

体积：`153229a`=622,924 / `227dff3`=624,554 / `2a139bb`=626,353 / `c8b3d57`=628,244 / `0d0b2ea`=629,468 / `eaa13a6`=630,473 / `07cc58e`=632,133 / `154e24f`=637,542

## 八、下一轮真机待验证清单

1. **切歌进度归零**：多连切几首，每首进度条与音频都应从 00:00 起；若仍带旧位置，抓 `[audio]` 看是 buffer 退路旧回调残留还是 `S.progress[id]` 记住了上次位置（设置里「记住播放进度」开关的预期行为需确认）。
2. **按钮状态**：播放中底部播放条与详情页大按钮都显示暂停图标（双竖线）；点一次变三角并真停。
3. **后台灵动岛暂停**：退后台，灵动岛/锁屏点暂停应能停住、不被抢回、按钮回三角；若仍停不掉，先看 JS 是否收到元素 `pause` 事件（可在 `[audio]` 加日志）。收不到则确认是原生缺口：需建 AVSession、配后台连续任务、桥内回调系统播放/暂停到 JS。
4. **中途开总开关**：先原生播一首 → 不切歌直接开音效总开关。预期：短暂 `pending=true` 缓存后 `bound=true media=true` 且有声音、音效可闻。
5. **切歌带音效**：回归确认仍正常。
6. **酷我歌词**：多切几首酷我，看是否一次出词；仍空则看诊断 detail。
7. **咪咕**：确认文本兜底是否生效；仍空需抓原始响应体前 200 字判断反爬/gzip。
8. **网易高亮位置**：视口坐标方案后是否居中；偏则排查 `[offset]` 方向、indexAt 容差。
