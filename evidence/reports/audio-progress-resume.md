# 音效 / 歌词 主线进度存档（明日续点）

- 存档时间：2026-11-17 深夜收工（真机体验排障第五轮：冷启动弹窗 / 详情页标题 / 酷狗音效开关）
- 仓库：`E:\AI\重构软件`，远端 `ansun1714/lx-music-m`，**HEAD = `98b87b8`（已推送，Release `hap-latest` 已出包，body「源码提交 98b87b8」）**
- 本轮产物 HAP：`C:\temp\LXMusic-98b87b8-unsigned.hap`（＝`C:\temp\LXMusic-hap-new.hap`），**653,548 B**，未签名，SHA-256 `299229f113bc67e0d376bad105ec938fc36d6e05dd4b988d20ca3e0dfbd05dd6`；已用 `present_files` 本机绝对路径推到对话框交付。
- 取包注意：Release 现在挂两个资产，`SHA256SUMS.txt`（93 B，排在 assets[0]）和 `entry-default-unsigned.hap`；必须按 `name -like '*.hap'` 过滤，不要取校验和文件。
- 交付口径（用户硬性要求）：**不许 `FileBatchUpload`/CDN 转存**（会变 `.image` 后缀被用户否决），一律 `present_files` 传本机绝对路径；不出签名包，用户自己在手机侧签。
- 仓位规矩：只保留 `LXMusic-hap-new.hap` 与当版带 sha 的副本，旧版包直接删（`7dac9ff`、`4127719` 已删）。

## 明日首件事（三条待真机验证，按这个顺序验最省轮次）

装在手机上的是 `98b87b8`，本轮改了三处、全部未真机验证：

1. **冷启动弹系统文件管理器**（连续四轮未解）
   - 已排掉的：`fileShare.activatePermission` 会拉起文件管理器 + `FILE_ACCESS_PERSIST` 权限声明（`4127719` 全删）；冷启动 12 秒内原生桥无任何 picker 调用（`18:45:36 init` 是轨迹里唯一一行）。
   - `98b87b8` 新招：`Index.ets` 注册 **`.onShowFileSelector()`** 并返回「已处理、不选任何文件」。ArkWeb 在页面发起文件选择请求（`<input type=file>` / `showOpenFilePicker`）且未注册该回调时，会由系统直接拉起文件管理器。
   - **判读**：新日志「原生桥轨迹（导出前快照）」里若出现 `ArkWeb 请求文件选择器：已拦截` → 就是页面请求引起的（已拦掉；若仍弹则下一步关 `Web.fileAccess(true)` 做对照，注意 `localMediaUrl` 用 `file://` 播沙箱音频，可能要保留）；若仍然只有 `init` → 是系统/ArkWeb 应用外层行为，换方向。
2. **详情页「下一首」标题/封面不更新**
   - 根因已定位：`renderOverlay()` 的 detail 分支取曲目是 `D.byId(S.overlayId) || currentTrack()`，`S.overlayId` 只在 `openOverlay()` 写一次，切歌后不更新。
   - `98b87b8` 修复：`playFrom` 在 `S.overlay === 'detail'` 时先 `S.overlayId = tr.id` 再 `renderOverlay()` + `loadDetailLyric(tr)`，标题/副标题/封面/总时长/收藏态一并换。
   - 验法：详情页打开状态连按几下「下一首」，看标题是否跟着走、歌词是否同步重载。
3. **酷狗平台上音效「关不掉」**
   - 证据（`lx-diag-...-10-22-27.txt`）：`18:21:17~18:21:35` 出现 `prepareGraph fail(音效未开启)` 与 `ok` 交替 11 次（间隔 1~2 秒），导出时 `enabled=true` → 一次点击让状态翻转两下。
   - `4127719`/`98b87b8` 现状：`fx-toggle` 按 `Snd.state().enabled` 反推目标值 + 400ms 去重丢弃重复事件；关闭时不再 `engine.prepareGraph()`；`setEnabled` 补 `LXdlog('fx','setEnabled -> ...')`。
   - 验法：音效页点关闭→开→关三四次，日志里 `fx-toggle 点击 -> enabled=` 与 `setEnabled ->` 两行应一一成对；若仍交替，说明别处又把开关打开（查 `setPreset/setBand/setReverb/setSurround` 的隐式 `enabled=true`）。

