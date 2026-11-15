/* 音效系统（v3.7.0）
 * 对齐 lxserver web 播放器 public/music/js/player/sound-effects.js：
 * - 10 段均衡器：31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k，peaking，Q = 1.4，±12dB
 * - 9 个官方预设：流行 / 舞曲 / 摇滚 / 古典 / 人声 / 慢歌 / 电子乐 / 重低音 / 柔和
 * - 混响：官方用 IR 音频文件，本版改为程序生成脉冲响应（不引入外部资源）
 * - 3D 环绕：PannerNode 绕听者旋转（官方 speed 25 / distance 5）
 * 只做效果，不接管播放控制与音量。
 */
(function () {
  'use strict';

  var KEY = 'lx_sound_effects_v1';

  /* 与官方一致的频段与预设增益 */
  var FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var PRESETS = [
    { name: '流行', values: [6, 5, -3, -2, 5, 4, -4, -3, 6, 4] },
    { name: '舞曲', values: [4, 3, -4, -6, 0, 0, 3, 4, 4, 5] },
    { name: '摇滚', values: [7, 6, 2, 1, -3, -4, 2, 1, 4, 5] },
    { name: '古典', values: [6, 7, 1, 2, -1, 1, -4, -6, -7, -8] },
    { name: '人声', values: [-5, -6, -4, -3, 3, 4, 5, 4, -3, -3] },
    { name: '慢歌', values: [5, 4, 2, 0, -2, 0, 3, 6, 7, 8] },
    { name: '电子乐', values: [6, 5, 0, -5, -4, 0, 6, 8, 8, 7] },
    { name: '重低音', values: [8, 7, 5, 4, 0, 0, 0, 0, 0, 0] },
    { name: '柔和', values: [-5, -5, -4, -4, 3, 2, 4, 4, 0, 0] }
  ];
  /* 混响档位：main = 干声增益，send = 湿声增益，sec/decay 用于生成 IR */
  var REVERBS = [
    { id: 'none', name: '关闭', main: 1, send: 0, sec: 0, decay: 1 },
    { id: 'room', name: '房间', main: 0.85, send: 1.1, sec: 1.1, decay: 3.2 },
    { id: 'hall', name: '大厅', main: 0.8, send: 1.8, sec: 2.6, decay: 2.2 },
    { id: 'church', name: '教堂', main: 0.75, send: 2.4, sec: 3.4, decay: 1.8 }
  ];

  var state = {
    enabled: false,
    preset: '关闭',
    eq: FREQS.map(function () { return 0; }),
    reverb: 'none',
    surround: false
  };

  var ctx = null, inputNode = null, outNode = null;
  var eqNodes = [], dryGain = null, wetGain = null, mixGain = null;
  var convolver = null, panner = null, mounted = false;
  var surroundTimer = null, angle = 0, lastIR = '';
  var listeners = [];

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function presetOf(name) {
    return PRESETS.filter(function (p) { return p.name === name; })[0] || null;
  }
  function reverbOf(id) {
    return REVERBS.filter(function (r) { return r.id === id; })[0] || REVERBS[0];
  }
  function isFlat() {
    return state.eq.every(function (v) { return !v; }) &&
      state.reverb === 'none' && !state.surround;
  }
  function emit() {
    listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  // ---------------------------------------------------------------- 持久化
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (raw && typeof raw === 'object') {
        if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled;
        if (Array.isArray(raw.eq) && raw.eq.length === FREQS.length) {
          state.eq = raw.eq.map(function (v) { return clamp(Number(v) || 0, -12, 12); });
        }
        if (raw.preset) state.preset = String(raw.preset);
        if (raw.reverb) state.reverb = reverbOf(raw.reverb).id;
        if (typeof raw.surround === 'boolean') state.surround = raw.surround;
      }
    } catch (e) { /* 忽略损坏配置 */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ---------------------------------------------------------------- 音频图
  /* 程序生成脉冲响应：噪声 × 指数衰减。官方用的是真实 IR 文件，这里避免引入外部资源。 */
  function makeIR(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  function setIR(id) {
    var rv = reverbOf(id);
    if (!convolver) return;
    if (rv.id === 'none') {
      wetGain.gain.value = 0;
      dryGain.gain.value = 1;
      lastIR = 'none';
      return;
    }
    if (lastIR !== rv.id) {
      try {
        convolver.buffer = makeIR(rv.sec, rv.decay);
      } catch (e) { /* 生成失败就当作关闭 */ }
      lastIR = rv.id;
    }
    dryGain.gain.value = rv.main;
    wetGain.gain.value = rv.send;
  }

  function tickSurround() {
    if (!panner || !state.surround) return;
    angle += 0.05;
    try {
      if (panner.positionX) {
        panner.positionX.value = Math.sin(angle) * 1.6;
        panner.positionZ.value = Math.cos(angle) * 1.6;
      } else {
        panner.setPosition(Math.sin(angle) * 1.6, 0, Math.cos(angle) * 1.6);
      }
    } catch (e) {}
  }
  /* 启动 / 停止环绕。注意这里只控制「是否在转」，不改 state.surround ——
   * 用户关掉音效时应当保留他配的环绕开关，重新打开时恢复。 */
  function startPanner() {
    if (!panner || surroundTimer) return;
    try { panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; } catch (e) {}
    tickSurround();
    surroundTimer = setInterval(tickSurround, 100);
  }
  function stopPanner() {
    if (surroundTimer) { clearInterval(surroundTimer); surroundTimer = null; }
    if (!panner) return;
    try {
      if (panner.positionX) { panner.positionX.value = 0; panner.positionZ.value = 0; }
      else panner.setPosition(0, 0, 0);
    } catch (e) {}
  }

  /* engine 建立 AudioContext 后调用：input → EQ → 干/湿 → 环绕 → destination */
  function mount(audioCtx, input, output) {
    if (!audioCtx || !input) return false;
    if (mounted && ctx === audioCtx) return true;
    ctx = audioCtx;
    inputNode = input;
    outNode = output || audioCtx.destination;
    try {
      if (!eqNodes.length) {
        eqNodes = FREQS.map(function (f) {
          var n = ctx.createBiquadFilter();
          n.type = 'peaking';
          n.frequency.value = f;
          n.Q.value = 1.4;
          n.gain.value = 0;
          return n;
        });
      }
      if (!dryGain) {
        dryGain = ctx.createGain();
        wetGain = ctx.createGain();
        mixGain = ctx.createGain();
        convolver = ctx.createConvolver();
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.rolloffFactor = 1;
      }
      // 输入 → 10 段 EQ
      inputNode.connect(eqNodes[0]);
      for (var i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
      var last = eqNodes[eqNodes.length - 1];
      // 干声 / 湿声
      last.connect(dryGain); dryGain.connect(mixGain);
      last.connect(convolver); convolver.connect(wetGain); wetGain.connect(mixGain);
      // 干湿混合 → 环绕 → 输出
      mixGain.connect(panner);
      panner.connect(outNode);
      mounted = true;
      apply();
      return true;
    } catch (e) {
      // 图建不起来时由调用方直连，避免重复连接导致音量翻倍
      mounted = false;
      return false;
    }
  }

  function apply() {
    if (!mounted) return;
    var t = ctx.currentTime;
    for (var i = 0; i < eqNodes.length; i++) {
      var v = state.enabled ? state.eq[i] : 0;
      try { eqNodes[i].gain.setTargetAtTime(v, t, 0.03); } catch (e) { eqNodes[i].gain.value = v; }
    }
    if (!state.enabled) {
      dryGain.gain.value = 1; wetGain.gain.value = 0;
      stopPanner();
      return;
    }
    setIR(state.reverb);
    if (state.surround) startPanner(); else stopPanner();
  }

  // ---------------------------------------------------------------- 控制
  function setEnabled(on) {
    // 关掉时只旁路，保留用户已配的 EQ / 混响 / 环绕
    state.enabled = !!on;
    apply(); save(); emit();
  }
  function setPreset(name) {
    var p = presetOf(name);
    state.preset = p ? p.name : '自定义';
    if (p) {
      state.eq = p.values.slice();
      if (!state.enabled) state.enabled = true;
    }
    apply(); save(); emit();
  }
  function setBand(i, gain) {
    i = Number(i);
    if (!(i >= 0 && i < FREQS.length)) return;
    state.eq[i] = clamp(Number(gain) || 0, -12, 12);
    var match = PRESETS.filter(function (p) {
      return p.values.every(function (v, k) { return v === state.eq[k]; });
    })[0];
    state.preset = match ? match.name : '自定义';
    if (!state.enabled) state.enabled = true;
    apply(); save(); emit();
  }
  function setReverb(id) {
    state.reverb = reverbOf(id).id;
    if (state.reverb !== 'none' && !state.enabled) state.enabled = true;
    apply(); save(); emit();
  }
  function setSurroundOn(on) {
    if (on && !state.enabled) state.enabled = true;
    state.surround = !!on;
    apply(); save(); emit();
  }
  function reset() {
    state.eq = FREQS.map(function () { return 0; });
    state.preset = '关闭';
    state.reverb = 'none';
    state.surround = false;
    apply(); save(); emit();
  }
  function describe() {
    if (!state.enabled) return '音效已关闭';
    if (isFlat()) return '已开启（未调整）';
    var bits = [];
    if (state.preset && state.preset !== '关闭') bits.push(state.preset);
    if (state.reverb !== 'none') bits.push(reverbOf(state.reverb).name);
    if (state.surround) bits.push('环绕');
    return bits.length ? bits.join(' · ') : '已调整';
  }

  load();

  window.LXSound = {
    FREQS: FREQS,
    PRESETS: PRESETS,
    REVERBS: REVERBS,
    state: function () { return state; },
    describe: describe,
    mount: mount,
    mounted: function () { return mounted; },
    setEnabled: setEnabled,
    setPreset: setPreset,
    setBand: setBand,
    setReverb: setReverb,
    setSurround: setSurroundOn,
    reset: reset,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();
