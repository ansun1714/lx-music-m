/* 音质管理（对齐 XCQ0607/lxserver 的 public/music/js/player/quality.js）
 *
 * 职责：
 *  - 定义音质优先级（最高 master 母带）与中文显示名；
 *  - 从曲目/平台接口给出的 qualitys 判断哪些档位「已声明可用」；
 *  - 提供下载/播放的音质选择、以及解析失败时的逐级降级链。
 *
 * 说明：平台的公开检索接口通常只声明到 flac/flac24bit/hires，
 * 更高的 master/atmos 等档位是否真有资源取决于你导入的音源脚本，
 * 因此界面把「未声明」的档位也列出来（标注待验证），允许用户主动尝试。
 */
(function () {
  'use strict';

  /* 从高到低 */
  var PRIORITY = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k'];
  var ORDER = PRIORITY.slice().reverse();

  var NAMES = {
    master: '母带音质',
    atmos_plus: '增强空间音频',
    atmos: '空间音频',
    hires: '高解析度',
    flac24bit: '24bit 无损',
    flac: '无损音质',
    '320k': '高音质',
    '192k': '192k 音质',
    '128k': '标准音质'
  };

  var SHORT = {
    master: '母带', atmos_plus: '增强空间', atmos: '空间音频', hires: '高解析',
    flac24bit: '24bit', flac: '无损', '320k': '320k', '192k': '192k', '128k': '128k'
  };

  var DESC = {
    master: '最高品质，通常为 24bit/96kHz 以上，体积很大',
    atmos_plus: '增强空间音频，需要音源支持',
    atmos: '空间音频，需要音源支持',
    hires: '高解析度，通常 24bit',
    flac24bit: '24bit 无损压缩',
    flac: '无损压缩，约 30–40MB/首',
    '320k': '接近无损的有损压缩',
    '192k': '中等码率',
    '128k': '体积最小，适合试听'
  };

  /* 各平台「可以选择」的音质（与 lxserver quality.js 保持一致） */
  var PLATFORM = {
    tx: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'],
    wy: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
    kw: ['128k', '320k', 'flac', 'flac24bit', 'hires'],
    kg: ['128k', '320k', 'flac', 'flac24bit', 'hires'],
    mg: ['128k', '320k', 'flac']
  };

  /* 旧版本留下的三档（standard/high/lossless）映射到标准 key */
  var LEGACY = { standard: '128k', high: '320k', lossless: 'flac' };

  function normalize(q) {
    if (!q) return '';
    var s = String(q).trim();
    return LEGACY[s] || s;
  }

  /* 曲目自身声明的音质：平台接口的 qualitys / 音源返回的 qualitys 或 types */
  /* 该曲目「绑定的音源」声明的档位。
   * 平台公开接口通常只到 flac24bit/hires，而用户导入的音源可能提供母带/空间音频，
   * 例如 sources.wy.qualitys = [...,'master']。这些档位要算作可用，否则菜单会误标灰。 */
  function sourceQualitys(track) {
    var SR = window.LXSources;
    if (!SR || typeof SR.trackSource !== 'function') return [];
    var a = null;
    try { a = SR.trackSource(track); } catch (e) { return []; }
    if (!a || !a.sources) return [];
    var decl = track && track.platform && a.sources[track.platform];
    if (!decl) return [];
    var list = decl.qualitys || decl.qualities || [];
    if (!Array.isArray(list)) list = Object.keys(list || {});
    var out = [];
    list.forEach(function (x) {
      var q = normalize(typeof x === 'string' ? x : (x && (x.type || x.quality)));
      if (q && PRIORITY.indexOf(q) >= 0 && out.indexOf(q) < 0) out.push(q);
    });
    return out;
  }

  function fromTrack(track) {
    if (!track) return [];
    var raw = track.qualitys || track.types ||
      (track._raw && (track._raw.qualitys || track._raw.types)) || [];
    if (!Array.isArray(raw)) raw = Object.keys(raw || {});
    var out = [];
    raw.forEach(function (x) {
      var q = normalize(typeof x === 'string' ? x : (x && (x.type || x.quality)));
      if (q && PRIORITY.indexOf(q) >= 0 && out.indexOf(q) < 0) out.push(q);
    });
    // 音源声明的档位并入（平台没声明但音源能给的，也算可用）
    sourceQualitys(track).forEach(function (q) { if (out.indexOf(q) < 0) out.push(q); });
    return out;
  }

  /* 平台可选项（由曲目的 platform 决定） */
  function platformList(track) {
    var pid = track && (track.platform || (track._raw && track._raw.source));
    return PLATFORM[pid] ? PLATFORM[pid].slice() : [];
  }

  /* 界面用：列出全部档位（高→低），标注该曲目是否声明可用 */
  function selectable(track) {
    var avail = fromTrack(track);
    var pf = platformList(track);
    return PRIORITY.map(function (q) {
      var declared = avail.indexOf(q) >= 0;
      var onPlatform = pf.length ? pf.indexOf(q) >= 0 : true;
      return {
        q: q,
        name: NAMES[q],
        short: SHORT[q],
        desc: DESC[q],
        declared: declared,          // 平台/音源明确说这首有该档
        onPlatform: onPlatform,      // 该平台是否在可选清单里
        available: declared || (!avail.length && onPlatform)
      };
    });
  }

  /* 单曲最佳档位：从偏好往下找第一个声明可用的 */
  function best(track, pref) {
    var avail = fromTrack(track);
    var start = PRIORITY.indexOf(normalize(pref) || '320k');
    if (start < 0) start = PRIORITY.indexOf('320k');
    if (!avail.length) return normalize(pref) || '320k';
    for (var i = start; i < PRIORITY.length; i++) {
      if (avail.indexOf(PRIORITY[i]) >= 0) return PRIORITY[i];
    }
    return avail.slice().sort(function (a, b) {
      return ORDER.indexOf(a) - ORDER.indexOf(b);
    })[0] || '128k';
  }

  /* 降级链：从当前档位往下，最多取 max 档（含自身） */
  function downgradeChain(q, track, max) {
    var from = PRIORITY.indexOf(normalize(q));
    if (from < 0) from = PRIORITY.indexOf('320k');
    var avail = fromTrack(track);
    var out = [];
    for (var i = from; i < PRIORITY.length; i++) {
      var cur = PRIORITY[i];
      // 曲目明确声明了其它档位时，跳过它没声明的档位（避免无谓请求）
      if (i > from && avail.length && avail.indexOf(cur) < 0) continue;
      out.push(cur);
      if (max && out.length >= max) break;
    }
    return out.length ? out : [normalize(q) || '128k'];
  }

  function lower(q, track) {
    var chain = downgradeChain(q, track, 0);
    return chain.length > 1 ? chain[1] : null;
  }

  function name(q) { return NAMES[normalize(q)] || String(q || '').toUpperCase(); }
  function short(q) { return SHORT[normalize(q)] || String(q || '').toUpperCase(); }
  function desc(q) { return DESC[normalize(q)] || ''; }
  /* 中文名已足够自解释的档位不再重复拼代号 */
  var NAME_ONLY = { master: 1, atmos_plus: 1, atmos: 1, hires: 1 };
  function label(q) {
    var k = normalize(q);
    return name(k) + (NAME_ONLY[k] ? '' : ' · ' + k.toUpperCase());
  }
  function isLossless(q) {
    return ['master', 'hires', 'flac24bit', 'flac', 'atmos', 'atmos_plus'].indexOf(normalize(q)) >= 0;
  }

  window.LXQuality = {
    PRIORITY: PRIORITY, ORDER: ORDER, NAMES: NAMES, SHORT: SHORT, DESC: DESC,
    PLATFORM: PLATFORM, LEGACY: LEGACY,
    normalize: normalize, fromTrack: fromTrack, platformList: platformList,
    sourceQualitys: sourceQualitys,
    selectable: selectable, best: best, downgradeChain: downgradeChain, lower: lower,
    name: name, short: short, desc: desc, label: label, isLossless: isLossless
  };
})();