## 已闭环（本轮确认，不必再动）

- **音效效果**：用户确认「音效目前效果可以了」。
- **灵动岛暂停**：用户确认「灵动岛暂停的问题目前解决掉了」。
- **切歌进度归零**：用户确认「切歌归0的问题解决掉了」。
- **QQ 歌词**：`98b87b8` 前已通，日志实证 `18:17:37 平台内置/tx => ok 1061 字`、`18:18:33 ok 1696 字`（`c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=&format=json&nobase64=1` + `Referer: y.qq.com`，配 `parseJsonLoose` / `maybeB64Text`）。
- **酷我断续**：换快源（星海 `yy1.zddyr.top`）后秒级就绪，实证慢源是上游代理（墨澜 `175.27.166.236:8928` ≈0.2~0.3 倍实时）。
- **酷我歌词偶发刷不出**：已加双重重试（700/1500ms）+ 竞态自愈，用户认可「概率比之前大很多」。

## 仍无解 / 已判定外部依赖

- **酷狗（kg）歌词**：三条 kg 后端全 `无数据`/`不支持音质`/`Failed to connect`，且 krc 需 zlib 解压能力，客户端无解。
- **QQ 偶发「音频加载失败」**：多切几次能播，音源侧间歇（`后端失败: QQ 音源暂无可用`），非客户端竞态。
- **停手约 10 秒左侧菜单自动弹出**：未定位。
- 2B（`ensureRunning()` 单飞、`ctx.onstatechange`、generation token、IR 优化）与 2C（环绕后台暂停、重写 `device-effects-check.js`、`run-all-tests.js`、统一 `isFlat()`）未开始。

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

## 0e. 2026-11-17 17:46 真机日志分析（`lx-diag-2026-11-17-09-46-54.txt`，8838 B）

**结论：酷我「放一秒停一会儿」不是客户端逻辑问题，是音源侧的上游代理吞吐不足。**

证据链（同一份日志内对照，排除网络整体问题）：

| 时间 | 平台 | 上游 host | 现象 |
|---|---|---|---|
| 17:44:52~17:45:05 | kw | `175.27.166.236:8928` | 起播 3 秒才有 `buf=0s`；`canplay buf=1s` → `waiting t=0.5` → 6 秒后 `canplay t=0.7 buf=1s` → 再 `waiting t=1.4`；`stalled` 在 t=0.4 出现 |
| 17:45:08~17:45:47 | kw | 同上 | 同样节奏：`waiting t=0.1` → 2s 后 `buf=1s` → `waiting t=0.5` → 6s 后 `buf=1s` → `waiting t=1.3` → 12s 后才 `buf=3s` |
| 17:45:57 | tx | `ws.stream.qqmusic.qq.com` | 起播即 `blob play rs=4 buf=237s`，整段已就绪 |
| 17:46:13 | mg | `freetyst.nf.migu.cn` | 起播即 `blob play rs=4 buf=284s` |

- 换算：kw 大约 **每 3~6 秒只能拿到 1 秒音频**（约 0.2~0.3 倍实时）。5 分钟的歌靠边下边播永远追不上，所以必然是「放一秒停一会儿」。
- `175.27.166.236:8928` 不是酷我官方 CDN，是音源侧自建的中转（墨澜聚合音源把 kw 流量转发到自己的服务器）。同一台手机同一时刻 tx/mg 秒级就绪 → **不是手机网络、不是 ArkWeb、不是我们的元素管理**。
- **音效关闭时也在断续**（17:44:32 / 17:44:52 / 17:45:08 三次 `prepareGraph fail(音效未开启)`），所以与音效图、Blob 抢带宽无关；此前把根因归到「双流抢带宽」是**错判**，`8e73530` 的 `stall-hold` 在这条日志里没有出现，因为它们不满足触发条件。
- 17:45:33 用户开音效后 `graph fetch lite=false`（128k 档位没解析成功，退回原地址），确实又在同一条慢链路上多开了一路 → 17:45:43~17:45:47 `buf` 从 3s 只涨到 8s。

