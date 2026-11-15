/* 数据层（v3.2.0 起不含任何演示音乐）
 * 结构、榜单名称、分类标签沿用 LX Music v1.9.2 的界面口径；
 * 歌曲、歌单、歌词、评论全部来自用户导入的自定义音源，经 external 池动态注入。
 * 内置曲库为空是刻意设计：避免测试曲目混进搜索结果。
 */
(function () {
  'use strict';

  var external = {};
  var SOURCES = [
    { id: 'kw', name: '酷我音乐', short: '酷我' },
    { id: 'kg', name: '酷狗音乐', short: '酷狗' },
    { id: 'mg', name: '咪咕音乐', short: '咪咕' },
    { id: 'wy', name: '网易云音乐', short: '网易' },
    { id: 'tx', name: 'QQ音乐', short: 'QQ' }
  ];

  // 榜单名称取自 v1.9.2 Hermes bundle 字符串表（evidence/ui-contexts.txt）
  var BOARDS = [
    { id: 'kw__16', name: '飙升榜', desc: '酷我音乐', color: '#4daf7c' },
    { id: 'kw__17', name: '热歌榜', desc: '酷我音乐', color: '#e57b58' },
    { id: 'kw__3', name: '酷我热歌榜', desc: '酷我音乐', color: '#d64541' },
    { id: 'kw__22', name: 'ACG新歌榜', desc: '酷我音乐', color: '#9b59b6' },
    { id: 'kw__26', name: '抖音榜', desc: '酷我音乐', color: '#4f62d0' },
    { id: 'kw__27', name: '快手热歌榜', desc: '酷我音乐', color: '#f5ab35' },
    { id: 'kw__28', name: 'KTV唛榜', desc: '酷我音乐', color: '#e1828d' },
    { id: 'kw__29', name: 'K歌金曲榜', desc: '酷我音乐', color: '#bc8044' },
    { id: 'kw__30', name: 'Vlog音乐榜', desc: '酷我音乐', color: '#4baed5' },
    { id: 'kw__31', name: '最强翻唱榜', desc: '酷我音乐', color: '#7fb575' },
    { id: 'kw__32', name: '经典怀旧榜', desc: '酷我音乐', color: '#af9479' },
    { id: 'kw__33', name: '小语种热歌榜', desc: '酷我音乐', color: '#6376a2' },
    { id: 'kw__34', name: '中国新乡村音乐排行榜', desc: '酷我音乐', color: '#647d39' },
    { id: 'kw__35', name: '腾讯音乐人原创榜', desc: '酷我音乐', color: '#33767b' },
    { id: 'kw__36', name: '校园音乐人排行榜', desc: '酷我音乐', color: '#e7aa36' },
    { id: 'kw__37', name: 'Beatport电子舞曲榜', desc: '酷我音乐', color: '#483472' },
    { id: 'kw__38', name: '美国Billboard榜', desc: '酷我音乐', color: '#c851d4' },
    { id: 'kw__39', name: '英国UK榜周榜', desc: '酷我音乐', color: '#4d83af' },
    { id: 'kw__40', name: 'YouTube音乐排行榜', desc: '酷我音乐', color: '#d64541' },
    { id: 'kw__41', name: '枕边轻音乐榜', desc: '酷我音乐', color: '#9ed458' },
    { id: 'kw__42', name: '华语内地榜', desc: '酷我音乐', color: '#f5b684' },
    { id: 'kw__43', name: '巅峰榜', desc: '酷我音乐', color: '#bcaaa4' },
    { id: 'kw__44', name: '编辑推荐榜', desc: '酷我音乐', color: '#e5a39f' },
    { id: 'kw__45', name: '摇滚榜', desc: '酷我音乐', color: '#795548' }
  ];

  var TAGS = ['推荐', '最新', '热门', '古风', '电音', 'DJ', '伤感', '轻音乐', '摇滚',
    '民谣', 'ACG', '治愈', '国风', '日语', '欧美', '纯音乐', '爵士', '说唱'];

  function fmt(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* v3.2.0：内置演示曲目、演示歌单、热门词、歌词、评论全部清空。
   * 所有音乐内容只来自用户导入的 JS 音源（经 addExternalTracks 注入 external 池）。
   * 保留 BOARDS / TAGS 只是界面骨架（榜单名与分类标签），不含任何歌曲数据。 */
  var tracks = [];
  var SONGLISTS = [];
  var HOT_WORDS = [];
  var LYRICS = [];
  var COMMENTS = [];

  var LIST_IDS = {
    DEFAULT: 'default', LOVE: 'love', TEMP: 'temp', DOWNLOAD: 'download', PLAY_LATER: 'play_later'
  };

  window.LXData = {
    SOURCES: SOURCES, BOARDS: BOARDS, TAGS: TAGS, SONGLISTS: SONGLISTS,
    tracks: tracks, HOT_WORDS: HOT_WORDS, LYRICS: LYRICS, COMMENTS: COMMENTS,
    LIST_IDS: LIST_IDS, fmt: fmt,
    // 自定义音源注入的动态曲目池：搜索结果由 JS 音源脚本返回，不写死在演示数据里
    external: external,
    addExternalTracks: function (arr) {
      (arr || []).forEach(function (t) { if (t && t.id) external[t.id] = t; });
    },
    sourceName: function (id) {
      if (String(id).indexOf('api:') === 0) {
        var a = window.LXSources && window.LXSources.byId(String(id).slice(4));
        return a ? a.name : '自定义源';
      }
      var s = SOURCES.filter(function (x) { return x.id === id; })[0];
      return s ? s.short : (id === 'all' ? '聚合' : id);
    },
    byId: function (id) {
      return tracks.filter(function (t) { return t.id === id; })[0] || external[id] || null;
    }
  };
})();
