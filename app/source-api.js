/* LX Music user-api v2.0.0 兼容层（对齐 APK assets/script/user-api-preload.js）
 * - 为导入的 JS 音源提供 globalThis.lx：EVENT_NAMES / request / on / send / utils
 * - lx.request 在 Android 外壳走 EchoBridge.httpRequest 原生 HTTP（不受跨域限制），
 *   在浏览器回退 fetch；两者都通过回调 (err, resp, body) 返回结果
 * - 脚本在受限作用域执行：屏蔽 window/document/localStorage/fetch/XMLHttpRequest 等宿主 API
 * - 扩展协议见 docs/自定义音源说明.md：action 除 musicUrl/lyric/pic 外，
 *   可选支持 search / songList / leaderboard / downloadUrl
 */
(function () {
  'use strict';

  var EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert'
  };
  // 扩展动作名：脚本可在 inited.sources[].actions 中声明
  var ACTIONS = {
    musicUrl: 'musicUrl', lyric: 'lyric', pic: 'pic',
    search: 'search', songList: 'songList', leaderboard: 'leaderboard',
    downloadUrl: 'downloadUrl'
  };
  var ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];
  var SUPPORT_QUALITYS = ['128k', '320k', 'flac', 'flac24bit'];

  // ---------------------------------------------------------------- HTTP 桥
  var httpSeq = 0, httpPending = {}, httpChunks = {};

  function toUtf8Bytes(str) {
    if (window.TextEncoder) return new Uint8Array(new TextEncoder().encode(str));
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }
  function bytesToUtf8(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (window.TextDecoder) return new TextDecoder('utf-8').decode(u);
    var s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return decodeURIComponent(escape(s));
  }
  function bytesToB64(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var s = atob(String(b64).replace(/\s/g, '')), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  /* Android 原生 HTTP 桥的回调入口（由 MainActivity.evaluateJavascript 调用） */
  window.LXHttp = {
    // 大响应（例如几 MB 的音频二进制）由 Java 侧分块回传，避免单次 JS 注入过大
    onChunkStart: function (key, total) { httpChunks[key] = new Array(total || 0); },
    onChunk: function (key, i, part) { if (httpChunks[key]) httpChunks[key][i] = part; },
    onResponse: function (key, error, statusCode, statusMessage, headersJson, body, isBinary) {
      var p = httpPending[key];
      if (!p) return;
      delete httpPending[key];
      var parts = httpChunks[key];
      delete httpChunks[key];
      var full = parts && parts.length ? parts.join('') : (body || '');
      if (p.timer) clearTimeout(p.timer);
      if (error) { p.cb(new Error(error), null, null); return; }
      var headers = {};
      try { headers = JSON.parse(headersJson || '{}'); } catch (e) {}
      var resp = {
        statusCode: statusCode,
        statusMessage: statusMessage,
        headers: headers,
        body: full,
        parts: parts && parts.length ? parts : null,
        __base64: !!isBinary
      };
      p.cb(null, resp, full);
    },
    onProgress: function () {},
    active: function () {
      return !!(window.EchoBridge && typeof window.EchoBridge.httpRequest === 'function');
    },
    pending: function () { return Object.keys(httpPending).length; }
  };

  function nativeRequest(url, options, callback) {
    var key = 'h' + (++httpSeq) + '_' + Date.now().toString(36);
    var B = window.EchoBridge;
    var p = { cb: callback, timer: null };
    httpPending[key] = p;
    var timeout = Math.min(Number(options.timeout) || 30000, 60000);
    p.timer = setTimeout(function () {
      if (!httpPending[key]) return;
      delete httpPending[key];
      if (B.cancelRequest) { try { B.cancelRequest(key); } catch (e) {} }
      callback(new Error('request timeout'), null, null);
    }, timeout + 3000);
    try {
      B.httpRequest(key, String(url), String(options.method || 'get').toUpperCase(),
        JSON.stringify(options.headers || {}), options.body == null ? '' : String(options.body),
        String(timeout), options.binary ? '1' : '0');
    } catch (e) {
      delete httpPending[key];
      clearTimeout(p.timer);
      callback(e, null, null);
    }
    return function () {
      if (!httpPending[key]) return;
      delete httpPending[key];
      clearTimeout(p.timer);
      if (B.cancelRequest) { try { B.cancelRequest(key); } catch (e2) {} }
    };
  }

  function browserRequest(url, options, callback) {
    var cancelled = false;
    var timeout = Math.min(Number(options.timeout) || 30000, 60000);
    var timer = setTimeout(function () { cancelled = true; callback(new Error('request timeout'), null, null); }, timeout);
    var opt = { method: String(options.method || 'get').toUpperCase(), headers: options.headers || {} };
    if (opt.method !== 'GET' && opt.method !== 'HEAD' && options.body != null) opt.body = options.body;
    fetch(url, opt).then(function (r) {
      if (cancelled) return;
      var headers = {};
      if (r.headers && r.headers.forEach) r.headers.forEach(function (v, k) { headers[k] = v; });
      return (options.binary ? r.arrayBuffer() : r.text()).then(function (body) {
        if (cancelled) return;
        clearTimeout(timer);
        var text = options.binary ? bytesToB64(new Uint8Array(body)) : String(body);
        var resp = { statusCode: r.status, statusMessage: r.statusText, headers: headers,
          body: text, __base64: !!options.binary };
        callback(null, resp, text);
      });
    }).catch(function (e) { if (!cancelled) { clearTimeout(timer); callback(e, null, null); } });
    return function () { cancelled = true; clearTimeout(timer); };
  }

  function httpRequest(url, options, callback) {
    options = options || {};
    if (window.LXHttp.active()) return nativeRequest(url, options, callback);
    if (typeof fetch === 'function') return browserRequest(url, options, callback);
    callback(new Error('当前环境不支持 HTTP 请求'), null, null);
    return function () {};
  }

  // ---------------------------------------------------------------- utils
  /* 紧凑 MD5（纯 JS，供音源签名使用；返回小写 hex） */
  function md5(str) {
    var s = unescape(encodeURIComponent(String(str))), len = s.length;
    var words = [], i;
    for (i = 0; i < len; i++) words[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    // 补齐到 64 字节（16 个 32-bit word）的整数倍，并写入位长度
    var nwords = (((len + 8) >> 6) + 1) * 16;
    words[nwords - 2] = len * 8;
    words[nwords - 1] = 0;
    for (i = 0; i < nwords; i++) if (words[i] === undefined) words[i] = 0;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = [];
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    function rot(x, n) { return (x << n) | (x >>> (32 - n)); }
    for (i = 0; i < words.length; i += 16) {
      var A = a, B = b, C = c, D = d, g, f, h;
      for (var j = 0; j < 64; j++) {
        if (j < 16) { f = (B & C) | (~B & D); g = j; }
        else if (j < 32) { f = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * j) % 16; }
        h = D; D = C; C = B;
        B = (B + rot((A + f + K[j] + words[i + g]) | 0, S[j])) | 0;
        A = h;
      }
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    var out = '';
    [a, b, c, d].forEach(function (x) {
      for (var k = 0; k < 4; k++) out += ('0' + ((x >>> (k * 8)) & 255).toString(16)).slice(-2);
    });
    return out;
  }

  var utils = {
    buffer: {
      from: function (input, encoding) {
        if (typeof input === 'string') {
          if (encoding === 'base64') return b64ToBytes(input);
          if (encoding === 'hex') {
            var m = input.match(/.{1,2}/g) || [], u = new Uint8Array(m.length);
            for (var i = 0; i < m.length; i++) u[i] = parseInt(m[i], 16);
            return u;
          }
          return toUtf8Bytes(input);
        }
        if (Array.isArray(input) || (input && input.buffer)) return new Uint8Array(input);
        throw new Error('Unsupported input type: ' + input);
      },
      bufToString: function (buf, format) {
        var u = new Uint8Array(buf);
        if (format === 'base64') return bytesToB64(u);
        if (format === 'hex') {
          var s = '';
          for (var i = 0; i < u.length; i++) s += ('0' + u[i].toString(16)).slice(-2);
          return s;
        }
        return bytesToUtf8(u);
      }
    },
    crypto: {
      randomBytes: function (size) {
        var u = new Uint8Array(Math.max(0, Math.min(size || 16, 65536)));
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(u);
        else for (var i = 0; i < u.length; i++) u[i] = Math.floor(Math.random() * 256);
        return u;
      },
      md5: md5,
      // 与原版移动版 zlib 一样未实现：明确报错而不是给出错误结果
      aesEncrypt: function () { throw new Error('aesEncrypt is not available in mobile env'); },
      rsaEncrypt: function () { throw new Error('rsaEncrypt is not available in mobile env'); }
    },
    zlib: {
      inflate: function () { return Promise.reject(new Error('zlib.inflate is not available in mobile env')); },
      deflate: function () { return Promise.reject(new Error('zlib.deflate is not available in mobile env')); }
    }
  };

  // ---------------------------------------------------------------- 脚本执行
  function compile(code, info, hooks) {
    var state = { inited: null, handler: null, updateAlertShown: false };
    var api = {
      EVENT_NAMES: EVENT_NAMES,
      ACTIONS: ACTIONS,
      ALL_SOURCES: ALL_SOURCES,
      SUPPORT_QUALITYS: SUPPORT_QUALITYS,
      version: '2.0.0',
      env: 'mobile',
      currentScriptInfo: info,
      utils: utils,
      request: function (url, options, callback) { return httpRequest(url, options, callback); },
      on: function (name, handler) {
        if (name !== EVENT_NAMES.request)
          return Promise.reject(new Error('The event is not supported: ' + name));
        state.handler = handler;
        return Promise.resolve();
      },
      send: function (name, data) {
        if (name === EVENT_NAMES.inited) {
          if (state.inited) return Promise.reject(new Error('Script is inited'));
          state.inited = data || {};
          return Promise.resolve();
        }
        if (name === EVENT_NAMES.updateAlert) {
          if (state.updateAlertShown) return Promise.reject(new Error('The update alert can only be called once.'));
          state.updateAlertShown = true;
          if (hooks && hooks.onUpdateAlert) hooks.onUpdateAlert(info, data || {});
          return Promise.resolve();
        }
        return Promise.reject(new Error('The event is not supported: ' + name));
      }
    };
    // 屏蔽宿主 API：脚本拿不到 DOM/存储/网络全局，只能用 lx 提供的能力
    var names = ['globalThis', 'window', 'self', 'top', 'parent', 'document', 'localStorage',
      'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket', 'navigator', 'location',
      'indexedDB', 'EchoBridge', 'LXApp', 'LXData', 'LXSources', 'LXDownload'];
    var fn = new Function(names.join(','), '"use strict";\n' + String(code));
    // 原版移动版允许 setTimeout / clearTimeout；把等价的最小宿主对象交给脚本
    var sandbox = {
      lx: api,
      setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
      Math: Math, JSON: JSON, Date: Date, Promise: Promise,
      Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, DataView: DataView,
      TextEncoder: window.TextEncoder, TextDecoder: window.TextDecoder,
      atob: atob, btoa: btoa, encodeURIComponent: encodeURIComponent,
      decodeURIComponent: decodeURIComponent, escape: escape, unescape: unescape
    };
    var args = names.map(function (n) {
      return n === 'globalThis' || n === 'self' ? sandbox : undefined;
    });
    fn.apply(null, args);
    return { api: api, state: state };
  }

  /* 向脚本注册的请求处理器发起一次调用（统一返回 Promise） */
  function invoke(runtime, source, action, info, timeout) {
    if (!runtime || !runtime.state.handler) return Promise.reject(new Error('Request event is not defined'));
    var p;
    try {
      p = runtime.state.handler.call(runtime.api, { source: source, action: action, info: info || {} });
    } catch (e) { return Promise.reject(e); }
    if (!p || typeof p.then !== 'function') p = Promise.resolve(p);
    var ms = timeout || 20000;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('音源响应超时（' + ms + 'ms）')); }
      }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  window.LXSourceAPI = {
    EVENT_NAMES: EVENT_NAMES,
    ACTIONS: ACTIONS,
    ALL_SOURCES: ALL_SOURCES,
    SUPPORT_QUALITYS: SUPPORT_QUALITYS,
    compile: compile,
    invoke: invoke,
    request: httpRequest,
    utils: utils,
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
    bytesToUtf8: bytesToUtf8
  };
})();
