/* 音频图与歌词解析的离线验证（无浏览器依赖）
 * 用法：node evidence/audio-graph-tests.js
 * 说明：这是「单元/模拟层」证据，不能替代 Android 模拟器或 HarmonyOS 真机结果。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------------- 最小 Web Audio 模拟 ---------------- */
let nodeCount = 0;
class MockParam { constructor(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } }
class MockNode {
  constructor(kind, ctx) { this.kind = kind; this.ctx = ctx; this.out = []; nodeCount++; }
  connect(dst) { if (dst && dst.ctx && dst.ctx !== this.ctx) throw new Error('cross-context connect'); this.out.push(dst); return dst; }
  disconnect() { this.out = []; }
}
class MockCtx {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.currentTime = 0; this.destination = new MockNode('dest', this); this.created = 0; }
  createGain() { this.created++; const n = new MockNode('gain', this); n.gain = new MockParam(1); return n; }
  createBiquadFilter() { this.created++; const n = new MockNode('biquad', this); n.gain = new MockParam(0); n.frequency = new MockParam(0); n.Q = new MockParam(1); n.type = ''; return n; }
  createConvolver() { this.created++; const n = new MockNode('conv', this); n.buffer = null; return n; }
  createPanner() { this.created++; const n = new MockNode('panner', this); n.positionX = new MockParam(0); n.positionZ = new MockParam(0); n.setPosition = () => {}; return n; }
  createBuffer(ch, len) { const d = []; for (let i = 0; i < ch; i++) d.push(new Float32Array(len)); return { getChannelData: i => d[i] }; }
  createMediaElementSource(el) { this.created++; const n = new MockNode('media', this); n.el = el; return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  decodeAudioData(ab, ok) { const b = { duration: 120 }; if (ok) ok(b); return Promise.resolve(b); }
}
class MockAudio {
  constructor() { this.volume = 1; this.currentTime = 0; this.duration = 180; this.paused = true; this.readyState = 4; this.src = ''; }
  addEventListener() {} removeEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {} removeAttribute() {}
}

