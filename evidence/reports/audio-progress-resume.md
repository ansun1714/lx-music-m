# 音效 / 歌词 主线进度存档（明日续点）

- 存档时间：2026-11-16 晚（用户收工）
- 仓库：`E:\AI\重构软件`，远端 `ansun1714/lx-music-m`，HEAD = `c8b3d57`（已推送，Release `hap-latest` 已出包）
- 本轮产物 HAP：`C:\temp\LXMusic-hap-new.hap`，628,244 B，未签名（对应 `c8b3d57`）

## 一、当前测试状态（严格按任务书口径）

| 项 | 状态 |
|---|---|
| 离线回归 `evidence/audio-graph-tests.js` | **PASS=11 FAIL=0 TOTAL=11** |
| `node --check`（engine/sources/lyrics/app） | PASS |
| HARMONY_REAL_DEVICE_TEST | **PENDING**（`c8b3d57` 未真机验证；hdc 本轮探测 `[Empty]`） |
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

`153229a`（Blob 失败降级 buffer）→ `227dff3`（128k 地址 + 咪咕/酷我兜底）→ `2a139bb`（逐块 Base64、兜底顺序、酷我新接口、kg 标注）→ `c8b3d57`（lite.then 的 this、attachEl、pending、咪咕文本兜底、视口坐标滚动）

体积：`153229a`=622,924 / `227dff3`=624,554 / `2a139bb`=626,353 / `c8b3d57`=628,244
