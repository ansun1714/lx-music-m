/* 歌曲下载中心（本版新增能力，对应原版源码中被注释掉的 download 菜单项）
 * - 自定义音源曲目：按音源 downloadUrl 返回的真实音频字节 + mime/ext 原样保存（不重新编码）
 * - 其余曲目：生成真实可播放的 16-bit PCM WAV（RIFF/WAVE 头正确）作为离线回退
 * - IndexedDB 保存 Blob，刷新后仍可离线播放；索引写 localStorage
 * - 任务队列：并发、进度、暂停/继续/取消/重试/移除/清空已完成
 * - 浏览器用 <a download> 交付；安卓外壳用分块 base64 桥写入系统下载目录
 */
(function () {
  'use strict';

  var QUALITIES = {
    standard: { label: '标准', sr: 6000, desc: '6 kHz · 单声道 PCM' },
    high: { label: '高清', sr: 8000, desc: '8 kHz · 单声道 PCM' },
    lossless: { label: '无损', sr: 11025, desc: '11 kHz · 无压缩 PCM WAV' }
  };
  var INDEX_KEY = 'lx_downloads_index_v1';
  var DB_NAME = 'lx-download-store', STORE = 'files';
  var jobs = {}, order = [], playable = {}, memFiles = {}, running = 0, seq = 0;
  var listeners = [], dbPromise = null;
  var opts = { quality: '320k', autoDeliver: true, parallel: 2, dir: 'Download/LX Music' };

  /* v3.12.0：可配置下载目录（相对外部存储的路径，例如 Music/LX Music）。
   * 只做一层清洗，最终仍由 Java 再校验一次，避免 ../ 之类越权写到别处。 */
  function dirOf() {
    var d = String(opts.dir == null ? '' : opts.dir).replace(/\\/g, '/').replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ').trim();
    if (!d || d.indexOf('..') >= 0 || !/^[^\\:*?"<>|\x00-\x1f]{1,80}$/.test(d)) {
      return 'Download/LX Music';
    }
    var roots = ['Download', 'Music', 'Documents', 'Pictures', 'Movies'];
    if (d.indexOf('/') < 0) return 'Download/' + d;                 // 只写子目录 → 落在 Download 下
    if (roots.indexOf(d.split('/')[0]) < 0) return 'Download/' + d;  // 未知根目录 → 也归到 Download
    return d;
  }
  function dirLabel() { return dirOf(); }

  function uid() { return 'dl' + (++seq) + '_' + Date.now().toString(36); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeName(s) {
    var v = String(s || 'track').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    return (v || 'track').slice(0, 70);
  }
  function fileName(j) {
    // 按歌曲来源格式决定扩展名：自定义音源返回 .mp3/.flac/.m4a/... 时原样保留
    var base = j.filename ? String(j.filename).replace(/\.[^.\/]+$/, '') : (j.name + ' - ' + j.singer);
    return safeName(base) + '.' + (j.ext || 'wav');
  }
  function fmtSize(n) {
    if (!n) return '—';
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }
  function emit() {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} }
    if (window.LXRenderDownloads && document.getElementById('dlList')) {
      try { window.LXRenderDownloads(); return; } catch (e) {}
    }
    if (window.LXApp && window.LXApp.render) window.LXApp.render();
  }
  function t(key, fb) {
    return (window.LXI18N && window.LXI18N[key]) || fb || key;
  }

  // ---------------------------------------------------------------- 存储
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
    return dbPromise;
  }
  function putBlob(key, blob) {
    return db().then(function (d) {
      if (!d) { memFiles[key] = blob; return; }
      return new Promise(function (resolve) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(blob, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { memFiles[key] = blob; resolve(); };
      });
    });
  }
  function getBlob(key) {
    return db().then(function (d) {
      if (!d) return memFiles[key] || null;
      return new Promise(function (resolve) {
        var tx = d.transaction(STORE, 'readonly'), r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result || memFiles[key] || null); };
        r.onerror = function () { resolve(memFiles[key] || null); };
      });
    });
  }
  function deleteBlob(key) {
    return db().then(function (d) {
      if (!d) { delete memFiles[key]; return; }
      try { d.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); }
      catch (e) { delete memFiles[key]; }
    });
  }

  // ---------------------------------------------------------------- WAV 编码
  function encodeWav(samples, sr) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var k = 0; k < n; k++) v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, samples[k])) * 32767, true);
    return new Blob([buf], { type: 'audio/wav' });
  }
  function buildSamples(track, sr) {
    var dur = Math.min(track.duration || 120, 180), n = Math.floor(sr * dur), a = new Float32Array(n);
    var seed = 0;
    for (var i = 0; i < track.id.length; i++) seed += track.id.charCodeAt(i);
    var base = 174 + (seed % 7) * 18;
    for (var k = 0; k < n; k++) {
      var tt = k / sr;
      var v = Math.sin(2 * Math.PI * base * tt) * 0.34 +
        Math.sin(2 * Math.PI * base * 1.5 * tt) * 0.18 +
        Math.sin(2 * Math.PI * base * 2 * tt) * 0.10;
      var env = Math.min(1, tt / 1.2) * Math.min(1, (dur - tt) / 1.6);
      a[k] = Math.max(-1, Math.min(1, v * (0.72 + 0.28 * Math.sin(tt * (base / 60) * Math.PI * 2)) * env * 0.55));
    }
    return a;
  }

  // ---------------------------------------------------------------- 原生流式下载（v3.4.0）
  /* 真实歌曲几十 MB，必须先落盘再统计，不能一次性读进内存。
   * Java 侧 downloadStart 流式写入 Download/LX Music，每 250ms 回调进度，
   * 支持取消与 Range 续传（暂停后 .part 保留，继续时自动续上）。 */
  function hasNativeDownloader() {
    var B = window.EchoBridge;
    return !!(B && typeof B.downloadStart === 'function' && typeof B.downloadCancel === 'function');
  }
  function stopNative(j, clear) {
    var B = window.EchoBridge;
    if (!B || !j || !j.nativeKey) return;
    try { B.downloadCancel(j.nativeKey); } catch (e) {}
    if (clear && typeof B.downloadClear === 'function') {
      try { B.downloadClear(j.nativeKey); } catch (e) {}
    }
  }
  window.LXDownloadBridge = {
    onProgress: function (key, received, total) {
      var j = jobs[key]; if (!j || j.state !== 'running') return;
      var now = Date.now();
      if (j._lastT && now > j._lastT) {
        var inst = (received - (j._lastB || 0)) / ((now - j._lastT) / 1000);
        if (inst >= 0) j.speed = inst;
      }
      j._lastB = received; j._lastT = now;
      j.received = received;
      j.total = total > 0 ? total : 0;
      if (j.total) {
        j.size = j.total;
        j.progress = Math.min(99, Math.round(received / j.total * 100));
        j.eta = j.speed > 0 ? Math.max(0, Math.round((j.total - received) / j.speed)) : -1;
      } else {
        j.size = received; j.progress = 0; j.eta = -1;
      }
      emit();
    },
    onDone: function (key, path, size) {
      var j = jobs[key]; if (!j) return;
      if (j.state === 'cancelled') { return; }
      j.state = 'done'; j.progress = 100; j.path = path || '';
      j.size = size || j.size; j.received = j.size;
      j.speed = 0; j.eta = -1; j.error = '';
      running = Math.max(0, running - 1);
      saveIndex(); emit(); pump();
      if (typeof onDoneHook === 'function') { try { onDoneHook(j); } catch (e) {} }
    },
    onError: function (key, msg) {
      var j = jobs[key]; if (!j) return;
      if (j.state === 'cancelled') return;
      j.speed = 0; j.eta = -1;
      if (msg === '已暂停') {
        running = Math.max(0, running - 1);
        j.state = 'paused';
        saveIndex(); emit(); pump();
        return;
      }
      /* 网络抖动（对端提前关闭连接、超时）不该直接降音质：
       * 先用已写入的 .part 做一次 Range 续传，仍然失败才走降档。 */
      var net = /end of stream|reset|broken pipe|timeout|timed out|超时|连接/i.test(String(msg || ''));
      if (net && !j._netRetry && !j.cancelled && j._nativeUrl &&
          window.EchoBridge && typeof window.EchoBridge.downloadPartialSize === 'function' &&
          window.EchoBridge.downloadPartialSize(j.id) > 0) {
        j._netRetry = true;
        j.state = 'running';   // 仍在下载中，保持 running 计数
        j.note = '网络中断，正在续传…';
        saveIndex(); emit();
        try {
          window.EchoBridge.downloadStart(j.id, j._nativeUrl, JSON.stringify(j._nativeHeaders || {}),
            fileName(j), j.mime || 'audio/mpeg', dirOf());
          return;
        } catch (e) {
          j._netRetry = false;
        }
      }
      // 该档位的直链下不动时，自动降一档重试（选母带却拿到 403 是常见情况）
      if (j.plan && j.planIndex + 1 < j.plan.length && !j.cancelled) {
        var Q = window.LXQuality;
        j.planIndex++;
        j.note = '下载失败（' + msg + '），正在尝试「' +
          (Q ? Q.short(j.plan[j.planIndex]) : j.plan[j.planIndex]) + '」';
        j.state = 'running';   // 任务仍在进行中，保持 running 计数不变
        saveIndex(); emit();
        retryAttempt(j);
        return;
      }
      running = Math.max(0, running - 1);
      j.state = 'error'; j.error = msg || '下载失败';
      saveIndex(); emit(); pump();
    }
  };
  var onDoneHook = null;

  /* native 失败后按 plan 里的下一档重来（attempt 定义在 run 内部，这里用事件队列接续） */
  function retryAttempt(j) {
    if (j && typeof j.__attempt === 'function') { j.__attempt(); return; }
    // 没有可复用的闭包时，退化为重新排队
    j.state = 'waiting';
    saveIndex(); emit(); pump();
  }

  // ---------------------------------------------------------------- 交付
  function blobToBase64(blob) {
    return new Promise(function (resolve) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ''), i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
      r.onerror = function () { resolve(''); };
      r.readAsDataURL(blob);
    });
  }
  function deliver(job) {
    if (!job.blob) return;
    var name = fileName(job), B = window.EchoBridge;
    if (B && typeof B.saveDownloadStart === 'function' && typeof B.saveDownloadChunk === 'function' &&
        typeof B.saveDownloadFinish === 'function') {
      blobToBase64(job.blob).then(function (b64) {
        B.saveDownloadStart(name, job.mime || 'audio/wav');
        var CH = 262144;
        for (var i = 0; i < b64.length; i += CH) B.saveDownloadChunk(b64.slice(i, Math.min(b64.length, i + CH)));
        B.saveDownloadFinish();
      });
      return;
    }
    try {
      var url = URL.createObjectURL(job.blob), a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 任务
  function meta(j) {
    return {
      id: j.id, trackId: j.trackId, name: j.name, singer: j.singer,
      quality: j.quality, size: j.size || 0, progress: j.progress || 0,
      state: j.state, path: j.path || '', error: j.error || '',
      received: j.received || 0, total: j.total || 0,
      deliveredQuality: j.deliveredQuality || '', note: j.note || '',
      speed: j.speed || 0, eta: j.eta === undefined ? -1 : j.eta,
      mime: j.mime || '', ext: j.ext || '', filename: j.filename || '',
      format: j.format || '', sourceLabel: j.sourceLabel || ''
    };
  }
  function saveIndex() {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify({
        opts: opts, jobs: order.map(function (id) {
          var m = meta(jobs[id]);
          if (m.state === 'running' || m.state === 'waiting') m.state = 'paused';
          return m;
        })
      }));
    } catch (e) {}
  }
  function restore() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(INDEX_KEY) || 'null'); } catch (e) { return; }
    if (!raw) return;
    if (raw.opts) Object.keys(raw.opts).forEach(function (k) { opts[k] = raw.opts[k]; });
    (raw.jobs || []).forEach(function (m) {
      var j = {
        id: m.id, trackId: m.trackId, name: m.name, singer: m.singer,
        quality: m.quality, size: m.size, progress: m.progress,
        state: m.state === 'done' ? 'done' : 'paused', path: m.path || '',
        mime: m.mime || '', ext: m.ext || '', filename: m.filename || '',
        format: m.format || '', sourceLabel: m.sourceLabel || '',
        blob: null, cancelled: false, error: m.error || ''
      };
      jobs[j.id] = j; order.push(j.id);
      if (j.state === 'done') getBlob(j.trackId).then(function (b) {
        if (b) { j.blob = b; try { playable[j.trackId] = URL.createObjectURL(b); } catch (e) {} }
      });
    });
  }

  function pump() {
    while (running < (opts.parallel || 2)) {
      var next = null;
      for (var i = 0; i < order.length; i++) {
        var j = jobs[order[i]];
        if (j.state === 'waiting') { next = j; break; }
      }
      if (!next) break;
      next.state = 'running';
      running++;
      run(next);
    }
  }
  function startNative(j, media) {
    var B = window.EchoBridge;
    j.nativeKey = j.id;
    j.state = 'running';
    j.error = '';
    j.received = 0; j.total = 0;
    j.speed = 0; j.eta = -1;
    j._lastB = 0; j._lastT = Date.now();
    j.progress = 0;
    emit();
    var headers = media.headers || {};
    j._nativeUrl = media.url;
    j._nativeHeaders = headers;
    B.downloadStart(j.id, media.url, JSON.stringify(headers), fileName(j), j.mime || 'audio/mpeg', dirOf());
  }

  function run(j) {
    j.error = '';
    j.note = '';
    j.deliveredQuality = '';
    var track = (window.LXData && window.LXData.byId(j.trackId)) ||
      { id: j.trackId, name: j.name, singer: j.singer, duration: 128 };
    var SR = window.LXSources;
    var Q = window.LXQuality;

    function finish(result) {
      j.blob = result.blob;
      j.mime = result.mime || 'audio/wav';
      j.ext = result.ext || 'wav';
      j.filename = result.filename || (j.name + ' - ' + j.singer + '.' + j.ext);
      j.format = String(j.ext).toUpperCase();
      j.sourceLabel = track.sourceLabel || '';
      j.size = j.blob.size;
      j.state = 'done'; j.progress = 100;
      if (!j.deliveredQuality) j.deliveredQuality = j.tryQuality || j.quality;
      try { playable[j.trackId] = URL.createObjectURL(j.blob); } catch (e) {}
      putBlob(j.trackId, j.blob).then(function () {
        if (opts.autoDeliver) deliver(j);
        saveIndex(); emit();
      });
      running--; saveIndex(); emit(); pump();
    }

    // 完全拿不到音源时才用的离线占位音轨（不冒充真实歌曲）
    function synth() {
      var sr = (QUALITIES[j.quality] || QUALITIES.high).sr;
      var total = Math.floor(Math.min(track.duration || 128, 180) * sr), CHUNK = sr * 2;
      var done = 0, samples = new Float32Array(total), seed = 0;
      for (var q = 0; q < track.id.length; q++) seed += track.id.charCodeAt(q);
      var base = 174 + (seed % 7) * 18;
      function step() {
        if (j.cancelled || j.state !== 'running') { running--; pump(); emit(); return; }
        var end = Math.min(total, done + CHUNK);
        for (var k = done; k < end; k++) {
          var tt = k / sr;
          var v = Math.sin(2 * Math.PI * base * tt) * 0.34 +
            Math.sin(2 * Math.PI * base * 1.5 * tt) * 0.18 +
            Math.sin(2 * Math.PI * base * 2 * tt) * 0.10;
          var env = Math.min(1, tt / 1.2) * Math.min(1, ((track.duration || 128) - tt) / 1.6);
          samples[k] = Math.max(-1, Math.min(1, v * (0.72 + 0.28 * Math.sin(tt * (base / 60) * Math.PI * 2)) * env * 0.55));
        }
        done = end;
        j.progress = Math.round(done / total * 100);
        emit();
        if (done < total) { setTimeout(step, 0); return; }
        try {
          finish({ blob: encodeWav(samples, sr), mime: 'audio/wav', ext: 'wav', filename: '' });
        } catch (e) {
          j.state = 'error'; j.error = String(e && e.message || e);
          running--; saveIndex(); emit(); pump();
        }
      }
      setTimeout(step, 0);
    }

    // 档位全部失败：如实报错，不再用合成音轨假装成功
    function failAll() {
      j.state = 'error';
      j.speed = 0; j.eta = -1;
      var tiers = (j.plan || [j.quality]).map(function (q) { return Q ? Q.short(q) : q; }).join(' / ');
      var why = (SR && SR.lastError) ? SR.lastError(track) : '';
      j.error = (why ? '音源取链失败：' + why : '音源没有提供可用地址') + '（已尝试：' + tiers + '）';
      running--; saveIndex(); emit(); pump();
    }

    /* 逐档尝试：选的档位解析不到就自动降一档，最多降 2 档。
     * 这样选「母带」但音源只支持无损时，会真的拿到无损，并在任务行标出降级。 */
    function attempt() {
      if (j.cancelled || j.state !== 'running') return;
      var q = j.plan[j.planIndex] || j.quality;
      j.tryQuality = q;
      j._netRetry = false;          // 每换一档都允许一次续传机会
      j.progress = 3; emit();
      SR.fetchMedia(track, q).then(function (m) {
        if (j.cancelled || j.state !== 'running') return;
        if (!m || (!m.url && !m.data)) { nextTier(q); return; }
        j.mime = m.mime || j.mime || 'audio/mpeg';
        j.ext = m.ext || j.ext || 'mp3';
        j.filename = m.filename || (j.name + ' - ' + j.singer + '.' + j.ext);
        j.format = String(j.ext).toUpperCase();
        j.deliveredQuality = q;
        if (m.url && /^https?:/i.test(m.url) && hasNativeDownloader()) {
          var srcObj = SR.trackSource(track);
          if (srcObj) j.sourceLabel = srcObj.name;
          startNative(j, m);
          return;
        }
        SR.mediaToBlob(m).then(function (blob) {
          if (j.cancelled || j.state !== 'running') return;
          if (blob && blob.size) finish({ blob: blob, mime: m.mime, ext: m.ext, filename: m.filename });
          else nextTier(q);
        }).catch(function () { nextTier(q); });
      }).catch(function () { nextTier(q); });
    }

    function nextTier(failedQuality) {
      if (j.cancelled || j.state !== 'running') return;
      if (j.planIndex + 1 < j.plan.length) {
        j.planIndex++;
        var why = (SR && SR.lastError) ? SR.lastError(track) : '';
        j.note = '「' + (Q ? Q.short(failedQuality) : failedQuality) + '」不可用' +
          (why ? '（' + why + '）' : '') + '，正在尝试「' +
          (Q ? Q.short(j.plan[j.planIndex]) : j.plan[j.planIndex]) + '」';
        emit();
        attempt();
        return;
      }
      failAll();
    }

    var hasSource = !!(SR && SR.trackSource && SR.trackSource(track) && SR.fetchMedia);
    if (!hasSource) { synth(); return; }

    var pref = j.quality || opts.quality || '320k';
    j.plan = Q ? Q.downgradeChain(pref, track, 3) : [pref];
    if (!j.plan.length) j.plan = [pref];
    j.planIndex = 0;
    j.__attempt = attempt;
    attempt();
  }

  function enqueue(tracks, quality) {
    var added = 0;
    (tracks || []).forEach(function (t) {
      if (!t) return;
      var exist = order.filter(function (id) { return jobs[id].trackId === t.id && jobs[id].state !== 'removed'; })[0];
      if (exist) return;
      var j = {
        id: uid(), trackId: t.id, name: t.name, singer: t.singer,
        quality: quality || opts.quality, size: 0, progress: 0,
        state: 'waiting', path: '', blob: null, cancelled: false, error: '',
        mime: t.mime || '', ext: t.ext || '', filename: '', format: '',
        sourceLabel: t.sourceLabel || ''
      };
      jobs[j.id] = j; order.unshift(j.id); added++;
    });
    saveIndex(); emit(); pump();
    return added;
  }
  function pause(id) {
    var j = jobs[id]; if (!j) return;
    if (j.state === 'running') {
      if (j.nativeKey && hasNativeDownloader()) {
        // 原生任务：取消连接但保留 .part，Java 回调 '已暂停' 后统一收尾
        stopNative(j, false);
        j.state = 'paused'; j.speed = 0; j.eta = -1;
        saveIndex(); emit();
        return;
      }
      j.state = 'paused'; running--; pump();
    } else if (j.state === 'waiting') j.state = 'paused';
    saveIndex(); emit();
  }
  function resume(id) {
    var j = jobs[id]; if (!j || j.state !== 'paused') return;
    j.state = 'waiting'; j.cancelled = false; j.error = '';
    saveIndex(); emit(); pump();
  }
  function cancel(id) {
    var j = jobs[id]; if (!j) return;
    if (j.nativeKey && hasNativeDownloader()) stopNative(j, true);
    if (j.state === 'running') { j.cancelled = true; running = Math.max(0, running - 1); }
    j.state = 'cancelled'; j.progress = 0; j.speed = 0; j.eta = -1;
    saveIndex(); emit(); pump();
  }
  function retry(id) {
    var j = jobs[id]; if (!j) return;
    j.state = 'waiting'; j.progress = 0; j.cancelled = false; j.error = '';
    j.speed = 0; j.eta = -1;
    saveIndex(); emit(); pump();
  }
  function remove(id) {
    var j = jobs[id]; if (!j) return;
    if (j.nativeKey && hasNativeDownloader()) stopNative(j, true);
    if (j.state === 'running') { j.cancelled = true; running = Math.max(0, running - 1); }
    delete jobs[id]; order = order.filter(function (x) { return x !== id; });
    saveIndex(); emit(); pump();
  }
  function clearFinished() {
    order.filter(function (id) { return jobs[id].state === 'done'; }).forEach(function (id) {
      delete jobs[id];
    });
    order = order.filter(function (id) { return !!jobs[id]; });
    saveIndex(); emit();
  }
  function all() { return order.map(function (id) { return meta(jobs[id]); }); }
  function stats() {
    var r = { done: 0, running: 0, waiting: 0, paused: 0, error: 0, bytes: 0, speed: 0 };
    order.forEach(function (id) {
      var j = jobs[id];
      if (r[j.state] !== undefined) r[j.state]++;
      if (j.state === 'done') r.bytes += j.size || 0;
      if (j.state === 'running') r.speed += (j.speed || 0);
    });
    r.sizeText = fmtSize(r.bytes);
    r.speedText = r.speed > 0 ? fmtSize(r.speed) + '/s' : '';
    return r;
  }
  /* v3.2.0 迁移：清掉内置演示曲目（id 形如 kw_0…kw_47）留在队列与 IndexedDB 里的任务。
   * 用户自己音源产生的 api_* 曲目不受影响。 */
  function purgeDemo() {
    var targets = order.filter(function (id) {
      return jobs[id] && /^kw_\d+$/.test(String(jobs[id].trackId || ''));
    });
    if (!targets.length) { saveIndex(); return 0; }
    var removedTracks = {};
    targets.forEach(function (id) {
      var j = jobs[id];
      if (j.state === 'running') { j.cancelled = true; if (running > 0) running--; }
      removedTracks[j.trackId] = 1;
      delete jobs[id];
    });
    order = order.filter(function (id) { return !!jobs[id]; });
    Object.keys(removedTracks).forEach(function (trackId) {
      deleteBlob(trackId);
      if (playable[trackId]) {
        try { URL.revokeObjectURL(playable[trackId]); } catch (e) {}
        delete playable[trackId];
      }
    });
    saveIndex(); emit(); pump();
    return targets.length;
  }

  function onDeviceSaved(name, ok, path) {
    order.forEach(function (id) {
      var j = jobs[id];
      if (fileName(j) === name && j.state === 'done') { j.path = ok ? path : ''; }
    });
    saveIndex(); emit();
  }

  restore();
  window.LXDownload = {
    QUALITIES: QUALITIES, opts: opts, enqueue: enqueue, pause: pause, resume: resume,
    cancel: cancel, retry: retry, remove: remove, clearFinished: clearFinished,
    deliver: deliver,
    deliverById: function (id) {
      var j = jobs[id];
      if (j && j.blob) { deliver(j); return true; }
      return false;
    },
    onDeviceSaved: onDeviceSaved, all: all, stats: stats, purgeDemo: purgeDemo,
    dirOf: dirOf, dirLabel: dirLabel, DL_PRESETS: [
      ['Download/LX Music', '系统下载目录 · Download/LX Music（默认）'],
      ['Music/LX Music', '媒体库音乐目录 · Music/LX Music'],
      ['Download/Music/LX Music', '下载目录下的 Music 子目录'],
      ['Music/下载', '媒体库音乐目录 · 中文子目录']
    ],
    onDone: function (fn) { onDoneHook = fn; }, hasNativeDownloader: hasNativeDownloader,
    onChange: function (fn) { listeners.push(fn); },
    getPlayableUrl: function (trackId) { return playable[trackId] || null; },
    /* v3.13.0：原生下载的任务没有内存 Blob，只有落盘路径 —— 交回给调用方用原生 /__local 播放 */
    getSavedPath: function (trackId) {
      var id = order.filter(function (x) { return jobs[x].trackId === trackId; })[0];
      if (id == null) return null;
      var j = jobs[id];
      return (j && j.state === 'done' && j.path) ? j.path : null;
    },
    fileName: fileName, fmtSize: fmtSize, esc: esc, t: t,
    isDone: function (trackId) {
      return order.some(function (id) { return jobs[id].trackId === trackId && jobs[id].state === 'done'; });
    }
  };
})();