**同轮其它发现：**

1. **kg（酷狗）三条后端全失败**：`海堂KG 无数据` / `白姬KG 不支持音质` / `星海KG 酷狗上游拒绝该请求`。曲目 `kg_316872940 忘情水` 无地址；但元素仍是上一首咪咕的 284s（`srcHost=freetyst.nf.migu.cn`），界面显示新歌、声音是旧歌 —— 见修复②。
2. **歌词诊断打印成 `[object Object]`**：`SR.lyricDiag()` 返回 `{src,ok,detail}` 对象，`diagSection` 直接 `join` 把最有用的失败原因全丢了 —— 见修复③。
3. **日志缺版本标识**：无法判断用户装的是 `8e73530` 还是更早的包 —— 见修复①。
4. 歌词本身：kw `平台内置/kw` 17:45:25 第一次 `fail 返回空`，17:45:37 第二次 `ok 833 字`，与「重试一次」策略吻合；酷我「偶发刷不出」= 第一次空、重试补上，属上游抖动。

**本轮修复（`app` 侧 3 处 + 构建侧 1 处）：**

1. `evidence/build-standalone.js`：构建时 `git rev-parse --short HEAD` 写入 `window.LXBuild`，`buildDiagnosticLog()` 首行输出「版本: xxx」。
2. `app/app.js` `playFrom`：`!ref`（解析不到地址）分支现在 `engine.stop()` + `renderPlayer()` + 重绘详情页，不再让上一首的元素和进度留在界面上。
3. `app/app.js` `buildDiagnosticLog`：`歌词诊断` 段把对象格式化成 `ok/FAIL · src · detail` 一行一条。
4. `app/engine.js` 慢流识别与让路：`_onStall` 15s 窗口累计 ≥3 次卡顿置 `_slowStream`；此后 `_swapViaBlob` 直接放弃并发取整段（`graph skip: slow-stream`）、`rebuild()` 不重建元素（`rebuild skipped: slow-stream`），优先保连续出声，`_lastError` 写明原因。`load()`/`stop()` 复位该标记。

**给用户的可操作建议（客户端改不了上游吞吐）：**

- 酷我这类慢源，先在「设置 → 自定义源 → 音源音质」把在线试听降到 128k，文件小 → 同样的带宽上限下实时倍率提高约 2~2.5 倍；仍不够就只能换源（tx/mg 在两份日志里都正常）。
- 酷狗三条后端全挂是音源配置问题（`不支持音质` / `上游拒绝`），需要在墨澜音源里换 kg 后端或换音源，客户端无解。

## 0d. 2026-11-17 晚（二）：日志入口不可见 + 酷我断续（已出包 `8e73530`，待真机验证）

**用户反馈**：① 最新版「日志下载的地方没找到」；② 酷我平台切歌后「放一秒停一会儿，放一秒停一会儿」，QQ 平台正常。

- **① 入口问题（已修）**：导出功能本身已接线（`case 'log-export'`），但入口埋在「设置 → 其他 → 缓存与错误日志 → 诊断日志 → 导出」三层里，音效页那颗「导出日志」按钮也在页面中段，用户翻不到。
  - `app/app.js`：`SETTING_GROUPS` 的「其他」组新增首行 `{ k:'__diag', n:'诊断日志', type:'diag' }`，`settingRow` 出「导出 / 查看」两颗按钮（`sr-actions` 容器）。
  - 新增 `diaglog` 浮层：等宽 `<pre>` 全文 + 「导出文件 / 复制全文 / 刷新」；`S.diagText` 缓存当前文本。
  - `copyDiagText()`：优先 `navigator.clipboard`，失败落 `textarea + execCommand`，再失败则把全文选中（长按可复制），三种结果都有 toast。
  - 音效页自检行按钮改为 `.fx-actions` 容器，`.fx-label` 允许收缩（`min-width:0; flex:1 1 auto`），避免两个按钮把标签挤没。
  - `app/styles.css`：新增 `.sr-actions` / `.diag-wrap` / `.diag-bar` / `.diag-pre` / `.fx-actions`。
