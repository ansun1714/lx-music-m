/* 播放引擎
 * - 自定义音源曲目：用 <audio> 播放在线 URL / data: 音频（mode='stream'）
 * - 已下载曲目：用 <audio> 播放本地 Blob（mode='local'）
 * - 其余曲目：Web Audio 实时合成柔和演示音轨（mode='synth'，无网络请求）
 * - 支持播放速率、音量、进度、播放结束回调
 * - 音效开启时才把 <audio> 接进 Web Audio；关闭时走原生播放（避免 CORS 静音与节点累积）
 */
(function () {
  'use strict';

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
    this._timer = null;
  }

  AudioEngine.prototype._ensureCtx = function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; return; }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.input = this.gain;
    /* 音效链：gain → 10 段 EQ → 干/湿混响 → 环绕 → destination。
     * 没有音效模块（或图建失败）时直连，保证永远能出声。 */
    var mounted = false;
    if (window.LXSound && typeof window.LXSound.mount === 'function') {
      try { mounted = window.LXSound.mount(this.ctx, this.gain, this.ctx.destination); }
      catch (e) { mounted = false; }
    }
    if (!mounted) this.gain.connect(this.ctx.destination);
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
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
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
          if (!resp.__base64 || !resp.body) return cb(new Error('not binary'));
          try {
            var got = this._b64ToParts(String(resp.body).replace(/\s/g, ''), MAXB);
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
      if (err || self._blobPending !== (ref.origin || key)) return;
      /* 用「切换这一刻」的位置，而不是发起请求时的位置：
       * 取字节要走网络，期间旧元素一直在播，用旧位置会让进度往回跳（听到一小段重复）。
       * 注意必须先取位置再摘 src —— removeAttribute('src') 会把 currentTime 归零。 */
      var now = self.position();
      /* 切换：暂停老元素、摘掉它的 source，让 WebView 回收解码器 */
      try { if (self.el) { self.el.pause(); self.el.removeAttribute('src'); self.el.load(); } } catch (e) {}
      if (self.mediaSrc) { try { self.mediaSrc.disconnect(); } catch (e) {} self.mediaSrc = null; }
      nx.volume = 1;
      self._blobPending = null;        // 成功接管后必须清标记，否则后续 rebuild 会被「已在取字节」挡住
      self._cloneFrom(nx, url, ref, now > 0 ? now : pos, was);
    }
    function onCanPlay() { finish(null); }
    function onErr() { finish(new Error('blob 加载失败')); }
    nx.addEventListener('canplay', onCanPlay);
    nx.addEventListener('error', onErr);
    if (nx.readyState >= 3) finish(null);
    return true;
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
    nx.addEventListener('loadedmetadata', function () {
      if (nx.duration && isFinite(nx.duration)) self.duration = nx.duration;
    });
    nx.addEventListener('error', function () {
      if (self.onError) self.onError('音频加载失败');
    });
    var useGraph = this.wantGraph(ref);
    if (useGraph) {
      this._ensureCtx();
      if (this.ctx) {
        try {
          this.mediaSrc = this.ctx.createMediaElementSource(nx);
          this.mediaSrc.connect(this.gain);
          nx.volume = 1;
        } catch (e) { this.mediaSrc = null; nx.volume = this.volume; }
      } else nx.volume = this.volume;
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
    var cached = this._blobCache[url];
    if (cached) {
      return this._swapToGraphable(cached, { kind: 'stream', url: cached, origin: url, mime: ref.mime, blob: true }, pos, was);
    }
    var key = url;
    var tid = this.track ? String(this.track.id) : '';
    this._blobPending = key;
    this._fetchBytes(url, ref.headers, function (err, bytes) {
      if (self._blobPending !== key) return;             // 已经切歌，丢弃
      if (!err && bytes && typeof bytes.size === 'number' && !bytes.size) err = new Error('空音频');
      if (err || !bytes) {
        if (self.onGraphUnavailable) self.onGraphUnavailable(err && err.message);
        return;
      }
      var mime = (ref.mime || self.mediaMime || 'audio/mpeg');
      var blob;
      try {
        /* _fetchBytes 现在直接给 Blob（分片解码，避免大文件 OOM）；兼容旧返回 Uint8Array 的情况 */
        blob = (bytes instanceof Blob) ? bytes : new Blob([bytes], { type: mime });
        if (blob.type !== mime && blob.slice) blob = blob.slice(0, blob.size, mime);
      } catch (e) {
        if (self.onGraphUnavailable) self.onGraphUnavailable('blob 创建失败');
        return;
      }
      var burl = URL.createObjectURL(blob);
      self._cacheBlob(key, mime, burl);
      if (self.track && String(self.track.id) !== tid) return;
      var p = self.position(), w = self.playing;
      self._swapToGraphable(burl, { kind: 'stream', url: burl, origin: key, mime: mime, blob: true }, p, w);
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
    el.addEventListener('ended', function () { self._ended(); });
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

    if (useGraph) {
      this._ensureCtx();
      if (this.ctx) {
        try {
          this.mediaSrc = this.ctx.createMediaElementSource(el);
          this.mediaSrc.connect(this.gain);
          el.volume = 1;
        } catch (e) {
          this.mediaSrc = null;
          el.volume = this.volume;
        }
      } else {
        el.volume = this.volume;
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
    this._graphFallback = false;
    this._blobPending = null;
    this._wantBlob = null;
    this._ending = false;
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
    if (!want) {
      this._blobPending = null;
      this._wantBlob = null;
      /* v3.13.2：关音效时不再换元素回原生。
       * sound-effects 的 apply() 在关闭状态下会把 EQ 各段增益置 0、湿声置 0，
       * 音频图本身就是「原样放行」——留着它就是干净的旁路。
       * 换元素要摘 src、重建解码器，实测会卡 1~2 秒没声音（用户看到的「关一下就没声了」）。 */
      if (this.mediaSrc) return true;
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
        /* 自愈：元素已加载却被暂停（换元素时被自动播放策略拦下），再推一次 play() */
        if (self.el && self.el.paused && self.el.readyState >= 2) {
          var q = self.el.play();
          if (q && q.catch) q.catch(function () {});
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