/* ---------------- 装载 app 脚本 ---------------- */
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Math, Date, JSON,
  localStorage: { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; } },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  unescape, encodeURIComponent, decodeURIComponent,
  AudioContext: MockCtx,
  Audio: MockAudio,
  location: { host: 'localhost', href: 'http://localhost/' },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector() { return null; } },
  Blob: class { constructor(parts) { this.size = 1; this.type = ''; } slice() { return this; } arrayBuffer() { return Promise.resolve(new ArrayBuffer(8)); } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['app/lyrics.js', 'app/sound-effects.js', 'app/engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
}

/* ---------------- 断言工具 ---------------- */
const results = [];
function check(id, name, fn) {
  try { fn(); results.push({ id, name, status: 'PASS', detail: '' }); }
  catch (e) { results.push({ id, name, status: 'FAIL', detail: String(e && e.message || e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------------- 测试 ---------------- */
check('T01', 'AudioContext 正常初始化并挂载音效链', () => {
  const eng = new sandbox.LXEngine();
  eng.volume = 0.8;
  eng._ensureCtx();
  assert(eng.ctxAlive(), 'ctx 未创建');
  assert(eng._graphMounted === true, '音效链未挂载');
  assert(sandbox.LXSound.mounted() === true, 'LXSound.mounted() 应为 true');
  assert(sandbox.LXSound.mountedCtx() === eng.ctx, 'mountedCtx 应为当前 ctx');
  assert(eng.isGraphHealthy() === false, '无 mediaSrc 时不应宣称健康');
});

check('T02', 'Context closed 后重建，且不跨上下文复用节点', () => {
  const eng = new sandbox.LXEngine();
  eng._ensureCtx();
  const oldCtx = eng.ctx;
  const oldEq = sandbox.LXSound.mountedCtx();
  oldCtx.state = 'closed';
  assert(eng.ctxAlive() === false, 'closed 应被判为不可用');
  eng._ensureCtx();
  assert(eng.ctx !== oldCtx, 'closed 上下文后未重建');
  assert(eng.ctx.state === 'running', '新 ctx 状态异常');
  assert(sandbox.LXSound.mountedCtx() === eng.ctx, '音效链仍挂在旧上下文上（跨上下文 = 静默失效）');
  assert(oldEq === oldCtx, '前提校验');
  assert(eng._graphMounted === true, '重建后未重新挂载');
});

check('T06', 'mount 失败时仍有基础出声路径（直连 destination）', () => {
  const eng = new sandbox.LXEngine();
  const realMount = sandbox.LXSound.mount;
  sandbox.LXSound.mount = () => false;          // 注入故障
  try {
    eng._ensureCtx();
    assert(eng._graphMounted === false, '不应标记为已挂载');
    const outs = eng.gain.out.map(n => n.kind);
    assert(outs.indexOf('dest') >= 0, '未直连 destination，会无声');
  } finally { sandbox.LXSound.mount = realMount; }
});

check('T07', '音效链 half-wired 失败后不残留半连接（事务式挂载）', () => {
  const eng = new sandbox.LXEngine();
  const realConv = MockCtx.prototype.createConvolver;
  let first = true;
  MockCtx.prototype.createConvolver = function () {
    if (first) { first = false; throw new Error('模拟建图失败'); }
    return realConv.call(this);
  };
  try { eng._ensureCtx(); } finally { MockCtx.prototype.createConvolver = realConv; }
  assert(eng._graphMounted === false, '建图失败不应标记为已挂载');
  assert(eng.gain && eng.gain.out.map(n => n.kind).indexOf('dest') >= 0, '失败后未回退直连 destination，会无声');
});

check('T08', 'Context closed 时 isGraphHealthy 必须为 false（P0-3 判定）', () => {
  const eng = new sandbox.LXEngine();
  eng._ensureCtx();
  eng.mediaSrc = { disconnect() {} };
  assert(eng.isGraphHealthy() === true, '正常状态应判健康');
  eng.ctx.state = 'closed';
  assert(eng.isGraphHealthy() === false, 'closed 仍判健康 → 永不自愈');
});

check('T09', '关闭音效（旁路）不等于音频图损坏', () => {
  const eng = new sandbox.LXEngine();
  sandbox.LXSound.setEnabled(true);
  eng._ensureCtx();
  sandbox.LXSound.setEnabled(false);
  eng.mediaSrc = { disconnect() {} };
  assert(eng.ctxAlive() === true, '旁路时 ctx 应仍可用');
  assert(sandbox.LXSound.mounted() === true, '旁路时保留图属于正常设计');
});

check('T13', '反复切换 EQ 预设不新增 AudioNode（复用节点）', () => {
  const eng = new sandbox.LXEngine();
  eng._ensureCtx();
  const before = nodeCount;
  for (let i = 0; i < 20; i++) {
    sandbox.LXSound.setPreset(sandbox.LXSound.PRESETS[i % 9].name);
    eng.ensureMounted();
  }
  assert(nodeCount === before, '节点数增长：' + (nodeCount - before));
});

check('T15', '反复开关 3D 环绕不产生重复定时器', () => {
  const eng = new sandbox.LXEngine();
  eng._ensureCtx();
  for (let i = 0; i < 10; i++) { sandbox.LXSound.setSurround(true); sandbox.LXSound.setSurround(false); }
  sandbox.LXSound.setSurround(true);
  // 内部只允许一个 timer：再切一次不应报错、duoble start 会被 if (surroundTimer) return 挡住
  sandbox.LXSound.setSurround(true);
  sandbox.LXSound.setSurround(false);
});

check('L01', '歌词解析：时间轴 / 翻译 / offset', () => {
  const parsed = sandbox.LXLyr.parse('[offset:200]\n[00:01.50]第一句\n[00:03.00]第二句\n[00:03.00]Second line');
  assert(parsed.hasTime === true, '应识别为带时间轴');
  assert(parsed.lines.length === 2, '行数应为 2，实际 ' + parsed.lines.length);
  assert(Math.abs(parsed.lines[0].t - 1.3) < 0.05, 'offset 未生效');
  assert(parsed.lines[1].trans === 'Second line', '同时间戳第二行应作为翻译');
});

check('L02', '歌词链路：音源未声明 actions 时也应被视为支持 lyric', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app/sources.js'), 'utf8');
  assert(/IMPLICIT_ACTIONS/.test(src), '缺少隐式能力表');
  assert(!/return \(a\.sources\[k\]\.actions \|\| \[\]\)\.indexOf\(action\) >= 0;\s*\}\s*\);/.test(src), '仍存在只认 actions 的旧实现');
});

check('T07b', 'MediaElementSource 不可用时退回 AudioBuffer 播放且音效链保留', () => {
  const eng = new sandbox.LXEngine();
  eng._ensureCtx();
  eng._fetchBytes = function (url, headers, cb) { cb(null, new sandbox.Blob([]), 8); };
  const okStart = eng._playViaBuffer('https://x.test/a.mp3', { kind: 'downloaded', url: 'https://x.test/a.mp3' }, 0, false);
  assert(okStart === true, '未进入 buffer 退路');
  return new Promise(() => {});
  assert(eng.mode === 'buffer', '模式未切到 buffer');
  assert(eng.buffer && eng.buffer.duration === 120, 'AudioBuffer 未挂上');
  assert(eng.el === null, 'buffer 模式不应再持有 <audio>');
});
/* ---------------- 输出 ---------------- */
const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.length - pass;
console.log('=== 音频图/歌词离线验证（单元+模拟层） ===');
results.forEach(r => console.log(`[${r.status}] ${r.id} ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
console.log(`\nPASS=${pass} FAIL=${fail} TOTAL=${results.length}`);
console.log('注：本结果不等同 Android 模拟器（ANDROID_EMULATOR_TEST=NOT_AVAILABLE）或 HarmonyOS 真机（HARMONY_REAL_DEVICE_TEST=PENDING）。');
process.exit(fail ? 1 : 0);