- **② 酷我断续（结构性修复，根因假设待日志确认）**：开着音效的在线曲目，当前是「原生元素直接流播远端地址」+「桥并行取整段字节准备 Blob」两条流同时跑。酷我这类按连接限速的 CDN 上，两路互抢带宽 → 元素反复 `waiting/stalled` → 听感即「放一秒停一会儿」；QQ 的 host 不卡限速，所以正常。
  - `app/engine.js`：新增 `_onStall(el)`，`waiting`/`stalled` 15s 窗口内累计 ≥2 次且存在 `_blobPending` 时置 `_stallHold` 并主动 `el.pause()`，把带宽全让给取字节；Blob 到达后由 `_swapToGraphable` 无缝接管（位置取暂停时刻 `currentTime`，不跳段）。
  - 250ms 定时器加 `_stallHold` 分支：让路期间既不当外部暂停、也不 `play()` 重放。
  - 新增 `_releaseStallHold(resume)`：取字节失败 / Blob 接管超时（12s）时解除让路并把元素放回去出声，避免「一首都没声」；`load()`/`stop()`/`_cloneFrom` 成功后都复位 `_stallHold`/`_stallWin`。
- 校验：`node --check app/app.js`、`node --check app/engine.js` 通过；`node evidence/audio-graph-tests.js` 仍 **PASS=11 FAIL=0**。
- 设备现状：便携 hdc 反复 `kill` 后 `list targets` 仍 `[Empty]`，PnP 无 HDC 设备 → 本轮未装机、未抓日志。
- 待真机验证：① 设置 →「其他」组第一行应直接看到「诊断日志 · 导出/查看」；② 酷我连切 3~5 首，是否还断续；仍断续则导出日志看 `[audio]` 里 `waiting/stalled` 与 `stall-hold` 记录，区分「限速」还是「解码器被回收」。

## 0f. 2026-11-17 18:04 真机日志分析（`lx-diag-2026-11-17-10-04-35.txt`，10562 B，版本 `556798d`）

**三条结论：换源后酷我问题彻底消失；`556798d` 的 `stall-hold` 在慢源上制造了「开音效就没声」的新回归；QQ 歌词为空是代码里根本没有 tx 分支。**

| 时间 | 平台 / 音源 | host | 结果 |
|---|---|---|---|
| 18:01:57 / 18:02:05 / 18:02:14 | kw / 墨澜 | `175.27.166.236:8928` | `stall-hold` 触发 → `el pause paused=true` → 之后只到 `canplay buf=1s`，**再也没有恢复播放**（用户 8 秒后手动切歌） |
| 18:03:54 起 | kw / 星海 | `yy1.zddyr.top` | `lite=true`、`blob play buf=271s`，秒级就绪、全程顺滑 |
| 18:02:28 / 18:03:07 | tx / 星海 | `ws.stream.qqmusic.qq.com` | 正常播放 |
| 18:04:08~18:04:18 | tx / 星海 | — | 连续四首 `后端失败: QQ 音源暂无可用`（星海 tx 后端挂了，上游问题） |

1. **酷我「放一秒停一会儿」= 上游代理吞吐不足，已由换源实证**：同一台手机、同一时刻，墨澜那条 `175.27.166.236:8928` 每 3~6 秒才进 1 秒音频（≈0.2~0.3 倍实时），换星海 `yy1.zddyr.top` 后起播即 `buf=271s`。用户主观确认「换了音乐源，确实酷我的不卡顿了」。客户端不再为慢源做带宽妥协，只保证「慢源上不出现更糟的体验」。
2. **`556798d` 引入回归：慢源 + 音效 = 彻底没声**。`_onStall` 在连续两次卡顿后 `el.pause()` 让路，但慢源上整段取字节要几分钟，`_releaseStallHold` 只在取字节失败/接管超时才调 → 元素被自己停住后无限期不出声。听感从「断续」恶化成「点了歌没声」。
3. **QQ 歌词为空是代码缺口**：`platformLyric` 只实现 `wy/kw/mg/kg`，**没有 `tx` 分支**，走到底部 `return Promise.resolve(null)` 且不记 `diagLyric`；`doLyric` 的音源链对 tx 也返回空（音源侧没有可用歌词后端）。日志「歌词诊断 (无)」即此。

