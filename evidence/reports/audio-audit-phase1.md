# 音效系统审计（阶段一）· LX Music M

- 审计时间：2026-11-16
- 仓库：`E:\AI\重构软件`（main，HEAD 与 origin/main 一致，工作区无未提交改动）
- 审计范围：`app/engine.js`、`app/sound-effects.js`、`app/app.js`（音频图同步与降级回调）、`harmony/` 桥接相关、`evidence/` 既有测试
- 本阶段只读，未修改任何代码、未提交、未推送

## 一、现有架构（事实描述）

播放分三种模式：

| 模式 | 触发 | 音频路径 |
|---|---|---|
| `synth` | 不是自定义音源曲目 | `AudioBufferSourceNode → gain →(音效链)→ destination` |
| `stream` | 音源给出在线 URL | `<audio>`；开音效时先把字节经原生桥取回成本源 Blob，再 `createMediaElementSource → gain →(音效链)→ destination` |
| `local` | 已下载曲目（`file://` / Blob） | 同上，直接接图 |

音效链（`sound-effects.js: mount()`）：`input(gain) → 10×BiquadFilter(peaking) → dryGain→mixGain`，旁支 `→ convolver → wetGain → mixGain`，`mixGain → panner(HRTF) → destination`。

音效开关语义（`engine.wantGraph`）：`LXSound.state().enabled` 为真即接管；在线曲目还要求「参数真的非平」（`graphMatters()`），否则保持原生播放，避免一开开关就把正在播放的网络流换成代理地址。

## 二、问题清单（按严重度）

### P0-1 `_ensureCtx()` 复用已 closed 的 AudioContext
`app/engine.js:65-81`

```js
AudioEngine.prototype._ensureCtx = function () {
  if (this.ctx) return;            // ← 只看引用，不看 state
```

- `ctx.state === 'closed'` 时仍直接返回，后续 `createMediaElementSource` / `connect` 对已关闭上下文无效或抛错，表现为「音效全开、实际没有处理，甚至没声音」。
- 也没有 `onstatechange`、没有重建 Context 的路径。
- 影响：锁屏/后台被系统回收、WebView 切后台后返回、长时间运行。
- 建议：状态机判断 `state !== 'closed'`；closed 时销毁旧节点引用、重建 Context，并把 generation+1。

### P0-2 重建 Context 后仍复用旧 Context 的节点（跨上下文连接）
`app/sound-effects.js:148-194`

```js
if (!eqNodes.length) { eqNodes = FREQS.map(...用 ctx 创建...); }   // ← 只判空，不判 ctx 是否换了
if (!dryGain) { dryGain = ctx.createGain(); ... }
```
`mount()` 只在 `mounted && ctx === audioCtx` 时早退；一旦 engine 换了新的 AudioContext，`eqNodes / dryGain / convolver / panner` 全部是**旧上下文**的节点，把它们连到新 `ctx.destination` 属于非法跨上下文连接 → 图静默失效（不报错、只是没有效果）。
- 影响：任何一次 Context 重建后音效永久失效，直到 App 重启。
- 建议：`mount()` 记录 `mountedCtx`，ctx 变化时 `teardown()`（disconnect 所有节点、清空引用、停 timer）再重建；`teardown` 必须幂等。

### P0-3 图健康判断只看对象引用
`app/app.js:1413-1424`

```js
var has = !!(engine.el && engine.mediaSrc);
if (want === has) return;
```
- `ctx` closed、`mediaSrc` 已断开、`gain` 未连到 destination、EQ/混响/环绕节点断链，`has` 仍为 `true`，`syncAudioGraph()` 直接 return，**永远不会自愈**。
- UI 的「音效已开启」与实际音频链脱钩，正是任务书 2.3 说的假状态。
- 建议：`engine.getAudioStatus()` 返回真实链路状态（见第三部分），`syncAudioGraph` 以它为准。

### P0-4 `mount()` 失败后没有重试路径，且失败后图处于「半连接」
`app/engine.js:75-80` + `app/sound-effects.js:154-193`

- `mount()` 内部 `try{...}catch{ mounted=false; return false }`，此时可能**已经**执行了 `input.connect(eqNodes[0])` 等部分连接；engine 随后 `gain.connect(destination)` 又直连一次 → 同一声源两条出口，音量翻倍/失真，或者半截图把声音吃掉。
- `mounted=false` 后没有任何地方再尝试 `mount()`（`_ensureCtx` 只有 `if (this.ctx) return`），音效永久不可用。
- 建议：`mount()` 先在**局部变量**建好整图，全部成功才一次性接线（事务式）；失败时 `teardown()` 清理已建节点；`engine` 提供 `ensureMounted()`，在每次接图前调用。

