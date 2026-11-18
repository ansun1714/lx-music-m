/* LX Music v1.9.2 界面与功能复现 · 主逻辑
 * 结构对齐原版：抽屉导航 + 42px Header + 6 个可横向切换视图 + 底部 PlayerBar。
 * 全局契约 window.LXApp 在脚本加载时就发布（早于首次 render），
 * 避免扩展模块在冷启动时读到未定义对象。
 */
(function () {
  'use strict';

  var D = window.LXData, DL = window.LXDownload, T = window.LXTheme, SR = window.LXSources;
  var Q = window.LXQuality, Snd = window.LXSound, Lyr = window.LXLyr;
  /* 真机诊断日志：HAP 走原生桥写 hilog（A00D00 / LXMusicBridge），浏览器只看 console；
   * 同时在内存里留一份环形缓冲，供「导出诊断日志」汇总成文件，免去每次连 hdc 抓日志。 */
  var devLog = [];
  window.LXdlog = function (tag, msg) {
    var line = '[' + tag + '] ' + msg;
    try {
      devLog.push({ t: new Date().toLocaleTimeString('zh-CN'), tag: String(tag), msg: String(msg) });
      if (devLog.length > 500) devLog.shift();
    } catch (e) {}
    try { if (window.EchoBridge && typeof EchoBridge.jsLog === 'function') EchoBridge.jsLog(tag, String(msg)); } catch (e) {}
    try { console.log('[LXDIAG]' + line); } catch (e) {}
  };
  /* 未捕获异常与未处理 Promise 拒绝也进诊断缓冲，避免崩溃现场只留在 hilog 里 */
  try {
    window.addEventListener('error', function (ev) {
      var msg = (ev && ev.message) || 'unknown error';
      if (ev && ev.filename) msg += ' @ ' + ev.filename + ':' + (ev.lineno || '');
      devLog.push({ t: new Date().toLocaleTimeString('zh-CN'), tag: 'error', msg: String(msg) });
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      var msg = r ? (r.message || String(r)) : 'unhandled rejection';
      devLog.push({ t: new Date().toLocaleTimeString('zh-CN'), tag: 'reject', msg: String(msg) });
    });
  } catch (e) {}
  var KEY = 'lx_state_v1';
  var ICON = {
    nav_search: 'search-2', nav_songlist: 'album', nav_top: 'leaderboard',
    nav_love: 'love', nav_setting: 'setting', nav_download: 'download-2'
  };
  var NAVS = [
    { id: 'nav_search' }, { id: 'nav_songlist' }, { id: 'nav_top' },
    { id: 'nav_love' }, { id: 'nav_download' }, { id: 'nav_setting' }
  ];
  var MODES = ['listLoop', 'random', 'list', 'singleLoop'];
  var MODE_ICON = { listLoop: 'list-loop', random: 'list-random', list: 'list-order', singleLoop: 'single-loop' };
  var MODE_TEXT = { listLoop: '列表循环', random: '随机播放', list: '顺序播放', singleLoop: '单曲循环' };

  function t(k, fb) { return (window.LXI18N && window.LXI18N[k]) || fb || k; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function fmt(sec) { return D.fmt(Math.max(0, Math.floor(sec || 0))); }
  function icon(n, cls) { return '<i class="lx-icon lx-' + n + (cls ? ' ' + cls : '') + '"></i>'; }

  var S = {
    nav: 'nav_search', theme: 'green',
    // v3.3.0：平台负责搜索/榜单；自定义音源是该平台的账号凭证（解析播放/下载地址）
    platform: 'kw',
    search: { text: '', results: null, tipOpen: true, searching: false, apiNote: '' },
    apiSource: '',
    history: [], hotLiked: {},
    songlistTag: '推荐', boardId: '',
    boardTracks: null, boardLoading: false, boardNote: '', boardSource: '',
    lists: [
      { id: 'default', name: '试听列表', trackIds: [] },
      { id: 'love', name: '我的收藏', trackIds: [] },
      { id: 'temp', name: '临时列表', trackIds: [] },
      { id: 'download', name: '下载', trackIds: [] },
      { id: 'play_later', name: '稍后播放', trackIds: [] }
    ],
    activeList: 'default',
    queue: [], index: -1, playing: false, mode: 'listLoop', rate: 1, volume: 0.8,
    selected: [], multi: false,
    settings: {
      drawerPosition: 'left', showBackBtn: true, showExitBtn: true,
      homePageScroll: true, autoHidePlayBar: false, statusBarPadding: true,
      isAutoTheme: false, showAlbumName: true, showInterval: true,
      fontSize: 14, savePlayTime: true, autoCleanPlayedList: false,
      lyricFontSize: 16, lyricAlign: 'center', showTranslation: true,
      showRoma: true, s2t: false, desktopLyric: false, fontShadow: false,
      playbackRate: 1, offline: false, audioQuality: '320k', logUserApi: false,
      downloadQuality: '320k', dlParallel: 2, dlAuto: true, downloadDir: 'Download/LX Music',
    exportDirUri: '',
      showLyric: true
    },
    sync: { addr: '', port: '', code: '', connected: false, log: [] },
    backup: { mode: 'merge' },
    commentLikes: {}, commentTab: 'hot',
    progress: {}, errorLog: [],
    overlay: null, overlayId: ''
  };

  var engine = new window.LXEngine();
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    }, 120);
  }
  // 鸿蒙侧「选择下载文件夹」的回调：拿到目录 URI 后记住，之后下载完成直接写入、不再弹窗
  window.LXSaveDir = {
    onDir: function (uri) {
      S.settings.exportDirUri = String(uri || '');
      save();
      try { if (typeof renderView === 'function') renderView(); } catch (e) {}
    },
    onFail: function (msg) {
      try { toast(msg || '选择文件夹失败'); } catch (e) {}
    }
  };
  function restore() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return; }
    if (!raw) return;
    ['nav', 'theme', 'platform', 'apiSource', 'history', 'hotLiked', 'songlistTag', 'boardId', 'lists',
      'activeList', 'queue', 'index', 'mode', 'rate', 'volume', 'selected',
      'sync', 'backup', 'commentLikes', 'commentTab', 'progress', 'errorLog'].forEach(function (k) {
      if (raw[k] !== undefined) S[k] = raw[k];
    });
    if (raw.search) Object.keys(raw.search).forEach(function (k) { S.search[k] = raw.search[k]; });
    if (raw.settings) Object.keys(raw.settings).forEach(function (k) { S.settings[k] = raw.settings[k]; });
    S.playing = false;
    S.overlay = null;
  }

  /* v3.2.0 数据迁移：内置演示曲目（kw_0…kw_47）已全部移除。
   * 这里清掉旧版本残留在播放列表、队列、进度、下载队列里的引用；
   * 用户自己音源产生的 api_* 曲目与导入的音源脚本不受影响。 */
  var DATA_VERSION = 3;
  function migrate() {
    var v = 0;
    try { v = Number(localStorage.getItem('lx_data_version') || 0); } catch (e) { v = 0; }
    if (v >= DATA_VERSION) return;
    function isDemo(id) { return /^kw_\d+$/.test(String(id || '')); }
    (S.lists || []).forEach(function (l) {
      l.trackIds = (l.trackIds || []).filter(function (id) { return !isDemo(id); });
    });
    S.queue = (S.queue || []).filter(function (id) { return !isDemo(id); });
    if (S.index >= S.queue.length) S.index = 0;
    Object.keys(S.progress || {}).forEach(function (id) { if (isDemo(id)) delete S.progress[id]; });
    S.history = [];
    S.search.results = null;
    S.search.text = '';
    S.search.apiNote = '';
    S.selected = [];
    S.boardTracks = null; S.boardNote = ''; S.boardId = '';
    if (!S.platform) S.platform = 'kw';
    try { DL.purgeDemo(); } catch (e) {}
    try { localStorage.setItem('lx_data_version', String(DATA_VERSION)); } catch (e) {}
  }

  // ---------------------------------------------------------------- 通用 UI
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast'); if (!el) return;
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2200);
  }
  function modal(title, body, actions) {
    var root = $('modalRoot'); if (!root) return;
    var html = '<div class="modal"><h3>' + esc(title) + '</h3><div>' + body + '</div><div class="modal-acts">';
    (actions || [{ text: t('close', '关闭'), act: 'close-modal' }]).forEach(function (a) {
      html += '<button class="btn ' + (a.primary ? 'primary' : '') + '" data-act="' + a.act + '"' +
        (a.id ? ' data-id="' + esc(a.id) + '"' : '') + '>' + esc(a.text) + '</button>';
    });
    html += '</div></div>';
    root.innerHTML = html; root.classList.remove('hidden');
  }
  function closeModal() { var r = $('modalRoot'); if (r) { r.classList.add('hidden'); r.innerHTML = ''; } }
  function exportFile(name, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      toast(t('setting_backup_export_success', '导出成功'));
    } catch (e) { toast(String(e.message || e)); }
  }
  /* ---------------------------------------------------------------- 本地文件选择
   * 真机 bug 修复（v3.1.1）：原实现创建 <input type=file> 后不挂 DOM 直接 .click()，
   * 桌面浏览器可用，但 Android WebView 会忽略游离元素的 click —— 表现为「点了没反应」，
   * 且没有 change / FileReader 回调，也没有任何提示。
   * 现改为：Android 一律走原生桥 EchoBridge.pickScript()（Java 直接读文件并分块回传文本），
   * 彻底绕开 onShowFileChooser / content:// / FileReader；浏览器保留加固后的 input 回退。
   */
  var filePick = {
    _cb: null, _name: '', _buf: null, _active: false, _timer: 0,
    __onStart: function (name) {
      this._name = name || 'script.js'; this._buf = []; this._active = true;
      if (this._timer) clearTimeout(this._timer);
      var self = this;
      // 只在 Java 真正开始回传时计超时（分块传输应在 30s 内完成）；
      // 用户慢慢挑文件不应被超时打断
      this._timer = setTimeout(function () { self.__onFail('接收文件超时，请重试'); }, 30000);
    },
    __onChunk: function (s) { if (this._active) this._buf.push(s); },
    __onDone: function (name) {
      if (!this._active) return;
      this._active = false;
      if (this._timer) clearTimeout(this._timer);
      var text = this._buf.join(''); this._buf = [];
      ackPick();
      this._finish(text, name || this._name);
    },
    __onFail: function (msg) {
      if (!this._active) return;
      this._active = false;
      if (this._timer) clearTimeout(this._timer);
      this._buf = [];
      ackPick();
      toast(msg || '未选择文件');
    },
    _finish: function (text, name) {
      if (text) text = text.replace(/^\uFEFF/, '');
      if (!text || !text.trim()) { toast('文件内容为空，或不是文本格式的音源脚本'); return; }
      if (this._cb) { var cb = this._cb; this._cb = null; cb(text, name); return; }
      // 选择文件期间页面被系统回收并重建：回调已丢失，仍按默认流程导入，避免结果石沉大海
      var res = SR.importScript(text, 'local:' + name);
      toast(res.ok ? t('user_api_import_success_tip', '导入成功 🎉') :
        (res.message || t('user_api_add_failed_tip', '无效的自定义源文件')));
      render();
      if (S.overlay === 'userapi') renderOverlay();
    },
    pick: function (cb, accept) {
      var B = window.EchoBridge;
      this._cb = cb;
      if (B && typeof B.pickScript === 'function') {
        // 先进入等待态（不启动计时器），保证「取消 / 读取失败 / 无选择器」都有可见反馈
        this._active = true; this._buf = [];
        try { B.pickScript(); return; }
        catch (e) { this.__onFail('无法打开文件选择器：' + (e && e.message || e)); return; }
      }
      this._fallback(cb, accept);
    },
    _fallback: function (cb, accept) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept || '.json,.js,.txt';
      // 必须挂载到 DOM；不用 display:none（部分 WebView 对不可见 input 同样忽略 click）
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(inp);
      var settled = false, fbTimer = 0;
      function cleanup() {
        if (fbTimer) { clearTimeout(fbTimer); fbTimer = 0; }
        try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch (e) {}
      }
      inp.addEventListener('change', function () {
        settled = true; cleanup();
        var f = inp.files && inp.files[0];
        if (!f) { toast('未选择文件'); return; }
        var r = new FileReader();
        r.onload = function () { cb(String(r.result || ''), f.name); };
        r.onerror = function () { toast('读取文件失败（' + ((r.error && r.error.name) || '未知错误') + '）'); };
        try { r.readAsText(f); } catch (e) { toast('读取文件失败：' + (e && e.message || e)); }
      });
      fbTimer = setTimeout(function () { if (!settled) cleanup(); }, 180000);
      try { inp.click(); }
      catch (e) { cleanup(); toast('无法打开文件选择器：' + (e && e.message || e)); }
    }
  };
  function ackPick() {
    try { if (window.EchoBridge && EchoBridge.pickScriptAck) EchoBridge.pickScriptAck(); } catch (e) {}
  }
  window.LXFilePick = filePick;
  function pickFile(cb, accept) { return filePick.pick(cb, accept); }
  function menu(items, x, y) {
    var el = $('contextMenu'); if (!el) return;
    el.innerHTML = items.map(function (i) {
      if (i.head) {
        return '<div class="ctx-head"><b>' + esc(i.text) + '</b>' +
          (i.sub ? '<span>' + esc(i.sub) + '</span>' : '') + '</div>';
      }
      return '<button data-act="' + i.act + '"' + (i.id ? ' data-id="' + esc(i.id) + '"' : '') +
        (i.pid ? ' data-pid="' + esc(i.pid) + '"' : '') +
        (i.q ? ' data-q="' + esc(i.q) + '"' : '') +
        (i.dim ? ' class="dim"' : '') + '>' +
        '<span>' + esc(i.text) + '</span>' +
        (i.tail ? '<em>' + esc(i.tail) + '</em>' : '') + '</button>';
    }).join('');
    el.classList.toggle('tall', items.length > 8);

    /* v3.13.7：原来在 hidden 状态下就量 offsetHeight（=0），所以「贴底那一行」的菜单
     * 永远不会往上翻，直接伸出屏幕外被裁掉。现在先让它参与布局（visibility:hidden），
     * 量到真实宽高再定位：下方放不下就翻到触点上方，左右也按真实宽度夹住。 */
    el.style.visibility = 'hidden';
    el.classList.remove('hidden');
    var vw = window.innerWidth || 360, vh = window.innerHeight || 700;
    var w = el.offsetWidth || 196, h = el.offsetHeight || 0;
    var left = Math.max(8, Math.min(x || 60, Math.max(8, vw - w - 8)));
    var top = (y || 120);
    if (top + h + 8 > vh) top = top - h - 8;          // 下方不够 → 翻到触点上方
    top = Math.max(8, Math.min(top, Math.max(8, vh - h - 8)));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.visibility = '';
  }
  function closeMenu() { var el = $('contextMenu'); if (el) el.classList.add('hidden'); }

  // ---------------------------------------------------------------- 抽屉 / Header
  function renderNav() {
    var host = $('navMenus'); if (!host) return;
    var badge = DL.stats().done;
    host.innerHTML = NAVS.map(function (n) {
      var label = n.id === 'nav_download' ? t('download', '下载') : t(n.id);
      return '<button class="nav-item ' + (S.nav === n.id ? 'active' : '') + '" data-act="nav" data-id="' + n.id + '">' +
        '<span class="ni-icon">' + icon(ICON[n.id]) + '</span>' +
        '<span class="ni-text">' + esc(label) + '</span>' +
        (n.id === 'nav_download' && badge ? '<em class="nav-badge">' + badge + '</em>' : '') +
        '</button>';
    }).join('');
    var foot = $('drawerFoot');
    if (foot) foot.innerHTML =
      (S.settings.showBackBtn ? '<button class="nav-item" data-act="back-home"><span class="ni-icon">' +
        icon('home') + '</span><span class="ni-text">' + esc(t('back_home', '返回桌面')) + '</span></button>' : '') +
      (S.settings.showExitBtn ? '<button class="nav-item" data-act="exit-app"><span class="ni-icon">' +
        icon('exit2') + '</span><span class="ni-text">' + esc(t('nav_exit', '退出应用')) + '</span></button>' : '');
  }
  function openDrawer(open) {
    var d = $('drawer'), m = $('drawerMask');
    if (d) d.classList.toggle('open', open);
    if (m) m.classList.toggle('show', open);
  }
  function renderHeader() {
    var el = $('headerTitle'); if (!el) return;
    el.textContent = S.nav === 'nav_download' ? t('download', '下载') : t(S.nav);
    var ex = $('headerExtra');
    if (!ex) return;
    /* v3.13.5：搜索页右上角原来的「歌曲 / 歌单」两个标签只是切换自己的高亮，
     * doSearch 从来不读 S.search.type —— 点了没有任何实际效果，属于死控件，整块删除。 */
    ex.innerHTML = S.nav === 'nav_download'
      ? '<button class="h-btn" data-act="dl-clear-finished" title="清理已完成">' + icon('eraser') + '</button>'
      : '';
  }

  // ---------------------------------------------------------------- 歌曲行
  function trackRow(tr, i, opts) {
    opts = opts || {};
    var cur = currentTrack();
    var playing = cur && cur.id === tr.id;
    var checked = S.multi && S.selected.indexOf(tr.id) >= 0;
    return '<div class="m-row ' + (playing ? 'playing' : '') + '" data-act="play-row" data-id="' + esc(tr.id) + '">' +
      (S.multi ? '<input class="chk" type="checkbox" data-act="select" data-id="' + esc(tr.id) + '"' +
        (checked ? ' checked' : '') + '>' :
        '<span class="m-idx">' + (playing ? icon('volume-higt') : (i + 1)) + '</span>') +
      '<div class="m-main"><div class="m-name">' + esc(tr.name) + '</div>' +
      '<div class="m-sub">' + esc(tr.singer) + (S.settings.showAlbumName ? ' · ' + esc(tr.album) : '') + '</div></div>' +
      '<span class="m-src">' + esc(tr.sourceLabel || D.sourceName(tr.source)) + '</span>' +
      (S.settings.showInterval ? '<span class="m-meta">' + esc(tr.time) + '</span>' : '') +
      (DL.isDone(tr.id) ? '<span class="m-act" title="已下载">' + icon('download-2') + '</span>' : '') +
      '<button class="m-act" data-act="track-menu" data-id="' + esc(tr.id) + '">' + icon('dots-vertical') + '</button>' +
      '</div>';
  }
  function trackList(tracks, opts) {
    tracks = (tracks || []).filter(Boolean);   // 曲目被移除后 lists 里可能留有失效 id
    if (!tracks.length) return '<div class="empty">' + icon('album') + esc(t('list_no_data', '暂无数据')) + '</div>';
    return '<div class="music-list">' + tracks.map(function (tr, i) { return trackRow(tr, i, opts); }).join('') + '</div>';
  }
  function currentTrack() { return S.queue.length ? D.byId(S.queue[S.index]) : null; }
  function contextIds() {
    // 歌单详情是浮层，播放全部 / 多选要以浮层里的曲目为准
    if (S.overlay === 'songlist' && PL.detail && PL.detail.tracks && PL.detail.tracks.length)
      return PL.detail.tracks.map(function (x) { return x.id; });
    // 榜单目录同样是浮层（v3.13.4），播放上下文就是目录里的曲目
    if (S.overlay === 'boardlist' && S.boardTracks && S.boardTracks.length)
      return S.boardTracks.map(function (x) { return x.id; });
    if (S.nav === 'nav_search' && S.search.results) return S.search.results.map(function (x) { return x.id; });
    // 排行榜与歌单的曲目也来自音源，不再用内置曲库兜底
    if (S.nav === 'nav_top' && S.boardTracks) return S.boardTracks.map(function (x) { return x.id; });
    var l = S.lists.filter(function (x) { return x.id === S.activeList; })[0];
    if (l && l.trackIds.length) return l.trackIds.slice();
    return [];
  }

  // ---------------------------------------------------------------- 视图：搜索
  /* 平台选择条：主界面的「各个平台选择」入口。
   * 带圆点表示该平台已绑定音源（账号），不改变行为只作状态提示。 */
  function platformBar(act) {
    var P = window.LXPlatform;
    return '<div class="pf-bar">' + P.LIST.map(function (p) {
      var bound = !!SR.forPlatform(p.id);
      return '<button class="pf-chip' + (S.platform === p.id ? ' on' : '') + (bound ? ' bound' : '') +
        '" data-act="' + (act || 'set-platform') + '" data-id="' + p.id + '">' +
        esc(p.short) + '<i></i></button>';
    }).join('') + '</div>';
  }

  function viewSearch() {
    var h = platformBar();
    h += '<div class="searchbar">' +
      '<input class="search-input" id="searchInput" placeholder="' + esc(t('search__welcome', '搜我所想~~😉')) +
      '" value="' + esc(S.search.text) + '">' +
      '<button class="search-go" data-act="do-search">' + icon('search-2') + '</button></div>';
    if (S.search.results) {
      h += '<div class="list-header"><button class="btn sm primary" data-act="play-all">' +
        esc(t('play_all', '播放全部')) + '</button><button class="btn sm" data-act="multi-toggle">' +
        esc(t('multi_select', '多选')) + '</button><span style="flex:1"></span>' +
        '<span style="font-size:calc(11px * var(--ui-fs));color:var(--c-font-label)">' + S.search.results.length + ' 首</span></div>';
      if (S.multi) h += multiBar();
      if (S.search.apiNote) h += '<div class="api-note">' + icon('setting') + esc(S.search.apiNote) + '</div>';
      h += trackList(S.search.results);
    } else {
      h += '<div class="welcome">' + esc(t('search__welcome', '搜我所想~~😉')) + '</div>';
      if (S.search.searching) {
        h += '<div class="api-note">' + icon('search-2') + esc(S.search.apiNote || '正在搜索…') + '</div>';
      }
      h += '<div class="tip-section"><div class="tip-title">' + esc(t('search_history_search', '历史搜索')) +
        '</div><div class="chips">' + (S.history.length
          ? S.history.slice(0, 10).map(function (w) {
              return '<button class="chip" data-act="quick-search" data-id="' + esc(w) + '">' + esc(w) + '</button>';
            }).join('')
          : '<span style="font-size:calc(12px * var(--ui-fs));color:var(--c-font-label)">暂无历史记录</span>') + '</div></div>';
      if (D.HOT_WORDS.length) {
        h += '<div class="tip-section"><div class="tip-title">' + esc(t('search_hot_search', '热门搜索')) +
          '</div><div class="chips">' + D.HOT_WORDS.map(function (w) {
            return '<button class="chip" data-act="quick-search" data-id="' + esc(w) + '">' + esc(w) + '</button>';
          }).join('') + '</div></div>';
      }
      h += '<div class="tip-section"><div class="tip-title">' + esc(LXPlatform.nameOf(S.platform)) + ' · 平台状态</div>' +
        '<div class="api-note">' + icon('setting') + esc(apiHint()) + '</div></div>';
    }
    return h;
  }

  /* 说明当前平台「能不能搜」「能不能播」，以及由谁提供播放地址 */
  function apiHint() {
    var pid = S.platform, name = LXPlatform.nameOf(pid);
    var v = SR.verifyPlatform(pid);
    var builtin = LXPlatform.hasBuiltinSearch(pid);
    if (v.ok) {
      return name + '：搜索由平台提供，播放/下载地址由音源「' + v.api.name + '」提供（验证通过）。';
    }
    if (builtin) {
      return name + ' 可直接搜索；在线收听/下载需要导入声明了 “' + pid + '” 的音源。' + v.message;
    }
    return name + ' 需要音源提供搜索与地址。' + v.message;
  }

  function multiBar() {
    return '<div class="multi-bar"><button class="btn sm" data-act="select-all">' +
      esc(t('select_all', '全选')) + '</button><span style="font-size:calc(12px * var(--ui-fs))">已选 ' + S.selected.length + '</span>' +
      '<span style="flex:1"></span><button class="btn sm" data-act="download-selected">' +
      icon('download-2') + ' ' + esc(t('download', '下载')) + '</button>' +
      '<button class="btn sm" data-act="add-selected">' + esc(t('add_to', '添加到...')) + '</button>' +
      '<button class="btn sm" data-act="multi-exit">' + esc(t('cancel', '取消')) + '</button></div>';
  }
  /* 搜索：平台负责出结果，音源只在平台接口不可用/需要签名时兜底提供搜索。
   * 任何空结果都必须带原因，不再静默。 */
  function doSearch(kw) {
    var q = String(kw == null ? S.search.text : kw).trim();
    if (!q) { S.search.results = null; renderView(); return; }
    S.search.text = q;
    S.history = [q].concat(S.history.filter(function (x) { return x !== q; })).slice(0, 20);

    var pid = S.platform;
    S.search.searching = true;
    S.search.results = null;
    S.search.apiNote = '正在从「' + LXPlatform.nameOf(pid) + '」搜索…';
    renderView();

    LXPlatform.search(pid, q, { limit: 30 }).then(function (r) {
      if (S.platform !== pid) return;        // 搜索期间切了平台
      S.search.searching = false;
      S.search.results = r.tracks;
      S.search.apiNote = searchNote(r, pid);
      S.selected = []; S.multi = false;
      save(); renderView();
      toast('「' + LXPlatform.nameOf(pid) + '」找到 ' + r.tracks.length + ' 首');
    }).catch(function (e) {
      if (S.platform !== pid) return;
      S.search.searching = false;
      S.search.results = [];
      S.search.apiNote = '搜索失败：' + String(e && e.message || e);
      renderView();
    });
  }

  function searchNote(r, pid) {
    if (!r.tracks.length) {
      return r.note || ('没有结果；若「' + LXPlatform.nameOf(pid) + '」需要音源提供搜索，请先到 设置 → 平台账号 绑定音源');
    }
    var via = r.provider === 'source'
      ? '由该平台绑定的音源提供搜索'
      : '来自' + LXPlatform.nameOf(pid) + '内置接口';
    if (r.note) via = r.note + ' · ' + via;
    if (r.errors && r.errors.length) via += ' · ' + r.errors[0];
    return r.tracks.length + ' 首 · ' + via;
  }

  // ---------------------------------------------------------------- 视图：歌单 / 排行榜
  /* v3.9.0：歌单改为「平台推荐歌单」——酷我/酷狗/咪咕/网易/QQ 各有官方歌单广场，
   * 卡片点进去再拉歌单曲目。数据只在内存（PL），不写进 localStorage，
   * 否则整份歌单曲目会被反复序列化，既慢又会顶爆 5MB 配额。 */
  var PL = {
    platform: '', page: 1, lists: null, loading: false, note: '',
    detail: null, detailLoading: false, detailNote: ''
  };

  function viewSongList() {
    var P = window.LXPlatform, pf = S.platform;
    var h = platformBar('set-list-platform');
    h += '<div class="sec-head"><h3>' + esc(P.nameOf(pf) + ' · ' + t('nav_songlist', '歌单')) + '</h3>' +
      '<button class="btn sm" data-act="pl-refresh">' +
      esc(t('refresh', '换一批')) + '</button></div>';
    if (PL.loading) {
      h += '<div class="api-note">' + icon('search-2') + '正在加载「' + esc(P.nameOf(pf)) + '」推荐歌单…</div>';
    } else if (PL.note) {
      h += '<div class="api-note">' + icon('setting') + esc(PL.note) + '</div>';
    }
    var lists = PL.lists || [];
    if (!lists.length) {
      if (!PL.loading) {
        h += '<div class="empty">' + icon('album') +
          (PL.note ? '暂时没有可显示的歌单' : '暂无歌单') + '</div>';
      }
      return h;
    }
    h += '<div class="grid">' + lists.map(function (l) {
      // 有封面时不再往封面上叠标题（下方已有名称），避免两行文字挤在一起
      return '<div class="card" data-act="open-songlist" data-id="' + esc(l.id) + '">' +
        '<div class="card-cover pl-cover-card" style="--card-color:' +
        ((P.byId(pf) || {}).color || '#4daf7c') + '">' +
        (l.img
          ? '<img src="' + esc(l.img) + '" alt="" loading="lazy" ' +
            'onerror="this.style.display=\'none\'">'
          : '<span>' + esc(String(l.name || '').slice(0, 10)) + '</span>') +
        '</div>' +
        '<div class="card-body"><div class="card-name">' + esc(l.name) + '</div>' +
        '<div class="card-sub">' +
        esc([l.count ? l.count + ' 首' : '', l.author || ''].filter(Boolean).join(' · ')) +
        '</div></div></div>';
    }).join('') + '</div>';
    return h;
  }

  function loadSongLists(page) {
    var pf = S.platform;
    if (PL.platform !== pf) { PL.lists = null; PL.page = 1; PL.platform = pf; }
    if (page) PL.page = page;
    PL.loading = true; PL.note = '';
    renderView();
    return LXPlatform.recommendLists(pf, PL.page).then(function (r) {
      if (S.platform !== pf) return;
      PL.loading = false;
      PL.lists = r.lists || [];
      PL.note = PL.lists.length ? '' : (r.note || '该平台没有返回歌单');
      if (S.nav === 'nav_songlist') renderView();
    }).catch(function (e) {
      if (S.platform !== pf) return;
      PL.loading = false; PL.lists = []; PL.page = 1;
      PL.note = '歌单加载失败：' + String(e && e.message || e);
      if (S.nav === 'nav_songlist') renderView();
    });
  }

  function openSongList(id) {
    var pf = S.platform;
    var item = (PL.lists || []).filter(function (x) { return x.id === id; })[0] ||
      { id: id, name: '歌单', img: '', author: '', play: '', count: 0 };
    PL.detail = {
      id: id, name: item.name, img: item.img, author: item.author,
      play: item.play, count: item.count, tracks: []
    };
    PL.detailLoading = true; PL.detailNote = '';
    openOverlay('songlist', id);
    LXPlatform.listDetail(pf, id).then(function (r) {
      if (!PL.detail || PL.detail.id !== id) return;   // 已关掉或换了歌单
      PL.detailLoading = false;
      PL.detail.tracks = r.tracks || [];
      PL.detail.count = PL.detail.count || PL.detail.tracks.length;
      PL.detailNote = PL.detail.tracks.length ? '' : (r.note || '该歌单没有返回曲目');
      if (S.overlay === 'songlist') renderOverlay();
    }).catch(function (e) {
      if (!PL.detail || PL.detail.id !== id) return;
      PL.detailLoading = false;
      PL.detailNote = '歌单加载失败：' + String(e && e.message || e);
      if (S.overlay === 'songlist') renderOverlay();
    });
  }
  function currentBoards() { return LXPlatform.boards(S.platform); }

  /* 排行榜：曲目由平台内置接口提供（当前酷狗已接入）；
   * 没有内置榜单的平台，回退到该平台绑定的音源 leaderboard 动作。 */
  function loadBoard() {
    var pf = S.platform;
    var boards = LXPlatform.boards(pf);
    var bid = S.boardId || (boards[0] && boards[0].id) || '';
    S.boardId = bid;
    S.boardLoading = true; S.boardTracks = null; S.boardNote = '';
    /* 榜单目录是浮层页面：曲目加载完只刷新浮层，背后的排行榜网格保持不动 */
    refreshBoardUi();
    if (!bid && !SR.forPlatform(pf)) {
      S.boardLoading = false;
      S.boardNote = '「' + LXPlatform.nameOf(pf) + '」暂无内置榜单，请改选酷狗音乐或为该平台绑定音源';
      refreshBoardUi();
      return;
    }
    LXPlatform.board(pf, bid, {}).then(function (r) {
      if (S.platform !== pf || S.boardId !== bid) return;
      S.boardLoading = false;
      S.boardTracks = r.tracks;
      S.boardNote = r.tracks.length
        ? r.tracks.length + ' 首 · ' + (r.provider === 'source' ? '来自该平台绑定的音源' : '来自' + LXPlatform.nameOf(pf) + '榜单')
        : (r.note || '该榜单没有返回曲目');
      if (r.errors && r.errors.length) S.boardNote += ' · ' + r.errors[0];
      refreshBoardUi();
    }).catch(function (e) {
      if (S.platform !== pf) return;
      S.boardLoading = false; S.boardTracks = [];
      S.boardNote = '榜单加载失败：' + String(e && e.message || e);
      refreshBoardUi();
    });
  }

  function refreshBoardUi() {
    if (S.overlay === 'boardlist') { renderOverlay(); return; }
    renderView();
  }

  function viewLeaderboard() {
    var pf = S.platform;
    var boards = currentBoards();
    var h = platformBar('set-board-platform');
    if (!boards.length) {
      h += '<div class="empty">' + icon('leaderboard') + '「' + esc(LXPlatform.nameOf(pf)) + '」暂无内置榜单</div>';
      h += '<div class="api-note">' + icon('setting') + (SR.forPlatform(pf)
        ? '该平台已绑定音源；若音源实现 leaderboard 动作，会自动用于榜单。'
        : '选「酷狗」可直接看内置榜单；其它平台需要绑定实现 leaderboard 的音源。') + '</div>';
      return h;
    }
    /* v3.13.4：榜单卡片改成「目录入口」——点一下就进这个榜的目录页，曲目在目录里。
     * 以前是点卡片后把歌曲刷在卡片下方，用户以为「点了没反应」。 */
    h += '<div class="sec-head"><h3>' + esc(LXPlatform.nameOf(pf) + ' · ' + t('nav_top', '排行榜')) + '</h3></div>';
    h += '<div class="grid">' + boards.slice(0, 8).map(function (b) {
      return '<div class="card" data-act="open-board" data-id="' + esc(b.id) + '">' +
        '<div class="card-cover" style="--card-color:' + ((LXPlatform.byId(pf) || {}).color || '#4daf7c') + '">' +
        esc(b.name) + '</div><div class="card-body"><div class="card-name">' + esc(b.name) + '</div>' +
        '<div class="card-sub">' + esc(LXPlatform.nameOf(pf)) + ' · 点击进入目录</div></div></div>';
    }).join('') + '</div>';
    h += '<div class="api-note">' + icon('leaderboard') +
      '点榜单卡片进入目录，目录里显示该榜的单曲；点歌曲即开始播放，底部播放条会一直留在页面上。</div>';
    return h;
  }

  /* 打开榜单目录（浮层页面）。曲目仍存 state.boardTracks，与旧测试/导出保持兼容。 */
  function openBoardDetail(id) {
    S.boardId = id; save();
    S.boardLoading = true; S.boardTracks = null; S.boardNote = '';
    openOverlay('boardlist', id);
    loadBoard();
  }


  // ---------------------------------------------------------------- 视图：我的列表
  function viewMyList() {
    var done = DL.all().filter(function (j) { return j.state === 'done'; }).map(function (j) { return j.trackId; });
    S.lists.forEach(function (l) { if (l.id === 'download') l.trackIds = done.slice(); });
    var h = '<div class="mylist-layout"><div class="list-nav">' + S.lists.map(function (l) {
      return '<button data-act="switch-list" data-id="' + esc(l.id) + '" class="' +
        (S.activeList === l.id ? 'on' : '') + '">' + esc(l.name) + ' (' + l.trackIds.length + ')</button>';
    }).join('') + '<button data-act="create-list">+ ' + esc(t('list_create', '新建列表')) + '</button></div>' +
      '<div class="list-content">';
    var l = S.lists.filter(function (x) { return x.id === S.activeList; })[0] || S.lists[0];
    h += '<div class="list-header"><button class="btn sm primary" data-act="play-list">' +
      esc(t('play_all', '播放全部')) + '</button><button class="btn sm" data-act="multi-toggle">' +
      esc(t('multi_select', '多选')) + '</button><span style="flex:1"></span>' +
      '<button class="btn sm" data-act="list-menu">' + icon('dots-vertical') + '</button></div>';
    if (S.multi) h += multiBar();
    var trs = l.trackIds.map(D.byId).filter(Boolean);
    h += trackList(trs) + '</div></div>';
    return h;
  }

  // ---------------------------------------------------------------- 视图：设置
  var SETTING_GROUPS = [
    /* 平台账号：每个平台可绑定一个音源作为「账号凭证」，用于验证并解析播放/下载地址 */
    { name: t('setting_basic_source', '自定义源'), items: [
      { k: '__api_quality', n: '音源音质（在线试听 / 下载）', type: 'audioquality' },
      { k: '__api_manage', n: t('setting_basic_source_user_api_btn', '自定义源管理'), type: 'userapi' },
      { k: 'logUserApi', n: t('setting_other_log_user_api_log', '记录自定义源日志'), type: 'bool' }
    ] },
    { name: '基础设置', items: [
      { k: 'drawerPosition', n: '抽屉位置', type: 'select', opts: [['left', '左侧'], ['right', '右侧']] },
      { k: 'showBackBtn', n: '显示「返回桌面」按钮', type: 'bool' },
      { k: 'showExitBtn', n: '显示「退出应用」按钮', type: 'bool' },
      { k: 'homePageScroll', n: '允许左右滑动切换页面', type: 'bool' },
      { k: 'autoHidePlayBar', n: '输入时自动隐藏播放条', type: 'bool' },
      { k: 'statusBarPadding', n: '总是保留状态栏高度', type: 'bool' }
    ] },
    { name: '播放', items: [
      { k: 'playbackRate', n: '播放速率', type: 'range', min: 0.5, max: 2, step: 0.1 },
      { k: 'savePlayTime', n: '记住播放进度', type: 'bool' },
      { k: 'autoCleanPlayedList', n: '自动清空已播放列表', type: 'bool' },
      { k: 'offline', n: '模拟离线（仅播放已缓存/已下载）', type: 'bool' }
    ] },
    { name: '歌词', items: [
      { k: 'lyricFontSize', n: '歌词字体大小', type: 'range', min: 12, max: 24, step: 1 },
      { k: 'lyricAlign', n: '歌词对齐方式', type: 'select', opts: [['left', '居左'], ['center', '居中'], ['right', '居右']] },
      { k: 'showTranslation', n: '显示歌词翻译', type: 'bool' },
      { k: 'showRoma', n: '显示歌词罗马音', type: 'bool' },
      { k: 's2t', n: '将播放的中文歌词转换为繁体', type: 'bool' },
      { k: 'desktopLyric', n: '启用桌面歌词', type: 'bool' },
      { k: 'fontShadow', n: '字体阴影', type: 'bool' }
    ] },
    { name: '列表', items: [
      { k: 'showAlbumName', n: '显示专辑名', type: 'bool' },
      { k: 'showInterval', n: '显示歌曲时长', type: 'bool' },
      { k: 'fontSize', n: '界面字体大小', type: 'range', min: 12, max: 18, step: 1 }
    ] },
    { name: '下载（本版新增）', items: [
      { k: '__dl_dir', n: '下载目录', type: 'dlpath' },
      { k: '__dl_quality', n: '下载音质', type: 'dlquality' },
      { k: 'dlParallel', n: '同时下载数量', type: 'range', min: 1, max: 4, step: 1 },
      { k: '__dl_auto', n: '完成后自动保存到设备', type: 'dlauto' }
    ] },
    { name: '备份与恢复', items: [
      { k: '__backup', n: '导出 / 导入列表与设置', type: 'backup' }
    ] },
    { name: '数据同步', items: [
      { k: '__sync', n: '连接码与同步服务地址', type: 'sync' }
    ] },
    { name: '其他', items: [
      { k: '__diag', n: '诊断日志', type: 'diag' },
      { k: '__cache', n: '缓存与错误日志', type: 'cache' },
      { k: '__about', n: '关于 LX Music', type: 'about' }
    ] }
  ];
  function settingRow(it) {
    var v = S.settings[it.k], main = '', extra = '', desc = '';
    if (it.type === 'apisrc') {
      var cur = SR.byId(S.apiSource);
      extra = '<button class="btn sm" data-act="api-select">' +
        esc(cur ? cur.name : t('setting_basic_source_test', '测试接口')) + '</button>';
      desc = cur ? '[' + cur.message + '] · 点击切换自定义源' :
        '[' + t('setting_basic_source_status_success', '初始化成功') + '] · 内置测试接口';
    } else if (it.type === 'userapi') {
      extra = '<button class="btn sm primary" data-act="open-panel" data-id="userapi">' +
        esc(t('setting_basic_source_user_api_btn', '自定义源管理')) + '</button>';
      desc = SR.list().length + ' 个已导入 · ' + SR.active().length + ' 个启用 · 可导入 JS 音源脚本';
    } else if (it.type === 'audioquality') {
      extra = '<select data-act="set-audio-quality">' +
        Q.PRIORITY.map(function (q) {
          return '<option value="' + q + '"' + (S.settings.audioQuality === q ? ' selected' : '') + '>' +
            Q.name(q) + '</option>';
        }).join('') + '</select>';
      desc = '向音源请求 musicUrl / downloadUrl 时传入 info.type；实际档位受音源支持范围限制';
    } else if (it.type === 'bool') {
      extra = '<label class="switch"><input type="checkbox" data-act="set-bool" data-id="' + it.k + '"' +
        (v ? ' checked' : '') + '><i></i></label>';
    } else if (it.type === 'select') {
      extra = '<select data-act="set-select" data-id="' + it.k + '">' + it.opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (v === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    } else if (it.type === 'range') {
      var mn = it.min != null ? it.min : 0, mx = it.max != null ? it.max : 10, stp = it.step || 1;
      if (v == null || v === '' || !isFinite(Number(v))) v = mn;
      // v3.10.0：滑块 + 数字框并列。两者都只在 input/change 里生效，
      // 点击时不再重建设置页（否则控件会在拖动/输入前被销毁，表现为「改不了」）。
      extra = '<div class="sr-range">' +
        '<input type="range" data-act="set-num" data-id="' + it.k + '" min="' + mn + '" max="' + mx +
          '" step="' + stp + '" value="' + v + '">' +
        '<input class="sr-num" type="number" data-act="set-num" data-id="' + it.k + '" min="' + mn +
          '" max="' + mx + '" step="' + stp + '" value="' + v + '">' +
        '</div>';
    } else if (it.type === 'dlpath') {
      // v3.12.0：下载歌曲落盘目录。预置几个常用相对路径，另可自定义
      var isHap = !!(window.EchoBridge && typeof window.EchoBridge.pickExportDir === 'function');
      if (isHap) {
        // 鸿蒙：系统不允许静默写入任意公共目录，改为「选一个文件夹并持久授权」，之后自动写入、不再弹框
        var dirUri = S.settings.exportDirUri || '';
        extra = '';
        desc = '鸿蒙系统未开放「选择文件夹」授权（缺少 FolderSelection 能力），无法静默写入自选目录；请用下载页的「全部保存」批量导出，或单首点「保存到文件」';
      } else {
        var cur = DL.dirOf();
        var presets = DL.DL_PRESETS || [];
        var inPreset = presets.some(function (p) { return p[0] === cur; });
        extra = '<select data-act="dl-path">' + presets.map(function (p) {
            return '<option value="' + esc(p[0]) + '"' + (cur === p[0] ? ' selected' : '') + '>' +
              esc(p[1]) + '</option>';
          }).join('') +
          '<option value="__custom"' + (inPreset ? '' : ' selected') + '>' +
            esc('自定义目录…') + '</option>' +
          '</select>';
        desc = '保存到 /storage/emulated/0/' + cur + '（Android 10+ 走 MediaStore，无需存储权限）';
      }
    } else if (it.type === 'dlquality') {
      var dq = Q.normalize(S.settings.downloadQuality || DL.opts.quality) || '320k';
      extra = '<select data-act="dl-quality">' + Q.PRIORITY.map(function (q) {
        return '<option value="' + q + '"' + (dq === q ? ' selected' : '') + '>' +
          Q.name(q) + '</option>';
      }).join('') + '</select>';
      desc = Q.name(dq) + '：' + Q.desc(dq);
    } else if (it.type === 'dlauto') {
      // 鸿蒙：系统无 FolderSelection 能力，无法授权目录实现静默写入，这条开关只对安卓有效，HAP 隐藏
      if (window.EchoBridge) { return ''; }
      extra = '<label class="switch"><input type="checkbox" data-act="dl-auto"' +
        (DL.opts.autoDeliver ? ' checked' : '') + '><i></i></label>';
    } else if (it.type === 'diag') {
      /* 诊断日志：真机排障要「不用连电脑就能把日志拿出来」。
       * 导出走系统保存框落成 txt；查看是同一份内容在应用内直接显示，导出被取消时也看得到。 */
      extra = '<div class="sr-actions"><button class="btn sm primary" data-act="log-export">导出</button>' +
        '<button class="btn sm" data-act="log-view">查看</button></div>';
      desc = '汇总引擎 / 音频元素事件 / 音源 / 歌词 / 错误日志，导出为 txt 文件回传分析';
    } else {
      extra = '<button class="btn sm" data-act="open-panel" data-id="' + it.type + '">' +
        esc(t('open', '打开')) + '</button>';
    }
    main = '<div class="sr-main"><div class="sr-name">' + esc(it.n) + '</div>' +
      (desc ? '<div class="sr-desc">' + esc(desc) + '</div>' : '') + '</div>';
    return '<div class="set-row">' + main + extra + '</div>';
  }
  function viewSetting() {
    var h = '<div class="set-group"><div class="set-group-title">' + esc(t('theme', '主题')) + '</div>' +
      '<div class="theme-grid">' + T.list.map(function (th) {
        return '<button class="theme-dot ' + (S.theme === th.id ? 'on' : '') + '" data-act="set-theme" data-id="' +
          th.id + '" style="background:' + th.primary + '">' + esc(th.name) + '</button>';
      }).join('') + '</div></div>';
    SETTING_GROUPS.forEach(function (g) {
      h += '<div class="set-group"><div class="set-group-title">' + esc(g.name) + '</div>' +
        g.items.map(settingRow).join('') + '</div>';
    });
    return h;
  }

  // ---------------------------------------------------------------- 视图：下载
  function viewDownload() {
    var st = DL.stats();
    var h = '<div class="dl-stats">' +
      '<div class="dl-stat"><b id="dlStatDone">' + st.done + '</b><span>已完成</span></div>' +
      '<div class="dl-stat"><b id="dlStatActive">' + (st.running + st.waiting) + '</b><span>进行中</span></div>' +
      '<div class="dl-stat"><b id="dlStatError">' + st.error + '</b><span>失败</span></div>' +
      '<div class="dl-stat"><b id="dlStatSize">' + esc(st.sizeText) + '</b><span>已占用</span></div></div>';
    h += '<div class="dl-live" id="dlLive">' + (st.speedText ? '下载中 · ' + esc(st.speedText) : '') + '</div>';
    h += '<div class="list-header"><button class="btn sm primary" data-act="dl-add-current">' +
      icon('download-2') + ' ' + esc(t('download_current', '下载当前列表 / 搜索结果')) + '</button>' +
      (st.error ? '<button class="btn sm" data-act="dl-retry-failed">重试失败 (' + st.error + ')</button>' : '') +
      (window.EchoBridge && typeof window.EchoBridge.saveAllDownloads === 'function' && st.done
        ? '<button class="btn sm" data-act="dl-save-all">全部保存</button>' : '') +
      '<button class="btn sm" data-act="dl-resume-all">' + esc(t('resume_all', '继续全部')) + '</button></div>';
    h += '<div class="set-row"><div class="sr-main"><div class="sr-name">' +
      esc(t('download_quality', '下载音质')) + '</div><div class="sr-desc">' +
      esc(Q.name(DL.opts.quality) + '：' + Q.desc(DL.opts.quality)) + '</div></div>' +
      '<select data-act="dl-quality">' + Q.PRIORITY.map(function (q) {
        return '<option value="' + q + '"' + (DL.opts.quality === q ? ' selected' : '') + '>' +
          Q.name(q) + '</option>';
      }).join('') + '</select></div>';
    h += '<div class="set-row"><div class="sr-main"><div class="sr-name">' +
      esc(t('auto_save', '完成后自动保存到设备')) + '</div></div>' +
      '<label class="switch"><input type="checkbox" data-act="dl-auto"' +
      (DL.opts.autoDeliver ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="sec-head"><h3>' + esc(t('download_tasks', '任务队列')) + '</h3></div>' +
      '<div id="dlList">' + downloadListHtml() + '</div>';
    return h;
  }
  function downloadListHtml() {
    var jobs = DL.all();
    if (!jobs.length) return '<div class="empty">' + icon('download-2') +
      esc(t('no_download_task', '暂无下载任务')) + '</div>';
    return jobs.map(function (j) {
      var stateText = { done: '已完成', running: '下载中', waiting: '等待中', paused: '已暂停',
        cancelled: '已取消', error: '失败' }[j.state] || j.state;
      var acts = '';
      if (j.state === 'running' || j.state === 'waiting') acts += '<button data-act="dl-pause" data-id="' + j.id + '">暂停</button>';
      if (j.state === 'paused') acts += '<button data-act="dl-resume" data-id="' + j.id + '">继续</button>';
      if (j.state === 'cancelled' || j.state === 'error') acts += '<button data-act="dl-retry" data-id="' + j.id + '">重试</button>';
      if (j.state === 'done') {
        // 完成的任务整行可点：点歌名就能直接播放，不再需要先找「播放」按钮
        if (!j.path) acts += '<button data-act="dl-save" data-id="' + j.id + '">保存到设备</button>';
        else if (window.EchoBridge && typeof window.EchoBridge.exportDownload === 'function') {
          acts += '<button data-act="dl-export" data-id="' + j.id + '">保存到文件</button>';
        }
      }
      acts += '<button data-act="dl-remove" data-id="' + j.id + '">移除</button>';
      var hit = j.state === 'done';
      var sizeText = (j.state === 'running' && j.total)
        ? DL.fmtSize(j.received) + ' / ' + DL.fmtSize(j.total)
        : DL.fmtSize(j.size);
      var liveText = (j.state === 'running' && j.speed ? ' · ' + DL.fmtSize(j.speed) + '/s' : '') +
        (j.state === 'running' && j.eta >= 0 ? ' · 剩余 ' + fmt(j.eta) : '');
      return '<div class="dl-item' + (hit ? ' hit' : '') + '"' +
        (hit ? ' data-act="dl-play" data-id="' + j.id + '"' : '') +
        '><div class="dl-head"><span class="dl-name">' +
        (hit ? '<i class="dl-play-ico">' + icon('play') + '</i>' : '') +
        esc(j.name) + ' - ' + esc(j.singer) + '</span><span class="dl-state">' + stateText + '</span></div>' +
        '<div class="dl-bar"><i style="width:' + j.progress + '%"></i></div>' +
        '<div class="dl-meta"><span>' + esc(qualityLabelOf(j)) +
        ' · ' + esc(j.format ? j.format + ' · ' + j.mime : 'WAV · audio/wav') +
        (j.sourceLabel ? ' · ' + esc(j.sourceLabel) : '') +
        ' · ' + esc(sizeText) + esc(liveText) + '</span><span>' + j.progress + '%</span></div>' +
        (j.note
          ? '<div class="dl-meta"><span class="dl-note">' + esc(j.note) + '</span></div>' : '') +
        (j.state === 'error' && j.error
          ? '<div class="dl-meta"><span style="color:#d64541">' + esc(j.error) + '</span></div>' : '') +
        (j.path ? '<div class="dl-meta"><span>' + (window.EchoBridge && typeof window.EchoBridge.exportDownload === 'function'
          ? '已下载到应用沙箱，点「保存到文件」导出到文件管理器'
          : '已保存到 ' + esc(j.path)) + '</span></div>' : '') +
        '<div class="dl-acts">' + acts + '</div></div>';
    }).join('');
  }
  function setText(id, v) { var e = $(id); if (e) e.textContent = v; }
  window.LXRenderDownloads = function () {
    var host = $('dlList'); if (host) host.innerHTML = downloadListHtml();
    var b = document.querySelector('.nav-badge');
    var st = DL.stats();
    if (b) b.textContent = st.done;
    // 统计卡片也必须随任务进度实时刷新，否则只在进入页面时算一次会一直显示 0
    setText('dlStatDone', st.done);
    setText('dlStatActive', st.running + st.waiting);
    setText('dlStatError', st.error);
    setText('dlStatSize', st.sizeText);
    setText('dlLive', st.speedText ? '下载中 · ' + st.speedText : '');
  };

  // ---------------------------------------------------------------- 全屏页：自定义源管理
  function userApiPanel() {
    var apis = SR.list();
    var h = '<div class="ov-body ua-panel">' +
      '<div class="ua-imports">' +
      '<button class="btn sm primary" data-act="api-import-local">' + icon('download-2') + ' ' +
      esc(t('user_api_btn_import_local', '本地导入')) + '</button>' +
      '<button class="btn sm" data-act="api-import-online">' + icon('search-2') + ' ' +
      esc(t('user_api_btn_import_online', '在线导入')) + '</button>' +
      '<button class="btn sm" data-act="api-import-paste">' + icon('add-music') + ' 粘贴脚本</button>' +
      '<button class="btn sm" data-act="api-load-template" data-id="builtin">示例脚本</button>' +
      '<button class="btn sm" data-act="api-load-template" data-id="http">HTTP 模板</button></div>';
    h += '<div class="ua-status">' + esc(t('setting_basic_source', '自定义源')) + '：' + apis.length + ' / ' + SR.MAX +
      ' · 已启用 ' + SR.active().length + ' · ' +
      (SR.hasSearch() ? '可用于搜索' : '搜索由平台提供，音源只补播放地址') + '</div>';
    if (!apis.length) {
      h += '<div class="empty">' + icon('setting') + esc(t('user_api_empty', '这里竟然是空的 😲')) + '</div>';
    } else {
      h += apis.map(function (a) {
        var acts = {}, srcs = Object.keys(a.sources || {});
        srcs.forEach(function (k) { (a.sources[k].actions || []).forEach(function (x) { acts[x] = 1; }); });
        var actNames = Object.keys(acts).join(' / ') || '—';
        var isDef = SR.isDefault(a.id);
        var canUpdate = /^online:/i.test(String(a.origin || ''));
        return '<div class="ua-item ' + (isDef ? 'active' : '') + '">' +
          '<div class="ua-head"><b>' + esc(a.name) + '</b>' +
          (isDef ? '<em class="ua-tag">默认</em>' : '') +
          '<span>' + esc((/^\d/.test(a.version) ? 'v' + a.version : a.version) || '') +
          ' · ' + esc(a.author || '未知作者') + '</span>' +
          '<em class="' + (a.status === 'success' ? 'ok' : 'bad') + '">[' + esc(a.message) + ']</em></div>' +
          '<div class="ua-desc">' + esc(a.description || '—') + '</div>' +
          '<div class="ua-desc">来源：' + esc(srcs.join(', ') || '—') + ' · 动作：' + esc(actNames) + '</div>' +
          (a.status === 'failed' ? '<div class="ua-err">' + esc(a.message) + '</div>' : '') +
          '<div class="ua-acts">' +
          '<label class="ua-sw">启用 <span class="switch"><input type="checkbox" data-act="api-toggle" data-id="' +
          esc(a.id) + '"' + (a.enabled ? ' checked' : '') + '><i></i></span></label>' +
          '<label class="ua-sw">' + esc(t('user_api_allow_show_update_alert', '允许显示更新弹窗')) +
          ' <span class="switch"><input type="checkbox" data-act="api-allow-alert" data-id="' + esc(a.id) + '"' +
          (a.allowUpdateAlert ? ' checked' : '') + '><i></i></span></label>' +
          (isDef
            ? '<button class="primary" data-act="api-clear-default">取消默认</button>'
            : '<button data-act="api-set-default" data-id="' + esc(a.id) + '">设为默认</button>') +
          (canUpdate ? '<button data-act="api-refresh" data-id="' + esc(a.id) + '">更新</button>' : '') +
          '<button data-act="api-test" data-id="' + esc(a.id) + '">搜索测试</button>' +
          '<button data-act="api-export" data-id="' + esc(a.id) + '">导出</button>' +
          '<button data-act="api-remove" data-id="' + esc(a.id) + '">移除</button></div></div>';
      }).join('');
    }
    h += '<div class="ua-tips"><div>' + esc(t('user_api_readme', '源编写说明：')) +
      ' <span class="ua-link" data-act="api-faq">FAQ</span> · lx-music-doc/mobile/custom-source</div>' +
      '<div>脚本头 <code>@name / @description / @version / @author / @homepage</code>；' +
      '通过 <code>globalThis.lx</code> 的 <code>on / send / request / utils</code> 与应用通信。</div>' +
      '<div>扩展动作：<code>search</code>（返回歌曲数组）、<code>downloadUrl</code>（返回 url/data + mime/ext）、' +
      '<code>musicUrl</code>（在线收听）。仅声明原版 musicUrl/lyric/pic 的脚本同样可用。</div>' +
      '<div>' + esc(t('user_api_note', '提示：虽然我们已经尽可能地隔离了脚本的运行环境，但导入包含恶意行为的脚本仍可能会影响你的系统，请谨慎导入。')) +
      '</div></div>';
    if (S.settings.logUserApi) {
      var lg = SR.logs();
      h += '<div class="set-group-title">自定义源日志 <button class="btn sm" data-act="api-log-clear">清理</button></div>' +
        '<div class="ua-log">' + (lg.length ? lg.slice(0, 30).map(esc).join('<br>') : '暂无日志') + '</div>';
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------- 全屏页
  /* v3.11.0：播放详情只要带着队列进来，就常驻一条「下一首 / 队列位置」信息条。
   * 点击整条进队列页，可以点任意一首直接切过去（配合随机模式实现「随时换一首」）。 */
  function queueStrip() {
    var len = S.queue.length;
    if (!len) return '';
    var pos = Math.max(0, S.index) + 1;
    // 「还剩几首」= 当前位置之后、还没播过的曲目数（各模式同一口径）
    var rest = Math.max(0, len - pos);
    var nextTxt;
    if (S.mode === 'singleLoop') {
      nextTxt = '单曲循环：播完重来这一首';
    } else if (S.mode === 'random') {
      nextTxt = '随机播放：每次从 ' + len + ' 首里抽一首';
    } else {
      var nx = len > 1 ? D.byId(S.queue[(Math.max(0, S.index) + 1) % len]) : null;
      nextTxt = nx ? nx.name + (nx.singer ? ' · ' + nx.singer : '') : '队列里只有这一首';
    }
    return '<div class="dq" data-act="open-queue">' +
      '<div class="dq-row"><span class="dq-k">下一首</span>' +
      '<span class="dq-v">' + esc(nextTxt) + '</span>' +
      '<i class="lx-icon lx-list-order dq-go"></i></div>' +
      '<div class="dq-row dq-meta"><span class="dq-k">队列</span>' +
      '<span class="dq-v">第 ' + pos + ' / ' + len + ' 首 · 还剩 ' + rest + ' 首 · ' +
      (MODE_TEXT[S.mode] || '列表循环') + '</span></div>' +
      '</div>';
  }
  function queueOverlayHtml() {
    if (!S.queue.length) return '<div class="empty">' + icon('album') + '播放队列是空的</div>';
    var len = S.queue.length;
    var head = '<div class="q-head"><span>共 ' + len + ' 首 · 当前第 ' + (Math.max(0, S.index) + 1) + ' 首</span>' +
      '<button class="btn sm" data-act="mode">' + icon(MODE_ICON[S.mode]) + ' ' +
      (MODE_TEXT[S.mode] || '列表循环') + '</button></div>';
    var rows = S.queue.map(function (id, i) {
      var tr = D.byId(id);
      if (!tr) return '';
      var on = i === S.index;
      return '<div class="q-item' + (on ? ' on' : '') + '" data-act="queue-play" data-val="' + i + '">' +
        '<span class="q-i">' + (on ? (S.playing ? icon('pause') : icon('play')) : String(i + 1)) + '</span>' +
        '<div class="q-main"><div class="q-name">' + esc(tr.name) + '</div>' +
        '<div class="q-sub">' + esc(tr.singer || '未知歌手') + '</div></div>' +
        '<span class="q-dur">' + esc(tr.time || '') + '</span></div>';
    }).join('');
    return '<div class="ov-body q-list">' + head + rows + '</div>';
  }
  function openOverlay(kind, id) {
    S.overlay = kind; S.overlayId = id || '';
    renderOverlay();
    if (kind === 'detail') {
      var dtr = D.byId(id) || currentTrack() || null;
      if (dtr) loadDetailLyric(dtr);
    }
  }

  /* 详情页歌词：先占位再异步向音源要（平台曲目同样能取到）。
   * 音源不给歌词时展示明确提示，不阻塞播放。 */
  function loadDetailLyric(tr) {
    var box = $('lyricBox');
    if (!box || !tr) return;
    S._lyr = null;
    if (S.settings.showLyric === false) {
      box.innerHTML = '<p class="lc-empty">歌词已隐藏</p>';
      return;
    }
    box.innerHTML = '<p class="lc-empty">歌词加载中…</p>';
    Lyr.load(tr).then(function (parsed) {
      if (S.overlay !== 'detail') return;
      var b = $('lyricBox'); if (!b) return;
      S._lyr = parsed || null;
      Lyr.render(b, parsed, tr.id);
      if (parsed && parsed.hasTime) Lyr.sync(b, parsed, engine.position());
    });
  }

  /* 音效设置页：预设 / 混响 / 环绕 / 10 段 EQ */
  function effectsHtml() {
    if (!Snd) return '<div class="empty">音效模块未加载</div>';
    var st = Snd.state();
    var h = '<div class="ov-body fx-wrap">';
    h += '<div class="fx-row"><div class="fx-label"><b>音效总开关</b><span>' + esc(Snd.describe()) + '</span></div>' +
      '<label class="switch"><input type="checkbox" data-act="fx-toggle"' + (st.enabled ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="fx-sec"><div class="fx-title">均衡器预设</div><div class="chips">' +
      Snd.PRESETS.map(function (p) {
        return '<button class="chip' + (st.preset === p.name ? ' on' : '') + '" data-act="fx-preset" data-id="' +
          esc(p.name) + '">' + esc(p.name) + '</button>';
      }).join('') + '</div></div>';
    h += '<div class="fx-sec"><div class="fx-title">环境混响</div><div class="chips">' +
      Snd.REVERBS.map(function (r) {
        return '<button class="chip' + (st.reverb === r.id ? ' on' : '') + '" data-act="fx-reverb" data-id="' +
          r.id + '">' + esc(r.name) + '</button>';
      }).join('') + '</div></div>';
    h += '<div class="fx-row"><div class="fx-label"><b>3D 环绕</b><span>声音绕听者缓慢旋转</span></div>' +
      '<label class="switch"><input type="checkbox" data-act="fx-surround"' + (st.surround ? ' checked' : '') + '><i></i></label></div>';
    /* 音量补偿：鸿蒙上「元素→MediaElementSource→AudioContext」这条通路整体比元素直出偏小，
     * 开音效后听感下降，与增益无关。这里给用户一个可调旋钮，关闭音效时自动按 100% 处理。 */
    var trimPct = Math.round((st.trim || 1) * 100);
    h += '<div class="fx-sec"><div class="fx-title">音量补偿 <em>音效开启时生效，关闭时自动 100%</em></div>' +
      '<div class="fx-band"><span class="fx-freq">补偿</span>' +
      '<input type="range" min="80" max="200" step="5" value="' + trimPct + '" data-act="fx-trim">' +
      '<span class="fx-val" id="fxTrimVal">' + trimPct + '%</span></div></div>';
    h += '<div class="fx-row"><div class="fx-label"><b>音频图自检</b><span id="fxDiag">点右侧按钮查看 audio 链路真实状态</span></div>' +
      '<div class="fx-actions"><button class="btn sm" data-act="fx-diag">检测</button>' +
      '<button class="btn sm" data-act="log-export">导出日志</button></div></div>';
    h += '<div class="fx-sec"><div class="fx-title">均衡器 <em>±12 dB</em></div>' +
      Snd.FREQS.map(function (f, i) {
        var v = st.eq[i];
        var name = f >= 1000 ? (f / 1000) + 'k' : String(f);
        return '<div class="fx-band"><span class="fx-freq">' + name + '</span>' +
          '<input type="range" min="-12" max="12" step="1" value="' + v + '" data-act="fx-band" data-i="' + i + '">' +
          '<span class="fx-val" id="fxVal' + i + '">' + (v > 0 ? '+' : '') + v + '</span></div>';
      }).join('') + '</div>';
    h += '<div class="fx-foot"><button class="btn sm" data-act="fx-reset">重置音效</button>' +
      '<span>音效只在播放时生效，关闭后保留你的配置</span></div>';
    h += '</div>';
    return h;
  }
  function closeOverlay() {
    S.overlay = null; S.overlayId = '';
    var o = $('overlay');
    if (o) { o.classList.add('hidden'); o.classList.remove('ov-with-bar'); o.innerHTML = ''; }
  }
  function renderOverlay() {
    var o = $('overlay'); if (!o) return;
    if (!S.overlay) { o.classList.add('hidden'); o.innerHTML = ''; return; }
    var k = S.overlay, body = '', title = '';
    // v3.2.0 不再有内置曲库兜底：没有正在播放的歌时 tr 为 null，各分支需自行处理
    var tr = D.byId(S.overlayId) || currentTrack() || null;
    if (k === 'userapi') {
      title = t('user_api_title', '自定义源管理（实验性）');
      body = userApiPanel();
    } else if (k === 'detail') {
      title = t('play_detail', '播放详情');
      if (!tr) {
        body = '<div class="empty">' + icon('album') + '还没有正在播放的歌曲</div>';
      } else {
        var showLyr = S.settings.showLyric !== false;
        body = '<div class="ov-body detail-body">' +
          '<div class="detail-cover">' +
          (tr.img ? '<img src="' + esc(tr.img) + '" alt="" onerror="this.style.display=\'none\'">' : icon('album')) +
          '</div>' +
          '<div class="detail-title">' + esc(tr.name) + '</div>' +
          '<div class="detail-sub">' + esc(tr.singer) + (tr.album ? ' · ' + esc(tr.album) : '') +
          (tr.platform ? ' · ' + esc(LXPlatform.nameOf(tr.platform)) : '') + '</div>' +
          queueStrip() +
          '<div class="lyric' + (showLyr ? '' : ' hidden') + '" id="lyricBox">' +
          '<p class="lc-empty">歌词加载中…</p></div></div>' +
          '<div class="player-ctl">' +
          '<div class="time-row"><span id="dTimeNow">00:00</span><span id="dTimeAll">' + esc(tr.time) + '</span></div>' +
          '<input class="seek" type="range" id="detailSeek" min="0" max="100" value="0">' +
          '<div class="ctl-row"><button data-act="mode">' + icon(MODE_ICON[S.mode]) + '</button>' +
          '<button data-act="prev">' + icon('prevMusic') + '</button>' +
          '<button class="big" data-act="toggle" id="detailToggle">' + icon(S.playing ? 'pause' : 'play') + '</button>' +
          '<button data-act="next">' + icon('nextMusic') + '</button>' +
          '<button data-act="rate">' + icon('playback-rate') + '</button></div>' +
          '<div class="detail-actions">' +
          '<button data-act="open-queue">' + icon('list-order') + '<span>列表</span></button>' +
          '<button data-act="detail-collect" class="' + (inAnyList(tr.id) ? 'on' : '') + '">' +
          icon('love') + '<span>收藏</span></button>' +
          '<button data-act="detail-download">' + icon('download-2') + '<span>下载</span></button>' +
          '<button data-act="detail-effects">' + icon('slider') + '<span>音效</span></button>' +
          '<button data-act="detail-lyric" class="' + (showLyr ? 'on' : '') + '">' +
          icon(showLyr ? 'lyric-on' : 'lyric-off') + '<span>歌词</span></button>' +
          '</div></div>';
      }
    } else if (k === 'diaglog') {
      title = '诊断日志';
      body = '<div class="ov-body diag-wrap">' +
        '<div class="diag-bar"><button class="btn sm primary" data-act="log-export">导出文件</button>' +
        '<button class="btn sm" data-act="log-copy">复制全文</button>' +
        '<button class="btn sm" data-act="diaglog-refresh">刷新</button></div>' +
        '<pre class="diag-pre" id="diagPre">' + esc(S.diagText || buildDiagnosticLog()) + '</pre></div>';
    } else if (k === 'effects') {
      title = '音效设置';
      body = effectsHtml();
    } else if (k === 'queue') {
      title = '播放列表';
      body = queueOverlayHtml();
    } else if (k === 'comment') {
      title = t('comment', '评论');
      body = '<div class="ov-body"><div class="tabs-scroll">' +
        '<button data-act="cm-tab" data-id="hot" class="' + (S.commentTab === 'hot' ? 'on' : '') + '">精彩评论</button>' +
        '<button data-act="cm-tab" data-id="new" class="' + (S.commentTab === 'new' ? 'on' : '') + '">最新评论</button></div>' +
        (D.COMMENTS.length ? D.COMMENTS.map(function (c, i) {
          var liked = !!S.commentLikes['c' + i];
          return '<div class="cm-item"><span class="cm-user">' + esc(c.user) + '</span><span class="cm-time">' +
            esc(c.time) + '</span><div class="cm-text">' + esc(c.text) + '</div>' +
            '<div class="cm-acts"><button data-act="cm-like" data-id="c' + i + '">' +
            icon('thumbs-up') + ' ' + (c.likes + (liked ? 1 : 0)) + '</button>' +
            '<span>' + c.replies + ' 条回复</span></div></div>';
        }).join('') : '<div class="empty">暂无评论</div>') + '</div>';
    } else if (k === 'songlist') {
      var pl = PL.detail || {};
      title = pl.name || t('songlist_detail', '歌单详情');
      var meta = [pl.author, pl.count ? pl.count + ' 首' : '', pl.play ? pl.play + ' 播放' : '']
        .filter(Boolean).join(' · ');
      body = '<div class="ov-body">' +
        '<div class="pl-head">' +
        (pl.img
          ? '<img class="pl-cover" src="' + esc(pl.img) + '" alt="" onerror="this.style.display=\'none\'">'
          : '<div class="pl-cover ph">' + icon('album') + '</div>') +
        '<div class="pl-meta"><div class="pl-name">' + esc(pl.name || '') + '</div>' +
        '<div class="card-sub">' + esc(meta) + '</div></div></div>' +
        (PL.detailLoading
          ? '<div class="api-note">' + icon('search-2') + '正在加载歌单曲目…</div>' : '') +
        (PL.detailNote ? '<div class="api-note">' + icon('setting') + esc(PL.detailNote) + '</div>' : '') +
        '<div class="list-header"><button class="btn sm primary" data-act="play-all-songlist">' +
        esc(t('play_all', '播放全部')) + '</button><span style="flex:1"></span>' +
        '<span style="font-size:calc(11px * var(--ui-fs));color:var(--c-font-label)">' +
        (pl.tracks && pl.tracks.length ? pl.tracks.length + ' 首' : '') + '</span></div>' +
        trackList(pl.tracks || []) + '</div>';
    } else if (k === 'boardlist') {
      var bds = currentBoards();
      var cur0 = bds.filter(function (b) { return b.id === S.boardId; })[0] || bds[0] || { name: '' };
      title = cur0.name || '榜单目录';
      body = '<div class="ov-body">' +
        '<div class="list-header"><button class="btn sm primary" data-act="play-board">' +
        esc(t('play_all', '播放全部')) + '</button><span style="flex:1"></span>' +
        '<span style="font-size:calc(11px * var(--ui-fs));color:var(--c-font-label)">' +
        esc(LXPlatform.nameOf(S.platform)) + (S.boardTracks && S.boardTracks.length ? ' · ' + S.boardTracks.length + ' 首' : '') +
        '</span></div>' +
        (S.boardLoading
          ? '<div class="api-note">' + icon('search-2') + '正在加载「' + esc(cur0.name) + '」…</div>' : '') +
        (S.boardNote ? '<div class="api-note">' + icon('setting') + esc(S.boardNote) + '</div>' : '') +
        trackList(S.boardTracks || []) + '</div>';
    } else if (k === 'backup') {
      title = t('setting_backup', '备份与恢复');
      body = '<div class="ov-body"><div class="set-group"><div class="set-group-title">导出</div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">' + esc(t('setting_backup_all', '所有数据（列表数据与设置数据）')) +
        '</div></div><button class="btn sm" data-act="backup-export" data-id="all">导出</button></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">列表数据</div></div>' +
        '<button class="btn sm" data-act="backup-export" data-id="lists">导出</button></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">设置数据</div></div>' +
        '<button class="btn sm" data-act="backup-export" data-id="settings">导出</button></div></div>' +
        '<div class="set-group"><div class="set-group-title">导入</div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">从备份文件恢复</div>' +
        '<div class="sr-desc">支持合并与完全覆盖</div></div>' +
        '<button class="btn sm" data-act="backup-import">选择文件</button></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">导入方式</div></div>' +
        '<select data-act="backup-mode"><option value="merge">合并</option><option value="overwrite">完全覆盖</option></select></div></div></div>';
    } else if (k === 'sync') {
      title = t('sync', '数据同步');
      body = '<div class="ov-body"><div class="set-group">' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">启用同步服务地址</div></div>' +
        '<label class="switch"><input type="checkbox" data-act="sync-toggle"' +
        (S.sync.connected ? ' checked' : '') + '><i></i></label></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">服务地址</div></div>' +
        '<input type="text" data-act="sync-addr" value="' + esc(S.sync.addr) + '" placeholder="http://"></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">端口</div></div>' +
        '<input type="text" data-act="sync-port" value="' + esc(S.sync.port) + '" placeholder="23332"></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">连接码</div></div>' +
        '<input type="text" data-act="sync-code" value="' + esc(S.sync.code) + '" placeholder="请输入连接码"></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">连接状态</div><div class="sr-desc">' +
        (S.sync.connected ? '已连接（本地模拟）' : '未连接') + '</div></div>' +
        '<button class="btn sm primary" data-act="sync-connect">连接</button></div>' +
        '<div class="set-group-title">同步日志</div><div style="padding:0 14px 20px;font-size:calc(12px * var(--ui-fs));color:var(--c-font-label)">' +
        (S.sync.log.length ? S.sync.log.map(esc).join('<br>') : '暂无日志') + '</div></div></div>';
    } else if (k === 'about') {
      title = t('setting_about', '关于 LX Music');
      body = '<div class="ov-body" style="padding:26px 20px;line-height:1.8">' +
        '<div style="text-align:center;margin-bottom:20px"><div style="font-size:calc(44px * var(--ui-fs))">' + icon('logo') +
        '</div><div style="font-size:calc(22px * var(--ui-fs));margin-top:8px">LX Music</div>' +
        '<div style="font-size:calc(12px * var(--ui-fs));color:var(--c-font-label)">v1.9.2 · 界面复现版</div></div>' +
        '<p>本项目基于 React Native 开发，是一个免费开源的音乐查找工具。本复现版本以 WebView 承载，' +
        '界面结构、主题配色、图标与文案均对齐 v1.9.2，并新增原版未实现的歌曲下载能力与自定义音源扩展。</p>' +
        '<p style="color:var(--c-font-label);font-size:calc(12px * var(--ui-fs))">内置曲库、歌词与评论为本地演示数据；' +
        '导入自定义 JS 音源后可发起网络请求（仅用于该音源声明的接口），按音源返回格式在线收听与下载。' +
        '项目协议 Apache-2.0（补充协议见原项目）。</p></div>';
    } else if (k === 'cache') {
      title = t('setting__other_meta_cache', '其他缓存管理');
      body = '<div class="ov-body"><div class="set-group">' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">错误日志</div>' +
        '<div class="sr-desc">' + S.errorLog.length + ' 条</div></div>' +
        '<button class="btn sm" data-act="log-clear">清理</button></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">诊断日志</div>' +
        '<div class="sr-desc">汇总引擎 / 音源 / 歌词 / 错误日志，导出为文件回传分析</div></div>' +
        '<button class="btn sm" data-act="log-export">导出</button></div>' +
        '<div class="set-row"><div class="sr-main"><div class="sr-name">已下载文件</div>' +
        '<div class="sr-desc">' + DL.stats().done + ' 个 · ' + DL.stats().sizeText + '</div></div>' +
        '<button class="btn sm" data-act="dl-clear-finished">清理已完成</button></div>' +
        '<div class="set-group-title">错误日志</div><div style="padding:0 14px 20px;font-size:calc(12px * var(--ui-fs));color:var(--c-font-label)">' +
        (S.errorLog.length ? S.errorLog.map(esc).join('<br>') : '暂无日志') + '</div></div></div>';
    }
    o.innerHTML = '<div class="ov-head"><button data-act="close-overlay">' + icon('chevron-left') + '</button>' +
      '<h2>' + esc(title) + '</h2></div>' + body;
    o.classList.remove('hidden');
    /* 歌单 / 榜单目录这类「边看边挑」的页面，让底部播放条留在页面上：
     * 浮层底边上移一个播放条的高度，播放条本身固定在 .page 末端，不随列表滚动消失。 */
    o.classList.toggle('ov-with-bar', k === 'songlist' || k === 'boardlist');
  }

  // ---------------------------------------------------------------- 播放
  /* v3.13.1：重启后曲库是空的（搜索结果只存在内存里），下载页点行时 D.byId 查不到曲目，
   * 原来会静默 return —— 用户看到的就是「点了没加载」。这里按下载任务把曲目重建回来。 */
  function trackFromDownload(id) {
    if (!DL || typeof DL.all !== 'function') return null;
    var j = (DL.all() || []).filter(function (x) { return x.trackId === id; })[0];
    if (!j) return null;
    return {
      id: id,
      name: j.name || (j.filename || '').replace(/\.\w+$/, '') || '已下载歌曲',
      singer: j.singer || '', album: '', platform: j.platform || 'kw',
      duration: 0, cover: j.cover || null, _fromDownload: true
    };
  }

  function playFrom(id, ids) {
    /* 在手势同步栈里先建 AudioContext：ArkWeb 对「脱离手势后创建/恢复 AudioContext」很敏感，
     * 等异步取到播放地址再建，就会出现 ctx 一直 none、音效永不生效。 */
    try { if (engine.prepareGraph) engine.prepareGraph(); } catch (e) {}
    var tr = D.byId(id);
    if (!tr) {
      tr = trackFromDownload(id);
      if (tr) D.addExternalTracks([tr]);
    }
    if (!tr) { toast('这首曲目已不在当前曲库中，请重新搜索后再播放'); return; }
    var local = DL.getPlayableUrl(id);
    /* v3.13.0：原生流式下载的任务没有内存 Blob，只有落盘路径；
     * 这里把它换成应用内同源地址（/__local），这样「已下载」的歌真的是本地播放，
     * 不再回头向音源要地址（网络断了 / 混合内容被拦时就会报「没有解析到播放地址」）。 */
    if (!local && DL.getSavedPath && window.EchoBridge &&
        typeof window.EchoBridge.localMediaUrl === 'function') {
      try {
        var saved = DL.getSavedPath(id);
        if (saved) local = window.EchoBridge.localMediaUrl(saved) || null;
      } catch (e) { local = null; }
    }
    // 离线拦截必须早于队列改写，否则被拒绝的曲目仍会顶替当前播放项（播放器状态与提示不一致）
    if (S.settings.offline && !local) { toast(t('offline_tip', '离线模式下该曲目未下载')); return; }
    // 平台曲目必须有该平台绑定的音源（账号）来解析地址——这就是原版的验证语义
    var src = SR.trackSource(tr);
    if (!local && !src) {
      toast('「' + (tr.platform ? LXPlatform.nameOf(tr.platform) : '该平台') +
        '」还没有绑定音源（账号）：设置 → 平台账号');
      return;
    }
    var list = (ids && ids.length ? ids : contextIds()).slice();
    var i = list.indexOf(id);
    if (i < 0) { list.unshift(id); i = 0; }
    S.queue = list; S.index = i;
    S.playing = false; renderPlayer();
    // 平台音源曲目：先向绑定的音源请求 musicUrl，再交给 <audio> 在线收听
    var prep;
    if (local) prep = Promise.resolve({ kind: 'downloaded', localUrl: local });
    else prep = SR.playableUrl(tr, S.settings.audioQuality || '128k')
      .then(function (m) {
        if (!m) return null;
        var hd = (m.media && m.media.headers) || null;
        var host = String(m.url || '').replace(/^https?:\/\//, '').split('/')[0];
        try { LXdlog('play', 'resolved host=' + host + ' mime=' + (m.mime || '-') +
          ' headers=' + (hd ? Object.keys(hd).join(',') : '-')); } catch (e) {}
        return {
          kind: 'stream', url: m.url, mime: m.mime,
          // 部分音源要求带 Referer / UA 才能取到音频字节，交给原生媒体代理透传
          headers: hd
        };
      })
      .catch(function () { return null; });
    prep.then(function (ref) {
      if (!ref) {
        // 把音源返回的原始原因带出来（例如「仅对认证用户开放：请使用卡密」），
        // 否则用户只会看到笼统的「没有地址」，无法判断该去配置什么。
        var why = SR.lastError ? SR.lastError(tr) : '';
        toast('没有解析到播放地址' + (why ? '：' + why : '：请确认该平台绑定的音源已通过验证'));
        /* 解析失败的歌不能留着上一首的元素继续占着：
         * 否则播放器显示的是新歌、声音还是上一首，进度条也停在上一次的位置（真机日志已证实）。 */
        try { engine.stop(); } catch (e) {}
        S.playing = false;
        renderPlayer();
        if (S.overlay === 'detail') renderOverlay();
        return null;
      }
      return engine.load(tr, ref);
    }).then(function (loaded) {
      if (loaded === null) return;
      if (S.settings.savePlayTime && S.progress[id] && S.progress[id] > 2 && S.progress[id] < tr.duration - 3)
        engine.seek(S.progress[id]);
      engine.setRate(S.rate);
      engine.setVolume(S.volume);
      engine.play();
      S.playing = true;
      var l = S.lists.filter(function (x) { return x.id === 'default'; })[0];
      if (l && l.trackIds.indexOf(id) < 0) l.trackIds.push(id);
      save(); renderPlayer(); renderView();
      if (S.overlay === 'detail') {
        /* 详情页渲染时优先用 S.overlayId（支持从列表打开某首的详情），切歌后必须同步成
         * 当前曲目，否则会出现「声音换了、封面和标题还是上一首」——真机 4127719 实测。 */
        S.overlayId = tr.id;
        renderOverlay();
        loadDetailLyric(tr);
      }
      else if (S.overlay === 'queue' || S.overlay === 'songlist' || S.overlay === 'boardlist') renderOverlay();
    }).catch(function (e) { toast('播放失败：' + String(e && e.message || e)); });
  }
  function togglePlay() {
    if (!S.queue.length) {
      var ids = contextIds();
      if (!ids.length) { toast('还没有可播放的歌曲，先搜索或打开排行榜'); return; }
      playFrom(ids[0], ids); return;
    }
    if (S.playing) { engine.pause(); S.playing = false; }
    else { engine.play(); S.playing = true; }
    renderPlayer();
  }
  function nextTrack(auto) {
    if (!S.queue.length) return;
    var n = S.index;
    if (S.mode === 'singleLoop' && auto) n = S.index;
    else if (S.mode === 'random') {
      n = Math.floor(Math.random() * S.queue.length);
      // 随机也要真的「换一首」：抽到自己就顺延，只有单曲队列才允许原地
      if (n === S.index && S.queue.length > 1) n = (n + 1) % S.queue.length;
    }
    else n = (S.index + 1) % S.queue.length;
    if (n === S.queue.length - 1 && S.mode === 'list' && auto) { engine.pause(); S.playing = false; renderPlayer(); return; }
    S.index = n;
    playFrom(S.queue[n], S.queue);
  }
  function prevTrack() {
    if (!S.queue.length) return;
    S.index = (S.index - 1 + S.queue.length) % S.queue.length;
    playFrom(S.queue[S.index], S.queue);
  }
  function cycleMode() {
    S.mode = MODES[(MODES.indexOf(S.mode) + 1) % MODES.length];
    save();
    toast({ listLoop: '列表循环', random: '随机播放', list: '顺序播放', singleLoop: '单曲循环' }[S.mode]);
    renderOverlay();
  }
  function renderPlayer() {
    var tr = currentTrack();
    var title = $('pbTitle'), info = $('pbInfo'), tog = $('pbToggle');
    if (title) title.textContent = tr ? tr.name : 'LX Music';
    if (info) info.textContent = tr
      ? (tr.singer || '未知歌手') + (tr.album ? ' · ' + tr.album : '')
      : (S.queue.length ? t('player__end', '播放完毕') : '未在播放');
    if (tog) tog.innerHTML = icon(S.playing ? 'pause' : 'play');
    var dt = $('detailToggle'); if (dt) dt.innerHTML = icon(S.playing ? 'pause' : 'play');
    /* 播放条实际高度写进 CSS 变量：歌单 / 榜单目录浮层用它把底边让出来，
     * 保证列表怎么滚都盖不住播放条（不同字号下高度会变）。 */
    var pb = $('playerBar');
    if (pb && pb.offsetHeight) {
      document.documentElement.style.setProperty('--pb-h', pb.offsetHeight + 'px');
    }
  }

  // ---------------------------------------------------------------- 渲染入口
  var VIEWS = {
    nav_search: viewSearch, nav_songlist: viewSongList, nav_top: viewLeaderboard,
    nav_love: viewMyList, nav_download: viewDownload, nav_setting: viewSetting
  };
  function renderView() {
    var el = $('view'); if (!el) return;
    el.innerHTML = (VIEWS[S.nav] || viewSearch)();
    renderHeader();
  }
  function render() { renderNav(); renderView(); renderPlayer(); }

  // ---------------------------------------------------------------- 事件
  function listTracksForDownload() {
    if (S.selected.length) return S.selected.map(D.byId).filter(Boolean);
    if (S.nav === 'nav_search' && S.search.results) return S.search.results.slice(0, 20);
    var l = S.lists.filter(function (x) { return x.id === S.activeList; })[0];
    if (l && l.trackIds.length) return l.trackIds.map(D.byId).filter(Boolean);
    var cur = currentTrack();
    return cur ? [cur] : [];
  }
  function addToList(ids) {
    modal(t('add_to', '添加到...'), S.lists.map(function (l) {
      return '<button class="set-row" style="width:100%;text-align:left" data-act="add-to-list" data-id="' +
        esc(l.id) + '" data-track="' + esc(ids.join(',')) + '"><div class="sr-main"><div class="sr-name">' +
        esc(l.name) + '</div></div>' + icon('chevron-right') + '</button>';
    }).join(''), [{ text: t('cancel', '取消'), act: 'close-modal' }]);
  }

  /* v3.13.6：详情页「收藏」——点一下弹出列表选择，挑一个列表把这歌塞进去。
   * 已经在这个列表里的会直接标「已收藏」，不会重复添加。 */
  function inAnyList(tid) {
    return (S.lists || []).some(function (l) { return l.trackIds.indexOf(tid) >= 0; });
  }
  function collectPicker(id) {
    /* 以详情页当前展示的那首为准（从列表长按进来的详情不一定是正在播放的歌），
     * 详情页没指定 id 时才退回正在播放的曲目。 */
    var tr = (S.overlay === 'detail' && D.byId(S.overlayId)) || D.byId(id) || currentTrack();
    if (!tr) { toast('还没有正在播放的歌曲'); return; }
    var lists = S.lists || [];
    if (!lists.length) { toast('还没有可用的列表，先到「我的列表」新建一个'); return; }
    modal('收藏到列表',
      '<div class="collect-hint">把「' + esc(tr.name) + '」添加到：</div>' +
      lists.map(function (l) {
        var has = l.trackIds.indexOf(tr.id) >= 0;
        return '<button class="set-row" style="width:100%;text-align:left" data-act="collect-to" data-id="' +
          esc(l.id) + '" data-track="' + esc(tr.id) + '"><div class="sr-main"><div class="sr-name">' +
          esc(l.name) + '</div><div class="sr-desc">' + l.trackIds.length + ' 首' +
          (has ? ' · 已收藏' : '') + '</div></div>' +
          (has ? icon('love') : icon('chevron-right')) + '</button>';
      }).join(''),
      [{ text: t('cancel', '取消'), act: 'close-modal' }]);
  }
  /* 音效开关与音频图保持一致：关闭时走原生播放，开启时才把 <audio> 接进 Web Audio。
   * 切换必须重建 <audio>（MediaElementSource 无法撤销），所以只在状态真正不一致时做。
   * v3.13.0：重建包在 try/catch 里 —— 失败只提示一次并把音效关掉，不能让用户看到报错。
   * v3.13.1：用 engine.wantGraph() 判定（在线音源只有在参数真非平时才改接音频图）。 */
  function syncAudioGraph() {
    var want = engine.wantGraph ? engine.wantGraph(engine._lastRef) : false;
    var bound = engine.isGraphBound ? engine.isGraphBound() : !!(engine.el && engine.mediaSrc);
    if (!engine.el) return;
    /* P0-3：图「看着在」但实际已失效（Context closed / 跨上下文 / 节点断链）时，
     * 先原地重挂一次；修好再按 want/bound 决定是否重建，不再拿对象引用当健康证明。 */
    if (bound && engine.isGraphHealthy && !engine.isGraphHealthy()) {
      try { engine.ensureMounted(); } catch (e) {}
      bound = engine.isGraphBound ? engine.isGraphBound() : bound;
      if (!bound) {
        try { engine.rebuild(); } catch (e2) { if (Snd) Snd.setEnabled(false); }
        return;
      }
    }
    if (want === bound) return;
    /* 冷启动阶段音效链未就绪、原生 <audio> 没挂上；链就绪后先直接补挂现有元素，
     * 挂不上再走 Blob 重建路径。 */
    try { if (engine.attachEl) engine.attachEl(); } catch (e) {}
    bound = engine.isGraphBound ? engine.isGraphBound() : bound;
    if (want === bound) return;
    try {
      engine.rebuild();
    } catch (e) {
      if (Snd) Snd.setEnabled(false);
      toast('音效接管失败，已切回原生播放：' + String(e && e.message || e));
    }
  }

  function qualityFor() {
    /* 手动选的档位就是最终请求档位：选母带就按母带请求。
     * 能否真的拿到由音源决定，解析不到时由 download.js 的 downgradeChain 逐档降级，
     * 并在任务行标注「母带音质 → 无损音质」。这里不能用 Q.best 预先降档，
     * 否则用户选了母带、实际却按无损入队，看起来像「最高档被限制」。 */
    return Q.normalize(S.settings.audioQuality || DL.opts.quality) || '320k';
  }
  function afterImport(res) {
    closeModal();
    if (res && res.ok && res.api) {
      S.apiSource = res.api.id;
      // 脚本靠 sources 的 key 声明能服务哪些平台，这里直接把结果告诉用户
      var declare = Object.keys(res.api.sources || {});
      var plats = declare.filter(function (k) { return !!LXPlatform.byId(k); })
        .map(function (k) { return LXPlatform.nameOf(k); });
      toast(t('user_api_import_success_tip', '导入成功 🎉') +
        (plats.length ? ' · 可服务：' + plats.join(' / ')
          : ' · 未声明平台（脚本 sources 里没有 kw/kg/mg/wy/tx）'));
      save();
    } else {
      toast((res && res.message) || t('user_api_add_failed_tip', '无效的自定义源文件'));
    }
    render();
    if (S.overlay === 'userapi') renderOverlay();
  }
  function apiPasteModal(text) {
    modal(t('user_api_btn_import', '导入自定义源脚本'),
      '<textarea id="apiScriptText" class="ua-textarea" spellcheck="false" ' +
      'placeholder="/**\n * @name 我的音源\n * @version 1.0.0\n */">' + esc(text || '') + '</textarea>' +
      '<div class="ua-hint">按原版 user-api v2.0.0 格式编写；导入前请确认脚本来源可信。</div>',
      [{ text: t('cancel', '取消'), act: 'close-modal' },
       { text: t('user_api_btn_import', '导入'), act: 'do-api-paste', primary: true }]);
  }

  function trackMenu(id, x, y) {
    S._menuPos = { x: x || 60, y: y || 120 };
    menu([
      { text: t('play', '播放'), act: 'menu-play', id: id },
      { text: t('collect', '收藏'), act: 'menu-fav', id: id },
      { text: t('play_later', '稍后播放'), act: 'menu-later', id: id },
      { text: t('download', '下载') + '…', act: 'menu-download-q', id: id },
      { text: t('song_detail', '歌曲详情'), act: 'menu-detail', id: id },
      { text: t('comment', '评论'), act: 'menu-comment', id: id },
      { text: t('add_to', '添加到...'), act: 'menu-add', id: id }
    ], x, y);
  }

  /* 任务行音质：若实际拿到的是降级档，显示「母带 → 无损」 */
  function qualityLabelOf(j) {
    var want = j.quality, got = j.deliveredQuality || j.quality;
    if (!want) return '';
    if (got && Q.normalize(got) !== Q.normalize(want)) {
      return Q.name(want) + ' → ' + Q.name(got);
    }
    return Q.name(got);
  }

  /* 「下载」二级菜单：让用户主动选品质（最高母带）。
   * 曲目接口声明可用的档位排在上面并标「可用」，其余标「待验证」仍可点，
   * 因为音源脚本可能自带资源。 */
  function qualityMenu(track, x, y, list) {
    var target = list || [track].filter(Boolean);
    if (!target.length) { toast('没有可下载的歌曲'); return; }
    var first = target[0];
    var items = Q.selectable(first);
    var rows = [{
      head: true,
      text: (target.length > 1 ? '下载 ' + target.length + ' 首 · ' : '下载 · ') + first.name,
      sub: (first.singer || '') + ' · 选择下载品质'
    }];
    var bulk = target.length > 1;
    items.forEach(function (it) {
      rows.push({
        act: bulk ? 'dl-enqueue-at-quality' : 'menu-download', id: first.id, q: it.q,
        text: it.name,
        tail: it.q.toUpperCase() + (it.declared ? ' · 可用' : ''),
        dim: !it.declared
      });
    });
    rows.push({ act: 'menu-download-back', id: first.id, text: '返回' });
    var pos = S._menuPos || {};
    menu(rows, x || pos.x || 60, y || pos.y || 120);
  }

  /* ---------------------------------------------------------------- v3.10.0 设置控件
   * 根因（旧版）：document 的 click 派发器对任何 [data-act] 元素都直接执行 action，
   * 于是点一下 <input>/<select> 就会跑 set-num / set-select / dl-quality → applySettings()
   * → renderView() 重建整个设置页。控件在被输入/选择之前就被替换掉，
   * 表现为「数字框点不动、下拉选不上、下载音质一直是母带」。
   * 处理：表单控件只在 change 事件里生效；点击不派发。
   * 拖动/键入走 input 事件，实时生效但不重渲染，保证交互不被打断。 */
  var FORM_ACTS = {
    'set-num': 1, 'set-select': 1, 'dl-quality': 1, 'dl-auto': 1, 'set-bool': 1,
    'dl-path': 1,
    'set-audio-quality': 1, 'backup-mode': 1, 'sync-toggle': 1,
    'sync-addr': 1, 'sync-port': 1, 'sync-code': 1, 'api-toggle': 1,
    'api-allow-alert': 1, 'fx-toggle': 1, 'fx-surround': 1, 'fx-band': 1, 'fx-trim': 1
  };
  function applyFontScale(v) {
    var fs = Number(v);
    if (!isFinite(fs) || fs <= 0) fs = 14;
    // CSS 全部用 px，改根字号不会生效；这里统一按基准 14px 折算成倍率，
    // 由 styles.css 的 calc(Npx * var(--ui-fs)) 应用（文字/图标一起缩放，不改布局结构）
    var k = Math.min(1.4, Math.max(0.8, fs / 14));
    document.documentElement.style.setProperty('--ui-fs', String(Math.round(k * 1000) / 1000));
  }
  function applyLyricSize(v) {
    var s = Number(v);
    if (!isFinite(s) || s <= 0) s = 16;
    document.documentElement.style.setProperty('--lyric-size', s + 'px');
  }
  /* v3.12.0：下载目录 —— 单一真源是 S.settings.downloadDir，DL.opts.dir 跟着它走 */
  function applyDlPath(p) {
    var d = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '').trim();
    if (!d || d.indexOf('..') >= 0) d = 'Download/LX Music';
    // 交给下载模块做一次统一清洗，避免两处规则不一致
    var old = DL.opts.dir; DL.opts.dir = d;
    var clean = (typeof DL.dirOf === 'function') ? DL.dirOf() : d;
    DL.opts.dir = clean;
    S.settings.downloadDir = clean;
    save();
    toast(t('download_dir', '下载目录') + '：' + clean);
    renderView();
    return clean;
  }
  function openDlPathModal() {
    var cur = (typeof DL.dirOf === 'function') ? DL.dirOf() : 'Download/LX Music';
    modal(t('download_dir', '下载目录'),
      '<input id="dlPathInput" class="ua-textarea dl-dir-input" spellcheck="false" ' +
      'value="' + esc(cur) + '" placeholder="Download/LX Music">' +
      '<div class="ua-hint">填相对路径，可只写子目录（如「我的音乐」，按 Download 处理）。' +
      'Android 10+ 只能写到公共根目录 Download / Music / Documents / Pictures 之下；' +
      '走 MediaStore 写入，无需存储权限，卸载应用不会删掉已下载文件。</div>',
      [{ text: t('cancel', '取消'), act: 'dl-path-cancel' },
       { text: t('confirm', '确定'), act: 'dl-path-apply', primary: true }]);
    var inp = document.getElementById('dlPathInput');
    if (inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 120);
  }

  /* 设置项实时生效（不重建视图）：滑块拖动 / 数字框键入都会立刻看到效果 */
  var LIVE_SETTING = {    playbackRate: function (v) { S.rate = v; engine.setRate(v); },
    fontSize: function (v) { applyFontScale(v); },
    lyricFontSize: function (v) { applyLyricSize(v); },
    dlParallel: function (v) { DL.opts.parallel = Math.max(1, Math.round(v)); }
  };
  function liveSetNum(k, raw, node) {
    var v = Number(raw);
    if (!isFinite(v) || raw === '') return false;
    if (node && node.min !== '' && node.min != null && v < Number(node.min)) v = Number(node.min);
    if (node && node.max !== '' && node.max != null && v > Number(node.max)) v = Number(node.max);
    if (k === 'playbackRate') v = Math.round(v * 10) / 10;
    S.settings[k] = v;
    if (LIVE_SETTING[k]) LIVE_SETTING[k](v);
    // 滑块与数字框互相同步
    var box = node && node.closest ? node.closest('.sr-range') : null;
    if (box && typeof box.querySelectorAll === 'function') {
      Array.prototype.forEach.call(box.querySelectorAll('input'), function (el) {
        if (el !== node) el.value = v;
      });
    }
    return true;
  }

  function onClick(e) {
    var node = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!node) { closeMenu(); closeModalIfBackdrop(e); return; }
    var a = node.dataset.act, id = node.dataset.id, val = node.dataset.val;
    var tag = (node.tagName || '').toUpperCase();
    if (e._change !== true && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && FORM_ACTS[a]) {
      // 控件自身的点击不做事：交给 change / input 事件（否则重渲染会吞掉输入与选择）
      return;
    }
    if (a !== 'track-menu') closeMenu();

    switch (a) {
      case 'drawer': openDrawer(true); return;
      case 'close-drawer': openDrawer(false); return;
      case 'nav':
        S.nav = id; S.multi = false; S.selected = []; openDrawer(false); save(); render();
        // 排行榜 / 歌单首次进入时拉取平台数据（失败会在页面上写明原因）
        if (id === 'nav_top' && !S.boardTracks) loadBoard();
        if (id === 'nav_songlist' && !PL.lists) loadSongLists(1);
        return;
      case 'back-home': toast(t('back_home', '返回桌面')); openDrawer(false); return;
      case 'exit-app': modal(t('exit_app_tip', '确定要退出应用吗？'), '', [
        { text: t('cancel', '取消'), act: 'close-modal' },
        { text: t('confirm', '确定'), act: 'do-exit', primary: true }]); return;
      case 'do-exit': closeModal(); openDrawer(false); toast('已退出（WebView 环境保留页面）'); return;

      // 搜索（v3.13.5：删掉右上角「歌曲/歌单」标签后不再有 search-type 动作）
      case 'set-platform': {
        if (S.platform === id) return;
        S.platform = id;
        S.search.results = null; S.search.apiNote = '';
        S.boardId = ''; S.boardTracks = null; S.boardNote = '';
        PL.lists = null; PL.platform = ''; PL.page = 1;
        PL.detail = null; PL.detailNote = '';
        save(); render();
        if (S.nav === 'nav_top') loadBoard();
        if (S.nav === 'nav_songlist') loadSongLists(1);
        toast(LXPlatform.nameOf(id) + (SR.forPlatform(id) ? ' · 已有音源' : ' · 暂无可用音源'));
        return;
      }
      case 'set-list-platform': {
        S.platform = id;
        PL.lists = null; PL.platform = ''; PL.page = 1;
        PL.detail = null; PL.detailNote = '';
        save(); render();
        loadSongLists(1);
        return;
      }
      case 'pl-refresh': {
        var next = (PL.page || 1) + 1;
        if (next > 6) next = 1;          // 平台歌单页数有限，到头回到第一批
        loadSongLists(next);
        return;
      }
      case 'set-board-platform': {
        S.platform = id;
        S.boardId = ''; S.boardTracks = null; S.boardNote = '';
        save(); render(); loadBoard(); return;
      }
case 'do-search': { var inp = $('searchInput'); doSearch(inp ? inp.value : S.search.text); return; }

      case 'quick-search': doSearch(id); return;



      // 列表与播放

      case 'play-row': playFrom(id); return;

      case 'play-all': case 'play-list': case 'play-board': case 'play-all-songlist': {

        /* 目录（歌单 / 榜单）还在加载时点「播放全部」，以前会静默什么都不发生。
         * 现在等它回来再播，最多等 10 秒，超时给明确提示。 */
        var dirLoading = (S.overlay === 'songlist' && PL.detailLoading) ||
          (S.overlay === 'boardlist' && S.boardLoading);

        if (dirLoading) {

          var tries = 0;

          var timer = setInterval(function () {

            tries++;

            var still = (S.overlay === 'songlist' && PL.detailLoading) ||
              (S.overlay === 'boardlist' && S.boardLoading);

            if (!still) {

              clearInterval(timer);

              var wids = contextIds();

              if (wids.length) playFrom(wids[0], wids);

              else toast('当前列表没有可播放的曲目');

            } else if (tries > 40) { clearInterval(timer); toast('目录加载超时，请稍后重试'); }

          }, 250);

          return;

        }

        var ids = contextIds();

        if (!ids.length) { toast('当前列表没有可播放的曲目'); return; }

        playFrom(ids[0], ids); return;

      }

      case 'toggle': togglePlay(); return;

      case 'next': nextTrack(false); return;

      case 'prev': prevTrack(); return;

      case 'mode': cycleMode(); return;
      case 'open-queue': openOverlay('queue'); return;
      case 'queue-play': {
        var qi = Number(val);
        if (!isFinite(qi) || qi < 0 || qi >= S.queue.length) return;
        S.index = qi;
        playFrom(S.queue[qi], S.queue);
        return;
      }

      case 'rate': {

        var rates = [0.75, 1, 1.25, 1.5, 2];

        S.rate = rates[(rates.indexOf(S.rate) + 1) % rates.length];

        S.settings.playbackRate = S.rate; engine.setRate(S.rate); save();

        toast(t('play_detail_setting_playback_rate', '播放速率') + ' ×' + S.rate); return;

      }

      case 'multi-toggle': S.multi = !S.multi; S.selected = []; renderView(); return;

      case 'multi-exit': S.multi = false; S.selected = []; renderView(); return;

      case 'select': {

        var i = S.selected.indexOf(id);

        if (i >= 0) S.selected.splice(i, 1); else S.selected.push(id);

        renderView(); return;

      }

      case 'select-all': S.selected = contextIds().slice(); renderView(); return;

      case 'dl-save-all': {
        var items = [];
        var all = DL.all ? DL.all() : [];
        (all || []).forEach(function (j) {
          if (j && j.state === 'done' && j.path) items.push({ path: j.path, name: String(j.name || 'export.bin') });
        });
        if (!items.length) { toast('没有可保存的文件'); return; }
        if (window.EchoBridge && typeof window.EchoBridge.saveAllDownloads === 'function') {
          try { window.EchoBridge.saveAllDownloads(JSON.stringify(items)); } catch (e) { toast('保存失败'); }
        }
        return;
      }
      case 'download-selected': case 'dl-add-current': {

        var dlTracks = listTracksForDownload();

        if (!dlTracks.length) { toast('没有可下载的歌曲'); return; }

        // 批量下载也先让用户选品质，而不是默默用默认档

        qualityMenu(dlTracks[0], 0, 0, dlTracks);

        return;

      }

      case 'dl-enqueue-at-quality': {

        var bulk = listTracksForDownload();

        var picked = node.dataset.q || qualityFor();

        var n = DL.enqueue(bulk, picked);

        toast(n ? t('download_added', '已加入下载队列') + ' ' + n + ' 首 · ' + Q.name(picked)

          : t('download_exists', '任务已存在'));

        if (S.nav !== 'nav_download') { S.nav = 'nav_download'; render(); }

        return;

      }

      case 'add-selected': addToList(S.selected.slice()); return;

      case 'add-to-list': {

        var l = S.lists.filter(function (x) { return x.id === id; })[0];

        (node.dataset.track || '').split(',').forEach(function (tid) {

          if (tid && l && l.trackIds.indexOf(tid) < 0) l.trackIds.push(tid);

        });

        closeModal(); save(); renderView(); toast(t('list_add_title_last', '添加成功')); return;

      }

      case 'switch-list': S.activeList = id; S.multi = false; S.selected = []; save(); renderView(); return;

      case 'create-list': modal(t('list_create', '新建列表'),

        '<input id="newListName" placeholder="' + esc(t('list_create_input_placeholder', '你想起啥名...')) + '">',

        [{ text: t('cancel', '取消'), act: 'close-modal' },

         { text: t('confirm', '确定'), act: 'do-create-list', primary: true }]); return;

      case 'do-create-list': {

        var ni = $('newListName'), name = ni && ni.value.trim();

        if (name) { S.lists.push({ id: 'user_' + Date.now(), name: name, trackIds: [] }); save(); renderView(); }

        closeModal(); return;

      }

      case 'list-menu': menu([

        { text: t('list_add_title_first_move', '导入歌单'), act: 'import-list' },

        { text: t('setting_backup', '备份与恢复'), act: 'open-panel', id: 'backup' },

        { text: t('list_create', '新建列表'), act: 'create-list' }

      ], 200, 120); return;

      case 'track-menu': trackMenu(id, e.clientX, e.clientY); return;

      case 'menu-play': playFrom(id); return;

      case 'menu-fav': {

        var lv = S.lists.filter(function (x) { return x.id === 'love'; })[0];

        if (lv.trackIds.indexOf(id) < 0) lv.trackIds.push(id);

        save(); toast(t('collect_success', '收藏成功')); return;

      }

      case 'menu-later': {

        var pl = S.lists.filter(function (x) { return x.id === 'play_later'; })[0];

        if (pl.trackIds.indexOf(id) < 0) pl.trackIds.push(id);

        save(); toast(t('play_later', '稍后播放')); return;

      }

      case 'menu-download-q': {

        var mt = D.byId(id);

        if (!mt) return;

        qualityMenu(mt);

        return;

      }

      case 'menu-download-back': {

        var bt = D.byId(id);

        if (!bt) return;

        var mp = S._menuPos || {};

        trackMenu(id, mp.x, mp.y);

        return;

      }

      case 'menu-download': {

        var one = [D.byId(id)].filter(Boolean);

        if (!one.length) return;

        var qsel = node.dataset.q || qualityFor();

        DL.enqueue(one, qsel);

        toast(t('download_added', '已加入下载队列') + ' · ' + Q.name(qsel));

        return;

      }

      case 'dl-pick-quality': {

        var ids = S.multi && S.selected.length

          ? S.selected.slice()

          : [id];

        var pack = ids.map(function (x) { return D.byId(x); }).filter(Boolean);

        if (!pack.length) return;

        qualityMenu(pack[0], 0, 0, pack);

        return;

      }

      case 'dl-enqueue-quality': {

        var list = (S.multi && S.selected.length ? S.selected.slice() : null) ||

          (S.nav === 'nav_search' && S.search.results ? S.search.results.map(function (x) { return x.id; }) : null) ||

          contextIds();

        var tracks = list.map(function (x) { return D.byId(x); }).filter(Boolean);

        if (!tracks.length) { toast('没有可下载的歌曲'); return; }

        qualityMenu(tracks[0], 0, 0, tracks);

        return;

      }

      case 'menu-detail': case 'open-detail': {

        var dt = currentTrack();

        if (!id && !dt) { toast('还没有正在播放的歌曲'); return; }

        openOverlay('detail', id || dt.id); return;

      }

      case 'menu-comment': openOverlay('comment', id); return;

      case 'menu-add': addToList([id]); return;

      case 'open-songlist': openSongList(id); return;

      case 'open-board': openBoardDetail(id); return;

      case 'board-menu': {

        var bl = currentBoards();

        if (!bl.length) { toast('该平台暂无内置榜单'); return; }

        menu(bl.slice(0, 20).map(function (b) {

          return { text: b.name, act: 'set-board', id: b.id };

        }), 120, 100);

        return;

      }

      case 'set-board': S.boardId = id; closeMenu(); loadBoard(); return;

      case 'sl-tag': S.songlistTag = id; save(); renderView(); return;

      // 自定义源
      case 'api-set-default': {
        var dr = SR.setDefault(id);
        save(); renderOverlay();
        toast(dr.ok ? '已将「' + (SR.byId(id) || {}).name + '」设为默认音源' : dr.message);
        return;
      }
      case 'api-clear-default': {
        SR.setDefault('');
        save(); renderOverlay();
        toast('已取消默认音源，将按脚本声明自动选择');
        return;
      }
      case 'api-refresh': {
        toast('正在检查更新…');
        SR.refresh(id).then(function (r) {
          save(); renderOverlay();
          toast(r.ok ? (r.message || '已更新') : (r.message || '更新失败'));
        }).catch(function (e) {
          toast('更新失败：' + String(e && e.message || e));
        });
        return;
      }
case 'set-audio-quality': S.settings.audioQuality = node.value; save(); toast('音源音质：' + Q.name(node.value)); return;

      case 'api-import-local': pickFile(function (text, fname) {

        afterImport(SR.importScript(text, 'local:' + (fname || 'script.js')));

      }, '.js,.txt,.lx'); return;

      case 'api-import-online': modal(t('user_api_btn_import_online', '在线导入'),

        '<input id="apiUrl" placeholder="' + esc(t('user_api_btn_import_online_input_tip', '请输入 HTTP 链接')) + '">',

        [{ text: t('cancel', '取消'), act: 'close-modal' },

         { text: t('user_api_btn_import', '导入'), act: 'do-api-online', primary: true }]); return;

      case 'do-api-online': {

        var u = $('apiUrl'), url = u ? u.value.trim() : '';

        closeModal();

        toast(t('user_api_btn_import_online_input_loading', '导入中...'));

        SR.importOnline(url, afterImport); return;

      }

      case 'api-import-paste': apiPasteModal(''); return;

      case 'api-load-template': apiPasteModal(id === 'http' ? SR.httpTemplate() : SR.builtinScript()); return;

      case 'do-api-paste': {

        var ta = $('apiScriptText');

        closeModal();

        if (ta) afterImport(SR.importScript(ta.value, 'paste'));

        return;

      }

      case 'api-toggle': SR.setEnabled(id, !!node.checked); renderOverlay(); return;

      case 'api-allow-alert': SR.setAllowUpdateAlert(id, !!node.checked); return;
            case 'api-test': {
        S.nav = 'nav_search'; closeOverlay(); save(); render();
        doSearch(S.search.text || '周杰伦');
        return;
      }
      case 'api-export': {
        var ae = SR.byId(id);
        if (ae) exportFile(ae.name.replace(/[\\/:*?"<>|]/g, '_') + '.js', ae.script, 'application/javascript');
        return;
      }
      case 'api-remove': {
        var ar = SR.byId(id);
        if (ar) modal(t('user_api_remove_tip', '你真的要移除「{name}」吗？').replace('{name}', ar.name), '',
          [{ text: t('cancel', '取消'), act: 'close-modal' },
           { text: t('confirm', '确定'), act: 'do-api-remove', id: id, primary: true }]);
        return;
      }
      case 'do-api-remove': {
        SR.remove(id); closeModal();
        if (S.apiSource === id) S.apiSource = '';
        save(); renderOverlay(); toast(t('remove_success', '已移除')); return;
      }
      case 'api-log-clear': SR.clearLogs(); renderOverlay(); return;
      case 'api-faq': toast('源编写说明：https://lxmusic.toside.cn/mobile/custom-source'); return;

      // 设置
      case 'set-theme': S.theme = id; T.apply(id); save(); render(); toast(T.list.filter(function (x) { return x.id === id; })[0].name); return;
      case 'set-bool': S.settings[id] = !!node.checked; save(); applySettings(); return;
      case 'set-select': S.settings[id] = node.value; save(); applySettings(); return;
      case 'set-num': {
        // 拖动 / 键入过程中已由 input 事件实时生效，这里只做落盘，不重建页面
        if (liveSetNum(id, node.value, node)) save();
        return;
      }
      case 'open-panel': openOverlay(id); return;
      case 'close-overlay': closeOverlay(); return;
      case 'cm-tab': S.commentTab = id; renderOverlay(); return;
      case 'cm-like': S.commentLikes[id] = !S.commentLikes[id]; renderOverlay(); return;
      case 'close-modal': closeModal(); return;

      // 下载
      case 'dl-quality': {
        var qv = Q.normalize(node.value) || '320k';
        S.settings.downloadQuality = qv;
        DL.opts.quality = qv;
        save();
        toast(t('download_quality', '默认下载音质') + '：' + Q.name(qv));
        renderView();
        return;
      }
      case 'dl-auto': {
        S.settings.dlAuto = !!node.checked;
        DL.opts.autoDeliver = !!node.checked;
        if (window.EchoBridge && typeof window.EchoBridge.setAutoExport === 'function') {
          try { window.EchoBridge.setAutoExport(node.checked ? '1' : '0'); } catch (e) {}
        }
        save();
        return;
      }
      case 'dl-dir-pick': {
        if (window.EchoBridge && typeof window.EchoBridge.pickExportDir === 'function') {
          try { window.EchoBridge.pickExportDir(); } catch (e) {}
        }
        return;
      }
      case 'dl-path': {
        var pv = String(node.value || '');
        if (pv === '__custom') { openDlPathModal(); return; }
        applyDlPath(pv);
        return;
      }
      case 'dl-path-cancel': {
        closeModal();
        renderView();   // 下拉可能临时显示「自定义」，取消后回到真实值
        return;
      }
      case 'dl-path-apply': {
        var el = document.getElementById('dlPathInput');
        var val = el ? String(el.value || '') : '';
        var r = DL.dirOf ? (function () {
          var old = DL.opts.dir; DL.opts.dir = val; var d = DL.dirOf(); DL.opts.dir = old; return d;
        })() : 'Download/LX Music';
        // 用户输入被清洗后若为空/非法，退回默认；仍要把清洗结果落到设置里
        applyDlPath(r);
        closeModal();
        return;
      }
      case 'dl-pause': DL.pause(id); return;
      case 'dl-resume': DL.resume(id); return;
      case 'dl-retry': DL.retry(id); return;
      case 'dl-remove': DL.remove(id); return;
      case 'dl-play': {
        var j = DL.all().filter(function (x) { return x.id === id; })[0];
        if (j) playFrom(j.trackId, [j.trackId]);
        return;
      }
      case 'dl-save': {
        // DL.all() 返回的是元数据（不含 Blob），必须按任务 id 取回内部 Blob 再交付
        var okSave = DL.deliverById ? DL.deliverById(id) : false;
        toast(okSave ? '已请求保存到设备' : t('download_not_ready', '文件尚未就绪'));
        return;
      }
      case 'dl-export': {
        var jx = DL.all().filter(function (x) { return x.id === id; })[0];
        if (!jx || !jx.path) { toast(t('download_not_ready', '文件尚未就绪')); return; }
        try { window.EchoBridge.exportDownload(jx.path, jx.mime || 'audio/mpeg'); }
        catch (e) { toast('导出失败'); }
        return;
      }
      case 'dl-resume-all': DL.all().filter(function (j) { return j.state === 'paused'; }).forEach(function (j) { DL.resume(j.id); }); return;
      case 'dl-clear-finished': DL.clearFinished(); renderView(); return;
      case 'detail-download': {
        var dlt = currentTrack();
        if (!dlt) { toast('还没有正在播放的歌曲'); return; }
        qualityMenu(dlt);
        return;
      }
      case 'detail-collect': {
        var ctr = (S.overlay === 'detail' && D.byId(S.overlayId)) || currentTrack();
        if (!ctr) { toast('还没有正在播放的歌曲'); return; }
        collectPicker(ctr.id);
        return;
      }
      case 'collect-to': {
        var cl = S.lists.filter(function (x) { return x.id === id; })[0];
        var clTid = node.dataset.track || '';
        if (!cl || !clTid) { closeModal(); return; }
        if (cl.trackIds.indexOf(clTid) >= 0) { toast('「' + cl.name + '」里已经有这首歌了'); return; }
        cl.trackIds.push(clTid);
        save();
        if (S.nav === 'nav_love') renderView();
        renderOverlay();
        closeModal();
        toast('已收藏到「' + cl.name + '」');
        return;
      }
      case 'detail-effects': openOverlay('effects'); return;
      case 'detail-lyric': {
        S.settings.showLyric = S.settings.showLyric === false;
        save(); renderOverlay();
        var lyt = currentTrack();
        if (lyt && S.settings.showLyric) loadDetailLyric(lyt);
        return;
      }
      case 'lyric-seek': {
        var seekTo = Number(node.dataset.t);
        if (isFinite(seekTo)) engine.seek(seekTo);
        return;
      }
      case 'fx-toggle': {
        /* 真机日志里这个开关出现过「一次点击导致 state 反复翻转」（prepareGraph ok/fail 交替
         * 十几秒），用户看到的现象就是「音效关不掉」。这里按 state 反推目标值 + 400ms 去重，
         * 避免重复派发的事件把开关再打开一次。 */
        var fxNow = Date.now();
        if (S._fxTapAt && fxNow - S._fxTapAt < 400) {
          if (window.LXdlog) window.LXdlog('fx', 'fx-toggle 重复事件已丢弃（' + (fxNow - S._fxTapAt) + 'ms）');
          renderOverlay();
          return;
        }
        S._fxTapAt = fxNow;
        var onFx = Snd ? !Snd.state().enabled : !!node.checked;
        if (Snd) Snd.setEnabled(onFx);
        if (window.LXdlog) window.LXdlog('fx', 'fx-toggle 点击 -> enabled=' + onFx +
          ' state=' + (Snd ? Snd.state().enabled : '-') + ' bound=' + (engine.isGraphBound ? engine.isGraphBound() : '-'));
        /* 关闭时不重建元素/不准备音频图：图本身是干净旁路，重建会卡 1~2 秒没声，
         * 也会让用户误以为「关了没反应」。 */
        if (onFx) { try { if (engine.prepareGraph) engine.prepareGraph(); } catch (e) {} }
        syncAudioGraph();
        renderOverlay();
        return;
      }
    case 'fx-diag': {
      var st2 = (engine.getAudioStatus ? engine.getAudioStatus() : {});
      var snd2 = Snd ? Snd.state() : {};
      var txt = 'ctx=' + st2.ctxState + ' ac=' + st2.acAvailable + ' snd=' + st2.soundLoaded +
        ' bound=' + st2.bound + ' healthy=' + st2.graphHealthy +
        '\nmedia=' + st2.mediaBound + ' mounted=' + st2.mounted + ' gen=' + st2.ctxGen +
        '\nmode=' + (st2.mode || '-') + ' el=' + (!!engine.el) + ' playing=' + (!!engine.playing) +
        ' pos=' + (engine.position ? Math.round(engine.position() * 10) / 10 : '-') + 's' +
        '\n音效: enabled=' + snd2.enabled + ' preset=' + snd2.preset + ' reverb=' + snd2.reverb +
        ' surround=' + (!!snd2.surround) + '\neq=' + JSON.stringify(snd2.eq) +
        '\ngraphHost=' + (st2.graphHost || '-') + ' lite=' + st2.liteUrl + ' pending=' + !!st2.blobPending +
        '\nlastError=' + (st2.lastError || '(无)');
      var box = $('fxDiag');
      if (box) box.textContent = txt;
      if (!engine.el && !engine.playing) toast('当前没有播放中的歌曲：先播一首，再点检测');
      else if (snd2.enabled && !st2.bound) toast('音效已开但未接入音频图：' + (st2.lastError || '原因见上方'));
      if (window.LXdlog) window.LXdlog('audio', txt.replace(/\n/g, ' | '));
      return;
    }
      case 'fx-surround': { if (Snd) Snd.setSurround(!!node.checked); syncAudioGraph(); renderOverlay(); return; }
      case 'fx-preset': { if (Snd) Snd.setPreset(id); try { if (engine.prepareGraph) engine.prepareGraph(); } catch (e) {} syncAudioGraph(); renderOverlay(); return; }
      case 'fx-reverb': { if (Snd) Snd.setReverb(id); syncAudioGraph(); renderOverlay(); return; }
      case 'fx-trim': { if (Snd) Snd.setTrim(Number(node && node.value) / 100); return; }
      case 'fx-reset': { if (Snd) Snd.reset(); syncAudioGraph(); renderOverlay(); toast('已重置音效'); return; }
      case 'dl-retry-failed': {
        var n = 0;
        DL.all().forEach(function (j) { if (j.state === 'error') { DL.retry(j.id); n++; } });
        toast(n ? '已重新加入 ' + n + ' 个失败任务' : '没有失败任务');
        renderView(); return;
      }

      // 备份 / 同步 / 其他
      case 'backup-export': {
        var data = id === 'lists' ? { lists: S.lists } : id === 'settings' ? { settings: S.settings, theme: S.theme } :
          { lists: S.lists, settings: S.settings, theme: S.theme, history: S.history };
        exportFile('lx-music-' + id + '-' + Date.now() + '.json', JSON.stringify(data, null, 2)); return;
      }
      case 'backup-import': pickFile(function (text) {
        try {
          var d = JSON.parse(text);
          if (d.lists) S.lists = S.backup.mode === 'overwrite' ? d.lists : mergeLists(d.lists);
          if (d.settings) Object.keys(d.settings).forEach(function (k) { S.settings[k] = d.settings[k]; });
          if (d.theme) { S.theme = d.theme; T.apply(d.theme); }
          if (d.history) S.history = d.history;
          save(); render(); toast(t('backup_import_success', '导入成功'));
        } catch (err) { toast('导入失败：' + err.message); }
      }); return;
      case 'backup-mode': S.backup.mode = node.value; save(); return;
      case 'sync-toggle': S.sync.connected = !!node.checked; logSync(S.sync.connected ? '已启用同步服务' : '已停用同步服务'); renderOverlay(); return;
      case 'sync-addr': S.sync.addr = node.value; save(); return;
      case 'sync-port': S.sync.port = node.value; save(); return;
      case 'sync-code': S.sync.code = node.value; save(); return;
      case 'sync-connect': logSync('尝试连接 ' + (S.sync.addr || 'localhost') + ':' + (S.sync.port || '23332'));
        S.sync.connected = true; renderOverlay(); return;
      case 'log-clear': S.errorLog = []; save(); renderOverlay(); return;
      case 'log-export': exportDiagnostic(); return;
      case 'log-view':
        S.diagText = buildDiagnosticLog();
        openOverlay('diaglog');
        return;
      case 'diaglog-refresh':
        S.diagText = buildDiagnosticLog();
        renderOverlay();
        return;
      case 'log-copy': copyDiagText(); return;
      case 'import-list': pickFile(function (text) {
        try {
          var d = JSON.parse(text), ids = (d.tracks || d.list || []).map(function (x) {
            return typeof x === 'string' ? x : x.id;
          }).filter(Boolean);
          var l = S.lists.filter(function (x) { return x.id === S.activeList; })[0];
          ids.forEach(function (tid) { if (l.trackIds.indexOf(tid) < 0) l.trackIds.push(tid); });
          save(); renderView(); toast('导入 ' + ids.length + ' 首');
        } catch (err) { toast('导入失败：' + err.message); }
      }); return;
    }
  }
  function mergeLists(incoming) {
    incoming.forEach(function (l) {
      var cur = S.lists.filter(function (x) { return x.id === l.id; })[0];
      if (cur) l.trackIds.forEach(function (tid) { if (cur.trackIds.indexOf(tid) < 0) cur.trackIds.push(tid); });
      else S.lists.push(l);
    });
    return S.lists;
  }
  function logSync(msg) {
    S.sync.log.unshift(new Date().toLocaleTimeString('zh-CN') + ' ' + msg);
    S.sync.log = S.sync.log.slice(0, 20); save();
  }
  function diagSection(title, lines) {
    return '\n==== ' + title + ' ====\n' + (lines && lines.length ? lines.join('\n') : '(无)');
  }
  /* 汇总内存里能拿到的全部诊断信息：引擎自检 / 音效 / 音源列表 / 歌词诊断 / 运行日志 /
   * 错误日志 / 下载任务 / 诊断缓冲，打成纯文本导出，供回传分析（替代 hdc 抓 hilog）。 */
  function buildDiagnosticLog() {
    var out = [];
    var tr = currentTrack();
    var st = (engine.getAudioStatus ? engine.getAudioStatus() : {});
    var snd = Snd ? Snd.state() : {};
    out.push('==== LX Music 诊断日志 ====');
    out.push('版本: ' + (window.LXBuild || '(未知，浏览器预览构建)'));
    out.push('导出时间: ' + new Date().toLocaleString('zh-CN'));
    out.push('UA: ' + navigator.userAgent);
    out.push('队列: ' + Math.min(S.index + 1, S.queue.length) + '/' + S.queue.length + ' · 模式=' + (S.mode || '-'));
    if (tr) {
      out.push('当前曲目: ' + (tr.name || '') + ' · ' + (tr.singer || ''));
      out.push('  id=' + tr.id + ' platform=' + (tr.platform || '-') + ' apiSource=' + (tr.apiSource || '-'));
      var le = SR.lastError(tr);
      if (le) out.push('  音源错误: ' + le);
    } else {
      out.push('当前曲目: (无)');
    }
    out.push('播放: playing=' + !!engine.playing + ' pos=' +
      (engine.position ? Math.round(engine.position() * 10) / 10 : '-') + 's' +
      ' duration=' + (tr && tr.duration ? tr.duration : '-'));

    out.push(diagSection('引擎自检', [
      'ctx=' + st.ctxState + ' ac=' + st.acAvailable + ' snd=' + st.soundLoaded,
      'bound=' + st.bound + ' healthy=' + st.graphHealthy + ' media=' + st.mediaBound + ' mounted=' + st.mounted,
      'gen=' + st.ctxGen + ' mode=' + (st.mode || '-') + ' el=' + !!engine.el,
      'graphHost=' + (st.graphHost || '-') + ' lite=' + st.liteUrl + ' pending=' + !!st.blobPending,
      'lastError=' + (st.lastError || '(无)')
    ]));

    var elLines = [];
    if (engine.el) {
      var e = engine.el, bufEnd = '-';
      try { if (e.buffered && e.buffered.length) bufEnd = Math.round(e.buffered.end(e.buffered.length - 1)) + 's'; } catch (er) {}
      var raw = String(engine._rawUrl || engine._lastUrl || '');
      elLines.push('srcHost=' + (raw ? raw.replace(/^https?:\/\//, '').split('/')[0] : '-'));
      elLines.push('mime=' + (engine.mediaMime || '-') + ' currentTime=' + (e.currentTime || 0).toFixed(1) +
        ' duration=' + (isFinite(e.duration) ? Math.round(e.duration) : '-') + 's');
      elLines.push('readyState=' + e.readyState + ' paused=' + e.paused + ' buffered=' + bufEnd +
        ' volume=' + e.volume.toFixed(2) + ' rate=' + e.playbackRate);
    } else {
      elLines.push('(无活动 audio 元素，mode=' + (st.mode || '-') + ')');
    }
    out.push(diagSection('音频元素', elLines));
    out.push(diagSection('音效状态', [
      'enabled=' + snd.enabled + ' preset=' + snd.preset + ' reverb=' + snd.reverb,
      'surround=' + !!snd.surround + ' eq=' + JSON.stringify(snd.eq),
      'trim=' + Math.round((snd.trim || 1) * 100) + '%',
      // route=direct 表示没串 HRTF 全景声节点（链路增益恒等）；route=panner 只在开了环绕时出现
      'route=' + (window.LXSound && typeof window.LXSound.route === 'function' ? window.LXSound.route() : '-')
    ]));

    var srcLines = SR.list().map(function (a) {
      var plats = a.sources ? Object.keys(a.sources).join(',') : '-';
      return '· ' + (a.name || a.id) + ' id=' + a.id + ' status=' + (a.status || '-') +
        ' enabled=' + !!a.enabled + ' builtin=' + !!a.builtin + ' platforms=' + plats;
    });
    out.push(diagSection('音源列表', srcLines));
    /* lyricDiag() 返回的是 {src,ok,detail} 对象数组，直接 join 会打成「[object Object]」，
     * 等于把最有用的歌词失败原因全丢了。这里格式化成一行一条。 */
    var lyrLines = (SR.lyricDiag() || []).map(function (d) {
      if (d && typeof d === 'object') {
        return (d.ok ? 'ok   ' : 'FAIL ') + (d.src || '-') + ' · ' + (d.detail || '-');
      }
      return String(d);
    });
    out.push(diagSection('歌词诊断', lyrLines));
    out.push(diagSection('音源运行日志', SR.logs()));
    out.push(diagSection('错误日志', S.errorLog.slice()));
    out.push(diagSection('同步日志', S.sync.log.slice()));

    var dlLines = DL.all().map(function (j) {
      return '· [' + j.state + '] ' + j.name + ' - ' + j.singer + (j.error ? '  err=' + j.error : '');
    });
    out.push(diagSection('下载任务', dlLines));

    /* 原生桥轨迹：只记可能拉起系统文件管理器/保存框的动作。注意这一段是**导出动作之前**的
     * 快照（本次导出自己那次 exportDownload 记录不会出现在里面）。冷启动若又弹窗，
     * 这段能区分是我们调了 picker、还是 ArkWeb/系统自己的行为。 */
    var natLines = ['(无原生桥)'];
    try {
      if (window.EchoBridge && typeof window.EchoBridge.nativeTrace === 'function') {
        natLines = String(window.EchoBridge.nativeTrace() || '(无)').split('\n');
      }
    } catch (e) { natLines = ['(读取失败: ' + ((e && e.message) || e) + ')']; }
    out.push(diagSection('原生桥轨迹（导出前快照）', natLines));

    out.push(diagSection('诊断缓冲', devLog.map(function (d) {
      return d.t + ' [' + d.tag + '] ' + d.msg;
    })));
    return out.join('\n');
  }
  function exportDiagnostic() {
    var text = buildDiagnosticLog();
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    var name = 'lx-diag-' + stamp + '.txt';
    var B = window.EchoBridge;
    if (B && typeof B.saveText === 'function') {
      try {
        B.saveText(name, text);
        if (typeof B.exportDownload === 'function') { try { B.exportDownload(name, 'text/plain'); } catch (e) {} }
        toast('诊断日志已导出：' + name);
      } catch (e) { toast('导出失败：' + e.message); }
    } else {
      try {
        var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) {}
      toast('浏览器环境已触发下载');
    }
  }
  /* 复制全文：ArkWeb 里 navigator.clipboard 常因非安全上下文不可用，
   * 用 textarea + execCommand 兜底，选中的范围也留在页面上供手动长按复制。 */
  function copyDiagText() {
    var text = S.diagText || buildDiagnosticLog();
    var done = function () { toast('已复制全文，可直接粘贴发送'); };
    var fail = function () {
      try {
        var sel = window.getSelection ? window.getSelection() : null;
        var pre = $('diagPre');
        if (pre && sel) {
          var r = document.createRange();
          r.selectNodeContents(pre);
          sel.removeAllRanges(); sel.addRange(r);
        }
      } catch (e) {}
      toast('已选中全文，长按可复制');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : fail(); });
        return;
      }
    } catch (e) {}
    legacyCopy(text) ? done() : fail();
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function applySettings(noRender) {
    var b = document.body;
    b.classList.toggle('no-animation', !S.settings.fontShadow);
    engine.setRate(S.settings.playbackRate || 1);
    engine.setVolume(S.volume);
    var root = document.documentElement;
    root.style.setProperty('--lyric-align', S.settings.lyricAlign || 'center');
    applyFontScale(S.settings.fontSize);
    applyLyricSize(S.settings.lyricFontSize);
    if (!noRender) renderView();
  }
  function closeModalIfBackdrop(e) {
    var r = $('modalRoot');
    if (r && !r.classList.contains('hidden') && e.target === r) closeModal();
  }

  // ---------------------------------------------------------------- 手势 / 键盘
  var touchX = 0, touchY = 0;
  function onTouchStart(e) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
  function onTouchEnd(e) {
    if (!S.settings.homePageScroll || S.overlay) return;
    var dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (dx < 0 && touchX < 30) { openDrawer(true); return; }   // 边缘右滑开抽屉
    var order = NAVS.map(function (n) { return n.id; });
    var i = order.indexOf(S.nav) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < order.length) { S.nav = order[i]; openDrawer(false); save(); render(); }
  }
  /* 系统返回键（Android）：先关浮层 / 菜单 / 抽屉，再回到搜索主界面，最后才允许退出。
   * 返回 true 表示这次返回已被页面消费，原生壳据此决定是否 finish()。 */
  function handleBack() {
    if (S.overlay) { closeOverlay(); return true; }
    var r = $('modalRoot');
    if (r && !r.classList.contains('hidden')) { closeModal(); return true; }
    var m = $('contextMenu');
    if (m && !m.classList.contains('hidden')) { closeMenu(); return true; }
    var d = $('drawer');
    if (d && d.classList.contains('open')) { openDrawer(false); return true; }
    // 任何其它页面都先回搜索主页，而不是直接退出应用
    if (S.nav !== 'nav_search') {
      S.nav = 'nav_search'; S.multi = false; S.selected = [];
      save(); render(); return true;
    }
    if (S.search.results) {
      S.search.results = null; S.search.apiNote = ''; S.search.searching = false;
      renderView(); return true;
    }
    if (S.search.text) {
      S.search.text = '';
      var inp = $('searchInput'); if (inp) inp.value = '';
      renderView(); return true;
    }
    return false;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (S.overlay) { closeOverlay(); return; }
      var r = $('modalRoot'); if (r && !r.classList.contains('hidden')) { closeModal(); return; }
      var m = $('contextMenu'); if (m && !m.classList.contains('hidden')) { closeMenu(); return; }
      var d = $('drawer'); if (d && d.classList.contains('open')) { openDrawer(false); return; }
    }
  }

  // ---------------------------------------------------------------- 初始化
  window.LXApp = {
    state: S, engine: engine, render: render, renderView: renderView,
    renderPlayer: renderPlayer, renderOverlay: renderOverlay,
    toast: toast, save: save, esc: esc, t: t, fmt: fmt,
    playFrom: playFrom, currentTrack: currentTrack, openOverlay: openOverlay,
    closeOverlay: closeOverlay, trackList: trackList,
    handleBack: handleBack, loadBoard: loadBoard, loadSongLists: loadSongLists,
    setDlPath: applyDlPath, dlPathModal: openDlPathModal
  };

  function init() {
    restore();
    migrate();
    T.apply(S.theme);
    engine.setVolume(S.volume);
    engine.setRate(S.settings.playbackRate || 1);
    // v3.10.0：字号/歌词字号在启动时就要应用（旧版只写根字号且从不调用，等于永远不生效）
    applyFontScale(S.settings.fontSize);
    applyLyricSize(S.settings.lyricFontSize);
    document.documentElement.style.setProperty('--lyric-align', S.settings.lyricAlign || 'center');
    // 下载偏好落盘后回填到下载队列（音质 / 并发 / 自动保存）
    DL.opts.quality = Q.normalize(S.settings.downloadQuality || DL.opts.quality) || '320k';
    DL.opts.parallel = Math.min(4, Math.max(1, Number(S.settings.dlParallel) || DL.opts.parallel || 2));
    DL.opts.autoDeliver = S.settings.dlAuto !== false;
    if (window.EchoBridge && typeof window.EchoBridge.setAutoExport === 'function') {
      try { window.EchoBridge.setAutoExport(DL.opts.autoDeliver ? '1' : '0'); } catch (e) {}
    }
    // v3.12.0：下载目录同样要在启动时回填，否则「改了路径但下次安装回默认」
    DL.opts.dir = S.settings.downloadDir && String(S.settings.downloadDir).trim() || 'Download/LX Music';
    if (typeof DL.dirOf === 'function') DL.opts.dir = DL.dirOf();
    S.settings.downloadDir = DL.opts.dir;
    S.settings.playbackRate = Number(S.settings.playbackRate) || 1;
    S.rate = S.settings.playbackRate;
    engine.onTick = function (pos, dur) {
      var fill = $('pbProgressFill');
      if (fill) fill.style.width = (dur ? pos / dur * 100 : 0) + '%';
      var now = $('dTimeNow'); if (now) now.textContent = fmt(pos);
      var all = $('dTimeAll'); if (all) all.textContent = fmt(dur);
      var seek = $('detailSeek'); if (seek && document.activeElement !== seek) seek.value = dur ? pos / dur * 100 : 0;
      var box = $('lyricBox');
      if (box && S._lyr) Lyr.sync(box, S._lyr, pos);
      var tr = currentTrack();
      if (tr) S.progress[tr.id] = pos;
      /* 引擎真实状态与界面镜像不一致时以引擎为准（自动播放被拒 / 外部暂停等） */
      if (!!S.playing !== !!engine.playing) {
        S.playing = !!engine.playing;
        renderPlayer();
      }
    };
    engine.onEnded = function () { S.playing = false; nextTrack(true); };
    engine.onStateChange = function (playing) {
      S.playing = !!playing;
      renderPlayer();
    };
    engine.onError = function (msg) { toast(msg); S.playing = false; renderPlayer(); };
    // 音频服务器不允许跨域时，音效会让浏览器静音；此时自动退回原生播放并说明
    engine.onGraphFallback = function () {
      if (Snd) Snd.setEnabled(false);
      toast('该音源不允许跨域，已关闭音效以保证正常播放');
      if (S.overlay === 'effects') renderOverlay();
    };
    /* v3.13.2：在线曲目接音效时要把音频缓存成本地 Blob（同源）才行，取不到字节就保持原生播放。
     * 这种情况不关音效开关、也不停播，只提示一次，避免用户以为「开了没声音」。 */
    engine.onGraphUnavailable = function (why) {
      if (S._fxHintShown) return;
      S._fxHintShown = true;
      toast('音效需要先缓存这段音频，当前取不到音频数据（' + (why || '网络原因') +
        '），已保持原生播放，不影响收听');
      setTimeout(function () { S._fxHintShown = false; }, 60000);
    };
    SR.onChange(function () {
      if (S.overlay === 'userapi') renderOverlay();
      var b = document.querySelector('.nav-badge');
      if (b) b.textContent = DL.stats().done;
    });
    /* v3.13.1：音效参数一变就和音频图对齐。原来只有 EQ 滑块的 input/change 事件会触发同步，
     * 于是「先播放、再调参数」或脚本/预设改参数时音频图不会重建，表现为「改了没效果」。
     * syncAudioGraph 内部只在「想接管 / 已接管」不一致时才重建，重复调用没有代价。 */
    if (Snd && Snd.onChange) Snd.onChange(function () { syncAudioGraph(); });
    // 下载完成后顺手保存同名歌词（音源实现 lyric 时），对齐 web 播放器的行为
    DL.onDone(function (job) {
      var tr = D.byId(job.trackId);
      if (!tr || !SR.lyric) return;
      SR.lyric(tr).then(function (r) {
        var text = r && (typeof r === 'string' ? r : (r.lyric || r.lrc));
        if (!text || typeof text !== 'string') return;
        var name = String(job.filename || (job.name + ' - ' + job.singer))
          .replace(/\.[^.\/]+$/, '') + '.lrc';
        var B = window.EchoBridge;
        if (B && typeof B.saveText === 'function') B.saveText(name, text);
      }).catch(function () {});
    });
    DL.onChange(function () {
      var b = document.querySelector('.nav-badge');
      if (b) b.textContent = DL.stats().done;
    });
    render();
    // 选择文件期间若 WebView 被系统回收，页面重建后主动取回暂存结果。
    // 注意：鸿蒙侧 pickScriptPull 现在是**空操作**（原生不缓存选择结果）。此前它被实现成
    // 「再调一次 pickScript」，于是每次冷启动/页面重建都会拉起系统文件选择器（真机实测）。
    try {
      if (window.EchoBridge && EchoBridge.pickScriptPull) EchoBridge.pickScriptPull();
    } catch (e) {}
    document.addEventListener('click', onClick, false);
    document.addEventListener('change', function (e) {
      var n = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!n) return;
      var a = n.dataset.act;
      if (a === 'fx-band') { syncAudioGraph(); return; }
      if (a === 'set-bool' || a === 'set-select' || a === 'set-num' ||
          a === 'dl-quality' || a === 'dl-auto' || a === 'dl-path' || a === 'backup-mode' ||
          a === 'set-audio-quality' || a === 'api-toggle' || a === 'api-allow-alert' ||
          a === 'fx-toggle' || a === 'fx-surround')
        onClick({ target: n, _change: true });
      else if (a === 'sync-toggle' || a === 'sync-addr' || a === 'sync-port' || a === 'sync-code')
        onClick({ target: n, _change: true });
    }, false);
    document.addEventListener('keydown', onKey);
    $('view').addEventListener('touchstart', onTouchStart, { passive: true });
    $('view').addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'detailSeek') {
        engine.seek(Number(e.target.value) / 100 * engine.duration);
      }
      if (e.target && e.target.id === 'searchInput') S.search.text = e.target.value;
      // 均衡器滑块：拖动即时生效，只更新数值，不重渲染（否则会打断拖动）
      if (e.target && e.target.dataset && e.target.dataset.act === 'fx-band' && Snd) {
        var bi = Number(e.target.dataset.i), bv = Number(e.target.value);
        Snd.setBand(bi, bv);
        var lbl = document.getElementById('fxVal' + bi);
        if (lbl) lbl.textContent = (bv > 0 ? '+' : '') + bv;
      }
      // 音量补偿：拖动即时生效（同 fx-band，不重渲染，避免打断拖动）
      if (e.target && e.target.dataset && e.target.dataset.act === 'fx-trim' && Snd) {
        var tv = Number(e.target.value);
        Snd.setTrim(tv / 100);
        var tl = document.getElementById('fxTrimVal');
        if (tl) tl.textContent = tv + '%';
      }
      // 设置页的滑块 / 数字框：拖动和键入都实时生效，不重渲染（v3.10.0）
      if (e.target && e.target.dataset && e.target.dataset.act === 'set-num') {
        liveSetNum(e.target.dataset.id, e.target.value, e.target);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'searchInput') doSearch(e.target.value);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