**本轮修复（3 处）：**

1. `app/engine.js` `_onStall`：
   - 15 秒窗口累计 **≥3 次**卡顿即判定慢流：置 `_slowStream`、清 `_blobPending`/`_wantBlob`、`_releaseStallHold(true)` 立刻恢复出声（不再压着不出声）。
   - ≥2 次的让路分支加 **3 秒兜底定时器**：3 秒内字节没到就 `_releaseStallHold(true)` 恢复原生播放，最长只哑 3 秒。
   - `_releaseStallHold` 清 `_holdTimer`；`load()`/`stop()` 均复位 `_holdTimer` 与 `_slowStream`（每首歌重新判定，换源后快源不受影响）。
2. `harmony/entry/src/main/ets/core/EchoBridge.ets` `loadSaveDir()`：**删掉启动期的 `fileShare.activatePermission`**，启动只从 preferences 读 URI 并回推 JS。冷启动弹系统文件管理器的根因就是 `init()` → `loadSaveDir()` 里的这次激活授权（`Index.ets` 的 `.onPageEnd` 注释早已写明该行为，但 `init()` 绕过了它）。授权改到 `saveToDir` 的失败重试分支（EPERM/EACCES/13900042）按需激活。
3. `app/sources.js`：
   - 新增 `tx` 内置歌词分支，走 `c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>&format=json&nobase64=1`（`Referer: https://y.qq.com/portal/player.html`）。本机不带 cookie 实测 `retcode=0` 且 `lyric` 为明文 LRC（曲目 `004QC9Z62Z5K6b`「独自去偷欢」取到 2KB 歌词）。
   - 新增 `parseJsonLoose()`：纯 JSON / JSONP `MusicJsonCallback(...)` / `try{...}catch(e){}` 三种包装依次尝试（腾讯三种都出现过），三种用例离线校验通过。
   - 新增 `maybeB64Text()`：`nobase64=1` 失效时歌词仍可能是 base64，先判字符集（≥40 字符且仅 base64 字符）再解，明文原样返回（离线校验：明文保持 true / base64 解出 true）。
   - `platformLyric` 顶部补诊断：缺 `songmid`、平台模块未就绪都记 `diagLyric`，界面「暂无歌词」后面能直接看到原因。
   - kw 歌词重试从 1 次提升到 **2 次**（700ms / 1500ms 递增），失败 detail 标注「已重试 2 次」。

**离线校验**：`node --check app/sources.js`、`app/engine.js` 通过；`node evidence/audio-graph-tests.js` **PASS=11 FAIL=0**；腾讯歌词接口与解析用例离线验证通过（真机仍未验证）。

**未解 / 上游问题**：星海 tx 后端 18:04 连续四首 `QQ 音源暂无可用`（音源侧，客户端无解）；kg 三条后端全失败（含 krc 未解密）；酷我慢源体验仍取决于用户所选音源。

## 0g. 2026-11-17 18:22 真机日志（`lx-diag-2026-11-17-10-22-27.txt`，`7dac9ff`）

**已确认修复生效：腾讯歌词通了。** `18:17:37 [lyric] 平台内置/tx => ok 1061 字`、`18:18:33 平台内置/tx => ok 1696 字`（音源侧 `星海音乐源/tx => fail 返回空` 后由内置接口补上）。酷我慢源也不再出现「开音效没声」：本轮 kw 全程走 `yy1.zddyr.top` / `fsandroid.tx.kugou.com` 快链，`blob play buf=279s`，无 `stall-hold`。

**用户新反馈两条：**

