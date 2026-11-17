/* 自定义音源管理中心（对齐 v1.9.2 的「自定义源管理（实验性）」）
 * - 导入 / 移除 / 启用 / 最多 20 个 / 状态与日志 / 持久化
 * - 完全兼容原版 user-api v2.0.0 脚本（musicUrl / lyric / pic）
 * - 扩展可选 action：search / songList / leaderboard / downloadUrl
 * - 搜索结果注入 LXData 外部曲目池，按来源格式提供在线播放与下载
 * 协议全文见 docs/自定义音源说明.md
 */
(function () {
  'use strict';

  var KEY = 'lx_user_apis_v2';
  var DEFAULT_KEY = 'lx_default_api_v1';   // 默认音源：搜索与切平台优先用它
  var defaultId = '';
  /* 最近一次媒体解析失败原因：音源抛出的原始 message（如「仅对认证用户开放」） */
  var mediaErrors = {};
  var API = window.LXSourceAPI;
  var MAX = 20;
  var list = [], runtimes = {}, logs = [], listeners = [];

  function uid() { return 'api_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function t(k, fb) { return (window.LXI18N && window.LXI18N[k]) || fb || k; }
  function log(msg) {
    logs.unshift(new Date().toLocaleTimeString('zh-CN') + ' ' + msg);
    logs = logs.slice(0, 80);
  }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.map(function (a) {
        return {
          id: a.id, name: a.name, description: a.description, version: a.version,
          author: a.author, homepage: a.homepage, script: a.script,
          enabled: a.enabled, allowUpdateAlert: a.allowUpdateAlert, builtin: !!a.builtin,
          origin: a.origin || ''
        };
      })));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 脚本头解析
  function parseHeader(text) {
    var src = String(text || '');
    var head = src.slice(0, 4096);
    function field(n) {
      var m = head.match(new RegExp('@' + n + '\\s+([^\\r\\n*]+)'));
      return m ? m[1].trim() : '';
    }
    var name = field('name');
    // 兼容 /* ... */ 块注释与 // 单行注释两种脚本头写法
    var hasComment = /\/\*/.test(head) || /^\s*\/\/\s*@name/m.test(head);
    if (!name || !hasComment || src.length < 20) return null;
    return {
      name: name.slice(0, 40),
      description: field('description').slice(0, 120),
      version: field('version').slice(0, 30),
      author: field('author').slice(0, 40),
      homepage: field('homepage').slice(0, 200),
      rawScript: src
    };
  }

  // ---------------------------------------------------------------- 运行时初始化
  function normalizeSources(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw.sources || raw).forEach(function (k) {
      var s = (raw.sources || raw)[k];
      if (!s || typeof s !== 'object') return;
      if (API.ALL_SOURCES.indexOf(k) < 0 && !/^[a-z0-9_-]{1,20}$/i.test(k)) return;
      out[k] = {
        name: String(s.name || k),
        type: String(s.type || 'music'),
        actions: (s.actions || []).slice(0, 12),
        qualitys: (s.qualitys || []).slice(0, 8)
      };
    });
    return out;
  }

  function initRuntime(a) {
    try {
      var info = {
        name: a.name, description: a.description, version: a.version,
        author: a.author, homepage: a.homepage, rawScript: a.script
      };
      var rt = API.compile(a.script, info, {
        onUpdateAlert: function (i, d) {
          if (!a.allowUpdateAlert) return;
          log('音源「' + i.name + '」发现新版本：' + String(d.log || '').slice(0, 120));
          if (window.LXApp && window.LXApp.toast)
            window.LXApp.toast(t('user_api_update_alert', '自定义源「{name}」发现新版本').replace('{name}', i.name));
        }
      });
      if (!rt.state.inited) throw new Error('脚本未发送 inited 事件');
      if (!rt.state.handler) throw new Error('脚本未注册 request 事件');
      runtimes[a.id] = rt;
      a.sources = normalizeSources(rt.state.inited);
      a.status = 'success';
      a.message = t('setting_basic_source_status_success', '初始化成功');
      log('初始化成功：' + a.name + '（' + Object.keys(a.sources).join(', ') + '）');
    } catch (e) {
      delete runtimes[a.id];
      a.sources = {};
      a.status = 'failed';
      a.message = String(e && e.message || e);
      log('初始化失败：' + a.name + ' — ' + a.message);
    }
  }

  /* 原版 user-api 里 musicUrl / lyric / pic 属「默认能力」：脚本未显式声明 actions 时也应视为支持。
   * 只有脚本自己声明了 actions，才按声明过滤（与 lx-music 的兼容口径一致）。
   * 之前只认 actions 声明，导致星海这类未声明 lyric 的音源被整条歌词链路跳过。 */
  var IMPLICIT_ACTIONS = ['musicUrl', 'lyric', 'pic'];
  function sourceHas(a, k, action) {
    var acts = (a.sources[k].actions || []);
    if (acts.length > 0) return acts.indexOf(action) >= 0;
    return IMPLICIT_ACTIONS.indexOf(action) >= 0;
  }
  function supports(a, action) {
    if (!a || a.status !== 'success') return false;
    return Object.keys(a.sources || {}).some(function (k) {
      return sourceHas(a, k, action);
    });
  }
  function sourceKeys(a, action) {
    var keys = [];
    Object.keys(a.sources || {}).forEach(function (k) {
      if (sourceHas(a, k, action)) keys.push(k);
    });
    return keys;
  }
  function active() {
    return list.filter(function (a) { return a.enabled && a.status === 'success'; });
  }
  function byId(id) { return list.filter(function (a) { return a.id === id; })[0] || null; }

  // ---------------------------------------------------------------- 导入 / 管理
  function importScript(text, origin) {
    var info = parseHeader(text);
    if (!info) {
      // 给出可操作的原因，避免用户遇到「点了导入没反应」却不知道文件哪里不合规
      var s = String(text || ''), head = s.slice(0, 4096);
      var why = !s.trim() ? '文件内容为空' :
        (!/\/\*/.test(head) && !/^\s*\/\/\s*@name/m.test(head)) ? '脚本缺少 /* ... */ 头部注释' :
        !/@name\s+\S/.test(head) ? '头部缺少 @name 字段（例：* @name 我的音源）' :
        s.length < 20 ? '脚本内容过短' : t('user_api_add_failed_tip', '无效的自定义源文件');
      return { ok: false, message: why };
    }
    // 同名音源视为「更新」：替换脚本并重新初始化，避免重复导入留下多份副本
    var dup = list.filter(function (x) { return x.name === info.name; })[0];
    if (dup) {
      dup.script = String(text);
      dup.description = info.description;
      dup.version = info.version;
      dup.author = info.author;
      dup.homepage = info.homepage;
      dup.origin = origin || dup.origin;
      delete runtimes[dup.id];
      initRuntime(dup);
      persist(); emit();
      log('更新音源：' + dup.name);
      if (dup.status === 'failed') {
        return { ok: false, api: dup, updated: true,
          message: t('user_api_import_failed_tip', '自定义源导入失败：\n{message}').replace('{message}', dup.message) };
      }
      return { ok: true, api: dup, updated: true, message: t('user_api_import_success_tip', '导入成功 🎉') };
    }
    if (list.length >= MAX) return { ok: false, message: t('user_api_max_tip', '最多只能同时存在 20 个源哦🤪') };
    var a = {
      id: uid(), name: info.name, description: info.description, version: info.version,
      author: info.author, homepage: info.homepage, script: String(text),
      enabled: true, allowUpdateAlert: true, builtin: false, origin: origin || 'local',
      status: 'initing', message: t('setting_basic_source_status_initing', '初始化中'), sources: {}
    };
    initRuntime(a);
    list.push(a);
    persist(); emit();
    log('导入音源：' + a.name + '（' + a.origin + '）');
    if (a.status === 'failed') return { ok: false, message: t('user_api_import_failed_tip', '自定义源导入失败：\n{message}').replace('{message}', a.message), api: a };
    return { ok: true, message: t('user_api_import_success_tip', '导入成功 🎉'), api: a };
  }
  function remove(id) {
    var a = byId(id); if (!a) return;
    list = list.filter(function (x) { return x.id !== id; });
    delete runtimes[id];
    if (defaultId === id) { defaultId = ''; try { localStorage.removeItem(DEFAULT_KEY); } catch (e) {} }
    persist(); emit();
    log('移除音源：' + a.name);
  }
  function setEnabled(id, on) {
    var a = byId(id); if (!a) return;
    a.enabled = !!on;
    if (a.enabled && !runtimes[id]) initRuntime(a);
    persist(); emit();
  }
  function setAllowUpdateAlert(id, on) {
    var a = byId(id); if (!a) return;
    a.allowUpdateAlert = !!on; persist(); emit();
  }
  function importOnline(url, cb) {
    var ok = /^https?:\/\//i.test(String(url || '').trim());
    if (!ok) { cb({ ok: false, message: t('user_api_btn_import_online_input_tip', '请输入 HTTP 链接') }); return; }
    API.request(String(url).trim(), { method: 'get', timeout: 20000 }, function (err, resp, body) {
      if (err) { cb({ ok: false, message: t('user_api_import_failed_tip', '自定义源导入失败：\n{message}').replace('{message}', err.message) }); return; }
      var text = resp && resp.__base64 ? API.bytesToUtf8(API.b64ToBytes(body)) : String(body || '');
      cb(importScript(text, 'online:' + url));
    });
  }

  // ---------------------------------------------------------------- 曲目规范化
  function mimeOf(ext, fallback) {
    var e = String(ext || '').toLowerCase().replace(/^\./, '');
    var map = {
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
      wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
      wma: 'audio/x-ms-wma', ape: 'audio/x-ape', mp4: 'audio/mp4',
      'flac24bit': 'audio/flac', '128k': 'audio/mpeg', '320k': 'audio/mpeg'
    };
    return map[e] || fallback || 'audio/mpeg';
  }
  function extOf(v) {
    var e = String(v || '').toLowerCase().replace(/^\./, '');
    if (e === 'flac24bit') return 'flac';
    if (e === '128k' || e === '320k') return 'mp3';
    return e || '';
  }
  function normalizeTrack(raw, a, sourceKey) {
    if (!raw || typeof raw !== 'object') return null;
    var mid = String(raw.songmid || raw.id || raw.musicId || '').trim();
    if (!mid) return null;
    var name = String(raw.name || raw.title || raw.songName || mid);
    var singer = String(raw.singer || raw.artist || raw.artists && raw.artists.map(function (x) { return x.name || x; }).join(' / ') || '未知歌手');
    var album = String(raw.album || raw.albumName || '');
    var dur = Number(raw.duration || raw.interval && Math.round(raw.interval) || 0);
    if (dur > 3600) dur = Math.round(dur / 1000);
    if (!dur || dur < 1) dur = 210;
    var mm = Math.floor(dur / 60), ss = dur % 60;
    var q = (raw.qualitys || raw.formats || []).map(function (f) { return typeof f === 'string' ? f : (f.type || f.ext); }).filter(Boolean);
    if (!q.length) q = sourceKeys(a, 'musicUrl').length ? ['128k', '320k', 'flac'] : ['128k'];
    var ext = extOf(raw.ext || raw.format || raw.type || '');
    return {
      id: 'api_' + a.id + '_' + mid,
      songmid: mid, name: name, singer: singer, album: album,
      source: 'api:' + a.id, sourceLabel: a.name, apiId: a.id, apiSource: sourceKey,
      duration: dur, time: ('0' + mm).slice(-2) + ':' + ('0' + ss).slice(-2),
      qualitys: q, ext: ext, mime: mimeOf(ext),
      pic: raw.pic || raw.cover || '', _raw: raw, _external: true
    };
  }
  function rawMusicInfo(track) {
    var base = (track && track._raw) ? track._raw : {
      songmid: track && track.songmid, name: track && track.name,
      singer: track && track.singer, album: track && track.album
    };
    /* 音源脚本几乎都按 musicInfo.source 选平台接口；缺这个字段时星海等脚本会直接返回 null，
     * 表现就是「歌词加载几秒后显示没有」。这里统一补齐常用别名。 */
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    if (!out.source) out.source = (track && (track.apiSource || track.platform || track.source)) || '';
    if (!out.songmid && track && track.songmid) out.songmid = track.songmid;
    if (!out.musicId && track && track.songmid) out.musicId = track.songmid;
    if (!out.albumName && track && track.album) out.albumName = track.album;
    if (!out.interval && track && track.duration) out.interval = String(track.duration);
    if (!out.rid && track && track.songmid) out.rid = track.songmid;
    if (!out.hash && track && track._raw && track._raw.hash) out.hash = track._raw.hash;
    return out;
  }

  // ---------------------------------------------------------------- 搜索
  function search(keyword, opts) {
    opts = opts || {};
    var q = String(keyword || '').trim();
    var targets = active().filter(function (a) { return supports(a, 'search'); });
    if (opts.apiId) targets = targets.filter(function (a) { return a.id === opts.apiId; });
    if (!targets.length) return Promise.resolve({ tracks: [], errors: [], called: 0 });
    var out = [], errors = [], called = 0;
    return Promise.all(targets.map(function (a) {
      return Promise.all(sourceKeys(a, 'search').map(function (sk) {
        called++;
        return API.invoke(runtimes[a.id], sk, 'search', {
          keyword: q, page: opts.page || 1, limit: opts.limit || 30, source: sk,
          type: opts.type || 'music'
        }, 25000).then(function (res) {
          var arr = Array.isArray(res) ? res : (res && (res.list || res.tracks || res.result)) || [];
          if (!Array.isArray(arr)) arr = [];
          arr.forEach(function (raw) {
            var tr = normalizeTrack(raw, a, sk);
            if (tr) out.push(tr);
          });
          log('搜索「' + q + '」@' + a.name + ' → ' + arr.length + ' 首');
        }).catch(function (e) {
          errors.push(a.name + '：' + String(e && e.message || e));
          log('搜索失败 @' + a.name + ' — ' + String(e && e.message || e));
        });
      }));
    })).then(function () {
      var seen = {};
      out = out.filter(function (x) { if (seen[x.id]) return false; seen[x.id] = 1; return true; });
      if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(out);
      return { tracks: out, errors: errors, called: called };
    });
  }

  function songList(id, opts) {
    var targets = active().filter(function (a) { return supports(a, 'songList'); });
    var out = [];
    return Promise.all(targets.map(function (a) {
      return Promise.all(sourceKeys(a, 'songList').map(function (sk) {
        return API.invoke(runtimes[a.id], sk, 'songList', { id: id, source: sk, page: 1 }, 25000)
          .then(function (res) {
            var arr = Array.isArray(res) ? res : (res && (res.list || res.tracks)) || [];
            arr.forEach(function (raw) { var tr = normalizeTrack(raw, a, sk); if (tr) out.push(tr); });
          }).catch(function () {});
      }));
    })).then(function () {
      if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(out);
      return out;
    });
  }

  /* 排行榜（扩展动作 leaderboard）：原版排行榜由内置 SDK 提供，移动版自定义源协议里没有，
   * 本版作为可选扩展，脚本返回 { list: [...] } 或数组即可；boardId 由脚本自行解释。 */
  function leaderboard(boardId, opts) {
    opts = opts || {};
    var targets = active().filter(function (a) { return supports(a, 'leaderboard'); });
    if (opts.apiId) targets = targets.filter(function (a) { return a.id === opts.apiId; });
    if (!targets.length) return Promise.resolve({ tracks: [], errors: [], called: 0 });
    var out = [], errors = [], called = 0;
    return Promise.all(targets.map(function (a) {
      return Promise.all(sourceKeys(a, 'leaderboard').map(function (sk) {
        called++;
        return API.invoke(runtimes[a.id], sk, 'leaderboard', {
          id: boardId, boardId: boardId, source: sk,
          page: opts.page || 1, limit: opts.limit || 30
        }, 25000).then(function (res) {
          var arr = Array.isArray(res) ? res : (res && (res.list || res.tracks || res.result)) || [];
          if (!Array.isArray(arr)) arr = [];
          arr.forEach(function (raw) { var tr = normalizeTrack(raw, a, sk); if (tr) out.push(tr); });
          log('排行榜 ' + boardId + ' @' + a.name + ' → ' + arr.length + ' 首');
        }).catch(function (e) {
          errors.push(a.name + '：' + String(e && e.message || e));
          log('排行榜加载失败 @' + a.name + ' — ' + String(e && e.message || e));
        });
      }));
    })).then(function () {
      var seen = {};
      out = out.filter(function (x) { if (seen[x.id]) return false; seen[x.id] = 1; return true; });
      if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(out);
      return { tracks: out, errors: errors, called: called };
    });
  }

  // ---------------------------------------------------------------- 媒体地址 / 下载数据
  function normalizeMedia(res, track, quality) {
    var r = res;
    if (typeof r === 'string') r = { url: r };
    if (!r || typeof r !== 'object') return null;
    var url = r.url || r.href || r.link || '';
    var data = r.data || r.base64 || '';
    if (!url && !data) return null;
    var ext = extOf(r.ext || r.format || r.type || track.ext);
    if (!ext && /^data:audio\/([a-z0-9]+)/i.test(String(url))) ext = extOf(RegExp.$1);
    if (!ext && url) {
      var m = String(url).split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = extOf(m[1]);
    }
    if (!ext) ext = 'mp3';
    var mime = r.mime || mimeOf(ext, track.mime);
    var filename = r.filename || (track.name + ' - ' + track.singer + '.' + ext);
    return {
      url: String(url), data: String(data), mime: mime, ext: ext,
      filename: String(filename).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 110),
      quality: quality, headers: r.headers || null,
      // 部分音源在取链响应里顺带返回歌词/封面，留着可省一次请求
      lyric: r.lyric || r.lrc || r.tlyric_lyric || '',
      cover: r.cover || r.pic || r.picUrl || ''
    };
  }

  /* 平台曲目没有 apiId：用「该平台绑定的音源」解析播放/下载地址。
   * 这就是原版的账号语义——平台负责搜索，音源负责验证并提供 URL。 */
  function trackSource(track) {
    if (!track) return null;
    if (track.apiId) return byId(track.apiId);
    if (track.platform) {
      var pid = forPlatform(track.platform);
      if (pid) return byId(pid);
    }
    return null;
  }
  /* 同一平台可能有多个音源（账号）。默认音源优先，取不到地址时依次尝试其它
   * 声明了该平台的音源 —— 一个账号失效（限流、人机验证、卡密过期）不该让整首歌没法播。 */
  function sourceChain(track) {
    if (!track) return [];
    var out = [], seen = {};
    function push(a) {
      if (!a || !a.enabled || seen[a.id] || !runtimes[a.id]) return;
      seen[a.id] = 1;
      out.push(a);
    }
    if (track.apiId) { push(byId(track.apiId)); return out; }
    push(byId(defaultId));
    platformProviders(track.platform).forEach(push);
    return out;
  }

  function resolveMedia(track, quality, kind) {
    if (!track) return Promise.resolve(null);
    var chain = sourceChain(track);
    if (!chain.length) return Promise.resolve(null);
    var q = quality || (track.qualitys && track.qualitys[0]) || '128k';
    var i = 0;
    function attempt() {
      if (i >= chain.length) return null;
      var a = chain[i++];
      var action = kind === 'download' && supports(a, 'downloadUrl') ? 'downloadUrl' : 'musicUrl';
      if (!supports(a, action)) {
        if (kind === 'download' && supports(a, 'musicUrl')) action = 'musicUrl';
        else return attempt();
      }
      var sk = track.apiSource ||
        (track.platform && a.sources && a.sources[track.platform] ? track.platform : sourceKeys(a, action)[0]);
      return API.invoke(runtimes[a.id], sk, action, {
        type: q, quality: q, musicInfo: rawMusicInfo(track), kind: kind
      }, 30000).then(function (res) {
        var m = normalizeMedia(res, track, q);
        if (m) {
          delete mediaErrors[track.id];
          log('解析 ' + action + '：' + track.name + '（' + m.mime + ' / .' + m.ext + '）');
          return m;
        }
        mediaErrors[track.id] = '音源没有返回播放地址';
        return attempt();
      }).catch(function (e) {
        var msg = String(e && e.message || e);
        mediaErrors[track.id] = msg;
        log('解析 ' + action + '失败：' + track.name + ' — ' + msg);
        return attempt();
      });
    }
    return Promise.resolve(attempt());
  }

  function mediaToBlob(m) {
    if (!m) return Promise.resolve(null);
    if (m.data) {
      var bytes;
      if (/^data:[^,]*;base64,/i.test(m.data)) bytes = API.b64ToBytes(m.data.replace(/^data:[^,]*,/i, ''));
      else if (/^data:/i.test(m.data)) bytes = API.b64ToBytes(m.data);
      else bytes = API.b64ToBytes(m.data);
      return Promise.resolve(new Blob([bytes], { type: m.mime }));
    }
    if (/^data:[^,]*;base64,/i.test(m.url)) {
      var b2 = API.b64ToBytes(m.url.replace(/^data:[^,]*,/i, ''));
      return Promise.resolve(new Blob([b2], { type: m.mime }));
    }
    if (/^blob:/i.test(m.url)) {
      return new Promise(function (resolve) {
        var x = new XMLHttpRequest();
        x.open('GET', m.url, true); x.responseType = 'blob';
        x.onload = function () { resolve(x.response || null); };
        x.onerror = function () { resolve(null); };
        x.send();
      });
    }
    return new Promise(function (resolve) {
      API.request(m.url, { method: 'get', binary: true, timeout: 60000, headers: m.headers || {} },
        function (err, resp, body) {
          if (err || !body) { log('HTTP 下载失败：' + String(err && err.message || 'empty body')); resolve(null); return; }
          try {
            var bytes = resp && resp.__base64 ? API.b64ToBytes(body) : new Uint8Array(body);
            resolve(new Blob([bytes], { type: m.mime }));
          } catch (e) { resolve(null); }
        });
    });
  }

  function fetchDownload(track, quality) {
    return resolveMedia(track, quality, 'download').then(function (m) {
      if (!m) return null;
      return mediaToBlob(m).then(function (blob) {
        if (!blob || !blob.size) return null;
        return { blob: blob, mime: m.mime, ext: m.ext, filename: m.filename, quality: m.quality };
      });
    }).catch(function () { return null; });
  }

  function playableUrl(track, quality) {
    return resolveMedia(track, quality, 'play').then(function (m) {
      if (!m) return null;
      if (m.url) return { url: m.url, mime: m.mime, media: m };
      if (m.data) {
        var u = /^data:/i.test(m.data) ? m.data : 'data:' + m.mime + ';base64,' + m.data;
        return { url: u, mime: m.mime, media: m };
      }
      return null;
    });
  }

  /* 歌词：平台曲目同样支持（按 track.platform 找绑定音源）。
   * 注意有些音源（如星海音乐源）只在取过一次播放地址后才有歌词缓存，
   * 因此第一次拿不到时会补一次 musicUrl 解析再问，并缓存结果。 */
  var lyricCache = {};
  var lyricPending = {};      // 进行中的歌词请求，避免切歌/重复开关时并发重复打链
  var lyricDiag = [];          // 歌词链路诊断：哪个音源、成功与否、条数/原因（真机排查用）

  function diagLyric(src, ok, detail) {
    lyricDiag.push({ src: src, ok: !!ok, detail: String(detail || '').slice(0, 120) });
    lyricDiag = lyricDiag.slice(-12);
    if (window.LXdlog) window.LXdlog('lyric', src + ' => ' + (ok ? 'ok ' + detail : 'fail ' + detail));
  }

  function normalizeLyric(res) {
    if (!res) return null;
    if (typeof res === 'string') return res.trim() ? { lyric: res, tlyric: '' } : null;
    var text = res.lyric || res.lrc || res.text || '';
    if (!text) return null;
    return { lyric: String(text), tlyric: String(res.tlyric || res.translation || '') };
  }

  function askLyric(a, track) {
    var sk = track.apiSource ||
      (track.platform && a.sources && a.sources[track.platform] ? track.platform : sourceKeys(a, 'lyric')[0]);
    return API.invoke(runtimes[a.id], sk, 'lyric',
      { musicInfo: rawMusicInfo(track) }, 15000).then(function (res) {
        var one = normalizeLyric(res);
        diagLyric(a.name + '/' + sk, !!one, one ? one.lyric.length + ' 字' : '返回空（' + JSON.stringify(res).slice(0, 80) + '）');
        return one;
      }).catch(function (e) {
        diagLyric(a.name + '/' + sk, false, (e && e.message) || e);
        return null;
      });
  }

  function doLyric(track) {
    // 默认音源不一定实现 lyric：按「默认优先」的顺序找第一个声明了 lyric 的音源
    var chain = sourceChain(track).filter(function (a) { return supports(a, 'lyric'); });
    if (!chain.length) return platformLyric(track);
    var i = 0;
    function next() {
      if (i >= chain.length) return platformLyric(track);
      var a = chain[i++];
      return askLyric(a, track).then(function (r) {
        if (r && r.lyric) { lyricCache[track.id] = r; return r; }
        // 没缓存 → 先取一次地址（音源会顺带把歌词放进 extraCache）
        return resolveMedia(track, '128k', 'musicUrl').then(function (m) {
          if (m && m.lyric) {
            var one = { lyric: String(m.lyric), tlyric: '' };
            lyricCache[track.id] = one;
            return one;
          }
          return askLyric(a, track).then(function (r2) {
            if (r2 && r2.lyric) { lyricCache[track.id] = r2; return r2; }
            return next();
          });
        });
      }).catch(function () { return next(); });
    }
    return next();
  }

  function lyric(track) {
    if (!track) return Promise.resolve(null);
    if (lyricCache[track.id]) return Promise.resolve(lyricCache[track.id]);
    if (lyricPending[track.id]) return lyricPending[track.id];
    var p = doLyric(track).then(function (r) {
      delete lyricPending[track.id];
      if (r && r.lyric) lyricCache[track.id] = r;
      return r && r.lyric ? r : null;
    }, function () {
      delete lyricPending[track.id];
      return null;
    });
    lyricPending[track.id] = p;
    return p;
  }

  function platformLyric(track) {
    var plat = track.platform || String(track.id || '').split('_')[0];
    var mid = track.songmid || String(track.id || '').replace(/^[a-z]+_/, '');
    var LP = window.LXPlatform;
    if (!mid || !LP || typeof LP.httpJson !== 'function') return Promise.resolve(null);
    if (plat === 'wy') {
      return LP.httpJson('https://music.163.com/api/song/lyric?id=' + encodeURIComponent(mid) + '&lv=-1&kv=-1&tv=-1',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10)', Referer: 'https://music.163.com/' } })
        .then(function (d) {
          var l = d && d.lrc && d.lrc.lyric;
          diagLyric('平台内置/wy', !!l, l ? l.length + ' 字' : '返回空');
          if (!l) return null;
          return { lyric: String(l), tlyric: String(d.tlyric && d.tlyric.lyric || '') };
        }).catch(function (e) { diagLyric('平台内置/wy', false, (e && e.message) || e); return null; });
    }
    if (plat === 'kw') {
      var kwMid = (track._raw && track._raw.rid) || mid;
      /* newlyric.lrc 已被限制；走移动端 songinfoandlrc，lrclist 是 [{time,lineLyric}]。
       * 该接口偶发反爬返回空 / 非 JSON，空结果时延迟一次重试。 */
      function kwFetch() {
        return LP.httpJson('https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=' + encodeURIComponent(kwMid),
          { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10)', Referer: 'https://m.kuwo.cn/' } })
          .then(function (d) {
            var list = d && (d.lrclist || (d.data && d.data.lrclist));
            if (!list || !list.length) throw new Error('返回空');
            return list.map(function (x) {
              var t = Number(x.time) || 0;
              var mm = String(Math.floor(t / 60)).padStart(2, '0');
              var ss = (t % 60).toFixed(2).padStart(5, '0');
              return '[' + mm + ':' + ss + ']' + (x.lineLyric || '');
            }).join('\n');
          });
      }
      return kwFetch().catch(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(kwFetch);
      }).then(function (lrc) {
        diagLyric('平台内置/kw', true, lrc.length + ' 字');
        return { lyric: lrc, tlyric: '' };
      }).catch(function (e) { diagLyric('平台内置/kw', false, (e && e.message) || e); return null; });
    }
    if (plat === 'mg') {
      return LP.http('https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId=' + encodeURIComponent(mid),
        { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10)', Referer: 'https://music.migu.cn/' } })
        .then(function (r) {
          var raw = (r && r.body) || '';
          var l = '';
          if (/^\s*[\[{]/.test(raw)) {
            try {
              var d = JSON.parse(raw);
              l = d && (d.lyric || (d.data && d.data.lyric)) || '';
            } catch (e) { l = ''; }
          }
          if (!l && /\[[0-9]+:/.test(raw)) l = raw;   // 部分源直接回 LRC 文本
          diagLyric('平台内置/mg', !!l, l ? l.length + ' 字' : '返回空');
          return l ? { lyric: String(l), tlyric: '' } : null;
        }).catch(function (e) { diagLyric('平台内置/mg', false, (e && e.message) || e); return null; });
    }
    if (plat === 'kg') {
      diagLyric('平台内置/kg', false, '暂未实现 krc 解密');
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  }

  // ---------------------------------------------------------------- 内置示例音源
  var BUILTIN = [
    '/**',
    ' * @name 示例音源 · 本地曲库',
    ' * @description 离线演示：JS 搜索 / 在线试听 / 按 WAV 格式下载',
    ' * @version 1.0.0',
    ' * @author LX Music 复现版',
    ' * @homepage https://lxmusic.toside.cn/mobile/custom-source',
    ' */',
    'const { EVENT_NAMES, on, send, utils } = globalThis.lx',
    'const library = [',
    '  { songmid: "demo-01", name: "夜落之前", singer: "青屿乐团", album: "海边的第七封信", duration: 118 },',
    '  { songmid: "demo-02", name: "把夜色折好", singer: "北岸电台", album: "慢速城市", duration: 128 },',
    '  { songmid: "demo-03", name: "雨停之后", singer: "林间信号", album: "潮湿的晴天", duration: 96 },',
    '  { songmid: "demo-04", name: "北纬三十度", singer: "青屿乐团", album: "远行记", duration: 142 },',
    '  { songmid: "demo-05", name: "给未来的便签", singer: "小白鲸", album: "抽屉里的海", duration: 105 },',
    '  { songmid: "demo-06", name: "凌晨三点的站台", singer: "北岸电台", album: "慢速城市", duration: 132 }',
    ']',
    'const cache = {}',
    'function wav(seed) {',
    '  if (cache[seed]) return cache[seed]',
    '  const sr = 6000, sec = 8, n = sr * sec, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)',
    '  function str(o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }',
    '  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE")',
    '  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true)',
    '  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true)',
    '  v.setUint16(32, 2, true); v.setUint16(34, 16, true)',
    '  str(36, "data"); v.setUint32(40, n * 2, true)',
    '  let h = 0; for (let i = 0; i < seed.length; i++) h += seed.charCodeAt(i)',
    '  const base = 196 + (h % 9) * 22',
    '  for (let k = 0; k < n; k++) {',
    '    const t = k / sr',
    '    const s = Math.sin(2 * Math.PI * base * t) * 0.36 + Math.sin(2 * Math.PI * base * 1.5 * t) * 0.16',
    '    const env = Math.min(1, t / 0.6) * Math.min(1, (sec - t) / 0.8)',
    '    v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, s * env * 0.6)) * 32767, true)',
    '  }',
    '  const b64 = utils.buffer.bufToString(new Uint8Array(buf), "base64")',
    '  cache[seed] = "data:audio/wav;base64," + b64',
    '  return cache[seed]',
    '}',
    'function song(mid) { return library.find(x => x.songmid === mid) || library[0] }',
    'on(EVENT_NAMES.request, ({ source, action, info }) => {',
    '  switch (action) {',
    '    case "search": {',
    '      const kw = String(info.keyword || "").toLowerCase()',
    '      const list = library.filter(x => !kw || (x.name + x.singer + x.album).toLowerCase().includes(kw))',
    '      return Promise.resolve(list.map(x => Object.assign({}, x, {',
    '        source, qualitys: ["128k", "320k", "flac"], ext: "wav", mime: "audio/wav" })))',
    '    }',
    '    case "musicUrl": return Promise.resolve(wav(info.musicInfo.songmid))',
    '    case "downloadUrl": {',
    '      const x = song(info.musicInfo.songmid)',
    '      return Promise.resolve({',
    '        data: wav(x.songmid), mime: "audio/wav", ext: "wav",',
    '        filename: x.name + " - " + x.singer + ".wav",',
    '        qualitys: ["128k", "320k", "flac"]',
    '      })',
    '    }',
    '    case "lyric": return Promise.resolve({ lyric: "[00:00]示例音源 · 本地演示歌词\\n[00:12]音源脚本由 JS 提供\\n[00:24]可在线试听与按格式下载" })',
    '    case "pic": return Promise.resolve("")',
    '    default: return Promise.reject(new Error("unsupported action: " + action))',
    '  }',
    '})',
    'send(EVENT_NAMES.inited, {',
    '  sources: {',
    '    local: {',
    '      name: "示例本地曲库", type: "music",',
    '      actions: ["musicUrl", "lyric", "pic", "search", "downloadUrl"],',
    '      qualitys: ["128k", "320k", "flac", "flac24bit"]',
    '    }',
    '  }',
    '})'
  ].join('\n');

  /* 在线接口模板：用户可把 URL 换成自己的服务，展示 lx.request 的真实用法 */
  var HTTP_TEMPLATE = [
    '/**',
    ' * @name 我的在线音源',
    ' * @description 通过 lx.request 调用自己的 HTTP 接口',
    ' * @version 1.0.0',
    ' * @author me',
    ' * @homepage https://example.com',
    ' */',
    'const { EVENT_NAMES, request, on, send } = globalThis.lx',
    'const BASE = "https://example.com/api"',
    'function get(path) {',
    '  return new Promise((resolve, reject) => {',
    '    request(BASE + path, { method: "get", timeout: 15000 }, (err, resp, body) => {',
    '      if (err) return reject(err)',
    '      try { resolve(JSON.parse(body)) } catch (e) { reject(e) }',
    '    })',
    '  })',
    '}',
    'on(EVENT_NAMES.request, ({ source, action, info }) => {',
    '  switch (action) {',
    '    case "search":',
    '      return get("/search?kw=" + encodeURIComponent(info.keyword))',
    '        .then(r => r.list.map(x => ({ songmid: x.id, name: x.name, singer: x.artist,',
    '          album: x.album, duration: x.duration, ext: x.ext || "mp3",',
    '          qualitys: ["128k", "320k"], source })))',
    '    case "musicUrl":',
    '      return get("/url?id=" + info.musicInfo.songmid + "&quality=" + info.type).then(r => r.url)',
    '    case "downloadUrl":',
    '      return get("/url?id=" + info.musicInfo.songmid + "&quality=" + info.type)',
    '        .then(r => ({ url: r.url, mime: r.mime || "audio/mpeg", ext: r.ext || "mp3",',
    '          filename: info.musicInfo.name + " - " + info.musicInfo.singer + ".mp3" }))',
    '    case "lyric": return get("/lyric?id=" + info.musicInfo.songmid)',
    '    default: return Promise.reject(new Error("unsupported action"))',
    '  }',
    '})',
    'send(EVENT_NAMES.inited, {',
    '  sources: {',
    '    kw: { name: "我的音源", type: "music",',
    '      actions: ["musicUrl", "search", "downloadUrl", "lyric"],',
    '      qualitys: ["128k", "320k"] }',
    '  }',
    '})'
  ].join('\n');

  /* 原版语义：音源脚本在 send(inited, { sources: { kw: ..., kg: ... } }) 里声明
   * 自己能服务哪些平台。这里按 key 自动匹配；「默认音源」只是优先级，不是逐平台绑定。 */
  function platformProviders(platformId) {
    return list.filter(function (a) {
      return a.enabled && a.status === 'success' && a.sources && a.sources[platformId];
    });
  }
  /* 平台用哪个音源解析地址：
   * 1) 用户设了「默认音源」，且它声明了该平台 → 用默认音源；
   * 2) 否则取第一个声明该平台的已启用音源。
   * 不再有「每个平台单独绑定」，一个默认音源即可覆盖它声明支持的所有平台。 */
  function forPlatform(platformId) {
    var d = byId(defaultId);
    if (d && d.enabled && d.status === 'success' && d.sources && d.sources[platformId]) return d.id;
    var ps = platformProviders(platformId);
    return ps.length ? ps[0].id : '';
  }
  function verifyPlatform(platformId) {
    var id = forPlatform(platformId);
    if (!id) {
      var any = list.filter(function (a) { return a.enabled; });
      return {
        ok: false, status: 'none', api: null,
        message: any.length
          ? '已导入的音源都没有声明支持该平台（脚本 sources 里缺少 “' + platformId + '”）'
          : '还没有导入音源'
      };
    }
    var a = byId(id);
    var v = verify(id);
    return { ok: v.ok, status: v.status, api: a, message: v.message };
  }

  // ---------------------------------------------------------------- 默认音源
  /* 全局只有一个「默认音源」：搜索、切平台、解析播放/下载地址都优先用它。
   * 它声明了哪些平台，就自动服务哪些平台（脚本 sources 的 key）。 */
  function setDefault(id) {
    if (id) {
      var a = byId(id);
      if (!a) return { ok: false, message: '音源不存在' };
      if (!a.enabled) return { ok: false, message: '请先启用该音源' };
      if (a.status !== 'success') return { ok: false, message: '音源初始化失败：' + (a.message || a.status) };
    }
    defaultId = id || '';
    try { localStorage.setItem(DEFAULT_KEY, defaultId); } catch (e) {}
    log(defaultId ? '默认音源 → ' + byId(defaultId).name : '已取消默认音源');
    emit();
    return { ok: true, message: defaultId ? '已设为默认音源' : '已取消默认音源' };
  }
  function defaultApi() { return byId(defaultId); }
  function isDefault(id) { return !!id && id === defaultId; }
  function loadDefault() {
    try { defaultId = localStorage.getItem(DEFAULT_KEY) || ''; } catch (e) { defaultId = ''; }
    // 音源被删掉时清空默认值
    if (defaultId && !byId(defaultId)) { defaultId = ''; try { localStorage.removeItem(DEFAULT_KEY); } catch (e) {} }
  }

  /* 从原始地址重新拉取脚本（音源卡片的「更新」）。
   * 只有在线导入的源有可更新的地址；本地文件源需要重新导入文件。 */
  function refresh(id) {
    var a = byId(id);
    if (!a) return Promise.resolve({ ok: false, message: '音源不存在' });
    var origin = String(a.origin || '');
    var m = origin.match(/^online:(.+)$/);
    var url = m ? m[1] : (/^https?:\/\//i.test(origin) ? origin : '');
    if (!url) return Promise.resolve({ ok: false, message: '该音源来自本地文件，请重新导入文件来更新' });
    var oldVersion = a.version || '';
    return new Promise(function (resolve) {
      API.request(url, { method: 'get', timeout: 20000 }, function (err, resp, body) {
        if (err) { resolve({ ok: false, message: '更新失败：' + String(err.message || err) }); return; }
        var text = resp && resp.__base64
          ? API.bytesToUtf8(API.b64ToBytes(body)) : String(body || '');
        if (!text.trim()) { resolve({ ok: false, message: '更新失败：脚本内容为空' }); return; }
        var r = importScript(text, 'online:' + url);
        if (r.ok && r.api) {
          r.api.origin = 'online:' + url;
          persist();
          var nv = r.api.version || '';
          r.message = (oldVersion && nv && oldVersion !== nv)
            ? '已更新：' + oldVersion + ' → ' + nv
            : '已重新加载脚本（版本 ' + (nv || '—') + '）';
        }
        resolve(r);
      });
    });
  }

  /* 验证状态：脚本是否合规可用（初始化成功 + 声明了 musicUrl） */
  function verify(apiId) {
    var a = byId(apiId);
    if (!a) return { ok: false, status: 'missing', message: '音源不存在' };
    if (!a.enabled) return { ok: false, status: 'disabled', message: '已停用' };
    if (a.status !== 'success') return { ok: false, status: 'invalid', message: a.message || '初始化失败' };
    if (!supports(a, 'musicUrl')) return { ok: false, status: 'no-music-url', message: '脚本未实现 musicUrl，无法解析播放地址' };
    return { ok: true, status: 'success', message: '验证通过' };
  }

  /* 只针对某个音源搜索（供平台适配器回退用） */
  function searchByApi(apiId, keyword, opts) {
    opts = opts || {};
    var a = byId(apiId);
    var q = String(keyword || '').trim();
    if (!a || !q || !supports(a, 'search')) {
      return Promise.resolve({ tracks: [], errors: [], called: 0 });
    }
    var keys = (opts.platform && a.sources && a.sources[opts.platform])
      ? [opts.platform] : sourceKeys(a, 'search');
    var out = [], errors = [], called = 0;
    return Promise.all(keys.map(function (sk) {
      called++;
      return API.invoke(runtimes[a.id], sk, 'search', {
        keyword: q, page: opts.page || 1, limit: opts.limit || 30, source: sk,
        type: opts.type || 'music'
      }, 25000).then(function (res) {
        var arr = Array.isArray(res) ? res : (res && (res.list || res.tracks || res.result)) || [];
        arr.forEach(function (raw) {
          var tr = normalizeTrack(raw, a, sk);
          if (tr) {
            tr.platform = opts.platform || tr.platform;
            out.push(tr);
          }
        });
      }).catch(function (e) {
        errors.push(a.name + '：' + String(e && e.message || e));
      });
    })).then(function () {
      if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(out);
      return { tracks: out, errors: errors, called: called };
    });
  }

  function leaderboardByApi(apiId, boardId, opts) {
    opts = opts || {};
    var a = byId(apiId);
    if (!a || !supports(a, 'leaderboard')) {
      return Promise.resolve({ tracks: [], errors: [], called: 0 });
    }
    var keys = (opts.platform && a.sources && a.sources[opts.platform])
      ? [opts.platform] : sourceKeys(a, 'leaderboard');
    var out = [], errors = [], called = 0;
    return Promise.all(keys.map(function (sk) {
      called++;
      return API.invoke(runtimes[a.id], sk, 'leaderboard', {
        id: boardId, boardId: boardId, source: sk, page: opts.page || 1, limit: opts.limit || 30
      }, 25000).then(function (res) {
        var arr = Array.isArray(res) ? res : (res && (res.list || res.tracks || res.result)) || [];
        arr.forEach(function (raw) {
          var tr = normalizeTrack(raw, a, sk);
          if (tr) { tr.platform = opts.platform || tr.platform; out.push(tr); }
        });
      }).catch(function (e) {
        errors.push(a.name + '：' + String(e && e.message || e));
      });
    })).then(function () {
      if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(out);
      return { tracks: out, errors: errors, called: called };
    });
  }

  // ---------------------------------------------------------------- 恢复
  function restore() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    if (Array.isArray(raw)) {
      raw.slice(0, MAX).forEach(function (m) {
        var a = {
          id: m.id, name: m.name, description: m.description, version: m.version,
          author: m.author, homepage: m.homepage, script: m.script,
          enabled: m.enabled !== false, allowUpdateAlert: m.allowUpdateAlert !== false,
          builtin: !!m.builtin, origin: m.origin || '', status: 'initing',
          message: t('setting_basic_source_status_initing', '初始化中'), sources: {}
        };
        list.push(a);
      });
    }
    // v3.2.0 起不再预置示例音源：用户要求清掉测试音乐、只用自己的音源。
    // 旧版本装过的 builtin 条目在升级时一并移除（脚本模板仍可在「示例脚本」里查看）。
    var builtinCount = list.filter(function (a) { return a.builtin; }).length;
    if (builtinCount) {
      list = list.filter(function (a) { return !a.builtin; });
      log('已移除 ' + builtinCount + ' 个旧版预置示例音源');
    }
    list.forEach(function (a) {
      if (a.enabled) initRuntime(a);
      else { a.status = 'disabled'; a.message = '已停用'; }
    });
    persist();
  }

  restore();

  window.LXSources = {
    MAX: MAX, list: function () { return list.slice(); },
    active: active, byId: byId, supports: supports, sourceKeys: sourceKeys,
    parseHeader: parseHeader, importScript: importScript, importOnline: importOnline,
    remove: remove, setEnabled: setEnabled, setAllowUpdateAlert: setAllowUpdateAlert,
    search: search, songList: songList, leaderboard: leaderboard, resolveMedia: resolveMedia,
    searchByApi: searchByApi, leaderboardByApi: leaderboardByApi, trackSource: trackSource,
    sourceChain: sourceChain,
    lastError: function (track) {
      var id = typeof track === 'string' ? track : (track && track.id);
      return (id && mediaErrors[id]) || '';
    },
    defaultApi: defaultApi, setDefault: setDefault, isDefault: isDefault, refresh: refresh, verify: verify,
    platformProviders: platformProviders, forPlatform: forPlatform, verifyPlatform: verifyPlatform,
    fetchDownload: fetchDownload, fetchMedia: function (track, quality) { return resolveMedia(track, quality, 'download'); },
    playableUrl: playableUrl, lyric: lyric,
    lyricDiag: function () { return lyricDiag.slice(); },
    clearLyric: function (id) { if (id) { delete lyricCache[id]; delete lyricPending[id]; } else { lyricCache = {}; lyricPending = {}; } },
    mediaToBlob: mediaToBlob, mimeOf: mimeOf, extOf: extOf,
    normalizeTrack: normalizeTrack, normalizeMedia: normalizeMedia,
    builtinScript: function () { return BUILTIN; },
    httpTemplate: function () { return HTTP_TEMPLATE; },
    logs: function () { return logs.slice(); },
    clearLogs: function () { logs = []; },
    onChange: function (fn) { listeners.push(fn); },
    esc: esc, t: t,
    hasSearch: function () { return active().some(function (a) { return supports(a, 'search'); }); },
    hasLeaderboard: function () { return active().some(function (a) { return supports(a, 'leaderboard'); }); },
    boardProviders: function () { return active().filter(function (a) { return supports(a, 'leaderboard'); }); },
    // 已启用的音源（不论是否支持 search）——主界面「搜索平台」下拉用
    enabledList: function () { return list.filter(function (a) { return a.enabled; }); }
  };
})();
