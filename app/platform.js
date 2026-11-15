/* 平台适配器（v3.3.0）
 * 语义对齐原版：**平台**负责搜索/榜单，**自定义音源**只是该平台的账号凭证，
 * 用来解析播放地址（musicUrl）与下载地址（downloadUrl）。
 *
 * - 酷我 / 酷狗 / 咪咕：内置公开搜索接口（纯 HTTP，走原生 HTTP 桥，不受 CORS 限制）
 * - 酷狗：内置榜单接口
 * - 网易：eapi（AES-128-ECB）搜索，与 lxserver wy/utils/crypto.js 一致
 * - QQ：musics.fcg + zzcSign（SHA1 取位/XOR/base64），与 lxserver tx/utils/crypto.js 一致
 *
 * 所有平台失败时都会回退到「该平台绑定的音源」，并在 note 里说明原因，
 * 不会静默返回空结果。
 */
(function () {
  'use strict';

  var PLATFORMS = [
    { id: 'kw', name: '酷我音乐', short: '酷我', color: '#4daf7c', builtin: true },
    { id: 'kg', name: '酷狗音乐', short: '酷狗', color: '#2f9cf4', builtin: true },
    { id: 'mg', name: '咪咕音乐', short: '咪咕', color: '#e57b58', builtin: true },
    { id: 'wy', name: '网易云音乐', short: '网易', color: '#d64541', builtin: true },
    { id: 'tx', name: 'QQ音乐', short: 'QQ', color: '#31c27c', builtin: true }
  ];

  var UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110 Mobile Safari/537.36';

  /* 平台返回的曲目要进入 LXData 的 external 池，才能被 D.byId 找到并播放 */
  function remember(tracks) {
    if (window.LXData && window.LXData.addExternalTracks) window.LXData.addExternalTracks(tracks);
    return tracks;
  }

  function byId(id) {
    return PLATFORMS.filter(function (p) { return p.id === id; })[0] || null;
  }
  function nameOf(id) {
    var p = byId(id);
    return p ? p.name : (id || '');
  }
  function fmt(sec) {
    var n = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(n / 60), s = n % 60;
    return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2);
  }
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 走原生 HTTP 桥：Android 用 HttpURLConnection，浏览器回退 fetch。
   * 支持三种载荷：form（application/x-www-form-urlencoded）、body（原样/JSON）、GET 查询串。 */
  function http(url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var API = window.LXSourceAPI;
      if (!API || typeof API.request !== 'function') { reject(new Error('HTTP 桥未就绪')); return; }
      var headers = {};
      var k;
      for (k in (opts.headers || { 'User-Agent': UA })) {
        if (Object.prototype.hasOwnProperty.call(opts.headers || {}, k)) headers[k] = opts.headers[k];
      }
      if (!headers['User-Agent']) headers['User-Agent'] = UA;
      var req = {
        method: opts.method || 'get',
        timeout: opts.timeout || 15000,
        headers: headers
      };
      if (opts.form) {
        var parts = [];
        for (k in opts.form) {
          if (Object.prototype.hasOwnProperty.call(opts.form, k)) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(opts.form[k]));
          }
        }
        req.body = parts.join('&');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (opts.body != null) {
        req.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      }
      API.request(url, req, function (err, resp, body) {
        if (err) { reject(new Error(String(err.message || err))); return; }
        if (!resp || resp.statusCode !== 200) {
          var peek = String(body == null ? '' : body).replace(/\s+/g, ' ').slice(0, 140);
          reject(new Error('HTTP ' + (resp ? resp.statusCode : '?') + (peek ? '：' + peek : '')));
          return;
        }
        resolve({ body: body, headers: resp.headers || {} });
      });
    });
  }
  function httpJson(url, opts) {
    return http(url, opts).then(function (r) {
      try { return JSON.parse(r.body); }
      catch (e) { throw new Error('接口返回的不是 JSON'); }
    });
  }

  // ------------------------------------------------------------------ 酷我
  var KW_QUALITY_BY_BITRATE = { 4000: 'flac24bit', 2000: 'flac', 320: '320k', 128: '128k' };

  function kwQualitys(minfo) {
    var out = [], seen = {};
    String(minfo || '').split(';').forEach(function (part) {
      var m = part.match(/bitrate:(\d+)/);
      if (!m) return;
      var q = KW_QUALITY_BY_BITRATE[Number(m[1])];
      if (q && !seen[q]) { seen[q] = 1; out.push(q); }
    });
    // 从低到高，与原版 types 顺序一致
    var order = ['128k', '320k', 'flac', 'flac24bit'];
    out.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return out.length ? out : ['128k'];
  }

  function kwTrack(raw) {
    var songmid = String(raw.MUSICRID || '').replace(/^MUSIC_/, '');
    if (!songmid) return null;
    var dur = Number(raw.DURATION) || 0;
    return {
      id: 'kw_' + songmid,
      platform: 'kw',
      songmid: songmid,
      name: decodeEntities(raw.SONGNAME || raw.NAME || songmid),
      singer: decodeEntities(raw.ARTIST || raw.FARTIST || '未知歌手').replace(/\s*&\s*/g, ' / '),
      album: decodeEntities(raw.ALBUM || ''),
      duration: dur,
      time: fmt(dur),
      qualitys: kwQualitys(raw.N_MINFO || raw.MINFO),
      ext: 'mp3',
      mime: 'audio/mpeg',
      _raw: {
        songmid: songmid,
        name: decodeEntities(raw.SONGNAME || ''),
        singer: decodeEntities(raw.ARTIST || ''),
        album: decodeEntities(raw.ALBUM || ''),
        duration: dur,
        rid: raw.DC_TARGETID || raw.MUSICRID || ''
      }
    };
  }

  function kwSearch(keyword, page, limit) {
    var url = 'http://search.kuwo.cn/r.s?client=kt&all=' + encodeURIComponent(keyword) +
      '&pn=' + (page - 1) + '&rn=' + limit +
      '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1' +
      '&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json' +
      '&vermerge=1&mobi=1&issubtitle=1';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/' } })
      .then(function (d) {
        var arr = (d && d.abslist) || [];
        return arr.map(kwTrack).filter(Boolean);
      });
  }

  // ------------------------------------------------------------------ 酷狗
  var KG_BOARDS = [
    { id: '8888', name: 'TOP500' }, { id: '6666', name: '飙升榜' },
    { id: '59703', name: '蜂鸟流行音乐榜' }, { id: '52144', name: '抖音热歌榜' },
    { id: '52767', name: '快手热歌榜' }, { id: '24971', name: 'DJ热歌榜' },
    { id: '23784', name: '网络红歌榜' }, { id: '44412', name: '说唱先锋榜' },
    { id: '31308', name: '内地榜' }, { id: '33160', name: '电音榜' },
    { id: '31313', name: '香港地区榜' }, { id: '51341', name: '民谣榜' },
    { id: '54848', name: '台湾地区榜' }, { id: '31310', name: '欧美榜' },
    { id: '33162', name: 'ACG新歌榜' }, { id: '31311', name: '韩国榜' },
    { id: '31312', name: '日本榜' }, { id: '33165', name: '粤语金曲榜' },
    { id: '33166', name: '欧美金曲榜' }, { id: '33163', name: '影视金曲榜' },
    { id: '51340', name: '伤感榜' }, { id: '30972', name: '酷狗音乐人原创榜' },
    { id: '59896', name: '摇滚榜' }, { id: '59900', name: '纯音乐榜' }
  ];

  function kgQualitys(raw) {
    var out = [];
    if (raw.FileHash && raw.FileSize !== 0) out.push('128k');
    if (raw.HQFileHash && raw.HQFileSize !== 0) out.push('320k');
    if (raw.SQFileHash && raw.SQFileSize !== 0) out.push('flac');
    if (raw.ResFileHash && raw.ResFileSize !== 0) out.push('flac24bit');
    return out.length ? out : ['128k'];
  }
  function kgHash(raw, quality) {
    if (quality === 'flac24bit') return raw.ResFileHash || '';
    if (quality === 'flac') return raw.SQFileHash || '';
    if (quality === '320k') return raw.HQFileHash || '';
    return raw.FileHash || '';
  }
  function kgSinger(raw) {
    if (Array.isArray(raw.Singers) && raw.Singers.length) {
      return raw.Singers.map(function (s) { return s && s.name || ''; }).filter(Boolean).join(' / ');
    }
    // 歌单 / 排行榜接口只给 singername，搜索接口给 SingerName
    return String(raw.SingerName || raw.singername || raw.singer_name || '')
      .replace(/\s*、\s*/g, ' / ');
  }
  function kgTrack(raw) {
    // 搜索结果用 Audioid + FileHash；榜单结果用 hash/audio_id
    var songmid = String(raw.Audioid || raw.audio_id || raw.Audioid || '');
    var hash = raw.FileHash || raw.hash || '';
    if (!songmid && hash) songmid = hash;
    if (!songmid) return null;
    var dur = Number(raw.Duration || raw.duration || 0);
    var name = decodeEntities(raw.OriSongName || raw.SongName || raw.songname || '');
    var singerText = decodeEntities(kgSinger(raw));
    /* 歌单 / 榜单接口没有 songname/singername，只有 filename（"歌手 - 歌名"），
     * 不解析就会把曲目显示成 hash —— 真机上表现为「歌单里全是乱码」。 */
    if (!name) {
      var fn = decodeEntities(raw.filename || '');
      var cut = fn.indexOf(' - ');
      if (cut > 0) {
        if (!singerText) singerText = fn.slice(0, cut).trim();
        name = fn.slice(cut + 3).trim();
      } else name = fn;
    }
    if (raw.Suffix && name) name += ' ' + String(raw.Suffix).trim();
    var qualitys = kgQualitys({
      FileHash: raw.FileHash || raw.hash || '', FileSize: raw.FileSize || raw.filesize || 1,
      HQFileHash: raw.HQFileHash || raw['320hash'] || '', HQFileSize: raw.HQFileSize || raw['320filesize'] || 0,
      SQFileHash: raw.SQFileHash || raw.sqhash || '', SQFileSize: raw.SQFileSize || raw.sqfilesize || 0,
      ResFileHash: raw.ResFileHash || raw.hash_high || '', ResFileSize: raw.ResFileSize || raw.filesize_high || 0
    });
    return {
      id: 'kg_' + songmid,
      platform: 'kg',
      songmid: songmid,
      name: name || songmid,
      singer: singerText || '未知歌手',
      album: decodeEntities(raw.AlbumName || raw.album_name || ''),
      duration: dur,
      time: fmt(dur),
      qualitys: qualitys,
      ext: 'mp3',
      mime: 'audio/mpeg',
      _raw: {
        songmid: songmid, hash: hash, albumId: raw.AlbumID || raw.album_id || '',
        name: name, singer: singerText, duration: dur,
        hashes: {
          '128k': raw.FileHash || raw.hash || '',
          '320k': raw.HQFileHash || raw['320hash'] || '',
          flac: raw.SQFileHash || raw.sqhash || '',
          flac24bit: raw.ResFileHash || raw.hash_high || ''
        }
      }
    };
  }

  function kgSearch(keyword, page, limit) {
    var url = 'http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1' +
      '&keyword=' + encodeURIComponent(keyword) + '&hifiquality=0&pagesize=' + limit +
      '&PrivilegeFilter=0&page=' + page;
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } })
      .then(function (d) {
        var lists = (d && d.data && d.data.lists) || [];
        var out = [], seen = {};
        lists.forEach(function (raw) {
          var tr = kgTrack(raw);
          if (tr && !seen[tr.id]) { seen[tr.id] = 1; out.push(tr); }
          (raw.Grp || []).forEach(function (g) {
            var sub = kgTrack(g);
            if (sub && !seen[sub.id]) { seen[sub.id] = 1; out.push(sub); }
          });
        });
        return out;
      });
  }

  function kgBoard(boardId, page, limit) {
    var url = 'http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0' +
      '&pagesize=' + limit + '&area_code=1&page=' + page + '&rankid=' + encodeURIComponent(boardId) +
      '&with_res_tag=0&show_portrait_mv=1';
    return httpJson(url, { headers: { 'User-Agent': UA } }).then(function (d) {
      var info = (d && d.data && d.data.info) || [];
      return info.map(kgTrack).filter(Boolean);
    });
  }

  // ------------------------------------------------------------------ 咪咕
  function mgQualitys(raw) {
    var out = [];
    // 搜索/歌单用 audioFormats，榜单用 rateFormats / newRateFormats
    (raw.audioFormats || raw.rateFormats || raw.newRateFormats || []).forEach(function (f) {
      var t = f && f.formatType;
      var q = t === 'ZQ24' ? 'flac24bit' : t === 'SQ' ? 'flac' : t === 'HQ' ? '320k' : t === 'PQ' ? '128k' : '';
      if (q && out.indexOf(q) < 0) out.push(q);
    });
    var order = ['128k', '320k', 'flac', 'flac24bit'];
    out.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return out.length ? out : ['128k'];
  }
  function mgSinger(raw) {
    var arr = raw.singers || raw.singerList || [];
    if (!Array.isArray(arr)) return String(raw.singer || '');
    return arr.map(function (s) { return s && (s.name || s.singerName) || ''; }).filter(Boolean).join(' / ');
  }
  function mgTrack(raw) {
    var songmid = String(raw.songId || raw.id || raw.contentId || '');
    if (!songmid) return null;
    var dur = Number(raw.duration || 0);
    if (dur > 3600) dur = Math.round(dur / 1000);   // 部分接口返回毫秒
    // 歌单接口把封面放在 img1/img2/img3，搜索接口用 albums[].img
    var img = raw.img1 || raw.img2 ||
      (raw.albumImgs && raw.albumImgs[0] && raw.albumImgs[0].img) ||
      (raw.albums && raw.albums[0] && (raw.albums[0].img || raw.albums[0].webpImg)) || '';
    return {
      id: 'mg_' + songmid,
      platform: 'mg',
      songmid: songmid,
      name: decodeEntities(raw.name || raw.songName || songmid),
      singer: decodeEntities(mgSinger(raw)) || '未知歌手',
      album: decodeEntities(raw.album || (raw.albums && raw.albums[0] && raw.albums[0].name) || ''),
      albumId: raw.albumId || '',
      duration: dur,
      time: fmt(dur),
      img: img,
      qualitys: mgQualitys(raw),
      ext: 'mp3',
      mime: 'audio/mpeg',
      _raw: {
        songmid: songmid,
        copyrightId: raw.copyrightId || '',
        contentId: raw.contentId || raw.id || '',
        name: decodeEntities(raw.name || raw.songName || ''),
        singer: decodeEntities(mgSinger(raw)),
        albumName: raw.album || '',
        duration: dur
      }
    };
  }

  function mgSearch(keyword, page, limit) {
    var sw = encodeURIComponent('{"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}');
    var url = 'http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu' +
      '&version=5.0.1&text=' + encodeURIComponent(keyword) + '&pageNo=' + page + '&pageSize=' + limit +
      '&searchSwitch=' + sw;
    return httpJson(url, { headers: { 'User-Agent': 'okhttp/3.9.1', Referer: 'http://music.migu.cn/' } })
      .then(function (d) {
        if (d && d.code && d.code !== '000000') throw new Error(d.info || ('咪咕返回 ' + d.code));
        var result = (d && d.songResultData && d.songResultData.result) || [];
        var out = [], seen = {};
        result.forEach(function (group) {
          (Array.isArray(group) ? group : [group]).forEach(function (raw) {
            var tr = mgTrack(raw);
            if (tr && !seen[tr.id]) { seen[tr.id] = 1; out.push(tr); }
          });
        });
        return out;
      });
  }

  // ------------------------------------------------------------------ 路由
  // ------------------------------------------------------------------ 网易云音乐
  /* 搜索走 eapi：params = AES-128-ECB(/api/search/song/list/page-36cd479b6b5-{json}-36cd479b6b5-md5)
   * 与 lxserver 的 wy/utils/crypto.js + eapiRequest 完全一致。 */
  var WY_EAPI_URL = 'http://interface.music.163.com/eapi/batch';
  var WY_EAPI_KEY = 'e82ckenh8dichen8';

  function wyEapiParams(path, data) {
    var C = window.LXNetCrypto;
    if (!C) throw new Error('加密模块未就绪');
    var text = JSON.stringify(data);
    var digest = C.md5('nobody' + path + 'use' + text + 'md5forencrypt');
    var payload = path + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest;
    return C.aesEcbHex(payload, WY_EAPI_KEY);
  }

  function wyHas(v) { return v != null && v !== 0 && v !== '0'; }

  /* 对应 lxserver wy/quality.js 的 buildQualitys（maxbr 与各档 size 字段双判） */
  function wyQualitys(song, privilege) {
    var out = [], p = privilege || song.privilege || {};
    var maxbr = Number(p.maxbr || 0);
    if (maxbr >= 128000 || wyHas(song.l)) out.push('128k');
    if (maxbr >= 320000 || wyHas(song.h)) out.push('320k');
    if (maxbr >= 999000 || wyHas(song.sq)) out.push('flac');
    if (wyHas(song.hr)) { out.push('flac24bit'); out.push('hires'); }
    if (wyHas(song.jyEffect || song.sky)) out.push('atmos');
    if (wyHas(song.jm || song.jymaster)) out.push('master');
    return out;
  }

  function wyTrack(res) {
    var s = res && res.baseInfo && res.baseInfo.simpleSongData;
    if (!s || !s.id) return null;
    var dur = Math.round((Number(s.dt) || 0) / 1000);
    var album = s.al || {};
    var singers = (s.ar || []).map(function (a) { return a.name; }).filter(Boolean);
    var singer = decodeEntities(singers.join('、'));
    return {
      id: 'wy_' + s.id,
      platform: 'wy',
      songmid: String(s.id),
      name: decodeEntities(s.name),
      singer: singer,
      album: decodeEntities(album.name || ''),
      albumId: album.id || '',
      duration: dur,
      time: fmt(dur),
      interval: fmt(dur),
      img: album.picUrl || '',
      source: 'wy',
      sourceLabel: '网易云音乐',
      qualitys: wyQualitys(s, s.privilege),
      // 音源脚本按 musicInfo.songmid / name / singer / albumName / interval 取链
      _raw: {
        songmid: String(s.id), id: String(s.id),
        name: s.name, singer: singers.join('、'),
        albumName: album.name || '', albumId: album.id || '',
        interval: fmt(dur), duration: dur, picUrl: album.picUrl || ''
      }
    };
  }

  function wySearch(keyword, page, limit) {
    var params = wyEapiParams('/api/search/song/list/page', {
      keyword: keyword,
      needCorrect: '1',
      channel: 'typing',
      offset: limit * (page - 1),
      scene: 'normal',
      total: page === 1,
      limit: limit
    });
    return httpJson(WY_EAPI_URL, {
      method: 'post',
      headers: {
        'User-Agent': UA,
        origin: 'https://music.163.com',
        Referer: 'https://music.163.com/'
      },
      form: { params: params },
      timeout: 20000
    }).then(function (d) {
      if (!d || d.code !== 200) throw new Error('网易接口 code=' + (d && d.code) + (d && d.message ? ' ' + d.message : ''));
      var res = (d.data && d.data.resources) || [];
      return res.map(wyTrack).filter(Boolean);
    });
  }

  // ------------------------------------------------------------------ QQ 音乐
  /* 搜索走 musics.fcg：sign = zzcSign(JSON body)，body 里带 SearchCgiService 模块。 */
  var TX_SEARCH_URL = 'https://u.y.qq.com/cgi-bin/musics.fcg';
  var TX_UA = 'QQMusic 14090508(android 12)';

  function txSearchId() {
    var s = '', i;
    for (i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.toUpperCase() + ('00000' + Math.floor(Math.random() * 100000)).slice(-5);
  }

  function txFirstSize(file, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = file[keys[i]];
      if (v != null && v !== 0 && v !== '0') return true;
    }
    return false;
  }

  /* 对应 lxserver tx/quality.js 的 buildQualitys */
  function txQualitys(file) {
    var out = [];
    if (txFirstSize(file, ['size_128mp3'])) out.push('128k');
    if (txFirstSize(file, ['size_320mp3'])) out.push('320k');
    if (txFirstSize(file, ['size_flac'])) out.push('flac');
    if (txFirstSize(file, ['size_hires', 'size_hires24bit', 'size_flac24bit'])) {
      out.push('flac24bit'); out.push('hires');
    }
    if (txFirstSize(file, ['size_atmos', 'size_dolby', 'size_dolby_atmos', 'size_360ra'])) out.push('atmos');
    if (txFirstSize(file, ['size_atmos_plus', 'size_dolby_plus', 'size_360ra_plus'])) out.push('atmos_plus');
    if (txFirstSize(file, ['size_master', 'size_ai_master', 'size_new'])) out.push('master');
    return out;
  }

  function txTrack(item) {
    if (!item || !item.file || !item.file.media_mid) return null;
    var mid = item.mid;
    if (!mid) return null;
    var file = item.file, album = item.album || {};
    var dur = Number(item.interval) || 0;
    var singers = (item.singer || []).map(function (x) { return x.name; }).filter(Boolean);
    var singer = decodeEntities(singers.join('、'));
    return {
      id: 'tx_' + mid,
      platform: 'tx',
      songmid: mid,
      songId: item.id || '',
      name: decodeEntities(item.title || item.name || ''),
      singer: singer,
      album: decodeEntities(album.name || ''),
      albumId: album.mid || '',
      duration: dur,
      time: fmt(dur),
      interval: fmt(dur),
      img: album.mid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + album.mid + '.jpg' : '',
      source: 'tx',
      sourceLabel: 'QQ音乐',
      qualitys: txQualitys(file),
      _raw: {
        songmid: mid, songid: item.id, media_mid: file.media_mid,
        name: item.title || item.name || '', singer: singers.join('、'),
        albumName: album.name || '', albumMid: album.mid || '',
        interval: fmt(dur), duration: dur
      }
    };
  }

  function txSearch(keyword, page, limit) {
    var C = window.LXNetCrypto;
    if (!C) throw new Error('加密模块未就绪');
    var payload = {
      comm: {
        _channelid: '0', _os_version: '6.2.9200-2', ct: '19', cv: '2151',
        guid: '1F70E520B2EAA7D25E11760783C53CA9', patch: '118',
        psrf_access_token_expiresAt: 0, psrf_qqaccess_token: '',
        psrf_qqopenid: '', psrf_qqunionid: '', tmeAppID: 'qqmusic',
        tmeLoginType: 0, uin: '0', wid: '7223299733393904640'
      },
      'music.search.SearchCgiService': {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          grp: 1,
          num_per_page: limit,
          page_num: page,
          query: keyword,
          remoteplace: 'txt.newclient.top',
          search_type: 0,
          searchid: txSearchId()
        }
      }
    };
    var body = JSON.stringify(payload);
    var sign = C.zzcSign(body);
    return httpJson(TX_SEARCH_URL + '?sign=' + sign, {
      method: 'post',
      headers: { 'User-Agent': TX_UA, 'Content-Type': 'application/json' },
      body: body,
      timeout: 20000
    }).then(function (d) {
      var req = d && (d['music.search.SearchCgiService'] || d.req);
      if (!req || !d || d.code !== 0 || req.code !== 0) {
        throw new Error('QQ接口 code=' + (d && d.code) + '/' + (req && req.code));
      }
      var list = (req.data && req.data.body && req.data.body.song && req.data.body.song.list) || [];
      return list.map(txTrack).filter(Boolean);
    });
  }

  // ------------------------------------------------------------------ 榜单 / 歌单（v3.9.0）
  /* 五个平台都接入内置榜单：口径对齐 lxserver 各自的 leaderboard 实现，
   * 榜单曲目由平台接口给出，播放/下载地址仍由音源解析。
   * 榜单 id 统一为「平台id:平台内id」，避免不同平台撞号。 */
  var KW_BOARDS = [
    { id: '16', name: '热歌榜' }, { id: '93', name: '飙升榜' },
    { id: '17', name: '新歌榜' }, { id: '158', name: '抖音热歌榜' },
    { id: '187', name: '流行趋势榜' }, { id: '26', name: '经典怀旧榜' },
    { id: '104', name: '华语榜' }, { id: '182', name: '粤语榜' },
    { id: '22', name: '欧美榜' }, { id: '184', name: '韩语榜' },
    { id: '183', name: '日语榜' }, { id: '242', name: '电音榜' },
    { id: '290', name: 'ACG新歌榜' }, { id: '292', name: '铃声榜' },
    { id: '284', name: '热评榜' }, { id: '64', name: '影视金曲榜' },
    { id: '176', name: 'DJ嗨歌榜' }, { id: '106', name: '真声音' },
    { id: '12', name: 'Billboard榜' }, { id: '13', name: '英国UK榜' },
    { id: '15', name: '日本公信榜' }, { id: '8', name: '香港电台榜' },
    { id: '151', name: '腾讯音乐人原创榜' }, { id: '145', name: '会员畅听榜' }
  ];
  var MG_BOARDS = [
    { id: '83048887', name: '全网热歌榜' }, { id: '83049014', name: '抖音热歌榜' },
    { id: '83048867', name: '免费热歌榜' }, { id: '83049056', name: '收藏人气榜' },
    { id: '76557745', name: '会员臻爱榜' }, { id: '83176390', name: '国风热歌榜' },
    { id: '27553319', name: '新歌榜' }, { id: '27186466', name: '热歌榜' },
    { id: '27553408', name: '原创榜' }
  ];
  var WY_BOARDS = [
    { id: '3778678', name: '热歌榜' }, { id: '19723756', name: '飙升榜' },
    { id: '3779629', name: '新歌榜' }, { id: '2884035', name: '原创榜' },
    { id: '991319590', name: '说唱榜' }, { id: '1978921795', name: '电音榜' },
    { id: '71384707', name: '古典榜' }, { id: '71385702', name: 'ACG榜' },
    { id: '745956260', name: '韩语榜' }, { id: '180106', name: 'UK排行榜周榜' },
    { id: '60198', name: '美国Billboard榜' }, { id: '5059644681', name: '日语榜' },
    { id: '5059633707', name: '摇滚榜' }, { id: '5059642708', name: '国风榜' },
    { id: '5059661515', name: '民谣榜' }, { id: '6723173524', name: '网络热歌榜' }
  ];
  var TX_BOARDS = [
    { id: '26', name: '热歌榜' }, { id: '4', name: '流行指数榜' },
    { id: '62', name: '飙升榜' }, { id: '27', name: '新歌榜' },
    { id: '58', name: '说唱榜' }, { id: '57', name: '喜力电音榜' },
    { id: '28', name: '网络歌曲榜' }, { id: '5', name: '内地榜' },
    { id: '3', name: '欧美榜' }, { id: '59', name: '香港地区榜' },
    { id: '61', name: '台湾地区榜' }, { id: '16', name: '韩国榜' },
    { id: '17', name: '日本榜' }, { id: '60', name: '抖快榜' },
    { id: '29', name: '影视金曲榜' }, { id: '63', name: 'DJ舞曲榜' },
    { id: '65', name: '国风热歌榜' }, { id: '72', name: '动漫音乐榜' },
    { id: '73', name: '游戏音乐榜' }, { id: '52', name: '腾讯音乐人原创榜' },
    { id: '36', name: 'K歌金曲榜' }, { id: '67', name: '听歌识曲榜' },
    { id: '131', name: '校园音乐人排行榜' }, { id: '64', name: '综艺新歌榜' }
  ];
  var BOARD_CATALOG = { kw: KW_BOARDS, kg: KG_BOARDS, mg: MG_BOARDS, wy: WY_BOARDS, tx: TX_BOARDS };

  var MG_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
    Referer: 'https://app.c.nf.migu.cn/',
    channel: '0146921'
  };

  /* 酷我榜单 / 歌单：只有 formats 字符串时按编码推断音质 */
  function kwFormats(s) {
    var out = [];
    String(s || '').split('|').forEach(function (f) {
      if (/^(ALFLAC|FLAC)$/.test(f)) { if (out.indexOf('flac') < 0) out.push('flac'); }
      else if (/^(MP3H|MP3320)$/.test(f)) { if (out.indexOf('320k') < 0) out.push('320k'); }
      else if (/^(MP3128|MP3)$/.test(f)) { if (out.indexOf('128k') < 0) out.push('128k'); }
    });
    var order = ['128k', '320k', 'flac', 'flac24bit'];
    out.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return out.length ? out : ['128k'];
  }

  function kwAnyTrack(raw) {
    var songmid = String(raw.id || raw.MUSICRID || raw.rid || '').replace(/^MUSIC_/, '');
    if (!songmid) return null;
    var dur = Number(raw.song_duration || raw.duration || raw.DURATION) || 0;
    var minfo = raw.N_MINFO || raw.n_minfo || raw.MINFO || raw.minfo || '';
    var name = decodeEntities(raw.name || raw.SONGNAME || raw.SongName || songmid);
    var singer = decodeEntities(raw.artist || raw.ARTIST || '未知歌手');
    var album = decodeEntities(raw.album || raw.ALBUM || '');
    return {
      id: 'kw_' + songmid,
      platform: 'kw',
      songmid: songmid,
      name: name,
      singer: singer,
      album: album,
      duration: dur,
      time: fmt(dur),
      qualitys: minfo ? kwQualitys(minfo) : kwFormats(raw.formats),
      ext: 'mp3',
      mime: 'audio/mpeg',
      _raw: {
        songmid: songmid, rid: songmid, name: name, singer: singer,
        album: album, duration: dur
      }
    };
  }

  function kwBoard(boardId, page, limit) {
    var url = 'http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=' + (page - 1) + '&rn=' + limit +
      '&type=bang&data=content&id=' + encodeURIComponent(boardId) + '&show_copyright_off=0&pcmp4=1&isbang=1';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/' } })
      .then(function (d) {
        var arr = d.musiclist || d.musicList || [];
        return arr.map(kwAnyTrack).filter(Boolean);
      });
  }

  /* 咪咕榜单：columnInfo.contents[].objectInfo */
  function mgBoardTrack(o) {
    if (!o) return null;
    var songmid = String(o.songId || o.contentId || '');
    if (!songmid) return null;
    // 榜单给的是 "00:03:30" 或秒数，两种都要能算
    var dur = 0;
    if (typeof o.length === 'string' && o.length.indexOf(':') > 0) {
      o.length.split(':').forEach(function (n) { dur = dur * 60 + (Number(n) || 0); });
    } else dur = Number(o.length || o.duration || 0) || 0;
    if (dur > 3600) dur = Math.round(dur / 1000);
    var img = (o.albumImgs && o.albumImgs[0] && (o.albumImgs[0].img || o.albumImgs[0].webpImg)) ||
      o.img1 || o.img2 || '';
    return {
      id: 'mg_' + songmid,
      platform: 'mg',
      songmid: songmid,
      name: decodeEntities(o.songName || o.name || songmid),
      singer: decodeEntities(o.singer || mgSinger(o)) || '未知歌手',
      album: decodeEntities(o.album || o.albumName || ''),
      albumId: o.albumId || '',
      duration: dur,
      time: fmt(dur),
      img: img,
      qualitys: mgQualitys(o),
      ext: 'mp3',
      mime: 'audio/mpeg',
      _raw: {
        songmid: songmid, copyrightId: o.copyrightId || '', contentId: o.contentId || '',
        name: o.songName || o.name || '', singer: o.singer || mgSinger(o),
        albumName: o.album || '', duration: dur
      }
    };
  }

  function mgBoard(boardId, page, limit) {
    var url = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=' +
      encodeURIComponent(boardId) + '&needAll=0';
    return httpJson(url, { headers: MG_HEADERS }).then(function (d) {
      if (d.code !== '000000') throw new Error(d.info || ('咪咕返回 ' + d.code));
      var list = (d.columnInfo && d.columnInfo.contents) || [];
      return list.map(function (c) { return c && c.objectInfo; })
        .filter(Boolean).map(mgBoardTrack).filter(Boolean);
    });
  }

  /* 网易榜单 / 歌单：playlist/detail 返回的曲目结构与搜索接口不同 */
  function wySongTrack(s) {
    if (!s || !s.id) return null;
    var dur = Math.round((Number(s.dt || s.duration) || 0) / 1000);
    var ar = s.ar || s.artists || [];
    var al = s.al || s.album || {};
    var singers = ar.map(function (a) { return a && a.name; }).filter(Boolean);
    var singer = decodeEntities(singers.join('、'));
    var img = al.picUrl || '';
    return {
      id: 'wy_' + s.id,
      platform: 'wy',
      songmid: String(s.id),
      name: decodeEntities(s.name),
      singer: singer || '未知歌手',
      album: decodeEntities(al.name || ''),
      albumId: al.id || '',
      duration: dur,
      time: fmt(dur),
      interval: fmt(dur),
      img: img,
      source: 'wy',
      sourceLabel: '网易云音乐',
      qualitys: wyQualitys(s, s.privilege),
      _raw: {
        songmid: String(s.id), id: String(s.id), name: s.name, singer: singers.join('、'),
        albumName: al.name || '', albumId: al.id || '', interval: fmt(dur),
        duration: dur, picUrl: img
      }
    };
  }

  function wyBoard(boardId, page, limit) {
    var url = 'https://music.163.com/api/playlist/detail?id=' + encodeURIComponent(boardId) +
      '&n=' + (limit || 100);
    return httpJson(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' }
    }).then(function (d) {
      var arr = (d.result && d.result.tracks) || [];
      return arr.map(wySongTrack).filter(Boolean);
    });
  }

  /* QQ 榜单：musicu.fcg 的 GetDetail 现在只回精简曲目（无 mid/file），
   * 改用老接口 fcg_v8_toplist_cp，返回值里带完整 songmid / file 体积。 */
  function txBoardTrack(d) {
    if (!d || !d.songmid) return null;
    var dur = Number(d.interval) || 0;
    var singers = (d.singer || []).map(function (x) { return x && x.name; }).filter(Boolean);
    var singer = decodeEntities(singers.join('、'));
    var file = {
      media_mid: d.strMediaMid || d.songmid,
      size_128mp3: d.size128, size_320mp3: d.size320,
      size_flac: d.sizeflac, size_hires: d.sizehires, size_master: d.sizemaster
    };
    return {
      id: 'tx_' + d.songmid,
      platform: 'tx',
      songmid: d.songmid,
      songId: d.songid || '',
      name: decodeEntities(d.songname || ''),
      singer: singer || '未知歌手',
      album: decodeEntities(d.albumname || ''),
      albumId: d.albummid || '',
      duration: dur,
      time: fmt(dur),
      interval: fmt(dur),
      img: d.albummid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + d.albummid + '.jpg' : '',
      source: 'tx',
      sourceLabel: 'QQ音乐',
      qualitys: txQualitys(file),
      _raw: {
        songmid: d.songmid, songid: d.songid, media_mid: file.media_mid,
        name: d.songname || '', singer: singers.join('、'),
        albumName: d.albumname || '', albumMid: d.albummid || '',
        interval: fmt(dur), duration: dur
      }
    };
  }

  function txBoard(boardId, page, limit) {
    var begin = (page - 1) * limit;
    var url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=' + encodeURIComponent(boardId) +
      '&song_begin=' + begin + '&song_num=' + limit + '&format=json&platform=yqq&needNewCode=1&tpl=3';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } })
      .then(function (d) {
        var arr = (d.songlist || []).map(function (x) { return x && x.data; });
        return arr.map(txBoardTrack).filter(Boolean);
      });
  }

  // ------------------------------------------------------------------ 推荐歌单
  function kwPlaylists(page) {
    var url = 'http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0' +
      '&appUid=76039576&pn=' + page + '&rn=24&order=hot';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/' } })
      .then(function (d) {
        if (d.code !== 200) throw new Error(d.message || ('酷我歌单 code=' + d.code));
        var arr = (d.data && d.data.data) || [];
        return arr.map(function (x) {
          return {
            id: String(x.id), name: decodeEntities(x.name), img: x.img || '',
            author: decodeEntities(x.uname || ''), play: String(x.listencnt || ''),
            count: Number(x.total) || 0
          };
        });
      });
  }

  function kgPlaylists(page) {
    var url = 'http://m.kugou.com/plist/index?json=true&page=' + page;
    return httpJson(url, { headers: { 'User-Agent': UA } }).then(function (d) {
      var arr = (d.plist && d.plist.list && d.plist.list.info) || [];
      return arr.map(function (x) {
        return {
          id: String(x.specialid), name: decodeEntities(x.specialname),
          img: String(x.imgurl || '').replace('{size}', '400'),
          author: decodeEntities(x.nickname || ''), play: String(x.playcount || ''),
          count: Number(x.songcount) || 0
        };
      });
    });
  }

  /* 咪咕歌单广场：返回的是多层页面模板，歌单节点统一为 ZJ-SongList-Item */
  function mgPlaylists(page) {
    var url = 'https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0' +
      '?templateVersion=2&pageNo=' + page;
    return httpJson(url, { headers: MG_HEADERS }).then(function (d) {
      if (d.code !== '000000') throw new Error(d.info || ('咪咕歌单 ' + d.code));
      var out = [], seen = {};
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o.view === 'ZJ-SongList-Item' && typeof o.action === 'string') {
          var m = o.action.match(/[?&]id=(\d+)/);
          if (m && !seen[m[1]]) {
            seen[m[1]] = 1;
            out.push({
              id: m[1], name: decodeEntities(o.txt || ''), img: o.img || '',
              author: '', play: String(o.txt2 || ''), count: 0
            });
          }
        }
        Object.keys(o).forEach(function (k) { walk(o[k]); });
      })(d.data);
      return out;
    });
  }

  function wyPlaylists(page) {
    var url = 'https://music.163.com/api/personalized/playlist?limit=30&offset=' + ((page - 1) * 30);
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } })
      .then(function (d) {
        return (d.result || []).map(function (x) {
          return {
            id: String(x.id), name: decodeEntities(x.name), img: x.picUrl || '',
            author: decodeEntities((x.creator && x.creator.nickname) || ''),
            play: String(x.playCount || ''), count: Number(x.trackCount) || 0
          };
        });
      });
  }

  function txPlaylists(page) {
    var size = 30;
    var payload = {
      comm: { cv: 1602, ct: 20 },
      playlist: {
        module: 'music.playlist.PlaylistSquare',
        method: 'GetRecommendWhole',
        param: { IsReqFeed: true, FeedReq: { From: (page - 1) * size, Size: size } }
      }
    };
    return httpJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'post',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 20000
    }).then(function (d) {
      var feed = (d.playlist && d.playlist.data && d.playlist.data.FeedRsp &&
        d.playlist.data.FeedRsp.List) || [];
      return feed.map(function (x) {
        var b = (x && x.Playlist && x.Playlist.basic) || {};
        var c = (x && x.Playlist && x.Playlist.content) || {};
        return {
          id: String(b.tid || ''), name: decodeEntities(b.title || ''),
          img: b.cover || b.picurl || c.cover || c.picurl || '',
          author: decodeEntities((b.creator && b.creator.nick) || ''),
          play: String(b.listennum || ''), count: Number(b.songnum) || 0
        };
      }).filter(function (x) { return x.id; });
    });
  }

  // ------------------------------------------------------------------ 歌单详情
  function kwListDetail(id) {
    var url = 'http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=' + encodeURIComponent(id) +
      '&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1' +
      '&vipver=MUSIC_9.0.5.0_W1&newver=1';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/' } })
      .then(function (d) {
        var arr = d.musiclist || [];
        if (!arr.length) throw new Error('歌单为空或已下架');
        return arr.map(kwAnyTrack).filter(Boolean);
      });
  }

  function kgListDetail(id) {
    var url = 'http://mobilecdnbj.kugou.com/api/v3/special/song?specialid=' +
      encodeURIComponent(id) + '&page=1&pagesize=100&version=9108&plat=0&area_code=1';
    return httpJson(url, { headers: { 'User-Agent': UA } }).then(function (d) {
      var arr = (d.data && d.data.info) || [];
      if (!arr.length) throw new Error('歌单为空或已下架');
      return arr.map(kgTrack).filter(Boolean);
    });
  }

  function mgListDetail(id) {
    var url = 'https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0' +
      '?pageNo=1&pageSize=100&playlistId=' + encodeURIComponent(id);
    return httpJson(url, { headers: MG_HEADERS }).then(function (d) {
      if (d.code !== '000000') throw new Error(d.info || ('咪咕歌单 ' + d.code));
      var arr = (d.data && d.data.songList) || [];
      if (!arr.length) throw new Error('歌单为空或已下架');
      return arr.map(function (x) { return mgTrack(x); }).filter(Boolean);
    });
  }

  function wyListDetail(id) {
    var url = 'https://music.163.com/api/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000';
    return httpJson(url, { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } })
      .then(function (d) {
        var arr = (d.result && d.result.tracks) || [];
        if (!arr.length) throw new Error('歌单为空或已下架');
        return arr.map(wySongTrack).filter(Boolean);
      });
  }

  function txListDetail(id) {
    var payload = {
      comm: { cv: 1602, ct: 20 },
      req: {
        module: 'music.srfDissInfo.DissInfo',
        method: 'CgiGetDiss',
        param: { disstid: Number(id), song_begin: 0, song_num: 100, dirid: 0, tag: 1, onlysonglist: 1 }
      }
    };
    return httpJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'post',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 20000
    }).then(function (d) {
      var arr = (d.req && d.req.data && d.req.data.songlist) || [];
      if (!arr.length) throw new Error('歌单为空或已下架');
      return arr.map(txTrack).filter(Boolean);
    });
  }

  var BOARD_LOADERS = { kw: kwBoard, kg: kgBoard, mg: mgBoard, wy: wyBoard, tx: txBoard };
  var LIST_LOADERS = {
    kw: kwPlaylists, kg: kgPlaylists, mg: mgPlaylists, wy: wyPlaylists, tx: txPlaylists
  };
  var DETAIL_LOADERS = {
    kw: kwListDetail, kg: kgListDetail, mg: mgListDetail, wy: wyListDetail, tx: txListDetail
  };

  var ADAPTERS = {
    kw: { search: kwSearch },
    kg: { search: kgSearch },
    mg: { search: mgSearch },
    wy: { search: wySearch },
    tx: { search: txSearch }
  };

  /* 内置不可用时，用绑定到该平台的自定义音源兜底（音源也可以自带 search） */
  function viaSource(platformId, keyword, opts, errors) {
    var SR = window.LXSources;
    var apiId = SR && typeof SR.forPlatform === 'function' ? SR.forPlatform(platformId) : '';
    if (!apiId) {
      return Promise.resolve({
        tracks: [], provider: 'none', errors: errors, note: errors.length
          ? '平台接口暂不可用，且该平台未配置音源'
          : (ADAPTERS[platformId] ? '' : '该平台需要自定义音源提供搜索（接口需签名）')
      });
    }
    return SR.searchByApi(apiId, keyword, Object.assign({ platform: platformId }, opts)).then(function (r) {
      return {
        tracks: r.tracks, provider: 'source',
        errors: errors.concat(r.errors || []),
        note: errors.length ? '平台接口不可用，已改用该平台绑定的音源' : ''
      };
    });
  }

  function search(platformId, keyword, opts) {
    opts = opts || {};
    var kw = String(keyword || '').trim();
    if (!kw) return Promise.resolve({ tracks: [], provider: 'none', errors: [], note: '' });
    var ad = ADAPTERS[platformId];
    var page = opts.page || 1, limit = opts.limit || 30;
    if (!ad || !ad.search) return viaSource(platformId, kw, opts, []);
    return ad.search(kw, page, limit).then(function (tracks) {
      remember(tracks);
      if (tracks.length) return { tracks: tracks, provider: 'builtin', errors: [], note: '' };
      return viaSource(platformId, kw, opts, []);
    }).catch(function (e) {
      return viaSource(platformId, kw, opts, [String(e && e.message || e)]);
    });
  }

  function boards(platformId) {
    var list = BOARD_CATALOG[platformId] || [];
    return list.map(function (b) {
      return { id: platformId + ':' + b.id, name: b.name, bangid: b.id };
    });
  }

  function viaSourceBoard(platformId, bangid, opts, err) {
    var SR = window.LXSources;
    var apiId = SR && typeof SR.forPlatform === 'function' ? SR.forPlatform(platformId) : '';
    if (!apiId) {
      return {
        tracks: [], provider: 'none', errors: err ? [err] : [],
        note: '平台榜单接口不可用，且该平台未配置音源'
      };
    }
    return SR.leaderboardByApi(apiId, bangid, Object.assign({ platform: platformId }, opts))
      .then(function (r) {
        return {
          tracks: r.tracks || [], provider: 'source', errors: r.errors || [],
          note: r.tracks && r.tracks.length
            ? '平台榜单不可用，已改用该平台的音源'
            : '平台榜单不可用，音源也没有返回曲目'
        };
      });
  }

  function board(platformId, boardId, opts) {
    opts = opts || {};
    var bangid = String(boardId || '').split(':').pop();
    var fn = BOARD_LOADERS[platformId];
    if (!fn) {
      return Promise.resolve({
        tracks: [], provider: 'none', errors: [],
        note: '该平台暂无内置榜单'
      });
    }
    return fn(bangid, opts.page || 1, opts.limit || 100).then(function (tracks) {
      if (!tracks.length) throw new Error('榜单没有返回曲目');
      remember(tracks);
      return { tracks: tracks, provider: 'builtin', errors: [], note: '' };
    }).catch(function (e) {
      return Promise.resolve(viaSourceBoard(platformId, bangid, opts, String(e && e.message || e)));
    });
  }

  /* 推荐歌单：每个平台都有官方歌单广场，返回统一的卡片结构 */
  function recommendLists(platformId, page) {
    var fn = LIST_LOADERS[platformId];
    if (!fn) return Promise.resolve({ lists: [], note: '该平台暂不支持在线歌单' });
    return fn(page || 1).then(function (lists) {
      return { lists: lists || [], note: lists && lists.length ? '' : '该平台没有返回歌单' };
    });
  }

  /* 歌单详情：曲目同样进 external 池，才能被 D.byId 找到并播放 */
  function listDetail(platformId, listId) {
    var fn = DETAIL_LOADERS[platformId];
    if (!fn) return Promise.resolve({ tracks: [], note: '该平台暂不支持在线歌单' });
    return fn(listId).then(function (tracks) {
      remember(tracks);
      return { tracks: tracks || [], note: '' };
    });
  }

  window.LXPlatform = {
    LIST: PLATFORMS,
    byId: byId,
    nameOf: nameOf,
    hasBuiltinSearch: function (id) { return !!(ADAPTERS[id] && ADAPTERS[id].search); },
    hasBuiltinBoard: function (id) { return !!BOARD_LOADERS[id]; },
    hasPlaylists: function (id) { return !!LIST_LOADERS[id]; },
    boards: boards,
    board: board,
    recommendLists: recommendLists,
    listDetail: listDetail,
    search: search,
    http: http,
    httpJson: httpJson,
    fmt: fmt,
    decodeEntities: decodeEntities
  };
})();