1. **冷启动仍弹系统文件管理器**。JS 侧日志无任何 picker 记录 → 说明不是页面触发的，是原生侧。排查后代码里只剩两处 `fileShare` 调用（`applySaveDir` 的 `persistPermission`、`saveToDir` 的权限重试 `activatePermission`），二者都会拉起系统文件管理器。
   - `module.json5`：删除 `ohos.permission.FILE_ACCESS_PERSIST` 声明（本机缺 FolderSelection，目录授权本就不可用）。
   - `EchoBridge.ets`：删除 `fileShare` import 与全部 `persistPermission` / `activatePermission` 调用（含 `saveToDir` 的权限重试分支，改为直接提示「用保存到文件导出」）。自此原生侧**不存在任何非用户点击的 picker / 授权调用**。
   - `EchoBridge.ets` 新增 `nativeTrace()`：只记录可能拉起系统 UI 的动作（`init` / `loadSaveDir` / `pickExportDir` / `exportDownload` / `saveAllDownloads` / `picker.save open` / `applySaveDir`），`buildDiagnosticLog()` 新增「原生桥轨迹」段。若下一版仍弹窗，这一段能直接证明是我们调的 picker、还是系统/ArkWeb 自发行为。
2. **酷狗平台音效关不掉**。日志证据：`18:21:17~18:21:35` 出现 `prepareGraph fail(音效未开启)` 与 `prepareGraph ok` 交替 11 次（间隔 1~2 秒），导出时 `enabled=true`。即**一次点击能让开关状态翻转两次**，用户看到的就是「关不掉」。
   - `app/app.js` `fx-toggle`：改为按 `Snd.state().enabled` 反推目标值，并对 400ms 内的重复事件去重丢弃；记录 `fx-toggle 点击 -> enabled=X state=X bound=X`。关闭时不再调用 `engine.prepareGraph()`（避免无谓重建元素、卡 1~2 秒没声）。
   - `app/sound-effects.js` `setEnabled`：补 `LXdlog('fx','setEnabled -> X mounted=X')`，与上面一行可一一对照，判断是「点击被重复派发」还是「别处又把开关打开」。
   - 说明：关闭时引擎仍保留音频图作**干净旁路**（EQ 全 0、湿声 0），不换元素——这是上一版为避免「关一下就没声」特意保留的行为，不影响听感。

**离线校验**：`node --check app/app.js`、`app/sound-effects.js` 通过；`node evidence/audio-graph-tests.js` **PASS=11 FAIL=0**。真机仍未验证。

## 0h. 2026-11-17 18:45 真机日志（`lx-diag-2026-11-17-10-45-48.txt`，1413 B，`4127719`）

**这份日志只覆盖冷启动后 12 秒（18:45:36 init → 18:45:48 导出），但足够定两件事。**

1. **原生桥轨迹只有一行 `18:45:36 init`**，没有 `picker.save open` / `exportDownload` / `pickExportDir` / `applySaveDir`。即冷启动后 12 秒内原生侧**没有发起任何 picker 或授权调用**。
   - 注意：这一段是 `buildDiagnosticLog()` 的快照，导出动作本身（`exportDownload`）发生在快照之后，所以不会出现在段内 —— 这是本轮把段落标题改成「原生桥轨迹（导出前快照）」的原因，避免误读成「导出没走桥」。
   - 结论：`4127719` 之后仍未解决的冷启动弹窗**不是 EchoBridge 拉的**。`fileShare` 调用与 `FILE_ACCESS_PERSIST` 声明已在本版删除。
2. **详情页切歌后标题/封面不更新**：`renderOverlay()` 的 detail 分支取曲目顺序是 `D.byId(S.overlayId) || currentTrack()`，而 `S.overlayId` 只在 `openOverlay()` 时写入、切歌后不更新 → 声音换歌、详情页仍渲染旧曲目。

**本轮修复（3 处）：**

1. `app/app.js` `playFrom`：详情页打开状态下切歌时 `S.overlayId = tr.id` 再 `renderOverlay()`，标题/封面/时长/收藏态一起跟着换歌。
2. `harmony/.../pages/Index.ets`：新增 **`.onShowFileSelector()` 显式接管**。ArkWeb 在页面发起文件选择（`<input type=file>` / `showOpenFilePicker`）且未注册该回调时，会由系统直接拉起文件管理器；这里直接返回「已处理且不选任何文件」，既避免系统弹窗，也把事件记进桥轨迹（`ArkWeb 请求文件选择器：已拦截`）。音源导入走 `EchoBridge.pickScript`，不受影响。
3. `EchoBridge.ets`：新增 `noteFileSelector()` 写入轨迹；`app.js` 诊断段标题改为「原生桥轨迹（导出前快照）」。