### P0-5 `<audio>` 的 MediaElementSource 生命周期与「关音效不换元素」策略冲突
`app/engine.js:440-471`

```js
if (!want) {
  if (this.mediaSrc) return true;   // 关音效时保留图，靠 gain=0 旁路
}
```
- 这条本身是合理的（避免换元素卡顿），但缺一条约束：一旦 `mediaSrc` 所在 Context 失效，这条「旁路」也会静音；且此后 `want=false` 永远走进 `return true`，不重建、不修复。
- 建议：`if (!want && this.mediaSrc && this.ctxHealthy()) return true;` 否则降级重建。

### P1-1 `play()` 只处理 suspended，不处理 closed / resume 拒绝 / 并发
`app/engine.js:486-535`

```js
if (this.mediaSrc && this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
```
- 返回的 Promise 没有 `.catch`；`resume()` 被拒绝时静默无声，用户只看到「播放键是播放态、没声音」。
- 多次 `play()` 可并发调用 `resume()`，没有 `_resuming` 去重。
- 建议：统一 `ensureRunning()`：最多一次并发；失败计数、指数退避（≤2 次）后进入 fallback；每次结果写日志。

### P1-2 没有 `statechange` / `visibilitychange` 监听
- 后台回前台、锁屏解锁后，`ctx` 常处于 `suspended`/`interrupted`，只有用户点播放才会 resume。
- 建议注册 `ctx.onstatechange` 与 `document.visibilitychange`（`hidden=false` 时 `ensureRunning()`），并在 `stop()`/页面卸载时清理；注意 Harmony ArkWeb 与 Android WebView 的差异，用同一套幂等注册。

### P1-3 没有媒体元素 generation token，旧异步任务可能污染新曲目
`app/engine.js:291-326`（`_swapViaBlob` / `_swapToGraphable`）
- 现在只靠 `_blobPending` 字符串与 `track.id` 比较，同一首歌重复播放时会命中同一 key，存在误切风险；`_fetchBytes` 回调里 `self.track.id !== tid` 判断后**没有释放已创建的 Blob URL**。
- 建议：`this._gen++`，所有异步回调先比 `gen`；丢弃时 `URL.revokeObjectURL`。

### P1-4 混响 IR 每次随机生成、无缓存、关闭不释放
`app/sound-effects.js:84-116`
- `Math.random()` 生成的 IR 每次切换档位都重新算（1.1~3.4 秒 × 双声道 × 48kHz，主线程阻塞几十到上百 ms），真机上表现为「切混响卡一下」。
- `lastIR` 只挡同档重复；换回同一档会重新生成。
- `convolver` 在 `reverb='none'` 时仍挂在图里（`wetGain=0`），不释放 buffer。
- 建议：IR 缓存（按 `id` 缓存 AudioBuffer）、固定种子的伪随机（保证每次听感一致）、关闭时 `convolver.buffer=null`。

### P2-1 3D 环绕 `setInterval(100ms)` 在后台持续运行
`app/sound-effects.js:132-145`
- 已有 `if (surroundTimer) return` 防重复，但没有 visibility 暂停；后台持续 10Hz 改 AudioParam。
- 建议：后台 `stopPanner()`、前台恢复；或改用 `positionX.setTargetAtTime` 的一次性自动化（每 100ms 仍是离散，优先评估 `AudioParam` 线性自动化）。

### P2-2 测试证据与真实能力脱节
- `evidence/device-effects-check.js` 头部仍是 v3.9.0、依赖已废弃的 `/__media` 代理描述；`evidence/device-player-check.json` 的 41 项 PASS 是 2026-11-15 的旧结果，**不能作为本次修复后的证据**。
- 现状没有「Context closed / resume reject / MediaElementSource 失败 / 图断链」的故障注入用例。

### P3-1 异常被吞
- `catch (e) { this.mediaSrc = null; nx.volume = this.volume; }`（`engine.js:277`）、`catch (e) {}` 多处，既不打日志也不上报状态，用户与开发者都无法判断是「跨域降级」还是「节点创建失败」。

### P3-2 `isFlat()` 与 `graphMatters()` 口径重复
- 两处各维护一份「EQ 全 0 且混响 none 且无环绕」的判断，容易漂移；建议由 `LXSound.isFlat()` 单一来源导出。

## 三、统一音频状态设计（建议，待确认后实施）

