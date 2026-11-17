# 音效 / 歌词 主线进度存档（明日续点）

- 存档时间：2026-11-17 凌晨（用户收工前更新）
- 仓库：`E:\AI\重构软件`，远端 `ansun1714/lx-music-m`，HEAD = `0d0b2ea`（已推送，Release `hap-latest` 已出包）
- 本轮产物 HAP：`C:\temp\LXMusic-hap-new.hap`，629,468 B，未签名（对应 `0d0b2ea`）

## 0. 2026-11-17 凌晨真机复测结论（装的是 `c8b3d57`，02:38 / 02:44 两张自检）

自检已接上图：`ctx=running ac=true snd=true bound=true healthy=true media=true mounted=true el=true playing=true`，`graphHost=f_sandroid.tx.kugou.com / m801.music.126.net`，`lite=true pending=false lastError=(无)`。**接图链路本身通了。**

用户反馈的两个真实残留：
1. **播放中途打开音效总开关 → 没声音**；带着音效切歌 → 音效正常有效。
   - 根因判断：`c8b3d57` 新增的 `attachEl()` 把「已在原生出声的活动解码器」直接补挂 `createMediaElementSource`。ArkWeb 不会把当前解码帧喂给该源节点，自检显示 `bound=true` 但全程静音；而切歌走的是 Blob 换新元素路径（`_swapViaBlob`→`_cloneFrom`），那条路径正常。
   - `0d0b2ea` 修复：`attachEl()` 对 `!el.paused && readyState>=2` 的活动元素直接拒绝补挂（返回 false），`syncAudioGraph` 随后落到 `rebuild()` 走已验证的 Blob 重建。
2. **歌词**：网易基本正常（切歌即出词）；酷我有时出词、有时空，重复开关歌词几次才刷出；咪咕/酷狗仍取不到。
   - `0d0b2ea`：酷我空结果/非 JSON 延迟 700ms 重试一次；歌词请求加 `lyricPending` 进行中缓存，消除并发重复打链与竞态覆盖；`clearLyric` 同步清 pending。

## 一、当前测试状态（严格按任务书口径）

| 项 | 状态 |
|---|---|
| 离线回归 `evidence/audio-graph-tests.js` | **PASS=11 FAIL=0 TOTAL=11** |
| `node --check`（engine/sources/lyrics/app） | PASS |
| HARMONY_REAL_DEVICE_TEST | **PENDING**（`0d0b2ea` 未真机验证；hdc 本轮探测 `[Empty]`） |
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

# 出包等待：轮询 releases/tags/hap-latest，按 body 里「源码提交」匹配 commit，
# 取 assets[0].url（Accept: application/octet-stream）下载到 C:\temp\LXMusic-hap-new.hap（覆盖，不留历史版本）
```

## 七、提交链

`153229a`（Blob 失败降级 buffer）→ `227dff3`（128k 地址 + 咪咕/酷我兜底）→ `2a139bb`（逐块 Base64、兜底顺序、酷我新接口、kg 标注）→ `c8b3d57`（lite.then 的 this、attachEl、pending、咪咕文本兜底、视口坐标滚动）→ `0d0b2ea`（活动元素拒绝补挂改走 Blob 重建；酷我重试一次；歌词进行中缓存）

体积：`153229a`=622,924 / `227dff3`=624,554 / `2a139bb`=626,353 / `c8b3d57`=628,244 / `0d0b2ea`=629,468

## 八、下一轮真机待验证清单

1. **中途开总开关**：先原生播一首 → 不切歌直接开音效总开关。预期：短暂走 Blob 缓存（自检 `pending=true` 片刻）后 `bound=true media=true` 且**有声音、音效可闻**。若仍静音，抓 hilog `[audio]` 看是否进了 `_swapViaBlob`、`graph fetch` host、`Blob 接管失败` 或 buffer 退路。
2. **切歌带音效**：回归确认仍正常（不能改坏这条已通路径）。
3. **酷我歌词**：多切几首酷我，看是否一次出词；仍空则看自检/诊断里 `平台内置/kw` 的 detail（返回空 / HTTP 状态 / 非 JSON）。
4. **咪咕**：确认文本兜底是否生效；若仍「不是 JSON/返回空」，需在真机抓原始响应体前 200 字判断是反爬页还是 gzip。
5. **网易高亮位置**：视口坐标方案后是否居中；若仍整体偏，转时间基准排查（`[offset]` 方向、indexAt 容差）。