**下一轮判读口径**：冷启动后再导出日志，若「原生桥轨迹」里出现 `ArkWeb 请求文件选择器：已拦截`，说明弹窗来源是页面发起的文件选择请求（已被拦截，若仍弹则需关 `fileAccess`）；若仍然只有 `init`，则是系统/ArkWeb 在应用外层的自发行为，需要换方向（例如关闭 `Web.fileAccess(true)` 做对照）。

**离线校验**：`node --check app/app.js` 通过；`node evidence/audio-graph-tests.js` **PASS=11 FAIL=0**。

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

`153229a`（Blob 失败降级 buffer）→ `227dff3`（128k 地址 + 咪咕/酷我兜底）→ `2a139bb`（逐块 Base64、兜底顺序、酷我新接口、kg 标注）→ `c8b3d57`（lite.then 的 this、attachEl、pending、咪咕文本兜底、视口坐标滚动）→ `0d0b2ea`（活动元素拒绝补挂改走 Blob 重建；酷我重试一次；歌词进行中缓存）→ `345f1c4`（docs 存档 [skip ci]）→ `eaa13a6`（播放状态回写镜像；识别外部暂停后不再重放抢回，清定时器）→ `07cc58e`（切歌代际守卫丢旧回调、进度归零；元素 pause/play 事件即时同步）→ `154e24f`（应用内诊断日志环形缓冲 + 汇总导出；全局异常/未处理拒绝入缓冲）→ `2bf3b6e`（音效面板加导出日志入口；音频元素事件/缓冲/地址进诊断缓冲）→ `8e73530`（诊断日志入口提到设置「其他」首行 + 全文查看/复制；酷我断续：原生流与取字节抢带宽，连续卡顿主动让路给 Blob 接管）

体积：`153229a`=622,924 / `227dff3`=624,554 / `2a139bb`=626,353 / `c8b3d57`=628,244 / `0d0b2ea`=629,468 / `eaa13a6`=630,473 / `07cc58e`=632,133 / `154e24f`=637,542 / `2bf3b6e`=640,088 / `8e73530`=646,147

## 八、下一轮真机待验证清单

1. **切歌进度归零**：多连切几首，每首进度条与音频都应从 00:00 起；若仍带旧位置，抓 `[audio]` 看是 buffer 退路旧回调残留还是 `S.progress[id]` 记住了上次位置（设置里「记住播放进度」开关的预期行为需确认）。
2. **按钮状态**：播放中底部播放条与详情页大按钮都显示暂停图标（双竖线）；点一次变三角并真停。
3. **后台灵动岛暂停**：退后台，灵动岛/锁屏点暂停应能停住、不被抢回、按钮回三角；若仍停不掉，先看 JS 是否收到元素 `pause` 事件（可在 `[audio]` 加日志）。收不到则确认是原生缺口：需建 AVSession、配后台连续任务、桥内回调系统播放/暂停到 JS。
4. **中途开总开关**：先原生播一首 → 不切歌直接开音效总开关。预期：短暂 `pending=true` 缓存后 `bound=true media=true` 且有声音、音效可闻。
5. **切歌带音效**：回归确认仍正常。
6. **酷我歌词**：多切几首酷我，看是否一次出词；仍空则看诊断 detail。
7. **咪咕**：确认文本兜底是否生效；仍空需抓原始响应体前 200 字判断反爬/gzip。
8. **网易高亮位置**：视口坐标方案后是否居中；偏则排查 `[offset]` 方向、indexAt 容差。
9. **诊断日志入口（`8e73530`）**：设置 → 其他组第一行「诊断日志」，点「导出」应弹系统保存框落 txt；点「查看」应看到分段全文；「复制全文」可粘贴。
10. **酷我断续（`8e73530`）**：连切 3~5 首听是否还「放一秒停一会儿」。若仍断续，导出日志看 `[audio]` 段：出现 `stall-hold` = 断流让路生效但字节取得慢；只有大量 `waiting/stalled` 没有 `stall-hold` = 判定没触发（`_blobPending` 为空，说明没走 Blob 路径）；无 `waiting` 却停 = 解码器被回收/元素被停，需查 `pause`/`ended` 事件。
