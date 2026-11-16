# 音效系统 2A 修复记录（P0 × 4 + 歌词链路）

- 执行时间：2026-11-16
- 源码提交：`e809f33`（分支 main）
- 构建产物：`hap-latest` / `entry-default-unsigned.hap`，609,676 B
- 测试层级说明：本节结论来自**单元/模拟层**（`evidence/audio-graph-tests.js`，mock Web Audio），
  不是浏览器真机结果。Android 模拟器 `NOT_AVAILABLE`；HarmonyOS 真机 `PENDING`（设备未连接，`hdc list targets=[Empty]`）。

## 一、逐项修复

### P0-1 / P0-2：closed 上下文与跨上下文复用节点

- 文件：`app/engine.js`、`app/sound-effects.js`
- 改了什么：新增 `_dropCtx()`（调 `LXSound.teardown()`、断开 gain/mediaSrc、`_ctxGen++`）；`_ensureCtx()` 发现 `ctx.state==='closed'` 先丢弃再重建；`LXSound.mount()` 改为事务式——所有节点先在局部变量建好、全部连接成功后才赋值给全局，失败逐个断开并置 `mountedCtx=null`；新增幂等 `teardown()` 与 `mountedCtx()` 导出。
- 为什么：旧代码 `if (!eqNodes.length)` 复用了旧上下文的 EQ/混响/环绕节点，把这些节点接到新 `destination` 属非法跨上下文连接，浏览器**不抛错、只是永久没效果**——这是「界面开着音效但完全没效果」的首要嫌疑。
- 对应测试：T02（关掉旧 ctx 后重建，断言 `LXSound.mountedCtx()===新 ctx`）、T07（建图注入异常，断言不残留半连接）。

### P0-3：音频图健康判断只看对象引用

- 文件：`app/engine.js`、`app/app.js`
- 改了什么：新增 `isGraphBound()` / `isGraphHealthy()` / `getAudioStatus()`；`syncAudioGraph()` 改为：`bound && !healthy` 时先 `ensureMounted()` 原地重挂，修不好再 `rebuild()`；不再用 `!!(engine.el && engine.mediaSrc)` 作为「已接图」的证据。
- 为什么：ctx 已 closed、节点断链时旧判定仍返回「已接图」，`syncAudioGraph()` 直接 return，**永远不会自愈**；UI 开关与真实链路脱钩。
- 对应测试：T08（`ctx.state='closed'` 后 `isGraphHealthy()` 必须为 false）。

### P0-4：mount 半连接、失败后无重试

- 文件：`app/engine.js`、`app/sound-effects.js`
- 改了什么：音效链挂载统一走 `ensureMounted()`（事务式 + 每次接图前校验 `mountedCtx`），失败时 `gain.connect(destination)` 直连兜底；`_cloneFrom` / `_createEl` 改为「先 `ensureMounted()` 再 `createMediaElementSource()`」，异常写入 `_lastError`，不再静默吞掉。
- 为什么：半连接会导致音量翻倍或半截图吃音；`mounted=false` 之后没有任何重挂路径，一切切歌都停在「没音效」状态。
- 对应测试：T06（mount 返回 false 时断言直连存在）、T07。

### P0-5：rebuild 的 bypass 早退

- 文件：`app/engine.js`
- 改了什么：`if (this.mediaSrc && this.isGraphHealthy()) return true;`
- 为什么：旧代码只要 `mediaSrc` 存在就认为「旁路可接受」，同样把断链当成正常。

### 顺带：歌词不显示

- 文件：`app/sources.js`（此前已改，本次补验证）
- 改了什么：`IMPLICIT_ACTIONS = ['musicUrl','lyric','pic']` + `sourceHas()`，音源脚本未声明 `actions` 时视为支持这三项。
- 为什么：星海等音源不写 `actions`，旧实现把整条歌词链路过滤掉，`LXLyr.load()` 恒返回 null。
- 对应测试：L01（解析 offset/翻译）、L02（静态断言隐式能力存在、旧实现已消失）。**真机歌词仍待验证。**

## 二、测试结果（离线，非真机）

| 编号 | 用例 | 状态 |
|---|---|---|
| T01 | Context 正常初始化并挂载 | PASS |
| T02 | closed 后重建、不跨上下文复用 | PASS |
| T06 | mount 失败仍能出声 | PASS |
| T07 | 建图失败不残留半连接 | PASS |
| T08 | closed 必须判不健康 | PASS |
| T09 | 旁路不误判为损坏 | PASS |
| T13 | 反复切换 EQ 不新增节点 | PASS |
| T15 | 反复开关环绕不叠加定时器 | PASS |
| L01 | 歌词解析（offset/翻译） | PASS |
| L02 | 未声明 actions 的音源仍支持 lyric | PASS |

`PASS=10 FAIL=0`（`node evidence/audio-graph-tests.js`）

## 三、状态汇总（严格区分）

- `DESKTOP_UNIT_TEST=PASS`
- `ANDROID_EMULATOR_TEST=NOT_AVAILABLE`（本机未探测到 AVD/ADB，未伪造结果）
- `ANDROID_REAL_DEVICE_TEST=PENDING`
- `HARMONY_REAL_DEVICE_TEST=PENDING`（`hdc list targets` 返回 `[Empty]`，设备未连接）

## 四、尚未覆盖（2B/2C）

`resume()` 无 catch / 无单飞、无 `statechange`/`visibilitychange`、无 generation token、环绕 100ms 定时器后台常驻、`evidence/device-effects-check.js` 仍是旧版证据、`run-all-tests.js` 未建。
