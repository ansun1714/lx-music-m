/* 歌词解析与滚动（v3.7.0）
 * 对齐 lxserver web 播放器 public/music/js/lyrics/lyric-parser.js 的解析口径：
 * - 时间标签 [mm:ss]、[mm:ss.xx]、[mm:ss:xx]、[hh:mm:ss.xx]，一行可带多个标签
 * - [offset:±ms] 偏移（正值表示歌词提前）
 * - 同一时间戳的第二段文本视为翻译行（官方用 extendedLyrics，这里合并进 trans）
 * - 去掉逐字标签 <mm:ss.xx>
 * 只负责解析、渲染与高亮，不做网络请求（歌词文本由 LXSources.lyric 提供）。
 */
(function () {
  'use strict';

  var TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
  var cache = {};
  var lastIdx = -1, lastTrack = '';

  function toSeconds(mm, ss, frac) {
    var f = frac == null ? 0 : Number('0.' + String(frac));
    return (Number(mm) || 0) * 60 + (Number(ss) || 0) + (isFinite(f) ? f : 0);
  }

  function parse(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var offset = 0;
    var mOff = src.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (mOff) offset = Number(mOff[1]) || 0;

    var lines = [], index = {}, plain = [];
    src.split('\n').forEach(function (raw) {
      var line = raw.replace(WORD_TAG, '').trim();
      if (!line) return;
      var stamps = [], m;
      TIME_TAG.lastIndex = 0;
      while ((m = TIME_TAG.exec(line))) {
        stamps.push(toSeconds(m[1], m[2], m[3]));
      }
      var content = line.replace(TIME_TAG, '').trim();
      if (!stamps.length) {
        // 没有时间轴：当作纯文本歌词（有些音源只给整段文本）
        if (content && !/^\[[a-z]+:/i.test(content)) plain.push(content);
        return;
      }
      if (!content) return;
      stamps.forEach(function (t) {
        var key = t.toFixed(2);
        if (index[key]) {
          // 同一时间戳的第二行通常是翻译
          if (!index[key].trans) index[key].trans = content;
          return;
        }
        var item = { t: Math.max(0, t - offset / 1000), text: content, trans: '' };
        index[key] = item;
        lines.push(item);
      });
    });

    lines.sort(function (a, b) { return a.t - b.t; });
    return { lines: lines, plain: plain, offset: offset, hasTime: lines.length > 0 };
  }

  function mergeTranslation(parsed, transParsed) {
    if (!parsed || !transParsed || !transParsed.lines.length) return parsed;
    var byTime = {};
    transParsed.lines.forEach(function (l) { byTime[l.t.toFixed(2)] = l.text; });
    parsed.lines.forEach(function (l) {
      if (!l.trans) {
        var v = byTime[l.t.toFixed(2)];
        if (v) l.trans = v;
      }
    });
    return parsed;
  }

  /* 当前应高亮的行：最后一个 t <= time 的行；还没到第一行返回 -1 */
  function indexAt(lines, time) {
    if (!lines || !lines.length) return -1;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= time + 0.02) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 渲染到容器。有时间的行可点击跳转，纯文本只做展示 */
  function render(container, parsed, trackId) {
    if (!container) return;
    lastIdx = -1;
    lastTrack = trackId || '';
    if (!parsed || (!parsed.lines.length && !parsed.plain.length)) {
      var why = '';
      try {
        var SR = window.LXSources;
        var dg = SR && typeof SR.lyricDiag === 'function' ? SR.lyricDiag() : [];
        if (dg && dg.length) {
          var last = dg[dg.length - 1];
          why = '<span class="lc-why">（' + esc(last.src + ': ' + (last.ok ? '内容为空' : last.detail)) + '）</span>';
        }
      } catch (e) {}
      container.innerHTML = '<p class="lc-empty">暂无歌词' + why + '</p>';
      return;
    }
    if (!parsed.hasTime) {
      container.innerHTML = '<div class="lc-plain">' + parsed.plain.map(function (l) {
        return '<p>' + esc(l) + '</p>';
      }).join('') + '</div>';
      return;
    }
    container.innerHTML = parsed.lines.map(function (l, i) {
      return '<p class="lc-line' + (i === 0 ? ' on' : '') + '" data-act="lyric-seek" data-t="' +
        l.t.toFixed(2) + '"><span class="lc-main">' + esc(l.text) + '</span>' +
        (l.trans ? '<span class="lc-sub">' + esc(l.trans) + '</span>' : '') + '</p>';
    }).join('');
  }

  /* 按播放时间同步高亮与滚动；返回当前行号 */
  function sync(container, parsed, time) {
    if (!container || !parsed || !parsed.hasTime) return -1;
    var idx = indexAt(parsed.lines, time);
    if (idx === lastIdx) return idx;
    var ps = container.querySelectorAll('.lc-line');
    if (!ps.length) return idx;
    for (var i = 0; i < ps.length; i++) ps[i].classList.toggle('on', i === idx);
    lastIdx = idx;
    var cur = ps[idx];
    if (cur) {
      var top = cur.offsetTop - container.clientHeight * 0.58 + cur.offsetHeight / 2;
      try { container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); }
      catch (e) { container.scrollTop = Math.max(0, top); }
    }
    return idx;
  }

  /* 歌词文本获取（带缓存）。音源不给歌词时返回 null，不抛错。 */
  function load(track) {
    if (!track || !track.id) return Promise.resolve(null);
    if (cache[track.id]) return Promise.resolve(cache[track.id]);
    var SR = window.LXSources;
    if (!SR || typeof SR.lyric !== 'function') return Promise.resolve(null);
    return SR.lyric(track).then(function (res) {
      if (!res || !res.lyric) return null;
      var parsed = parse(res.lyric);
      if (res.tlyric) mergeTranslation(parsed, parse(res.tlyric));
      if (!parsed.lines.length && !parsed.plain.length) return null;
      cache[track.id] = parsed;
      return parsed;
    }).catch(function () { return null; });
  }

  function clear(id) {
    if (id) delete cache[id];
    else cache = {};
  }

  window.LXLyr = {
    parse: parse,
    indexAt: indexAt,
    render: render,
    sync: sync,
    load: load,
    clear: clear,
    hasTime: function (parsed) { return !!(parsed && parsed.hasTime); }
  };
})();
