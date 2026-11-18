/* 播放引擎
 * - 自定义音源曲目：用 <audio> 播放在线 URL / data: 音频（mode='stream'）
 * - 已下载曲目：用 <audio> 播放本地 Blob（mode='local'）
 * - 其余曲目：Web Audio 实时合成柔和演示音轨（mode='synth'，无网络请求）
 * - 支持播放速率、音量、进度、播放结束回调
 * - 音效开启时才把 <audio> 接进 Web Audio；关闭时走原生播放（避免 CORS 静音与节点累积）
 */
(function () {
  'use strict';

  function dlog(tag, msg) {
    try { if (window.LXdlog) window.LXdlog(tag, msg); } catch (e) {}
  }

  /* 原生媒体代理（v3.9.0）
   * 音源返回的音频大多没有任何 CORS 响应头：<audio> 一旦设置 crossOrigin 再接进 Web Audio，
   * 浏览器会判定为「跨域污染」直接静音，真机上的表现就是「两个平台有音效、另外的平台提示
   * 音源不允许跨域」。这里把远端地址交给原生壳，由它在本源（app.echo.local）下转发字节流
   * 并透传 Range，于是 <audio> 与页面同源 —— 音效全平台可用，进度条也能拖动。 */
  function b64(s) {
    try { return btoa(unescape(encodeURIComponent(String(s)))); }
    catch (e) { return ''; }
  }

  var MediaProxy = {
    available: function () {
      var B = window.EchoBridge;
      return !!(B && typeof B.mediaProxyBase === 'function');
    },
    wrap: function (url, headers) {
      if (!MediaProxy.available() || !/^https?:/i.test(String(url || ''))) return '';
      // 已经在本应用源下的地址（例如 /__local 的本地文件）本身同源，再套一层代理只会自己绕自己
      try { if (new URL(url).host === location.host) return ''; } catch (e) {}
      var base;
      try { base = window.EchoBridge.mediaProxyBase(); } catch (e) { return ''; }
      if (!base) return '';
      var enc = b64(url);
      if (!enc) return '';
      var out = base + '?u=' + encodeURIComponent(enc);
      var hs = '';
      try {
        if (headers && Object.keys(headers).length) hs = b64(JSON.stringify(headers));
      } catch (e) { hs = ''; }
      if (hs) out += '&h=' + encodeURIComponent(hs);
      return out;
    }
  };
  window.LXMediaProxy = MediaProxy;

  function AudioEngine() {
    this.ctx = null;
    this.gain = null;
    this.src = null;
    this.buffer = null;
    this.el = null;               // 本地文件模式
    this.mode = 'synth';
    this.playing = false;
    this.offset = 0;
    this.startCtxTime = 0;
    this.duration = 0;
    this.playbackRate = 1;
    this.volume = 0.8;
    this.track = null;
    this.onTick = null;
    this.onEnded = null;
    this.onStateChange = null;
    this._pauseMiss = 0;
    this._loadGen = 0;
    this._timer = null;
  }

  /* 释放当前 AudioContext 上的所有节点引用。
   * MediaElementSource 无法撤销，只能随 <audio> 元素一起丢弃；这里只断开引用，
   * 真正的元素替换发生在 _createEl / rebuild。 */
  AudioEngine.prototype._dropCtx = function () {
    if (window.LXSound && typeof window.LXSound.teardown === 'function') {
      try { window.LXSound.teardown(); } catch (e) { this._lastError = 'sound teardown: ' + e; }
    }
    if (this.mediaSrc) { try { this.mediaSrc.disconnect(); } catch (e) {} this.mediaSrc = null; }
    if (this.gain) { try { this.gain.disconnect(); } catch (e) {} this.gain = null; }
    this.input = null;
    this.ctx = null;
    this._graphMounted = false;
    this._ctxGen = (this._ctxGen || 0) + 1;
  };

  AudioEngine.prototype.ctxAlive = function () {
    return !!(this.ctx && this.ctx.state !== 'closed');
  };

  /* 把 <audio> 的关键事件写进诊断缓冲：真机排查「放一秒停一会儿」时，
     区分是网络缓冲不足（waiting/stalled 反复）还是 pause/play 事件在来回抢状态。 */
  AudioEngine.prototype._attachDiag = function (el, tag) {
    if (!el) return;
    ['waiting', 'stalled', 'playing', 'pause', 'play', 'canplay', 'ended', 'error', 'loadedmetadata']
      .forEach(function (ev) {
        el.addEventListener(ev, function () {
          var buf = '-';
          try {
            if (el.buffered && el.buffered.length) {
              buf = Math.round(el.buffered.end(el.buffered.length - 1)) + 's';
            }
          } catch (e) {}
          dlog('audio', tag + ' ' + ev + ' t=' + (el.currentTime || 0).toFixed(1) +
            ' rs=' + el.readyState + ' paused=' + el.paused + ' buf=' + buf);
        });
      });
  };

  /* 有些音源（酷我这类 CDN）会按连接限速。此时「原生在线播放」和「桥取字节」两条流
   * 同时在抢同一条带宽，元素就会反复 waiting/stalled —— 听感正是「放一秒停一会儿」。
   * 连续两次卡顿就主动暂停原生播放，把带宽全让给取字节；字节回来后由 Blob 无缝接管，
   * 音效也才真正接得上。其它平台（QQ 等）不触发，行为不变。 */
  AudioEngine.prototype._onStall = function (el) {
    if (this.el !== el) return;
    var now = Date.now();
    if (!this._stallWin || now - this._stallWin.t0 > 15000) this._stallWin = { n: 0, t0: now };
    this._stallWin.n++;
    /* 15 秒内卡 3 次以上 = 上游吞吐连实时都跟不上（真机日志里酷我代理约 0.2~0.3 倍速）。
     * 这种源上再并发取整段字节只会让两条流互相饿死：标记慢流、放弃这次取字节，
     * 并立刻恢复原生播放 —— 否则用户看到的就是「一开音效就彻底没声」（556798d 真机实测）。 */
    if (this._stallWin.n >= 3) {
      if (!this._slowStream) dlog('audio', 'slow-stream：上游吞吐不足实时（15s 内 ' +
        this._stallWin.n + ' 次卡顿），放弃并发取整段');
      this._slowStream = true;
      this._wantBlob = null;
      this._blobPending = null;
      this._releaseStallHold(true);
      return;
    }
    if (!this._blobPending || this._stallHold) return;
    if (this._stallWin.n < 2) return;
    this._stallHold = true;
    dlog('audio', 'stall-hold：原生在线播放连续卡顿，暂停让路给取字节 pending=' +
      String(this._blobPending).slice(0, 70));
    try { el.pause(); } catch (e) {}
    /* 兜底：3 秒内字节没到就恢复出声。慢源上整段取字节可能要几分钟，
     * 无限期压着只会让人以为播放器死了。 */
    var self = this;
    if (this._holdTimer) clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(function () {
      self._holdTimer = null;
      if (self._stallHold) {
        dlog('audio', 'stall-hold 超时 3s 未取到字节，恢复原生播放');
        self._releaseStallHold(true);
      }
    }, 3000);
  };

  /* 解除「让路」状态：取字节失败或需要退回原生时，必须把元素重新放起来，
   * 否则用户看到的是「点了歌一首都没声」（元素被我们自己 paused 了）。 */
  AudioEngine.prototype._releaseStallHold = function (resume) {
    var held = this._stallHold;
    this._stallHold = false;
    this._stallWin = null;
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    if (!held || !resume) return;
    if (this.playing && this.el && this.el.paused) {
      var q = this.el.play();
      if (q && q.catch) q.catch(function () {});
    }
  };

  AudioEngine.prototype._ensureCtx = function () {
    /* P0-1：不能只看「ctx 是否存在」。closed 的上下文再 createMediaElementSource/connect
     * 都是无效操作（不报错、只是没声音/没效果），必须先丢弃再重建。 */
    /* P0-4：图挂载改成可重试 —— 每次接图前都走 ensureMounted()，不再一次性决定。 */
    if (this.ctx && this.ctx.state === 'closed') this._dropCtx();
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this._lastError = 'Web Audio 不可用'; return; }
    try { this.ctx = new AC(); } catch (e) {
      this.ctx = null;
      this._lastError = 'AudioContext 创建失败: ' + (e && e.message || e);
      return;
    }
    this._ctxGen = (this._ctxGen || 0) + 1;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.input = this.gain;
    this.ensureMounted();
  };

  /* 建立/修复 音效链：gain → EQ → 干湿 → 环绕 → destination。
   * 事务式：LXSound.mount() 内部整体建好才接线，失败时由这里直连 destination 兜底。 */
  /* 在用户手势的同步栈里预先建好 AudioContext 并接图。
   * ArkWeb/WebView 对「必须在手势内创建/恢复 AudioContext」很敏感；等异步取完播放地址再建，
   * 往往已经脱离手势上下文，表现就是 ctx 一直是 none、音效永不生效。 */
  AudioEngine.prototype.prepareGraph = function () {
    var why = '';
    try {
      if (!this.graphEnabled()) why = '音效未开启';
      else {
        this._ensureCtx();
        if (!this.ctx) why = 'AudioContext 创建失败';
        else if (this.ctx.state === 'suspended' && this.ctx.resume) {
          var p = this.ctx.resume();
          if (p && p.catch) p.catch(function (e) { dlog('audio', 'resume reject: ' + (e && e.message || e)); });
        }
        if (this.ctx) this.ensureMounted();
      }
    } catch (e) { why = String(e && e.message || e); }
    dlog('audio', 'prepareGraph ' + (why ? 'fail(' + why + ')' : 'ok ctx=' + (this.ctx && this.ctx.state) + ' mounted=' + this._graphMounted));
    return this.ctxAlive();
  };

  AudioEngine.prototype.ensureMounted = function () {
    if (!this.ctx || this.ctx.state === 'closed' || !this.gain) return false;
    var S = window.LXSound;
    var mountedCtx = (S && typeof S.mountedCtx === 'function') ? S.mountedCtx() : null;
    /* 图属于旧上下文 / 已被销毁：先清干净，避免跨上下文连节点（P0-2） */
    if (this._graphMounted && mountedCtx !== this.ctx) {
      try { if (S && S.teardown) S.teardown(); } catch (e) {}
      try { this.gain.disconnect(); } catch (e) {}
      this._graphMounted = false;
    }
    if (this._graphMounted && mountedCtx === this.ctx) return true;
    var mounted = false;
    if (S && typeof S.mount === 'function') {
      try { mounted = S.mount(this.ctx, this.gain, this.ctx.destination); }
      catch (e) { mounted = false; this._lastError = 'sound mount: ' + (e && e.message || e); }
    }
    this._graphMounted = !!mounted;
    if (!mounted) {
      /* 音效链不可用时保证基础出声（旁路，不是 error） */
      try { this.gain.connect(this.ctx.destination); } catch (e) {}
    }
    dlog('audio', 'ensureMounted=' + mounted + ' ctx=' + this.ctx.state + ' err=' + (this._lastError || '-'));
    return this._graphMounted;
  };

  /* 直接把当前正在播放的 <audio> 接入音频图（不换 Blob）。
   * 冷启动时 ctx/音效链还没就绪，_createEl 阶段挂不上；手势后 ensureMounted 成功，
   * 这里补挂一次，避免一直停在原生旁路。跨域被污染导致静音时由 error/回退路径兜底。 */
  AudioEngine.prototype.attachEl = function () {
    if (this.mediaSrc || !this.el || !this.ctx) return false;
    if (!this.wantGraph(this._lastRef)) return false;
    /* 已在原生出声的活动解码器补挂进 MediaElementSource，ArkWeb 不会把当前解码帧
     * 喂给图节点（表现为自检 bound=true 但全程静音）。这类情况交给 rebuild 换新元素，
     * 只对「还没起播 / 已暂停」的元素直接补挂。 */
    if (!this.el.paused && this.el.readyState >= 2) return false;
    if (!this.ensureMounted()) return false;
    try {
      this.mediaSrc = this.ctx.createMediaElementSource(this.el);
      this.mediaSrc.connect(this.gain);
      this.el.volume = 1;
      dlog('audio', 'attachEl ok');
      return true;
    } catch (e) {
      this.mediaSrc = null;
      this._lastError = 'MediaElementSource 创建失败: ' + (e && e.message || e);
      dlog('audio', this._lastError);
      return false;
    }
  };

  /* 统一状态查询（P0-3 的判定依据）：不看「对象是否存在」，看上下文与挂载是否真的可用 */
  AudioEngine.prototype.isGraphBound = function () {
    return !!(this.mediaSrc && this.ctx && this.ctx.state !== 'closed' && this._graphMounted);
  };

  /* 开音效时把「已经在放、但没挂进音频图」的元素换成挂进图的新元素。
   * 与 rebuild() 的差别：不做 want/bound 判断、不去重新取字节，直接用元素现有 currentSrc
   * （blob: 同源，秒切，不会卡）。专治「关掉音效（已回原生元素）再打开，音效失效」。 */
  AudioEngine.prototype.forceGraphSwap = function () {
    if (!this.el) return false;
    var url = this.el.currentSrc || this.el.src;
    if (!url) return false;
    var last = this._lastRef || {};
    var ref = {
      kind: last.kind || this.mode || 'stream',
      url: last.origin || url,
      localUrl: url,
      origin: last.origin || '',
      mime: last.mime || this.mediaMime,
      headers: last.headers
    };
    var pos = this.position(), was = this.playing;
    try { this.el.pause(); } catch (e) {}
    if (this.mediaSrc) { try { this.mediaSrc.disconnect(); } catch (e) {} this.mediaSrc = null; }
    this.playing = false;
    dlog('audio', 'forceGraphSwap url=' + String(url).slice(0, 48) + ' pos=' + (Math.round(pos * 10) / 10));
    try { this._createEl(url, ref, pos, was, false); } catch (e) {
      dlog('audio', 'forceGraphSwap fail ' + e);
      return false;
    }
    return true;
  };

  AudioEngine.prototype.isGraphHealthy = function () {
    if (!this.mediaSrc) return false;
    if (!this.ctx || this.ctx.state === 'closed') return false;
    if (!this._graphMounted) return false;
    var S = window.LXSound;
    if (S && typeof S.mountedCtx === 'function' && S.mountedCtx() !== this.ctx) return false;
    return true;
  };

  AudioEngine.prototype.getAudioStatus = function () {
    var S = window.LXSound;
    var st = (S && typeof S.state === 'function') ? S.state() : null;
    return {
      mode: this.mode,
      ctxAlive: this.ctxAlive(),
      ctxState: this.ctx ? this.ctx.state : 'none',
      acAvailable: !!(window.AudioContext || window.webkitAudioContext),
      soundLoaded: !!(window.LXSound && typeof window.LXSound.state === 'function'),
      mediaBound: !!this.mediaSrc,
      mounted: !!this._graphMounted,
      bound: this.isGraphBound(),
      graphHealthy: this.isGraphHealthy(),
      eqOn: !!(st && st.enabled),
      reverbOn: !!(st && st.enabled && st.reverb !== 'none'),
      surroundOn: !!(st && st.enabled && st.surround),
      degraded: !!this._graphFallback,
      lastError: this._lastError || '',
      ctxGen: this._ctxGen || 0,
      graphHost: this._graphUrl ? String(this._graphUrl).replace(/^https?:\/\//, '').split('/')[0] : '',
      liteUrl: !!this._graphLite,
      blobPending: !!this._blobPending
    };
  };

  // 生成一条与曲目时长一致的柔和音轨（正弦叠加 + 缓慢包络）
  AudioEngine.prototype._synth = function (track) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var dur = Math.min(track.duration || 120, 180);
    var sr = 22050, n = Math.floor(sr * dur);
    var buf = this.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    var seed = 0;
    for (var i = 0; i < track.id.length; i++) seed += track.id.charCodeAt(i);
    var base = 174 + (seed % 7) * 18;
    for (var k = 0; k < n; k++) {
      var t = k / sr;
      var beat = t * (base / 60);
      var v = Math.sin(2 * Math.PI * base * t) * 0.34
        + Math.sin(2 * Math.PI * base * 1.5 * t) * 0.18
        + Math.sin(2 * Math.PI * base * 2 * t) * 0.10;
      var pulse = 0.72 + 0.28 * Math.sin(beat * Math.PI * 2);
      var env = Math.min(1, t / 1.2) * Math.min(1, (dur - t) / 1.6);
      d[k] = Math.max(-1, Math.min(1, v * pulse * env * 0.55));
    }
    return buf;
  };

  /* 是否接管音频图。
   * v3.13.0：只要音效总开关打开就接管 —— 原来还要求「EQ / 混响 / 环绕至少有一项非平」，
   * 于是用户刚打开开关、参数全为 0 时会觉得「开了没反应」。现在开关即生效（图接上，
   * 音量与后续调节都走 Web Audio）；关闭时回到原生播放，完全不创建 MediaElementSource。
   * 跨域音频由 /__media 与 /__local 同源代理兜底，真遇到加载失败仍会自动退回原生并提示。 */
  AudioEngine.prototype.graphEnabled = function () {
    var S = window.LXSound;
    if (!S || typeof S.state !== 'function') return false;
    return !!S.state().enabled;
  };

  /* 音效参数是否真的在起作用（EQ 非平 / 混响 / 环绕）。 */
  AudioEngine.prototype.graphMatters = function () {
    var S = window.LXSound;
    if (!S || typeof S.state !== 'function') return false;
    var st = S.state();
    if (!st || !st.enabled) return false;
    var flat = (st.eq || []).every(function (v) { return !v; });
    return !flat || (st.reverb && st.reverb !== 'none') || !!st.surround;
  };

  /* 这条音源要不要接 Web Audio。
   * v3.13.1：本地文件（已下载 / blob，本身同源）开关一开就接管；
   * 在线音源只有在「参数真的非平」时才改走同源媒体代理 —— 否则打开开关的一瞬间就把正在放的
   * 网络音频重建成代理地址，源站稍有风吹草动就加载失败，用户看到的是「开音效就报错」。
   * 一旦用户真的调了 EQ/混响/环绕，仍然走 v3.9.0 的 /__media 代理路径（那条路是验过 40 项的）。 */
  AudioEngine.prototype.wantGraph = function (ref) {
    if (!this.graphEnabled()) return false;
    var kind = (ref && ref.kind) || this.mode;
    if (kind === 'downloaded' || kind === 'local') return true;
    return this.graphMatters();
  };

  /* ---------- 音频字节缓存（v3.13.2）：把在线音频取成本地 Blob ----------
   * 为什么不再只靠 /__media：媒体代理是一次「重路由」，源站稍有波动（502 / 不认 Range /
   * 必须带 Referer / 返回 302 到别的 CDN）就会加载失败；而 <audio> 一旦是跨域且没 CORS 头，
   * 接进 Web Audio 会被判污染直接**静音**（不报错、也没声音，正是用户遇到的「开了没声音」）。
   * 所以接入音效时先把整段音频经原生桥取回来（不受 CORS 限制，能带请求头），
   * 存成本源 Blob 再交给 <audio> —— 同源、无 Range 依赖、必然能进图。 */
  AudioEngine.prototype._blobCache = {};
  AudioEngine.prototype._blobOrder = [];

  AudioEngine.prototype._cacheBlob = function (url, mime, blobUrl) {
    var self = this;
    if (!url || !blobUrl) return;
    if (this._blobCache[url]) { try { URL.revokeObjectURL(this._blobCache[url]); } catch (e) {} }
    else this._blobOrder.push(url);
    this._blobCache[url] = blobUrl;
    while (this._blobOrder.length > 3) {
      var old = this._blobOrder.shift();
      var u = self._blobCache[old];
      if (u) { try { URL.revokeObjectURL(u); } catch (e) {} delete self._blobCache[old]; }
    }
  };

  /* 把 base64 分片解码成 Blob parts（v3.13.3）：
   * 真机上几十 MB 的整串 base64 一次性 atob 会产生「巨大的二进制字符串 + 同样大的 Uint8Array」，
   * 叠上 Java 侧的分块串就有 OOM 风险。按 512KB 切片解码，每片只占一小块内存。 */
  /* 每个原生分块是独立 Base64（各自带 = 填充），不能拼接后整体 atob，
   * 否则内部填充会让 atob 抛 "not correctly encoded"。逐块解码再拼接。 */
  AudioEngine.prototype._decodeB64Parts = function (parts, maxBytes) {
    var out = [], total = 0;
    (parts || []).forEach(function (p) {
      p = String(p || '').replace(/\s/g, '');
      if (!p) return;
      var bin = atob(p);
      total += bin.length;
      if (maxBytes && total > maxBytes) throw new Error('文件过大（超过 ' + Math.floor(maxBytes / 1048576) + 'MB），已跳过音效');
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      out.push(u8);
    });
    return { parts: out, bytes: total };
  };

  AudioEngine.prototype._b64ToParts = function (b64, maxBytes) {
    var SLICE = 524288;                                  // 必须是 4 的倍数
    var parts = [];
    var total = 0;
    for (var off = 0; off < b64.length; off += SLICE) {
      var chunk = b64.substr(off, SLICE);
      var bin = atob(chunk);
      total += bin.length;
      if (maxBytes && total > maxBytes) throw new Error('文件过大（超过 ' + Math.floor(maxBytes / 1048576) + 'MB），已跳过音效');
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(i);
      parts.push(u8);
    }
    return { parts: parts, bytes: total };
  };

  AudioEngine.prototype._fetchBytes = function (url, headers, cb) {
    /* 优先用原生桥（LXSourceAPI.request 内部走 EchoBridge.httpRequest，binary=true 返回 base64）：
     * 不受 CORS / 混合内容限制，还能带上音源要求的 Referer / UA。
     * v3.13.3：原生侧改成「边读边 Base64、分块回传」，并限制 24MB，避免整份 Base64 撑爆内存闪退。 */
    var MAXB = 24 * 1024 * 1024;
    var api = window.LXSourceAPI;
    if (api && typeof api.request === 'function' &&
        window.EchoBridge && typeof window.EchoBridge.httpRequest === 'function') {
      api.request(url, { method: 'GET', headers: headers || {}, binary: true, timeout: 60000 },
        function (err, resp) {
          if (err || !resp) return cb(err || new Error('empty response'));
          if (resp.statusCode && resp.statusCode >= 400) return cb(new Error('HTTP ' + resp.statusCode));
          if (!resp.__base64 || (!resp.body && !resp.parts)) return cb(new Error('not binary'));
          try {
            var got;
            if (resp.parts && resp.parts.length) {
              got = this._decodeB64Parts(resp.parts, MAXB);
            } else {
              got = this._b64ToParts(String(resp.body).replace(/\s/g, ''), MAXB);
            }
            cb(null, new Blob(got.parts, { type: 'audio/mpeg' }), got.bytes);
          } catch (e) { cb(e); }
        }.bind(this));
      return;
    }
    /* 浏览器预览（没有原生桥）时退回 window.fetch；跨域源会失败，那就保持原生播放 */
    var F = window.fetch;
    if (typeof F !== 'function') return cb(new Error('no fetcher'));
    F.call(window, url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      if (b.size > MAXB) throw new Error('文件过大（超过 ' + Math.floor(MAXB / 1048576) + 'MB），已跳过音效');
      cb(null, b, b.size);
    }).catch(function (e) { cb(e); });
  };

  /* 把当前在线音频换成同源 Blob，再接管音频图。
   * 关键：先让旧的（原生）<audio> 继续出声，同时把 Blob 元素**预加载到 canplay**，
   * 一切就绪才在同一位置一次性切换 —— 中间不会出现「打开了音效却没声音」的空档。 */
  AudioEngine.prototype._swapToGraphable = function (url, ref, pos, was) {
    var self = this;
    var nx = new Audio();
    nx.preload = 'auto';
    nx.playbackRate = this.playbackRate;
    nx.volume = 0;                     // 未切换前绝对不出声，避免两个源同时响
    nx.src = url;
    var key = url;
    var done = false;
    var timer = setTimeout(function () { finish(new Error('预加载超时')); }, 12000);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      nx.removeEventListener('canplay', onCanPlay);
      nx.removeEventListener('error', onErr);
      /* 换入失败（超时 / blob 不可播）：不能像旧版那样静默放弃音频图，
       * 直接退到「解码成 AudioBuffer 走音效链」，音乐与音效都保住。 */
      if (err) {
        self._lastError = 'Blob 接管失败: ' + (err.message || err);
        dlog('audio', self._lastError);
        self._stallHold = false;            // 接管失败要放原生继续播，恢复它在 timer 里自愈
        self._stallWin = null;
        try { nx.pause(); nx.removeAttribute('src'); nx.load(); } catch (e) {}
        self._releaseStallHold(true);     // 让被我们暂停的原生元素重新出声
        if (self._playViaBuffer(ref.origin || key, ref, self.position(), self.playing)) return;
        if (self.onGraphUnavailable) self.onGraphUnavailable(self._lastError);
        return;
      }
      if (self._blobPending !== (ref.origin || key)) return;
      /* 用「切换这一刻」的位置，而不是发起请求时的位置：
       * 取字节要走网络，期间旧元素一直在播，用旧位置会让进度往回跳（听到一小段重复）。
       * 注意必须先取位置再摘 src —— removeAttribute('src') 会把 currentTime 归零。 */
      var now = self.position();
      /* 切换：暂停老元素、摘掉它的 source，让 WebView 回收解码器 */
      try { if (self.el) { self.el.pause(); self.el.removeAttribute('src'); self.el.load(); } } catch (e) {}
      if (self.mediaSrc) { try { self.mediaSrc.disconnect(); } catch (e) {} self.mediaSrc = null; }
      nx.volume = 1;
      self._blobPending = null;        // 成功接管后必须清标记，否则后续 rebuild 会被「已在取字节」挡住
      self._stallHold = false;         // 已经换成 Blob，恢复正常状态机
      self._stallWin = null;
      self._cloneFrom(nx, url, ref, now > 0 ? now : pos, was);
    }
    function onCanPlay() { finish(null); }
    function onErr() { finish(new Error('blob 加载失败')); }
    nx.addEventListener('canplay', onCanPlay);
    nx.addEventListener('error', onErr);
    if (nx.readyState >= 3) finish(null);
    return true;
  };

  /* ArkWeb 没有 createMediaElementSource 时的退路：
   * 用原生桥把音频字节取回来 → decodeAudioData → 直接接进音效链（gain→EQ→…）播放。
   * 代价是整段解码进内存（上限 24MB），换来音效在任何 WebView 上都能真实生效。 */
  AudioEngine.prototype._playViaBuffer = function (url, ref, startAt, autoplay) {
    var self = this;
    var gen = this._loadGen || 0;
    url = String(url || '');
    if (!url) return false;
    this._ensureCtx();
    if (!this.ctx || typeof this.ctx.decodeAudioData !== 'function') {
      this._lastError = 'decodeAudioData 不可用';
      dlog('audio', this._lastError);
      return false;
    }
    dlog('audio', 'buffer fallback: ' + url.slice(0, 80));
    function toArrayBuffer(b, cb) {
      if (b && typeof b.arrayBuffer === 'function') {
        b.arrayBuffer().then(cb, function () { cb(new ArrayBuffer(0)); });
        return;
      }
      try {
        var fr = new FileReader();
        fr.onload = function () { cb(fr.result); };
        fr.onerror = function () { cb(new ArrayBuffer(0)); };
        fr.readAsArrayBuffer(b);
      } catch (e) { cb(new ArrayBuffer(0)); }
    }
    function decode(blob) {
      if (!blob || typeof blob.size === 'number' && !blob.size) {
        self._lastError = '音频字节为空';
        if (self.onError) self.onError('音频加载失败');
        return;
      }
      var got = false;
      function ok(buf) {
        if (got) return; got = true;
        if (gen !== self._loadGen) return;      // 已切歌，旧解码结果丢弃
        self._applyBuffer(buf, ref, startAt, autoplay);
      }
      function fail(e) {
        if (got) return; got = true;
        if (gen !== self._loadGen) return;
        self._lastError = '解码失败: ' + (e && e.message || e);
        dlog('audio', self._lastError);
        if (self.onError) self.onError('音频解码失败（该格式可能不受支持）');
      }
      toArrayBuffer(blob, function (ab) {
        try {
          var p = self.ctx.decodeAudioData(ab, ok, fail);
          if (p && typeof p.then === 'function') p.then(ok, fail);
        } catch (e) { fail(e); }
      });
    }
    if (/^file:/i.test(url) && typeof window.fetch === 'function') {
      window.fetch(url).then(function (r) { return r.blob(); }).then(decode).catch(function (e) {
        self._lastError = '本地文件读取失败: ' + (e && e.message || e);
        if (self.onError) self.onError('本地文件读取失败（可能未保存到设备或已被删除）');
      });
      return true;
    }
    this._fetchBytes(url, ref && ref.headers, function (err, bytes) {
      if (gen !== self._loadGen) return;
      if (err || !bytes) {
        self._lastError = '音效取字节失败: ' + (err && err.message);
        dlog('audio', self._lastError);
        if (self.onError) self.onError('音频加载失败');
        return;
      }
      decode(bytes instanceof Blob ? bytes : new Blob([bytes], { type: (ref && ref.mime) || 'audio/mpeg' }));
    });
    return true;
  };

  AudioEngine.prototype._applyBuffer = function (buf, ref, startAt, autoplay) {
    if (!buf) return;
    /* 从原生 <audio> 切过来时必须先停掉旧元素，否则两个源同时出声 */
    if (this.el) {
      try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); } catch (e) {}
      this.el = null;
    }
    if (this.mediaSrc) { try { this.mediaSrc.disconnect(); } catch (e) {} }
    this.mode = 'buffer';
    this._rawUrl = (ref && (ref.origin || ref.url)) || this._rawUrl;
    this._lastRef = ref;
    this.buffer = buf;
    this.duration = buf.duration || this.duration;
    this.offset = Math.max(0, Number(startAt) || 0);
    this.playing = false;
    this.mediaSrc = null;
    this.el = null;
    dlog('audio', 'buffer ready ' + this.duration.toFixed(1) + 's');
    if (autoplay) this.play();
    else if (this.onTick) this.onTick(this.offset, this.duration);
  };

  /* 用已就绪的 <audio> 接管音频图（不再新建元素） */
  AudioEngine.prototype._cloneFrom = function (nx, url, ref, startAt, autoplay) {
    var self = this;
    this.el = nx;
    this.mode = ref.kind === 'stream' ? 'stream' : 'local';
    this._rawUrl = ref.origin || url;
    this._lastUrl = url;
    this._lastRef = ref;
    this.mediaMime = ref.mime || '';
    this.playing = false;
    this._ending = false;
    nx.addEventListener('ended', function () { self._ended(); });
    nx.addEventListener('pause', function () {
      if (!self.playing || self.el !== nx) return;
      self.playing = false;
      self.offset = self.position();
      self._pauseMiss = 0;
      if (self._timer) { clearInterval(self._timer); self._timer = null; }
      if (self.onStateChange) self.onStateChange(false);
    });
    nx.addEventListener('play', function () {
      if (self.playing || self.el !== nx) return;
      self.playing = true;
      if (self.onStateChange) self.onStateChange(true);
      self.play();
    });
    nx.addEventListener('loadedmetadata', function () {
      if (nx.duration && isFinite(nx.duration)) self.duration = nx.duration;
    });
    nx.addEventListener('error', function () {
      if (self.onError) self.onError('音频加载失败');
    });
    this._attachDiag(nx, 'blob');
    var useGraph = this.wantGraph(ref);
    if (useGraph && this.ensureMounted()) {
      try {
        this.mediaSrc = this.ctx.createMediaElementSource(nx);
        this.mediaSrc.connect(this.gain);
        nx.volume = 1;
      } catch (e) {
        this.mediaSrc = null;
        this._lastError = 'MediaElementSource 创建失败: ' + (e && e.message || e);
        dlog('audio', 'createMediaElementSource fail: ' + this._lastError);
        nx.volume = this.volume;
        try { nx.pause(); nx.removeAttribute('src'); nx.load(); } catch (e2) {}
        this.el = null;
        if (this._playViaBuffer(ref.origin || url, ref, startAt, autoplay)) return;
      }
    } else {
      this.mediaSrc = null;
      nx.volume = this.volume;
    }
    if (startAt > 0 && (!this.duration || startAt < this.duration - 0.1)) {
      try { nx.currentTime = startAt; } catch (e) {}
    }
    if (autoplay) this.play();
  };

  /* 把当前在线音频换成同源 Blob，再接管音频图。全程不打断正在播放的原生音频：
   * 先让它继续放，字节一到就在同一位置换成 Blob 元素并接图。 */
  AudioEngine.prototype._swapViaBlob = function (ref, pos, was) {
    var self = this;
    var url = ref && (ref.url || ref.localUrl);
    if (!url) return false;
    /* 慢流：整段取字节本身就要几十倍实时，再并发只会把正在播的那条也拖死。
     * 这种源上优先保「能连续出声」，音效留给下一首或换源后再接。 */
    if (this._slowStream) {
      this._lastError = '上游吞吐不足，已保持原生播放（不并发取整段）';
      dlog('audio', 'graph skip: slow-stream host=' +
        String(url).replace(/^https?:\/\//, '').split('/')[0]);
      this._blobPending = null;
      this._wantBlob = null;
      if (this.onGraphUnavailable) this.onGraphUnavailable(this._lastError);
      return false;
    }
    var cached = this._blobCache[url];
    if (cached) {
      return this._swapToGraphable(cached, { kind: 'stream', url: cached, origin: url, mime: ref.mime, blob: true }, pos, was);
    }
    var key = url;
    var tid = this.track ? String(this.track.id) : '';
    this._blobPending = key;
    /* 音效图只需要能解码的音频：FLAC/高码率整段 >24MB 会被原生侧直接拒掉。
     * 先让音源另取一条 128k 播放地址（体积约 3~5MB），取不到再用原地址。 */
    var SR = window.LXSources;
    var lite = null;
    if (SR && typeof SR.resolveMedia === 'function' && this.track) {
      lite = SR.resolveMedia(this.track, '128k', 'musicUrl')
        .then(function (m) { return (m && m.url) ? m : null; }).catch(function () { return null; });
    } else {
      lite = Promise.resolve(null);
    }
    lite.then(function (m) {
      if (self._blobPending !== key) return;
      var fetchUrl = (m && m.url) || url;
      var headers = (m && m.headers) || ref.headers;
      self._graphUrl = fetchUrl;
      self._graphLite = !!(m && m.url);
      dlog('audio', 'graph fetch lite=' + self._graphLite + ' host=' + String(fetchUrl).replace(/^https?:\/\//, '').split('/')[0]);
      self._fetchBytes(fetchUrl, headers, function (err, bytes) {
        if (self._blobPending !== key) return;             // 已经切歌，丢弃
        if (!err && bytes && typeof bytes.size === 'number' && !bytes.size) err = new Error('空音频');
        if (err || !bytes) {
          self._lastError = '音效取字节失败: ' + (err && err.message);
          dlog('audio', self._lastError);
          self._releaseStallHold(true);
          if (self._playViaBuffer(fetchUrl, ref, self.position(), self.playing)) return;
          if (self.onGraphUnavailable) self.onGraphUnavailable(err && err.message);
          return;
        }
        var mime = (m && m.mime) || (ref.mime || self.mediaMime || 'audio/mpeg');
        var blob;
        try {
          blob = (bytes instanceof Blob) ? bytes : new Blob([bytes], { type: mime });
          if (blob.type !== mime && blob.slice) blob = blob.slice(0, blob.size, mime);
        } catch (e) {
          self._lastError = 'blob 创建失败: ' + (e && e.message);
          if (self.onGraphUnavailable) self.onGraphUnavailable('blob 创建失败');
          return;
        }
        var burl = URL.createObjectURL(blob);
        self._cacheBlob(key, mime, burl);
        if (self.track && String(self.track.id) !== tid) return;
        var p = self.position(), w = self.playing;
        self._swapToGraphable(burl, { kind: 'stream', url: burl, origin: key, mime: mime, blob: true }, p, w);
      });
    });
    return true;
  };

  /* 创建 <audio> 并决定是否接入 Web Audio */
  AudioEngine.prototype._createEl = function (url, ref, startAt, autoplay, forceNative) {
    var self = this;
    this.mode = (ref.origin || ref.kind === 'stream') ? 'stream' : 'local';
    this.mediaMime = ref.mime || '';
    var rawUrl = ref.origin || url;          // 原始地址：回退与 rebuild 都用它
    var el = new Audio();
    el.preload = 'auto';
    el.playbackRate = this.playbackRate;
    var useGraph = !forceNative && this.wantGraph(ref);
    dlog('audio', 'createEl useGraph=' + useGraph + ' forceNative=' + !!forceNative +
      ' kind=' + (ref && ref.kind || '-') + ' url=' + String(url).slice(0, 40));
    /* graph 模式下优先走原生媒体代理（同源，不会被静音）。
     * 代理不可用（浏览器预览）时才退回 crossOrigin='anonymous'，
     * 极端情况下由 onError 回退原生播放，保证永远有声音。 */
    if (useGraph && /^https?:/i.test(url)) {
      var proxied = MediaProxy.wrap(url, ref.headers);
      if (proxied) url = proxied;
      else {
        /* 同源地址（/__local、/__media 都在本源下）不需要也不该标 crossOrigin：
         * WebView 的媒体加载器对「CORS 模式」的拦截响应校验比网络栈严格，
         * 标了 anonymous 反而会 NETWORK_NO_SOURCE 加载失败（真机实测：位置在 0↔结尾来回跳）。
         * 只有真正跨域的远端地址才退回 CORS 模式。 */
        var sameOrigin = false;
        try { sameOrigin = new URL(url, location.href).host === location.host; } catch (e) { sameOrigin = false; }
        if (!sameOrigin) { try { el.crossOrigin = 'anonymous'; } catch (e) {} }
      }
    }
    el.src = url;
    this._attachDiag(el, 'el');
    el.addEventListener('waiting', function () { self._onStall(el); });
    el.addEventListener('stalled', function () { self._onStall(el); });
    el.addEventListener('ended', function () { self._ended(); });
    /* 元素被外部（灵动岛 / 系统媒体控件 / 锁屏）暂停或恢复时，事件即时同步内部状态，
     * 不等 250ms 轮询；自己调 pause() 会先把 playing 置 false，这里不会误触发。 */
    el.addEventListener('pause', function () {
      if (!self.playing || self.el !== el) return;
      self.playing = false;
      self.offset = self.position();
      self._pauseMiss = 0;
      if (self._timer) { clearInterval(self._timer); self._timer = null; }
      if (self.onStateChange) self.onStateChange(false);
    });
    el.addEventListener('play', function () {
      if (self.playing || self.el !== el) return;
      self.playing = true;
      if (self.onStateChange) self.onStateChange(true);
      self.play();
    });
    el.addEventListener('loadedmetadata', function () {
      if (el.duration && isFinite(el.duration)) self.duration = el.duration;
    });
    el.addEventListener('error', function () {
      // graph 模式下跨域被拒：自动退回原生播放，不让用户面对「没声音」
      if (useGraph && self.el === el && !self._graphFallback) {
        self._graphFallback = true;
        var pos = self.position(), was = self.playing;
        // 强制原生播放，避免在同一模式下反复失败
        self._createEl(rawUrl, ref, pos, was, true);
        if (self.onGraphFallback) self.onGraphFallback();
        return;
      }
      if (self.onError) self.onError(ref && ref.kind === 'downloaded'
        ? '本地文件读取失败（可能未保存到设备或已被删除）' : '在线音频加载失败');
    });
    this.el = el;
    /* 换了新的 <audio> 就必须把 playing 归零：
     * 否则下面 autoplay 调 play() 会被「已经在播」的判断提前 return，新元素永远不启动，
     * 表现就是 readyState 一直 0、进度卡住 —— 用户听到的正是「开了音效就没声音」。 */
    this.playing = false;
    this._rawUrl = rawUrl;
    this._lastUrl = url;
    this._lastRef = ref;

    if (useGraph && this.ensureMounted()) {
      try {
        this.mediaSrc = this.ctx.createMediaElementSource(el);
        this.mediaSrc.connect(this.gain);
        el.volume = 1;
      } catch (e) {
        this.mediaSrc = null;
        this._lastError = 'MediaElementSource 创建失败: ' + (e && e.message || e);
        dlog('audio', 'createMediaElementSource fail(el): ' + this._lastError);
        el.volume = this.volume;
        /* ArkWeb 若没有 createMediaElementSource，退回「解码成 AudioBuffer 再走音效链」 */
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e2) {}
        this.el = null;
        if (this._playViaBuffer(rawUrl, ref, startAt, autoplay)) return;
      }
    } else {
      this.mediaSrc = null;
      el.volume = this.volume;
    }

    /* 不能在曲尾附近起播（startAt 恰好等于时长会立刻触发 ended，进而重建、再 ended 的死循环） */
    if (startAt > 0 && (!this.duration || startAt < this.duration - 0.1)) {
      try { el.currentTime = startAt; } catch (e) {}
    }
    if (autoplay) this.play();
  };

  AudioEngine.prototype.load = function (track, ref) {
    var self = this;
    this.stop(true);
    this.track = track;
    this.duration = track.duration || 120;
    this.offset = 0;
    this._loadGen = (this._loadGen || 0) + 1;
    this._graphFallback = false;
    this._blobPending = null;
    this._wantBlob = null;
    this._ending = false;
    this._stallHold = false;
    this._stallWin = null;
    this._slowStream = false;
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    try {
      var lu = String((ref && (ref.url || ref.localUrl)) || '');
      var lhost = lu.replace(/^https?:\/\//, '').split('/')[0];
      dlog('audio', 'load platform=' + (track.platform || '-') + ' host=' + (lhost || '-') +
        ' mime=' + (ref && ref.mime || '-') + ' kind=' + (ref && ref.kind || '-'));
    } catch (e) {}
    if (this.onTick) this.onTick(0, this.duration);
    return new Promise(function (resolve) {
      if (ref && (ref.kind === 'downloaded' || ref.kind === 'stream') && (ref.localUrl || ref.url)) {
        var u = ref.url || ref.localUrl;
        /* 在线曲目 + 音效开启：先按原生播放出声（绝不静音），字节缓存好再接管音频图 */
        if (self.wantGraph(ref) && ref.kind === 'stream' && /^https?:/i.test(String(u))) {
          self._createEl(u, ref, 0, false, true);
          self._wantBlob = ref;
        } else {
          self._createEl(u, ref, 0, false);
        }
        resolve(true);
        return;
      }
      self.mode = 'synth';
      self._ensureCtx();
      self.buffer = self.ctx ? self._synth(track) : null;
      resolve(true);
    });
  };

  /* 切换音效开关时重建当前音频：MediaElementSource 不能撤销，
   * 只能换一个新的 <audio> 才能安全地在「原生 / 音效」之间切换。
   * v3.13.2：在线曲目不再走「代理重路由」，改为「缓存成同源 Blob 再接管」，见 _swapViaBlob。 */
  AudioEngine.prototype.rebuild = function () {
    if (!this.el || !this._lastUrl) return false;
    if (this.mode !== 'stream' && this.mode !== 'local') return false;
    var pos = this.position(), was = this.playing;
    var last = this._lastRef || { kind: this.mode, url: this._rawUrl || this._lastUrl, mime: this.mediaMime };
    var origin = last.origin || last.url || this._rawUrl || this._lastUrl;
    var base = {
      kind: (last.kind === 'stream' || last.origin) ? 'stream' : (last.kind || this.mode),
      url: origin, localUrl: origin, mime: last.mime, headers: last.headers
    };
    var want = this.wantGraph(base);
    /* 慢流上不重建元素：重建会摘 src、丢缓冲，等于把「勉强能播」的也打断。 */
    if (want && this._slowStream) {
      this._lastError = '上游吞吐不足，暂不接入音效（保持播放优先）';
      dlog('audio', 'rebuild skipped: slow-stream');
      if (this.onGraphUnavailable) this.onGraphUnavailable(this._lastError);
      return true;
    }
    if (!want) {
      this._blobPending = null;
      this._wantBlob = null;
      /* 关音效必须**真的离开 WebAudio 通路**。
       *
       * 曾经的做法是「保留音频图当干净旁路」：apply() 把 EQ 各段增益置 0、湿声置 0、干声置 1，
       * 于是理论上增益恒等，还能省掉换元素的 1~2 秒静音。但鸿蒙 ArkWeb 实测：
       * 元素 → MediaElementSource → AudioContext.destination 这条通路的整体输出，
       * 本身就比 <audio> 元素直出小一截（不是我们的增益造成的，图里所有增益都已是 1）。
       * 结果就是「开音效变小、关音效也回不来」—— 用户反馈两轮都是这个现象。
       *
       * 所以这里改回「关音效 = 换一个新的原生元素」，MediaElementSource 无法撤销，
       * 换元素是唯一能真正回到原生输出的方式。在新元素上直接复用当前元素的 currentSrc
       * （blob: 或 http 都可用），再把播放位置/速率/音量接回去，尽量无缝。 */
      var srcNow = this.el && (this.el.currentSrc || this.el.src);
      if (srcNow && this.mediaSrc) {
        try { this.el.pause(); } catch (e) {}
        try { this.mediaSrc.disconnect(); } catch (e) {}
        this.mediaSrc = null;
        this._graphMounted = false;
        if (window.LXSound && typeof window.LXSound.teardown === 'function') {
          try { window.LXSound.teardown(); } catch (e) {}
        }
        this.playing = false;
        dlog('audio', 'rebuild -> native (leave WebAudio path)');
        this._createEl(srcNow, {
          kind: base.kind, url: origin, localUrl: srcNow,
          mime: last.mime, headers: last.headers, origin: origin
        }, pos, was, true);
        return true;
      }
    }
    if (want && base.kind === 'stream' && /^https?:/i.test(String(origin))) {
      if (this._blobPending === origin) return true;      // 正在缓存，别重复发起
      this._swapViaBlob(base, pos, was);                  // 原生继续放，缓存好再切
      return true;
    }
    try { this.el.pause(); } catch (e) {}
    if (this.mediaSrc) { try { this.mediaSrc.disconnect(); } catch (e) {} this.mediaSrc = null; }
    this.playing = false;
    this._graphFallback = false;
    this._createEl(want ? origin : origin, base, pos, was, !want);
    return true;
  };

  AudioEngine.prototype._startSource = function (at) {
    if (!this.buffer || !this.ctx) return;
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.playbackRate.value = this.playbackRate || 1;
    this.src.connect(this.gain);
    var self = this;
    this.src.onended = function () { if (self.playing) self._ended(); };
    this.startCtxTime = this.ctx.currentTime;
    this.src.start(0, at || 0);
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
  };

  AudioEngine.prototype.play = function () {
    var self = this;
    if (this.playing) return Promise.resolve(true);
    if (this.el) {
      // graph 在冷启动时是 suspended，必须 resume 才会有声音
      if (this.mediaSrc && this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      /* 已经停在曲末（例如刚播完又按了播放 / 关音效重建时正好在结尾）就从 0 起，避免「按了没反应」 */
      if (this.duration && this.position() >= this.duration - 0.05) {
        try { this.el.currentTime = 0; } catch (e) {}
      }
      this.el.playbackRate = this.playbackRate;
      var p = this.el.play();
      /* 换元素时浏览器可能因为「没有用户手势」拒绝自动播放，而且不会报错，只是没声音。
       * 这里捕获拒绝并在下一拍重试一次，把「开了音效却卡住不出声」自愈掉。 */
      if (p && p.catch) p.catch(function () {
        setTimeout(function () {
          if (self.playing && self.el && self.el.paused) {
            var q = self.el.play();
            if (q && q.catch) q.catch(function () {});
          }
        }, 260);
      });
      this.playing = true;
      /* 在线曲目开着音效：此时已经按原生出声了，把字节缓存成本地 Blob 后无缝接管 */
      if (this._wantBlob) {
        var br = this._wantBlob;
        this._wantBlob = null;
        this._blobPending = br.url || br.localUrl;
        this._swapViaBlob(br, this.position(), true);
      }
    } else {
      this._ensureCtx();
      if (!this.buffer) this.buffer = this._synth(this.track || { id: 'x', duration: 120 });
      this._startSource(this.offset);
      this.playing = true;
    }
    if (!this._timer) {
      this._timer = setInterval(function () {
        if (!self.playing) return;
        /* 元素被外部（灵动岛 / 系统媒体控件 / 锁屏）暂停时，不能反复重放把暂停抢回来；
         * 连续两拍仍暂停，就认定是外部暂停，同步内部状态并通知 UI。 */
        if (self._stallHold) {
          /* 正在等 Blob 接管：元素是「故意」暂停的，既不能当外部暂停处理，也不能重放抢带宽 */
        } else if (self.el && self.el.paused && self.el.readyState >= 2) {
          self._pauseMiss = (self._pauseMiss || 0) + 1;
          if (self._pauseMiss < 2) {
            var q = self.el.play();
            if (q && q.catch) q.catch(function () {});
          } else {
            self.playing = false;
            self.offset = self.position();
            self._pauseMiss = 0;
            try { if (self.el) self.el.pause(); } catch (e) {}
            if (self._timer) { clearInterval(self._timer); self._timer = null; }
            if (self.onStateChange) self.onStateChange(false);
          }
        } else {
          self._pauseMiss = 0;
        }
        if (self.onTick) self.onTick(self.position(), self.duration);
        if (self.position() >= self.duration) self._ended();
      }, 250);
    }
    return Promise.resolve(true);
  };

  AudioEngine.prototype.pause = function () {
    if (!this.playing) return;
    this.offset = this.position();
    this.playing = false;
    if (this.el) this.el.pause();
    else if (this.src) { try { this.src.stop(); } catch (e) {} this.src = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  };

  AudioEngine.prototype.stop = function (silent) {
    this._blobPending = null;
    this._wantBlob = null;
    this._ending = false;
    this._stallHold = false;
    this._stallWin = null;
    this._slowStream = false;
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    if (this.el) {
      try { this.el.pause(); } catch (e) {}
      /* v3.13.2：必须把旧 <audio> 的 src 摘掉再 load()，让 WebView 立刻回收它的媒体解码器。
       * 池子被占满后新建的元素 readyState 会一直是 0（不加载、没声音），
       * 还会被 _ended 当成播完，陷入「重建 → 不加载 → 再重建」的死循环。 */
      try { this.el.removeAttribute('src'); this.el.load(); } catch (e) {}
      this.el = null;
    }
    if (this.mediaSrc) { try { this.mediaSrc.disconnect(); } catch (e) {} this.mediaSrc = null; }
    if (this.src) { try { this.src.stop(); } catch (e) {} this.src = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.playing = false;
    this.offset = 0;
    if (!silent && this.onTick) this.onTick(0, this.duration);
  };

  AudioEngine.prototype._ended = function () {
    if (this._ending) return;      // 防重入：ended 里会重建，重建再报 ended 就成死循环
    this._ending = true;
    this.stop(true);
    if (this.onTick) this.onTick(this.duration, this.duration);
    if (this.onEnded) this.onEnded();
  };

  AudioEngine.prototype.position = function () {
    if (this.el) return this.el.currentTime || 0;
    if (!this.playing || !this.ctx) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startCtxTime) * (this.playbackRate || 1);
  };

  AudioEngine.prototype.seek = function (pos) {
    var p = Math.max(0, Math.min(pos, this.duration - 0.2));
    var was = this.playing;
    if (was) this.pause();
    this.offset = p;
    if (this.el) this.el.currentTime = p;
    if (was) this.play();
    if (this.onTick) this.onTick(p, this.duration);
    return Promise.resolve(true);
  };

  AudioEngine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
    // 已接入 graph 时音量只在 gain 上生效，元素本身保持 1
    if (this.el) this.el.volume = this.mediaSrc ? 1 : v;
  };

  AudioEngine.prototype.setRate = function (r) {
    this.playbackRate = r;
    if (this.el) this.el.playbackRate = r;
    if (this.src) this.src.playbackRate.value = r;
  };

  window.LXEngine = AudioEngine;
})();