```
native     未接图，原生 <audio>/buffer 播放
active     图健康，音效真实参与
bypass     图存在但被主动旁路（用户关音效，保留图避免卡顿）
recovering 正在 resume / 重建 Context / 重挂图
fallback   图不可用，已降级原生，且不再自动重试（直到用户操作或曲目变化）
error      不可恢复（如 Web Audio 不可用），仅原生
```

`engine.getAudioStatus()` 至少返回：`mode`、`ctxState`、`ctxAlive`、`mediaBound`、`mounted`、`mountedCtxAlive`、`graphHealthy`、`eqOn/reverbOn/surroundOn`、`recovering`、`degraded`、`lastError`、`lastRecoverResult`。

`isGraphHealthy()` 实现约束：Web Audio 没有「查询连接图」的 API，因此必须由**内部连接记录**（`wired` 标志 + `wiredCtx` 引用 + `input/output` 节点是否仍属于当前 ctx）推导，禁止臆造 API。

## 四、修复计划（分阶段，需你确认后执行）

### 阶段 2A（P0，先修「音效假开启/没效果」）
1. `engine._ensureCtx()`：`ctx` 存在但 `state==='closed'` → `teardownAll()` 后重建；新增 `_ctxGen`。
2. `sound-effects.mount()`：改成事务式（局部建图→全成功才接线）；记录 `mountedCtx`；ctx 变化先 `teardown()`（disconnect 全部 + 清引用 + 停 timer + 清 IR 缓存）。
3. `engine.getAudioStatus()` + `isGraphHealthy()`；`syncAudioGraph()` 改用它，并区分 `bypass` 与「图坏了」。
4. 每次 `_createEl/_cloneFrom` 接图前调用 `ensureMounted()`；失败 → `fallback` 并 toast 一次。
5. 对应测试：T01/T06/T07/T08/T09/T10。

### 阶段 2B（P1，生命周期与恢复）
1. `ensureRunning()`：单飞 + `resume` 结果校验（`state==='running'` 才算成功）+ 有限重试 + 失败降级。
2. `ctx.onstatechange`、`visibilitychange` 监听（幂等注册/清理）。
3. generation token：`load()` 递增；所有异步回调校验；丢弃时 revoke Blob URL。
4. IR 缓存 + 固定种子 + 关闭释放。
5. 测试：T02/T03/T04/T05/T11/T12/T17/T20。

### 阶段 2C（P2/P3，性能与证据）
1. 环绕后台暂停；评估 `AudioParam` 自动化替代定时器。
2. 重写 `evidence/device-effects-check.js`（去 v3.9.0/`__media` 旧描述），新增 `evidence/run-all-tests.js` 与故障注入用例（T13-T16、T18、T19）。
3. 统一 `isFlat()` 来源；所有 `catch` 补 `lastError` 与 hilog/console 记录。

## 五、测试与环境现状（阶段一实查）

- 电脑端：Node.js 可用（`node --check` 通过 app 各 js）；无 npm 测试框架绑定到音频模块；`evidence/` 为自研脚本。
- Android：本机未确认 SDK/AVD/ADB 环境（阶段二开始前先探测，缺则记 `NOT_AVAILABLE`）。
- HarmonyOS：真机曾连上（`33Z0224703029804`），但当前 `hdc list targets` 为 `[Empty]`；本阶段不产生任何真机结论，`HARMONY_REAL_DEVICE_TEST=PENDING`。

## 六、兼容性风险

1. 重建 Context 会短暂断音（切换瞬间），需用「旧元素继续出声 → 新图就绪再切」的方式，与现有 `_swapToGraphable` 思路一致。
2. Harmony `ArkWeb` 对 `createMediaElementSource` 与 Blob 的支持行为需真机验证，不能据桌面浏览器推断。
3. 关闭音效时保留图（bypass）依赖 `wetGain=0 / EQ=0`，若图本身失效必须降级重建，否则「关音效也没声」。

## 七、本阶段结论

- 用户可感知的「音效开了没效果 / 有时彻底没声」，最可能的三个根因按概率排序：
  1. **P0-2 跨上下文复用节点**（一旦 Context 被系统回收，音效永久失效）；
  2. **P0-3 健康判断只看引用**（失效后永不自愈）；
  3. **P0-4 mount 半连接 + 无重试**（失败一次即长期失效，且可能音量翻倍/无声）。
- 本报告只做审计，未改任何文件。等你确认后按 2A → 2B → 2C 顺序实施，每步跑对应测试并回传 diff 与结果。
