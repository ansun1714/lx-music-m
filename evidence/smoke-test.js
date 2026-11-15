/* v3 冒烟测试：Node + 最小 DOM/Web API shim，验证 LX Music 界面复现版
 * 用法：node evidence/smoke-test.js
 *
 * 目标：
 *  1) 模拟浏览器冷启动：readyState=loading、八个脚本按序加载、再触发 DOMContentLoaded
 *  2) 验证界面骨架（抽屉 6 项导航 / 原版文案 / 42px Header / PlayerBar）
 *  3) 验证 16 套主题、520 条文案、52 个图标、24 个榜单
 *  4) 验证 6 个视图、全屏页、搜索、播放、设置、备份/同步
 *  5) 验证歌曲下载：真实 WAV 头、队列状态机、Android 分块桥、离线播放
 *  6) 验证自定义 JS 音源：user-api v2.0.0 兼容层、导入、搜索、在线收听、按格式下载
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const APP = path.resolve(__dirname, '..', 'app');
const SCRIPTS = ['i18n.js', 'themes.js', 'data.js', 'engine.js', 'sound-effects.js',
  'source-api.js', 'sources.js', 'net-crypto.js', 'platform.js', 'quality.js', 'lyrics.js', 'download.js', 'app.js'];

/* 冒烟测试专用的 JS 音源：3 首曲目，覆盖 search / leaderboard / musicUrl / downloadUrl。
 * 产品默认数据已清空，测试必须自己导入音源才能验证搜索与播放链路。 */
const TEST_SCRIPT = [
  '/**',
  ' * @name 测试源',
  ' * @description 冒烟测试用',
  ' * @version 1.0.0',
  ' * @author qa',
  ' * @homepage https://example.com',
  ' */',
  'const { EVENT_NAMES, on, send, utils } = globalThis.lx',
  'const list = [',
  '  { songmid: "qa1", name: "夜测一", singer: "测试歌手", album: "QA", duration: 100, ext: "wav" },',
  '  { songmid: "qa2", name: "夜测二", singer: "测试歌手", album: "QA", duration: 110, ext: "wav" },',
  '  { songmid: "qa3", name: "夜测三", singer: "测试歌手", album: "QA", duration: 120, ext: "wav" }',
  ']',
  'function wavUrl() {',
  '  const sr = 6000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)',
  '  function str(o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }',
  '  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE")',
  '  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true)',
  '  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true)',
  '  v.setUint16(32, 2, true); v.setUint16(34, 16, true)',
  '  str(36, "data"); v.setUint32(40, n * 2, true)',
  '  return "data:audio/wav;base64," + utils.buffer.bufToString(new Uint8Array(buf), "base64")',
  '}',
  'function withMeta(x, source) { return Object.assign({}, x, { source, qualitys: ["128k"], ext: "wav", mime: "audio/wav" }) }',
  'on(EVENT_NAMES.request, ({ source, action, info }) => {',
  '  if (action === "search") {',
  '    const kw = String(info.keyword || "")',
  '    return Promise.resolve(list.filter(x => !kw || (x.name + x.singer).indexOf(kw) >= 0).map(x => withMeta(x, source)))',
  '  }',
  '  if (action === "leaderboard") return Promise.resolve(list.map(x => withMeta(x, source)))',
  '  if (action === "musicUrl") return Promise.resolve(wavUrl())',
  '  if (action === "downloadUrl") return Promise.resolve({',
  '    data: wavUrl(), mime: "audio/wav", ext: "wav",',
  '    filename: info.musicInfo.name + " - " + info.musicInfo.singer + ".wav" })',
  '  if (action === "lyric") return Promise.resolve({ lyric: "[00:00]测试歌词" })',
  '  return Promise.reject(new Error("unsupported action: " + action))',
  '})',
  'const ACTIONS = ["search", "leaderboard", "musicUrl", "downloadUrl", "lyric"]',
  'send(EVENT_NAMES.inited, { sources: {',
  '  kw: { name: "测试源", type: "music", actions: ACTIONS, qualitys: ["128k"] },',
  '  kg: { name: "测试源", type: "music", actions: ACTIONS, qualitys: ["128k"] },',
  '  test: { name: "测试源", type: "music", actions: ACTIONS, qualitys: ["128k"] }',
  '} })'
].join('\n');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}
function group(title) { console.log('\n=== ' + title + ' ==='); }

// ------------------------------------------------------------------ DOM shim
function makeEl(id) {
  const cls = new Set();
  const el = {
    id: id || '', tagName: 'DIV', innerHTML: '', textContent: '', value: '',
    checked: false, style: {}, dataset: {}, _ev: {},
    classList: {
      add: (...a) => a.forEach(x => cls.add(x)),
      remove: (...a) => a.forEach(x => cls.delete(x)),
      contains: x => cls.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !cls.has(x) : !!force;
        if (on) cls.add(x); else cls.delete(x);
        return on;
      }
    },
    addEventListener(t, fn) { (this._ev[t] || (this._ev[t] = [])).push(fn); },
    removeEventListener() {},
    appendChild(x) { (this.children || (this.children = [])).push(x); return x; },
    removeChild(x) {
      if (this.children) { const i = this.children.indexOf(x); if (i >= 0) this.children.splice(i, 1); }
      return x;
    },
    remove() {}, click() {}, focus() {},
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
  el.style.setProperty = function (k, v) { this[k] = v; };
  return el;
}

const nodes = {};
const docEvents = {};
const cssVars = {};
const document = {
  readyState: 'loading',
  documentElement: makeEl('html'),
  body: makeEl('body'),
  activeElement: null,
  getElementById(id) { return nodes[id] || (nodes[id] = makeEl(id)); },
  createElement(tag) { const e = makeEl(''); e.tagName = String(tag).toUpperCase(); return e; },
  querySelector(sel) { return sel === '.nav-badge' ? (nodes.__badge || null) : null; },
  querySelectorAll() { return []; },
  addEventListener(t, fn) { (docEvents[t] || (docEvents[t] = [])).push(fn); },
  removeEventListener() {}
};
document.documentElement.style.setProperty = function (k, v) { cssVars[k] = v; this[k] = v; };
['navMenus', 'drawerFoot', 'headerTitle', 'headerExtra', 'view', 'playerBar', 'pbTitle',
  'pbInfo', 'pbToggle', 'pbProgressFill', 'overlay', 'modalRoot', 'contextMenu', 'toast',
  'drawer', 'drawerMask', 'searchInput', 'dlList', 'detailSeek', 'lyricBox', 'dTimeNow',
  'dTimeAll', 'detailToggle'].forEach(id => document.getElementById(id));

// ------------------------------------------------------------------ Web API shim
const storage = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: k => { delete storage[k]; },
  clear: () => Object.keys(storage).forEach(k => delete storage[k])
};
let objUrlSeq = 0;
const URL = {
  createObjectURL: () => 'blob:shim/' + (++objUrlSeq),
  revokeObjectURL: () => {}
};
class FakeAudio {
  constructor() {
    this.currentTime = 0; this.duration = 128; this.volume = 1;
    this.playbackRate = 1; this.src = ''; this._ev = {};
  }
  addEventListener(t, fn) { (this._ev[t] || (this._ev[t] = [])).push(fn); }
  play() { this._playing = true; return Promise.resolve(); }
  pause() { this._playing = false; }
}
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(ab => {
      this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' +
        Buffer.from(ab).toString('base64');
      if (this.onload) this.onload();
    }).catch(() => { if (this.onerror) this.onerror(); });
  }
  readAsText(blob) {
    blob.text().then(s => { this.result = s; if (this.onload) this.onload(); });
  }
}

// Android 桥桩：记录分块 base64，最后拼成文件供 WAV 头校验
const bridge = {
  calls: [], chunks: [], name: '', mime: '', ctx: null,
  saveDownloadStart(name, mime) { this.name = name; this.mime = mime; this.chunks = []; this.calls.push('start'); },
  saveDownloadChunk(b64) { this.chunks.push(b64); this.calls.push('chunk'); },
  saveDownloadFinish() { this.calls.push('finish'); },
  // 原生 HTTP 桥桩：模拟在线音源接口与二进制音频下载
  httpRequest(key, url, method, headers, body, timeout, binary) {
    this.calls.push('http');
    this.lastUrl = String(url);
    this.lastMethod = String(method || '').toUpperCase();
    this.lastBody = body == null ? '' : String(body);
    this.lastHeaders = headers;
    const isBin = binary === '1';
    let text;
    if (isBin) {
      text = Buffer.from('ID3 fake-mp3-bytes').toString('base64');
    } else if (/search\.kuwo\.cn/.test(url)) {
      // 酷我搜索：真实字段结构（abslist / SONGNAME / MUSICRID / N_MINFO）
      text = JSON.stringify({ TOTAL: '2', SHOW: '2', abslist: [
        { SONGNAME: '夜测一', ARTIST: '测试歌手', ALBUM: 'QA', DURATION: '100',
          MUSICRID: 'MUSIC_1001', N_MINFO: 'level:p,bitrate:128,format:mp3,size:3Mb' },
        { SONGNAME: '夜测二', ARTIST: '测试歌手&amp;另一个', ALBUM: 'QA', DURATION: '110',
          MUSICRID: 'MUSIC_1002', N_MINFO: 'level:h,bitrate:320,format:mp3,size:9Mb' }
      ] });
    } else if (/songsearch\.kugou\.com/.test(url)) {
      text = JSON.stringify({ status: 1, error_code: 0, data: { total: 1, lists: [
        { Audioid: 2001, OriSongName: '酷狗测试曲', Singers: [{ name: '酷狗歌手' }],
          AlbumName: 'KG', Duration: 120, FileHash: 'HASH128', FileSize: 1,
          HQFileHash: 'HASH320', HQFileSize: 1, SQFileHash: '', SQFileSize: 0,
          ResFileHash: '', ResFileSize: 0 }
      ] } });
    } else if (/rank\/song/.test(url)) {
      text = JSON.stringify({ data: { total: 2, info: [
        { audio_id: 3001, songname: '榜单曲一', authors: [{ author_name: '榜单歌手' }],
          album_name: 'Rank', duration: 130, hash: 'RH1', filesize: 1 },
        { audio_id: 3002, songname: '榜单曲二', authors: [{ author_name: '榜单歌手' }],
          album_name: 'Rank', duration: 140, hash: 'RH2', filesize: 1 }
      ] } });
    } else if (/interface\.music\.163\.com\/eapi\/batch/.test(url)) {
      // 网易 eapi 搜索：resources[].baseInfo.simpleSongData
      text = JSON.stringify({ code: 200, message: '', data: { totalCount: 3, resources: [
        { baseInfo: { simpleSongData: {
          id: 9001, name: '网易测试曲', dt: 213000,
          ar: [{ name: '网易歌手' }, { name: '合唱者' }],
          al: { id: 77, name: '网易专辑', picUrl: 'https://p1.example.com/a.jpg' },
          l: 3400000, h: 9000000, sq: 26000000, hr: 60000000,
          privilege: { maxbr: 999000 } } } },
        { baseInfo: { simpleSongData: {
          id: 9002, name: '网易无损曲', dt: 180000,
          ar: [{ name: '网易歌手' }],
          al: { id: 78, name: '网易专辑二', picUrl: '' },
          l: 3000000, h: 8000000, sq: 24000000,
          jm: 90000000, privilege: { maxbr: 1999000 } } } }
      ] } });
    } else if (/u\.y\.qq\.com\/cgi-bin\/musics\.fcg/.test(url)) {
      // QQ musics.fcg：music.search.SearchCgiService.data.body.song.list
      text = JSON.stringify({ code: 0, ts: 1, 'music.search.SearchCgiService': {
        code: 0, data: { body: { song: { list: [
          { mid: 'TXMID001', id: 7001, title: 'QQ测试曲', name: 'QQ测试曲',
            singer: [{ name: 'QQ歌手' }], album: { mid: 'ALB01', name: 'QQ专辑' },
            interval: 245, file: { media_mid: 'MEDIA01', size_128mp3: 3900000,
              size_320mp3: 9800000, size_flac: 31000000, size_master: 88000000 } },
          { mid: 'TXMID002', id: 7002, title: 'QQ高品质曲', name: 'QQ高品质曲',
            singer: [{ name: 'QQ歌手' }], album: { mid: 'ALB02', name: 'QQ专辑二' },
            interval: 200, file: { media_mid: 'MEDIA02', size_128mp3: 3200000,
              size_320mp3: 8100000 } }
        ] } } }
      } });
    } else if (/musicapp\.migu\.cn/.test(url)) {
      text = JSON.stringify({ code: '000000', songResultData: { totalCount: '1', result: [[
        { songId: '4001', name: '咪咕测试曲', singers: [{ name: '咪咕歌手' }],
          album: 'MG', duration: 150, copyrightId: 'C1', audioFormats: [{ formatType: 'PQ' }] }
      ]] } });
    } else if (String(url).indexOf('source.js') >= 0 && this.ctx && this.ctx.LXSources) {
      text = this.ctx.LXSources.builtinScript();
    } else {
      text = JSON.stringify({ list: [{ songmid: 'net-1', name: '网络曲目', singer: '在线歌手', ext: 'mp3' }],
        url: 'http://x/a.mp3' });
    }
    setTimeout(() => {
      if (this.ctx && this.ctx.LXHttp)
        this.ctx.LXHttp.onResponse(key, null, 200, 'OK', '{"content-type":"application/json"}', text, isBin ? 1 : 0);
    }, 0);
  },
  cancelRequest() {},
  // 原生流式下载桩（v3.4.0）
  dlCalls: [], dlUrl: '', dlName: '', dlCancels: [], dlKey: '', dlHeaders: '', dlDir: '',
  downloadStart(key, url, headers, name, mime, dir) {
    this.dlCalls.push('start'); this.dlKey = key; this.dlUrl = url;
    this.dlName = name; this.dlHeaders = headers; this.dlDir = dir == null ? '' : dir;
  },
  downloadCancel(key) { this.dlCancels.push(key); },
  // 本地已下载文件回放（v3.13.0）
  localPaths: [],
  localMediaUrl(p) {
    this.localPaths.push(p);
    return 'https://app.echo.local/__local?p=' + encodeURIComponent(String(p));
  },
  downloadClear() {},
  downloadPartialSize() { return 0; },
  // 原生音源脚本选择桥（v3.1.1）：记录调用，回传由测试显式模拟
  pickScriptCalls: 0, pickAcks: 0, pickPulls: 0,
  pickScript() { this.pickScriptCalls++; },
  pickScriptAck() { this.pickAcks++; },
  pickScriptPull() { this.pickPulls++; }
};

const btoaShim = s => Buffer.from(String(s), 'binary').toString('base64');
const atobShim = s => Buffer.from(String(s), 'base64').toString('binary');
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Math, JSON, Date, RegExp, Error, Object, Array, String, Number, Boolean,
  ArrayBuffer, DataView, Float32Array, Int16Array, Uint8Array, Uint16Array, Uint32Array,
  Buffer, Blob, URL, localStorage, document,
  btoa: btoaShim, atob: atobShim,
  TextEncoder, TextDecoder, escape: global.escape, unescape: global.unescape,
  Audio: FakeAudio, FileReader: FakeFileReader,
  EchoBridge: bridge,
  indexedDB: undefined, AudioContext: undefined, webkitAudioContext: undefined,
  navigator: { userAgent: 'smoke-test' },
  location: { host: 'app.echo.local', href: 'https://app.echo.local/index.html' }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
bridge.ctx = sandbox;
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(APP, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}
function fire(type, act, id, extra) {
  const node = Object.assign({ dataset: {}, value: '', checked: false, files: null }, extra || {});
  node.dataset.act = act;
  if (id !== undefined) node.dataset.id = id;
  // change 事件会把节点本身当作 target 再交给 onClick，节点也需要 closest
  node.closest = () => node;
  const ev = {
    target: { closest: () => node, value: node.value, checked: node.checked, files: node.files },
    clientX: 10, clientY: 10
  };
  (docEvents[type] || []).forEach(fn => fn(ev));
  return node;
}
const html = id => document.getElementById(id).innerHTML;
const waitFor = (fn, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve(true);
    if (Date.now() - t0 > (ms || 8000)) return reject(new Error('waitFor timeout'));
    setTimeout(poll, 10);
  })();
});

// ------------------------------------------------------------------ 开始测试
(async function run() {
  group('1. 冷启动（八脚本按序加载 + DOMContentLoaded）');
  let coldErr = null;
  try {
    SCRIPTS.forEach(load);
    check('十三个脚本加载无语法/运行时异常', true);
    check('DOMContentLoaded 之前不自动渲染（避免白屏）', html('navMenus') === '');
    (docEvents.DOMContentLoaded || []).forEach(fn => fn());
  } catch (e) { coldErr = e; }
  check('冷启动无异常', !coldErr, coldErr && coldErr.stack);
  const W = sandbox;
  check('window.LXI18N 已挂载', !!W.LXI18N);
  check('window.LXTheme 已挂载', !!W.LXTheme);
  check('window.LXData 已挂载', !!W.LXData);
  check('window.LXEngine 已挂载', !!W.LXEngine);
  check('window.LXDownload 已挂载', !!W.LXDownload);
  check('window.LXSourceAPI（lx 兼容层）已挂载', !!W.LXSourceAPI);
  check('window.LXSources（音源管理）已挂载', !!W.LXSources);
  check('window.LXPlatform（平台适配器）已挂载', !!W.LXPlatform);
  check('window.LXHttp（原生 HTTP 桥）已挂载', !!W.LXHttp);
  check('window.LXApp 已挂载（早于首次 render）', !!W.LXApp);
  check('window.LXRenderDownloads 已挂载', typeof W.LXRenderDownloads === 'function');
  check('首屏已渲染（抽屉导航非空）', html('navMenus').length > 0);

  group('2. 原版界面证据：文案 / 主题 / 图标 / 数据口径');
  const i18n = W.LXI18N || {};
  check('zh-cn 文案 520 条', Object.keys(i18n).length === 520, String(Object.keys(i18n).length));
  check('nav_search = 搜索', i18n.nav_search === '搜索', i18n.nav_search);
  check('nav_love = 我的列表', i18n.nav_love === '我的列表', i18n.nav_love);
  check('search__welcome 原版文案', i18n.search__welcome === '搜我所想~~😉', i18n.search__welcome);
  check('search_history_search = 历史搜索', i18n.search_history_search === '历史搜索');
  check('16 套主题', W.LXTheme.list.length === 16, String(W.LXTheme.list.length));
  check('默认主题 green / 绿意盎然', W.LXTheme.list[0].id === 'green' && W.LXTheme.list[0].name === '绿意盎然');
  check('默认 primary rgb(77, 175, 124)', W.LXTheme.list[0].primary === 'rgb(77, 175, 124)');
  const built = W.LXTheme.build(W.LXTheme.list[0]);
  check('派生颜色变量 >= 232', Object.keys(built).length >= 232, String(Object.keys(built).length));
  check('c-font 别名已映射', !!built['c-font']);
  check('c-content-background 别名已映射', !!built['c-content-background']);
  const iconsCss = fs.readFileSync(path.join(APP, 'icons.css'), 'utf8');
  const iconRules = (iconsCss.match(/\.lx-[\w-]+:before\s*\{/g) || []).length;
  check('52 个 icomoon 图标类', iconRules === 52, String(iconRules));
  check('图标字体文件存在', fs.existsSync(path.join(APP, 'fonts', 'icomoon.ttf')));
  check('图标码点 download-2 存在', /\.lx-download-2:before/.test(iconsCss));
  check('24 个榜单', W.LXData.BOARDS.length === 24, String(W.LXData.BOARDS.length));
  check('内置演示曲库已清空', W.LXData.tracks.length === 0, String(W.LXData.tracks.length));
  check('演示歌单 / 热门词 / 歌词 / 评论已清空',
    W.LXData.SONGLISTS.length === 0 && W.LXData.HOT_WORDS.length === 0 &&
    W.LXData.LYRICS.length === 0 && W.LXData.COMMENTS.length === 0);
  check('5 个默认列表（含 download）', W.LXData.LIST_IDS.DOWNLOAD === 'download');
  check('green 主题 CSS 变量已写入 documentElement', cssVars['--c-primary'] === 'rgb(77, 175, 124)', cssVars['--c-primary']);
  check('data-theme 属性 = green', document.documentElement.getAttribute('data-theme') === 'green');

  group('3. 界面骨架：抽屉 / Header / 视图 / PlayerBar');
  const navHtml = html('navMenus');
  check('抽屉 6 项导航', (navHtml.match(/class="nav-item/g) || []).length === 6,
    String((navHtml.match(/class="nav-item/g) || []).length));
  ['搜索', '歌单', '排行榜', '我的列表', '下载', '设置'].forEach(label => {
    check('导航含「' + label + '」', navHtml.indexOf('>' + label + '<') >= 0);
  });
  check('导航图标沿用原版 icon 名', /lx-search-2/.test(navHtml) && /lx-download-2/.test(navHtml) && /lx-leaderboard/.test(navHtml));
  check('Header 首屏标题 = 搜索', document.getElementById('headerTitle').textContent === '搜索');
  check('PlayerBar 初始标题 = LX Music', document.getElementById('pbTitle').textContent === 'LX Music');
  const styleCss = fs.readFileSync(path.join(APP, 'styles.css'), 'utf8');
  check('Header 高度 42px（对齐原版）', /\.header\s*\{[^}]*height:\s*42px/.test(styleCss));
  check('抽屉宽 70% / 最大 300px', /\.drawer\s*\{[^}]*width:\s*70%/.test(styleCss) && /max-width:\s*300px/.test(styleCss));
  check('歌曲行高 54px', /\.m-row\s*\{[^}]*height:\s*54px/.test(styleCss));
  check('PlayerBar 按钮 46×46 / 图标 24px', /\.pb-btn\s*\{[^}]*width:\s*46px/.test(styleCss) && /font-size:\s*(?:calc\(\s*)?24px/.test(styleCss));
  // v3.13.5：搜索页右上角「歌曲 / 歌单」两个标签是死控件（只切自身高亮，doSearch 从不读 type），已删除
  check('搜索页 header 不再有「歌曲/歌单」死标签',
    document.getElementById('headerExtra').innerHTML.indexOf('search-type') < 0 &&
    document.getElementById('headerExtra').innerHTML.indexOf('type-tabs') < 0,
    document.getElementById('headerExtra').innerHTML.slice(0, 60));
  check('搜索页右上角为空', document.getElementById('headerExtra').innerHTML.trim() === '');
  check('styles.css 已移除 .type-tabs 规则', styleCss.indexOf('.type-tabs') < 0);
  check('页面标题为 LX Music', /<title>LX Music<\/title>/.test(fs.readFileSync(path.join(APP, 'index.html'), 'utf8')));

  group('4. 六个视图切换与渲染');
  const viewCases = [
    ['nav_search', '搜索', 'searchbar'],
    ['nav_songlist', '歌单', 'pl-refresh'],
    ['nav_top', '排行榜', 'board'],
    ['nav_love', '我的列表', ''],
    ['nav_download', '下载', 'dl-stats'],
    ['nav_setting', '设置', 'theme-grid']
  ];
  for (const [id, title, marker] of viewCases) {
    fire('click', 'nav', id);
    const h = html('view');
    check('视图 ' + id + ' 渲染非空', h.length > 50, String(h.length));
    check('视图 ' + id + ' 标题 = ' + title, document.getElementById('headerTitle').textContent === title,
      document.getElementById('headerTitle').textContent);
    if (marker) check('视图 ' + id + ' 含 ' + marker, h.indexOf(marker) >= 0);
    check('视图 ' + id + ' 无 [object Object]/undefined', !/\[object Object\]|>undefined</.test(h));
  }

  group('5. 平台搜索 / 播放 / 队列 / 全屏页');
  fire('click', 'nav', 'nav_search');
  const S = W.LXApp.state;
  check('搜索页显示「搜我所想~~😉」欢迎语', html('view').indexOf('搜我所想') >= 0);
  check('搜索页显示「历史搜索」区块', html('view').indexOf('历史搜索') >= 0);
  check('搜索页有平台选择条', html('view').indexOf('pf-bar') >= 0);
  check('平台 chip = 5 个', (html('view').match(/class="pf-chip/g) || []).length === 5);
  check('默认平台 = 酷我', S.platform === 'kw', S.platform);
  check('未导入音源时说明不能播放',
    (html('view').indexOf('还没有导入音源') >= 0), html('view').slice(-200));

  // 搜路由平台内置接口完成（不需要音源）
  document.getElementById('searchInput').value = '夜';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results, 10000);
  check('酷我内置接口返回结果', S.search.results.length === 2, String(S.search.results.length));
  check('曲目带平台标记且无 apiId',
    S.search.results.every(x => x.platform === 'kw' && !x.apiId));
  check('来源说明含平台名', (S.search.apiNote || '').indexOf('酷我') >= 0, S.search.apiNote);
  check('搜索历史写入「夜」', S.history[0] === '夜');

  // 未绑定音源（账号）时，播放必须被拦下并给出原因
  const firstId = S.search.results[0].id;
  fire('click', 'play-row', firstId);
  await new Promise(r => setTimeout(r, 150));
  check('未绑定音源时播放被拦截', S.playing === false && S.queue.length === 0);

  // 导入并绑定测试音源到酷我，之后才能播放/下载
  const imp = W.LXSources.importScript(TEST_SCRIPT, 'smoke');
  check('导入测试音源成功', imp.ok, imp.message);
  check('音源按 sources 声明自动匹配酷我', W.LXSources.forPlatform('kw') === imp.api.id,
    W.LXSources.forPlatform('kw'));
  check('平台验证通过', W.LXSources.verifyPlatform('kw').ok);
  check('未声明的平台不会误匹配', !W.LXSources.forPlatform('wy'), W.LXSources.forPlatform('wy'));
  fire('click', 'nav', 'nav_search');
  fire('click', 'play-row', firstId);
  await waitFor(() => W.LXApp.engine.mode === 'stream', 10000);
  check('绑定后平台曲目走在线收听', W.LXApp.engine.mode === 'stream');
  check('平台曲目播放队列已建立', S.queue.length > 0);
  check('结果页显示条数', html('view').indexOf('首</span>') >= 0);
  fire('click', 'multi-toggle');
  check('多选栏出现', html('view').indexOf('multi-bar') >= 0);
  fire('click', 'select-all');
  check('全选生效', S.selected.length === S.search.results.length);
  fire('click', 'multi-exit');
  check('退出多选清空选择', S.selected.length === 0 && S.multi === false);
  fire('click', 'play-row', firstId);
  await waitFor(() => W.LXApp.state.playing === true, 5000);
  check('点曲目行开始播放', S.playing === true);
  check('播放队列已建立', S.queue.length > 0);
  check('PlayerBar 显示当前曲目名', document.getElementById('pbTitle').textContent.length > 0);
  check('PlayerBar 显示暂停图标', html('pbToggle').indexOf('lx-pause') >= 0, html('pbToggle'));
  fire('click', 'toggle');
  check('点暂停后 PlayerBar 恢复播放图标', html('pbToggle').indexOf('lx-play') >= 0);
  fire('click', 'toggle');
  check('再次点按恢复播放', S.playing === true);
  fire('click', 'next');
  check('下一首切换队列索引', S.index >= 0 && S.queue.length > 1);
  fire('click', 'mode');
  check('播放模式循环', ['listLoop', 'random', 'list', 'singleLoop'].indexOf(S.mode) >= 0);
  fire('click', 'rate');
  check('播放速率切换', S.rate !== 1 && W.LXApp.engine.playbackRate === S.rate, String(S.rate));
  fire('click', 'open-detail');
  check('播放详情页打开', html('overlay').indexOf('player-ctl') >= 0);
  check('播放详情页含歌词', html('overlay').indexOf('lyricBox') >= 0);
  fire('click', 'close-overlay');
  check('播放详情页关闭', html('overlay') === '');
  fire('click', 'track-menu', firstId);
  check('歌曲长按菜单含「下载」', html('contextMenu').indexOf('menu-download') >= 0);
  fire('click', 'menu-comment', firstId);
  check('评论页打开', html('overlay').indexOf('精彩评论') >= 0);
  fire('click', 'cm-tab', 'new');
  check('评论页切换最新评论', S.commentTab === 'new');
  fire('click', 'cm-like', 'c0');
  check('评论点赞生效', !!S.commentLikes.c0);
  fire('click', 'close-overlay');
  ['backup', 'sync', 'about', 'cache'].forEach(k => {
    fire('click', 'open-panel', k);
    check('全屏页 ' + k + ' 渲染', html('overlay').length > 100);
    fire('click', 'close-overlay');
  });
  fire('click', 'nav', 'nav_setting');
  check('设置页 16 个主题色块', (html('view').match(/class="theme-dot/g) || []).length === 16);
  fire('change', 'set-bool', 'offline', { checked: true, value: '' });
  check('模拟离线开关生效', S.settings.offline === true);
  fire('change', 'set-bool', 'offline', { checked: false, value: '' });
  fire('click', 'set-theme', 'black');
  check('切换黑色主题', S.theme === 'black' && document.documentElement.getAttribute('data-dark') === '1');
  check('黑色主题主背景', cssVars['--c-main-background'] === 'rgba(19, 19, 19, 0.95)', cssVars['--c-main-background']);
  W.LXTheme.list.forEach(th => {
    W.LXTheme.apply(th.id);
  });
  check('16 套主题全部可应用且生成 --c-primary', cssVars['--c-primary'] !== undefined);
  fire('click', 'set-theme', 'green');

  group('6. 歌曲下载：WAV 编码 / 队列状态机 / Android 桥');
  fire('click', 'nav', 'nav_download');
  check('下载页统计区', html('view').indexOf('dl-stats') >= 0);
  check('下载页音质选择', html('view').indexOf('dl-quality') >= 0);
  const DL = W.LXDownload;
  check('3 个音质档位', Object.keys(DL.QUALITIES).length === 3);
  check('音质采样率 6000/8000/11025', DL.QUALITIES.standard.sr === 6000 && DL.QUALITIES.high.sr === 8000 && DL.QUALITIES.lossless.sr === 11025);
  // 无 apiId 的曲目走本地 WAV 合成回退；产品已无内置曲目，这里显式注入测试曲目
  const tr = { id: 'qa_synth_1', name: '本地合成音轨', singer: 'QA', album: 'QA', duration: 30, source: 'local' };
  W.LXData.addExternalTracks([tr]);
  DL.opts.autoDeliver = true;
  bridge.calls.length = 0;
  const added = DL.enqueue([tr], 'high');
  check('入队 1 首', added === 1 && DL.all().length === 1);
  check('重复入队被去重', DL.enqueue([tr], 'high') === 0);
  await waitFor(() => DL.all()[0] && DL.all()[0].state === 'done', 15000);
  const job = DL.all()[0];
  check('任务完成 state=done', job.state === 'done', job.state);
  check('进度 100%', job.progress === 100, String(job.progress));
  check('生成文件大小 = 44 + 8000×时长×2', job.size === 44 + 8000 * 30 * 2, String(job.size));
  check('文件名含中文曲名与歌手', /\.wav$/.test(DL.fileName(job)) && DL.fileName(job).indexOf(tr.name) >= 0);
  check('离线可播放 URL 已生成', !!DL.getPlayableUrl(tr.id));
  check('isDone 标记生效', DL.isDone(tr.id) === true);
  check('stats.done = 1', DL.stats().done === 1);
  check('下载页统计卡片随任务实时刷新（已完成=1）',
    String(document.getElementById('dlStatDone').textContent) === '1',
    String(document.getElementById('dlStatDone').textContent));
  check('下载页「已占用」实时刷新',
    String(document.getElementById('dlStatSize').textContent) !== '—',
    String(document.getElementById('dlStatSize').textContent));
  await waitFor(() => bridge.calls.indexOf('finish') >= 0, 5000);
  check('Android 桥 start/chunk/finish 均被调用',
    bridge.calls[0] === 'start' && bridge.calls.indexOf('chunk') > 0 && bridge.calls[bridge.calls.length - 1] === 'finish');
  check('分块数 > 1（大文件分块传输）', bridge.chunks.length > 1, String(bridge.chunks.length));
  check('桥 MIME = audio/wav', bridge.mime === 'audio/wav', bridge.mime);
  const wavBuf = Buffer.from(bridge.chunks.join(''), 'base64');
  check('WAV 字节数与任务 size 一致', wavBuf.length === job.size, wavBuf.length + '/' + job.size);
  check('RIFF 头', wavBuf.toString('ascii', 0, 4) === 'RIFF');
  check('WAVE 标识', wavBuf.toString('ascii', 8, 12) === 'WAVE');
  check('fmt  子块', wavBuf.toString('ascii', 12, 16) === 'fmt ');
  check('PCM 格式 = 1', wavBuf.readUInt16LE(20) === 1);
  check('单声道 = 1', wavBuf.readUInt16LE(22) === 1);
  check('采样率 = 8000', wavBuf.readUInt32LE(24) === 8000, String(wavBuf.readUInt32LE(24)));
  check('位深 = 16', wavBuf.readUInt16LE(34) === 16);
  check('data 子块', wavBuf.toString('ascii', 36, 40) === 'data');
  check('data 长度 = 总长 - 44', wavBuf.readUInt32LE(40) === wavBuf.length - 44);
  check('RIFF 长度字段正确', wavBuf.readUInt32LE(4) === wavBuf.length - 8);
  // 设备回写回调
  DL.onDeviceSaved(DL.fileName(job), true, '/sdcard/Download/LX Music/' + DL.fileName(job));
  check('onDeviceSaved 记录落盘路径', (DL.all()[0].path || '').indexOf('Download') >= 0, DL.all()[0].path);
  // 「保存到设备」按钮：必须能拿到 Blob（曾因传元数据而失效）
  bridge.calls.length = 0;
  fire('click', 'dl-save', job.id);
  await waitFor(() => bridge.calls.indexOf('finish') >= 0, 5000);
  check('「保存到设备」按钮可重新交付文件', bridge.calls[0] === 'start' && bridge.calls[bridge.calls.length - 1] === 'finish');
  // 离线播放已下载曲目
  S.settings.offline = true;
  fire('click', 'dl-play', job.id);
  await waitFor(() => W.LXApp.engine.mode === 'local', 3000);
  check('离线模式下已下载曲目可播放', W.LXApp.engine.mode === 'local' && S.playing === true);
  W.LXData.addExternalTracks([{ id: 'qa_synth_2', name: '未下载音轨', singer: 'QA', album: 'QA', duration: 8, source: 'local' }]);
  const noLocalId = 'qa_synth_2';
  fire('click', 'play-row', noLocalId);
  check('离线模式拦截未下载曲目', W.LXApp.state.queue.indexOf(noLocalId) < 0 || S.queue[S.index] !== noLocalId);
  S.settings.offline = false;

  group('7. 队列状态机：暂停 / 继续 / 取消 / 重试 / 移除 / 清理');
  W.LXData.addExternalTracks([{ id: 'qa_synth_3', name: '队列音轨', singer: 'QA', album: 'QA', duration: 8, source: 'local' }]);
  const tr2 = W.LXData.byId('qa_synth_3');
  DL.enqueue([tr2], 'standard');
  const j2 = DL.all()[0];
  check('新任务进入 waiting/running', ['waiting', 'running'].indexOf(j2.state) >= 0, j2.state);
  DL.pause(j2.id);
  check('暂停 -> paused', DL.all().filter(x => x.id === j2.id)[0].state === 'paused');
  DL.resume(j2.id);
  check('继续 -> waiting/running', ['waiting', 'running'].indexOf(DL.all().filter(x => x.id === j2.id)[0].state) >= 0);
  DL.cancel(j2.id);
  check('取消 -> cancelled', DL.all().filter(x => x.id === j2.id)[0].state === 'cancelled');
  DL.retry(j2.id);
  check('重试 -> waiting/running', ['waiting', 'running'].indexOf(DL.all().filter(x => x.id === j2.id)[0].state) >= 0);
  DL.cancel(j2.id);
  DL.remove(j2.id);
  check('移除后任务消失', !DL.all().some(x => x.id === j2.id));
  DL.clearFinished();
  check('清理已完成后队列为空', DL.all().length === 0, String(DL.all().length));
  check('清空后 stats.done = 0', DL.stats().done === 0);

  group('8. 持久化 / 单文件版 / 无网络请求');
  check('状态写入 localStorage', Object.keys(storage).some(k => k.indexOf('lx_state') >= 0));
  check('下载索引写入 localStorage', Object.keys(storage).some(k => k.indexOf('lx_downloads_index') >= 0));
  const runtimeJs = ['i18n.js', 'themes.js', 'data.js', 'engine.js', 'download.js', 'app.js']
    .map(f => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');
  check('非音源模块无网络 API（fetch/XHR/WebSocket/EventSource）',
    !/\bfetch\s*\(|XMLHttpRequest|new WebSocket|new EventSource|sendBeacon/.test(runtimeJs));
  check('运行时脚本不引用外部资源 URL', !/(?:src|href)\s*=\s*["']https?:\/\//.test(runtimeJs));
  const sourceJs = ['source-api.js', 'sources.js']
    .map(f => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');
  check('网络能力只集中在音源运行时（lx.request 兼容层）',
    /httpRequest/.test(sourceJs) && /LXHttp\.active/.test(sourceJs));
  check('音源脚本受限作用域屏蔽 window/document/localStorage/fetch',
    /'document', 'localStorage'/.test(sourceJs) && /LXApp', 'LXData'/.test(sourceJs));
  const standalone = path.join(APP, 'standalone.html');
  if (fs.existsSync(standalone)) {
    const sf = fs.readFileSync(standalone, 'utf8');
    check('单文件版存在且 > 100 KB', sf.length > 100000, String(sf.length));
    check('单文件版无外部 script/link 引用', !/<script src=|<link rel="stylesheet"/.test(sf));
    check('单文件版内联 13 段脚本', (sf.match(/<script>/g) || []).length === 13);
    check('单文件版内联字体 base64', sf.indexOf('data:font/ttf;base64,') >= 0);
    check('单文件版含 3 段 CSS 注释', (sf.match(/\/\* ===== .*\.css ===== \*\//g) || []).length === 3);
  } else {
    check('单文件版已生成', false, '请先运行 node evidence/build-standalone.js');
  }

  group('9. 自定义 JS 音源：协议 / 导入 / 搜索 / 在线收听 / 按格式下载');
  const APIX = W.LXSourceAPI, SR = W.LXSources;
  check('lx 兼容层 EVENT_NAMES 对齐原版 v2.0.0',
    JSON.stringify(APIX.EVENT_NAMES) === JSON.stringify({ request: 'request', inited: 'inited', updateAlert: 'updateAlert' }));
  check('lx 支持原版音质档位', JSON.stringify(APIX.SUPPORT_QUALITYS) === JSON.stringify(['128k', '320k', 'flac', 'flac24bit']));
  check('utils.buffer base64/hex/utf8 往返',
    APIX.utils.buffer.bufToString(APIX.utils.buffer.from('4c58', 'hex'), 'utf8') === 'LX' &&
    APIX.utils.buffer.bufToString(APIX.utils.buffer.from('LX', 'utf8'), 'base64') === 'TFg=');
  check('utils.crypto.md5 结果正确', APIX.utils.crypto.md5('abc') === '900150983cd24fb0d6963f7d28e17f72',
    APIX.utils.crypto.md5('abc'));
  const builtin = SR.list().filter(a => a.name === '测试源')[0] || SR.list()[0];
  check('测试音源初始化成功', !!builtin && builtin.status === 'success', builtin && builtin.message);
  check('示例音源声明 search / downloadUrl / musicUrl',
    SR.supports(builtin, 'search') && SR.supports(builtin, 'downloadUrl') && SR.supports(builtin, 'musicUrl'));
  check('脚本头解析 @name / @version / @author',
    SR.parseHeader(SR.builtinScript()).name === '示例音源 · 本地曲库' &&
    SR.parseHeader(SR.builtinScript()).version === '1.0.0');
  check('无效脚本被拒绝', SR.parseHeader('console.log(1)') === null);
  const legacyScript = [
    '/**', ' * @name 原版兼容测试源', ' * @version 1.2.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, ({ action }) => {',
    '  if (action === "musicUrl") return Promise.resolve("https://example.com/a.mp3")',
    '  if (action === "lyric") return Promise.resolve({ lyric: "[00:00]hi" })',
    '  return Promise.reject(new Error("unsupported"))',
    '})',
    'send(EVENT_NAMES.inited, { sources: { kw: { type: "music", actions: ["musicUrl"],',
    '  qualitys: ["128k", "320k"] }, local: { type: "music", actions: ["musicUrl", "lyric", "pic"], qualitys: [] } } })'
  ].join('\n');
  const legacyRes = SR.importScript(legacyScript, 'test');
  check('原版 user-api v2.0.0 脚本可直接导入', legacyRes.ok && legacyRes.api.status === 'success',
    legacyRes.message);
  check('原版脚本只声明 musicUrl/lyric/pic 仍可用', SR.supports(legacyRes.api, 'musicUrl') && !SR.supports(legacyRes.api, 'search'));
  const probe = APIX.compile([
    '/**', ' * @name probe', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, () => Promise.resolve(typeof window + ":" + typeof document + ":" + typeof localStorage))',
    'send(EVENT_NAMES.inited, { sources: {} })'
  ].join('\n'), { name: 'probe', rawScript: '' });
  const scope = await APIX.invoke(probe, 'kw', 'musicUrl', {});
  check('脚本作用域屏蔽 window/document/localStorage', scope === 'undefined:undefined:undefined', scope);
  check('lx 版本 2.0.0 / env mobile', probe.api.version === '2.0.0' && probe.api.env === 'mobile');

  const sr = await SR.search('夜');
  const extTrack = sr.tracks.filter(x => x.apiId === builtin.id)[0];
  check('JS 音源搜索返回曲目', sr.called >= 1 && sr.tracks.length >= 1, String(sr.tracks.length));
  check('搜索结果注入 LXData 曲目池', !!extTrack && !!W.LXData.byId(extTrack.id));
  check('曲目带自定义来源 / 音质 / 格式',
    !!extTrack && extTrack.source === 'api:' + builtin.id && extTrack.qualitys.length >= 1 && extTrack.ext === 'wav');
  const pm = await SR.playableUrl(extTrack, '128k');
  check('musicUrl 返回可在线播放的 URL', !!pm && /^data:audio\/wav;base64,/.test(pm.url));
  const fd = await SR.fetchDownload(extTrack, '128k');
  check('downloadUrl 按来源格式返回 Blob',
    !!fd && !!fd.blob && fd.blob.size > 1000 && fd.mime === 'audio/wav' && fd.ext === 'wav',
    fd && fd.mime + '/' + fd.ext);
  const dlHead = Buffer.from(await fd.blob.arrayBuffer()).slice(0, 4).toString('ascii');
  check('下载字节是真实 RIFF/WAVE 音频', dlHead === 'RIFF', dlHead);

  S.nav = 'nav_search'; S.search.text = '夜';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results && S.search.results.length > 0, 10000);
  check('搜索页按平台结果渲染',
    S.search.results.length > 0 && S.search.results.every(x => !!x.platform), String(S.search.results.length));
  check('搜索结果显示平台来源说明', (S.search.apiNote || '').indexOf('酷我') >= 0, S.search.apiNote);
  fire('click', 'play-row', extTrack.id);
  await waitFor(() => W.LXApp.engine.mode === 'stream', 8000);
  check('自定义音源曲目走在线收听（engine.mode=stream）', W.LXApp.engine.mode === 'stream');
  check('在线音频元素已设置播放地址', !!W.LXApp.engine.el && W.LXApp.engine.el.src.indexOf('data:audio/wav') === 0);

  bridge.calls.length = 0;
  DL.enqueue([extTrack], '128k');
  await waitFor(() => DL.all().some(j => j.trackId === extTrack.id && j.state === 'done'), 10000);
  const dj = DL.all().filter(j => j.trackId === extTrack.id)[0];
  check('下载任务按音源格式完成', !!dj && dj.state === 'done' && dj.format === 'WAV' && dj.mime === 'audio/wav',
    dj && dj.format + '/' + dj.mime);
  check('文件名后缀按来源格式生成', !!dj && /\.wav$/.test(DL.fileName(dj)));
  check('Android 保存桥使用音源 MIME', bridge.mime === 'audio/wav', bridge.mime);
  check('音源曲目已下载标记', DL.isDone(extTrack.id));
  check('按音源格式下载仍可离线播放（local）', !!DL.getPlayableUrl(extTrack.id));

  fire('click', 'open-panel', 'userapi');
  const uaHtml = html('overlay');
  check('自定义源管理页标题用原版文案', uaHtml.indexOf('自定义源管理（实验性）') >= 0);
  check('含本地/在线导入与粘贴脚本', uaHtml.indexOf('本地导入') >= 0 && uaHtml.indexOf('在线导入') >= 0 && uaHtml.indexOf('粘贴脚本') >= 0);
  check('含原版安全提示', uaHtml.indexOf('请谨慎导入') >= 0);
  check('列表显示音源状态与动作', uaHtml.indexOf('初始化成功') >= 0 && uaHtml.indexOf('downloadUrl') >= 0);
  check('含源编写说明与 FAQ 入口', uaHtml.indexOf('源编写说明') >= 0 && uaHtml.indexOf('api-faq') >= 0);
  fire('click', 'close-overlay');
  fire('click', 'nav', 'nav_setting');
  check('设置页含自定义源管理', html('view').indexOf('自定义源管理') >= 0);
  check('已去掉平台单独绑定入口',
    html('view').indexOf('data-act="bind-platform"') < 0 && html('view').indexOf('平台账号（音源验证）') < 0);
  check('设置页可切换音源音质', html('view').indexOf('set-audio-quality') >= 0);
  fire('change', 'set-audio-quality', undefined, { value: '320k' });
  check('音质切换写入设置', S.settings.audioQuality === '320k', S.settings.audioQuality);

  SR.setEnabled(builtin.id, false);
  check('停用音源后不参与搜索', !SR.active().some(a => a.id === builtin.id));
  SR.setEnabled(builtin.id, true);
  check('重新启用音源后自动重新初始化', SR.active().some(a => a.id === builtin.id) && SR.byId(builtin.id).status === 'success');
  const onlineRes = await new Promise(res => SR.importOnline('https://example.com/source.js', res));
  check('在线导入经原生 HTTP 桥成功', onlineRes.ok, onlineRes.message);
  check('在线导入脚本同样可搜索', SR.supports(onlineRes.api, 'search'));
  const badOnline = await new Promise(res => SR.importOnline('ftp://bad', res));
  check('非 HTTP 在线导入被拒绝', !badOnline.ok);
  check('音源日志已记录', SR.logs().length >= 3, String(SR.logs().length));
  // 同名音源现在会被视为「更新」，容量测试必须用不同名字
  let capOk = true, cap = 0;
  while (SR.list().length < SR.MAX && cap < 40) {
    const script = SR.httpTemplate().replace('@name 我的在线音源', '@name 容量测试源' + cap);
    const rr = SR.importScript(script, 'cap');
    if (!rr.ok) { capOk = false; break; }
    cap++;
  }
  const over = SR.importScript(
    SR.builtinScript().replace('@name 示例音源 · 本地曲库', '@name 超限测试源'), 'cap');
  check('最多 20 个音源限制生效', capOk && SR.list().length === SR.MAX && !over.ok && over.message.indexOf('20') >= 0,
    String(SR.list().length));
  check('移除音源可用', (function () {
    const n = SR.list().length, id = SR.list()[n - 1].id;
    SR.remove(id);
    return SR.list().length === n - 1;
  })());

  group('10. 平台切换 / 排行榜 / 数据迁移');
  // 切到酷狗：搜索走酷狗内置接口
  fire('click', 'set-platform', 'kg');
  check('切换到酷狗平台', S.platform === 'kg', S.platform);
  check('切平台清空上一次结果', S.search.results === null);
  document.getElementById('searchInput').value = '测试';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results, 10000);
  check('酷狗接口返回结果', S.search.results.length === 1, String(S.search.results.length));
  check('结果带酷狗平台标记', S.search.results.every(x => x.platform === 'kg'));
  check('酷狗曲目带 hash（供音源解析）',
    !!S.search.results[0]._raw.hashes['128k'], JSON.stringify(S.search.results[0]._raw.hashes || {}));

  // 酷狗内置榜单
  S.boardTracks = null; S.boardId = '';
  fire('click', 'nav', 'nav_top');
  await waitFor(() => !S.boardLoading && S.boardTracks && S.boardTracks.length > 0, 15000);
  check('酷狗内置 24 个榜单', W.LXPlatform.boards('kg').length === 24, String(W.LXPlatform.boards('kg').length));
  check('榜单曲目来自酷狗接口', S.boardTracks.length === 2, String(S.boardTracks.length));
  // v3.13.4：排行榜页只放卡片入口，曲目在点开的目录浮层里
  check('排行榜页渲染榜单卡片入口', html('view').indexOf('open-board') >= 0);
  check('榜单来源说明含平台名', (S.boardNote || '').indexOf('酷狗') >= 0, S.boardNote);

  // 点榜单卡片 → 进入目录浮层，曲目在目录里
  fire('click', 'open-board', S.boardId);
  await waitFor(() => S.overlay === 'boardlist' && !S.boardLoading, 15000);
  check('点榜单卡片进入目录浮层', S.overlay === 'boardlist');
  check('榜单目录渲染曲目', html('overlay').indexOf('榜单曲一') >= 0);
  check('目录浮层给底部播放条让位',
    document.getElementById('overlay').classList.contains('ov-with-bar'));
  check('排行榜主页不再把曲目铺在下面', html('view').indexOf('榜单曲一') < 0);

  // 绑定音源后榜单可直接播放
  check('同一音源也自动服务酷狗', W.LXSources.forPlatform('kg') === imp.api.id);
  fire('click', 'play-board');
  await waitFor(() => S.playing === true, 8000);
  check('有音源提供地址时榜单可播放', S.playing === true);

  // v3.9.0：五个平台都接入了内置榜单目录，切换平台后仍要渲染出榜单卡片
  const boardCounts = ['kw', 'kg', 'mg', 'wy', 'tx'].map(id => W.LXPlatform.boards(id).length);
  check('五个平台都有榜单目录', boardCounts.every(n => n > 0), boardCounts.join('/'));
  fire('click', 'set-board-platform', 'kw');
  await new Promise(r => setTimeout(r, 400));
  check('切到酷我后仍渲染榜单卡片', html('view').indexOf('open-board') >= 0);

  // 咪咕：内置接口可用
  fire('click', 'set-platform', 'mg');
  document.getElementById('searchInput').value = '测试';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results, 10000);
  check('咪咕接口返回结果', S.search.results.length === 1, String(S.search.results.length));
  check('咪咕结果带平台标记', S.search.results[0].platform === 'mg');

  // ---- 网易：eapi 加密搜索（v3.6.0）----
  check('网易已内置搜索', W.LXPlatform.hasBuiltinSearch('wy'));
  check('QQ 已内置搜索', W.LXPlatform.hasBuiltinSearch('tx'));
  fire('click', 'set-platform', 'wy');
  document.getElementById('searchInput').value = '网易';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results, 10000);
  check('网易接口返回结果', S.search.results.length === 2, String(S.search.results.length));
  check('网易结果带平台标记', S.search.results.every(x => x.platform === 'wy'));
  check('网易来源说明含平台名', (S.search.apiNote || '').indexOf('网易') >= 0, S.search.apiNote);
  check('网易请求为 POST form', bridge.lastMethod === 'POST' &&
    /params=/.test(bridge.lastBody), bridge.lastMethod + ' ' + bridge.lastBody.slice(0, 40));
  check('网易 params 是大写 hex（AES 输出）',
    /^params=[0-9A-F]+$/.test(bridge.lastBody), bridge.lastBody.slice(0, 60));
  const wyTrack0 = S.search.results[0];
  check('网易曲目带 songmid / interval（供音源取链）',
    !!wyTrack0.songmid && /^\d{2}:\d{2}$/.test(wyTrack0.interval),
    wyTrack0.songmid + ' / ' + wyTrack0.interval);
  check('网易曲目合并多歌手', wyTrack0.singer === '网易歌手、合唱者', wyTrack0.singer);
  check('网易曲目音质含无损', wyTrack0.qualitys.indexOf('flac') >= 0, wyTrack0.qualitys.join(','));
  check('网易曲目音质含母带（jm 存在）',
    S.search.results[1].qualitys.indexOf('master') >= 0, S.search.results[1].qualitys.join(','));
  check('网易曲目时长按 dt/1000 换算', wyTrack0.duration === 213, String(wyTrack0.duration));

  // ---- QQ：musics.fcg + zzcSign（v3.6.0）----
  fire('click', 'set-platform', 'tx');
  document.getElementById('searchInput').value = 'QQ';
  fire('click', 'do-search');
  await waitFor(() => !S.search.searching && S.search.results, 10000);
  check('QQ 接口返回结果', S.search.results.length === 2, String(S.search.results.length));
  check('QQ 结果带平台标记', S.search.results.every(x => x.platform === 'tx'));
  check('QQ 来源说明含平台名', (S.search.apiNote || '').indexOf('QQ') >= 0, S.search.apiNote);
  check('QQ 请求带 sign 且为 POST JSON', bridge.lastMethod === 'POST' &&
    /sign=zzc[a-z0-9]+/.test(bridge.lastUrl) &&
    /"music\.search\.SearchCgiService"/.test(bridge.lastBody),
    bridge.lastUrl.slice(-40));
  const txTrack0 = S.search.results[0];
  check('QQ 曲目 songmid = mid', txTrack0.songmid === 'TXMID001', txTrack0.songmid);
  check('QQ 曲目带 media_mid（供音源取链）',
    txTrack0._raw.media_mid === 'MEDIA01', txTrack0._raw.media_mid);
  check('QQ 曲目音质含母带', txTrack0.qualitys.indexOf('master') >= 0, txTrack0.qualitys.join(','));
  check('QQ 曲目音质不含未声明档', txTrack0.qualitys.indexOf('hires') < 0, txTrack0.qualitys.join(','));
  check('QQ 曲目时长来自 interval 秒', txTrack0.duration === 245, String(txTrack0.duration));

  // ---- 加密实现固定向量（改坏会立刻暴露）----
  const NC = W.LXNetCrypto;
  check('加密模块已挂载', !!NC);
  check('SHA1 与标准一致', NC.sha1('abc') === 'a9993e364706816aba3e25717850c26c9cd0d89d', NC.sha1('abc'));
  check('MD5 与标准一致', NC.md5('abc') === '900150983cd24fb0d6963f7d28e17f72', NC.md5('abc'));
  check('AES-128-ECB 与标准一致',
    NC.aesEcbHex('hello', 'e82ckenh8dichen8') === '3329CABA8FB561FF0086A5823D14F529',
    NC.aesEcbHex('hello', 'e82ckenh8dichen8'));
  check('zzcSign 与 lxserver 一致',
    NC.zzcSign('{"a":1}') === 'zzc7746109xq501htmv4ipz7c8owlxfpihjm1fd695c7', NC.zzcSign('{"a":1}'));

  // ---- 音源声明母带 → 品质菜单标为「可用」----
  const wyMasterScript = [
    '/**', ' * @name 网易QQ母带源', ' * @version 1.0.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, ({ action }) => Promise.reject(new Error("unsupported: " + action)))',
    'send(EVENT_NAMES.inited, { sources: {',
    '  wy: { name: "网易QQ母带源", type: "music", actions: ["musicUrl","downloadUrl"], qualitys: ["128k","320k","flac","hires","master"] },',
    '  tx: { name: "网易QQ母带源", type: "music", actions: ["musicUrl","downloadUrl"], qualitys: ["128k","320k","flac","master"] }',
    '} })'
  ].join('\n');
  const wmImp = SR.importScript(wyMasterScript, 'wy-master');
  check('导入网易QQ母带源', wmImp.ok, wmImp.message);
  check('网易曲目按 sources 找到音源', W.LXSources.forPlatform('wy') === wmImp.api.id,
    W.LXSources.forPlatform('wy'));
  check('QQ 曲目按 sources 找到音源', W.LXSources.forPlatform('tx') === wmImp.api.id);
  check('音源声明的档位被读出',
    W.LXQuality.sourceQualitys(wyTrack0).indexOf('master') >= 0,
    W.LXQuality.sourceQualitys(wyTrack0).join(','));
  check('菜单把母带标为可用（网易）',
    W.LXQuality.selectable(wyTrack0).filter(function (x) { return x.q === 'master'; })[0].declared === true);
  check('菜单把母带标为可用（QQ）',
    W.LXQuality.selectable(txTrack0).filter(function (x) { return x.q === 'master'; })[0].declared === true);
  const wmSel = W.LXQuality.selectable(wyTrack0);
  check('未声明的档位仍灰显但保留在菜单',
    wmSel.length === 9 && wmSel.filter(function (x) { return x.q === 'atmos_plus'; })[0].declared === false);

  // 数据迁移：内置演示曲目（kw_*）的下载任务会被清理
  W.LXData.addExternalTracks([{ id: 'kw_7', name: '旧演示曲', singer: 'demo', album: '', duration: 5, source: 'kw' }]);
  DL.enqueue([W.LXData.byId('kw_7')], 'standard');
  const purged = DL.purgeDemo();
  check('迁移清理内置演示曲目的下载任务', purged >= 1 && !DL.all().some(j => j.trackId === 'kw_7'),
    String(purged));
  check('数据版本已标记为 3', localStorage.getItem('lx_data_version') === '3',
    localStorage.getItem('lx_data_version'));

  group('11. 本地音源导入（真机 bug 回归：点「本地导入」无反应）');
  const FP = W.LXFilePick;
  check('window.LXFilePick 已挂载', !!FP);
  check('冷启动主动向 Java 索取暂存结果', bridge.pickPulls >= 1, String(bridge.pickPulls));
  // 上一组把名额占满，先清出空间
  SR.list().slice().forEach(a => { if (!a.builtin) SR.remove(a.id); });
  const beforeApis = SR.list().length;
  const beforeCalls = bridge.pickScriptCalls;
  fire('click', 'api-import-local');
  check('点「本地导入」调用原生 pickScript 桥', bridge.pickScriptCalls === beforeCalls + 1,
    beforeCalls + '->' + bridge.pickScriptCalls);
  check('立即进入等待态（取消/失败也有反馈）', FP._active === true);

  // 模拟 Java onActivityResult → UTF-8 文本分块回传
  const fileScript = SR.builtinScript().replace('@name 示例音源 · 本地曲库', '@name 真机文件导入音源');
  FP.__onStart('真机测试.js');
  for (let i = 0; i < fileScript.length; i += 3000) FP.__onChunk(fileScript.slice(i, i + 3000));
  FP.__onDone('真机测试.js');
  check('分块回传后音源数量 +1', SR.list().length === beforeApis + 1,
    beforeApis + '->' + SR.list().length);
  const imported = SR.list().filter(a => a.name === '真机文件导入音源')[0];
  check('音源名称取自文件脚本头 @name', !!imported);
  check('origin 记录真实文件名', !!imported && imported.origin === 'local:真机测试.js',
    imported && imported.origin);
  check('已向 Java 确认消费（防重复导入）', bridge.pickAcks >= 1, String(bridge.pickAcks));
  check('等待态正常结束', FP._active === false);
  check('导入的音源可立即用于搜索', !!imported && SR.supports(imported, 'search'));

  const acks0 = bridge.pickAcks;
  fire('click', 'api-import-local');
  FP.__onFail('已取消选择');
  check('取消选择不再静默（确认消费 + 结束等待态）',
    FP._active === false && bridge.pickAcks === acks0 + 1);

  check('空文件给出可操作原因', SR.importScript('', 'test').message.indexOf('文件内容为空') >= 0);
  check('缺少 @name 给出可操作原因',
    SR.importScript('/* hello */\nvar a = 1;\nconsole.log(1);', 'test').message.indexOf('@name') >= 0);

  // 浏览器回退路径：file input 必须挂载 DOM，且不能 display:none（真机 WebView 会忽略）
  FP._fallback(function () {}, '.js');
  const inputs = (document.body.children || []).filter(x => x.tagName === 'INPUT' && x.type === 'file');
  check('回退路径把 file input 挂到 DOM', inputs.length >= 1, String(inputs.length));
  check('回退路径不用 display:none', inputs.length > 0 &&
    !/display\s*:\s*none/.test(inputs[0].style.cssText || ''));
  // 模拟用户取消（shim 的 click 不会真的弹选择器），顺便清掉兜底定时器
  if (inputs.length) (inputs[0]._ev.change || []).forEach(fn => fn());
  check('回退路径「未选择文件」不会静默', true);

  group('12. 原生流式下载（真实音频 URL / 进度 / 继续）');
  const dlScript = [
    '/**', ' * @name HTTP 下载源', ' * @version 1.0.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, ({ action }) => {',
    '  if (action === "downloadUrl") return Promise.resolve({ url: "http://cdn.example.com/a.mp3",',
    '    mime: "audio/mpeg", ext: "mp3", filename: "网源 - 网页音频.mp3" })',
    '  if (action === "musicUrl") return Promise.resolve("http://cdn.example.com/a.mp3")',
    '  return Promise.reject(new Error("unsupported"))',
    '})',
    'send(EVENT_NAMES.inited, { sources: { kw: { name: "HTTP下载源", type: "music",',
    '  actions: ["musicUrl", "downloadUrl"], qualitys: ["128k"] } } })'
  ].join('\n');
  const dlImp = SR.importScript(dlScript, 'http-dl');
  check('导入 HTTP 下载源', dlImp.ok, dlImp.message);
  const httpTrack = {
    id: 'kw_http_dl_1', platform: 'kw', apiId: dlImp.api.id, songmid: 'h1',
    name: '网页音频', singer: '网源', album: '', duration: 200,
    qualitys: ['128k'], ext: 'mp3', mime: 'audio/mpeg'
  };
  W.LXData.addExternalTracks([httpTrack]);
  bridge.dlCalls.length = 0;
  DL.enqueue([httpTrack], '128k');
  await waitFor(() => bridge.dlCalls.indexOf('start') >= 0, 8000);
  check('音源返回 http 地址时走原生流式下载', bridge.dlCalls.indexOf('start') >= 0);
  check('下载 URL 来自音源 downloadUrl', bridge.dlUrl === 'http://cdn.example.com/a.mp3', bridge.dlUrl);
  check('文件名按歌手-歌名生成', /网源 - 网页音频\.mp3/.test(bridge.dlName), bridge.dlName);
  check('原生下载带上落盘目录（默认 Download/LX Music）',
    bridge.dlDir === 'Download/LX Music', bridge.dlDir);

  const dlKey = bridge.dlKey;
  W.LXDownloadBridge.onProgress(dlKey, 500000, 1000000);
  const mj = DL.all().filter(x => x.id === dlKey)[0];
  check('进度按已下载字节计算', mj.progress === 50, String(mj.progress));
  check('记录已接收 / 总大小', mj.received === 500000 && mj.total === 1000000,
    mj.received + '/' + mj.total);
  check('计算下载速度', mj.speed > 0 || mj.speed === 0);

  W.LXDownloadBridge.onDone(dlKey, 'Download/LX Music/网源 - 网页音频.mp3', 1000000);
  const mj2 = DL.all().filter(x => x.id === dlKey)[0];
  check('原生下载完成后 state=done', mj2.state === 'done', mj2.state);
  check('进度 100%', mj2.progress === 100, String(mj2.progress));
  check('记录落盘路径', /Download\/LX Music/.test(mj2.path), mj2.path);
  check('原生下载后不再显示「保存到设备」', !!mj2.path);

  // 取消要真正中断原生任务
  const httpTrack2 = Object.assign({}, httpTrack, { id: 'kw_http_dl_2', songmid: 'h2' });
  W.LXData.addExternalTracks([httpTrack2]);
  DL.enqueue([httpTrack2], '128k');
  await waitFor(() => bridge.dlCalls.filter(x => x === 'start').length >= 2, 8000);
  const key2 = bridge.dlKey;
  DL.cancel(key2);
  check('取消任务会中断原生下载', bridge.dlCancels.indexOf(key2) >= 0);

  // 失败回调要落到任务上
  const httpTrack3 = Object.assign({}, httpTrack, { id: 'kw_http_dl_3', songmid: 'h3' });
  W.LXData.addExternalTracks([httpTrack3]);
  DL.enqueue([httpTrack3], '128k');
  await waitFor(() => bridge.dlCalls.filter(x => x === 'start').length >= 3, 8000);
  const key3 = bridge.dlKey;
  W.LXDownloadBridge.onError(key3, 'HTTP 403');
  const mj3 = DL.all().filter(x => x.id === key3)[0];
  check('下载失败记录原因', mj3.state === 'error' && mj3.error === 'HTTP 403', mj3.state + '/' + mj3.error);
  check('失败任务可重试', (function () { DL.retry(key3); return true; })());

  group('13. 下载音质选择（最高母带 / 按音源解析 / 自动降级）');
  const QQ = W.LXQuality;
  check('音质模块已挂载', !!QQ);
  check('共 9 档音质', QQ.PRIORITY.length === 9, String(QQ.PRIORITY.length));
  check('最高档是母带 master', QQ.PRIORITY[0] === 'master', QQ.PRIORITY[0]);
  check('最低档是 128k', QQ.PRIORITY[8] === '128k', QQ.PRIORITY[8]);
  check('母带中文名 = 母带音质', QQ.name('master') === '母带音质', QQ.name('master'));
  check('旧三档映射到标准 key',
    QQ.normalize('standard') === '128k' && QQ.normalize('high') === '320k' && QQ.normalize('lossless') === 'flac');
  check('平台可选音质：酷我到 hires、QQ 到母带',
    QQ.platformList({ platform: 'kw' }).indexOf('hires') >= 0 &&
    QQ.platformList({ platform: 'kw' }).indexOf('master') < 0 &&
    QQ.platformList({ platform: 'tx' }).indexOf('master') >= 0);
  check('从曲目 qualitys 读出可用档',
    QQ.fromTrack({ qualitys: ['128k', '320k', 'flac'] }).join(',') === '128k,320k,flac');
  check('selectable 覆盖 9 档并标注声明状态', (function () {
    const list = QQ.selectable({ platform: 'kw', qualitys: ['128k', '320k'] });
    return list.length === 9 && list.filter(x => x.declared).length === 2;
  })());

  // 菜单：歌曲隐藏菜单的「下载…」要先出品质列表
  W.LXData.addExternalTracks([{
    id: 'kw_menu_1', platform: 'kw', songmid: 'mm', name: '菜单曲', singer: '测试',
    album: '', duration: 60, qualitys: ['128k', '320k'], ext: 'mp3', mime: 'audio/mpeg'
  }]);
  const mt = W.LXData.byId('kw_menu_1');
  fire('click', 'menu-download-q', mt.id);
  const mHtml = html('contextMenu');
  check('下载菜单标题提示选择品质', mHtml.indexOf('选择下载品质') >= 0, mHtml.slice(0, 80));
  check('下载菜单列出母带音质', mHtml.indexOf('母带音质') >= 0);
  check('下载菜单列出 9 个品质选项', (mHtml.match(/data-q="/g) || []).length === 9,
    String((mHtml.match(/data-q="/g) || []).length));
  check('下载菜单含返回项', mHtml.indexOf('返回') >= 0);

  // 音源：只给到无损，母带与 24bit 返回空，用来看降级
  const masterScript = [
    '/**', ' * @name 母带降级源', ' * @version 1.0.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, ({ action, info }) => {',
    '  const t = String(info && info.type || "")',
    '  if (action === "downloadUrl" || action === "musicUrl") {',
    '    if (t === "master" || t === "flac24bit") return Promise.resolve(null)',
    '    return Promise.resolve({ url: "http://cdn.example.com/hi.mp3", mime: "audio/mpeg",',
    '      ext: "mp3", filename: "母带测试曲 - 测试.mp3" })',
    '  }',
    '  return Promise.reject(new Error("unsupported"))',
    '})',
    'send(EVENT_NAMES.inited, { sources: { kw: { name: "母带降级源", type: "music",',
    '  actions: ["musicUrl", "downloadUrl"], qualitys: ["128k", "320k", "flac"] } } })'
  ].join('\n');
  const mImp = SR.importScript(masterScript, 'master');
  check('导入母带降级源', mImp.ok, mImp.message);
  const hiTrack = {
    id: 'kw_master_1', platform: 'kw', apiId: mImp.api.id, songmid: 'm1',
    name: '母带测试曲', singer: '测试', album: '', duration: 60,
    qualitys: ['128k', '320k', 'flac', 'flac24bit'], ext: 'mp3', mime: 'audio/mpeg'
  };
  W.LXData.addExternalTracks([hiTrack]);
  const seenTypes = [];
  const origFetch = SR.fetchMedia;
  SR.fetchMedia = function (tr, q) { if (tr.id === 'kw_master_1') seenTypes.push(q); return origFetch.call(SR, tr, q); };

  fire('click', 'menu-download', 'kw_master_1', { dataset: { q: 'master' } });
  const mjob = DL.all().filter(x => x.trackId === 'kw_master_1')[0];
  check('按所选母带入队', !!mjob && mjob.quality === 'master', mjob && mjob.quality);
  check('音源收到的 info.type = master', seenTypes[0] === 'master', String(seenTypes[0]));
  await waitFor(() => {
    const j = DL.all().filter(x => x.trackId === 'kw_master_1')[0];
    return j && j.state === 'running' && j.deliveredQuality === 'flac';
  }, 10000);
  const qjob = DL.all().filter(x => x.trackId === 'kw_master_1')[0];
  check('母带解析不到时自动降级', qjob.deliveredQuality === 'flac', qjob.deliveredQuality);
  check('降级过程逐档尝试', seenTypes.join(',') === 'master,flac24bit,flac', seenTypes.join(','));
  check('任务上留下降级说明', (qjob.note || '').indexOf('正在尝试') >= 0 || qjob.deliveredQuality === 'flac', qjob.note);
  W.LXDownloadBridge.onDone(qjob.id, 'Download/LX Music/母带测试曲 - 测试.mp3', 2048);
  await waitFor(() => DL.all().filter(x => x.trackId === 'kw_master_1')[0].state === 'done', 5000);
  S.nav = 'nav_download'; W.LXApp.renderView();
  check('下载页显示「母带音质 → 无损音质」',
    html('view').indexOf('母带音质 → 无损音质') >= 0, html('view').slice(0, 400));

  // 全部档位都拿不到地址时，必须如实报错（不再用合成音轨冒充）
  const noneScript = masterScript
    .replace('@name 母带降级源', '@name 全档失败源')
    .replace('if (t === "master" || t === "flac24bit") return Promise.resolve(null)',
      'return Promise.resolve(null)');
  const nImp = SR.importScript(noneScript, 'none');
  check('导入全档失败源', nImp.ok, nImp.message);
  W.LXData.addExternalTracks([{
    id: 'kw_none_1', platform: 'kw', apiId: nImp.api.id, songmid: 'n1',
    name: '无地址曲', singer: '测试', album: '', duration: 60,
    qualitys: ['128k', '320k', 'flac'], ext: 'mp3', mime: 'audio/mpeg'
  }]);
  fire('click', 'menu-download', 'kw_none_1', { dataset: { q: '320k' } });
  await waitFor(() => DL.all().filter(x => x.trackId === 'kw_none_1')[0].state === 'error', 10000);
  const nj = DL.all().filter(x => x.trackId === 'kw_none_1')[0];
  check('全档失败时任务标为 error', nj.state === 'error', nj.state);
  check('错误说明列出尝试过的档位', (nj.error || '').indexOf('已尝试') >= 0, nj.error);
  SR.fetchMedia = origFetch;

  // 批量下载同样先选品质
  S.multi = true; S.selected = [mt.id, 'kw_master_1'];
  S.nav = 'nav_search';
  fire('click', 'download-selected');
  const bHtml = html('contextMenu');
  check('批量下载先弹品质菜单', bHtml.indexOf('选择下载品质') >= 0 && bHtml.indexOf('母带音质') >= 0);
  check('批量菜单用批量入队动作', bHtml.indexOf('dl-enqueue-at-quality') >= 0);
  S.multi = false; S.selected = [];

  group('14. 音源取链失败必须透传原因（v3.6.0）');
  const denyScript = [
    '/**', ' * @name 拒绝取链源', ' * @version 1.0.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, () => Promise.reject(new Error("该音源仅对认证用户开放：请使用卡密")))',
    'send(EVENT_NAMES.inited, { sources: { kw: { name: "拒绝取链源", type: "music",',
    '  actions: ["musicUrl", "downloadUrl"], qualitys: ["128k"] } } })'
  ].join('\n');
  const denyImp = SR.importScript(denyScript, 'deny');
  check('导入拒绝取链源', denyImp.ok, denyImp.message);
  W.LXData.addExternalTracks([{
    id: 'kw_deny_1', platform: 'kw', apiId: denyImp.api.id, songmid: 'd1',
    name: '受限曲', singer: '测试', album: '', duration: 60, qualitys: ['128k']
  }]);
  const denyTrack = W.LXData.byId('kw_deny_1');
  const denyMedia = await SR.fetchMedia(denyTrack, '128k');
  check('解析失败返回 null', denyMedia === null);
  check('记录音源返回的原始原因',
    /仅对认证用户开放/.test(SR.lastError(denyTrack)), SR.lastError(denyTrack));
  DL.enqueue([denyTrack], '128k');
  await waitFor(function () {
    const j = DL.all().filter(x => x.trackId === 'kw_deny_1')[0];
    return j && j.state === 'error';
  }, 12000);
  const denyJob = DL.all().filter(x => x.trackId === 'kw_deny_1')[0];
  check('下载任务进入 error', !!denyJob && denyJob.state === 'error', denyJob && denyJob.state);
  check('错误文案带音源原文（不是笼统「没有地址」）',
    /仅对认证用户开放/.test(denyJob.error || ''), denyJob.error);
  check('错误文案仍列出尝试过的档位',
    /已尝试/.test(denyJob.error || ''), denyJob.error);

  group('15. 音效系统（对齐 lxserver sound-effects）');
  const Snd = W.LXSound;
  check('LXSound 已挂载', !!Snd);
  check('10 段均衡器（31Hz~16kHz）',
    Snd.FREQS.length === 10 && Snd.FREQS[0] === 31 && Snd.FREQS[9] === 16000, Snd.FREQS.join(','));
  check('9 个官方预设', Snd.PRESETS.length === 9, String(Snd.PRESETS.length));
  check('预设名称与官方一致',
    Snd.PRESETS.map(function (p) { return p.name; }).join(',') === '流行,舞曲,摇滚,古典,人声,慢歌,电子乐,重低音,柔和',
    Snd.PRESETS.map(function (p) { return p.name; }).join(','));
  check('重低音预设增益与官方一致',
    Snd.PRESETS.filter(function (p) { return p.name === '重低音'; })[0].values.join(',') === '8,7,5,4,0,0,0,0,0,0');
  check('默认关闭', Snd.state().enabled === false && Snd.describe() === '音效已关闭', Snd.describe());

  Snd.setPreset('摇滚');
  check('套用预设后自动开启', Snd.state().enabled === true);
  check('预设增益写入 EQ', Snd.state().eq.join(',') === '7,6,2,1,-3,-4,2,1,4,5', Snd.state().eq.join(','));
  check('状态描述含预设名', Snd.describe().indexOf('摇滚') >= 0, Snd.describe());

  Snd.setBand(1, 99);
  check('单段增益钳制在 +12', Snd.state().eq[1] === 12, String(Snd.state().eq[1]));
  Snd.setBand(0, 10);
  check('手动改频段后预设变「自定义」', Snd.state().preset === '自定义', Snd.state().preset);

  Snd.setReverb('hall');
  check('混响切到大厅', Snd.state().reverb === 'hall' && Snd.describe().indexOf('大厅') >= 0, Snd.describe());
  Snd.setSurround(true);
  check('3D 环绕可开启', Snd.state().surround === true && Snd.describe().indexOf('环绕') >= 0, Snd.describe());
  check('音效配置已持久化',
    (localStorage.getItem('lx_sound_effects_v1') || '').indexOf('hall') >= 0,
    localStorage.getItem('lx_sound_effects_v1'));

  Snd.setEnabled(false);
  check('关闭音效保留已配参数',
    Snd.state().eq[0] === 10 && Snd.state().reverb === 'hall' && Snd.state().surround === true);
  check('关闭后描述为已关闭', Snd.describe() === '音效已关闭');
  Snd.reset();
  check('重置清空 EQ / 混响 / 环绕',
    Snd.state().eq.every(function (v) { return v === 0; }) &&
    Snd.state().reverb === 'none' && Snd.state().surround === false);

  group('16. 歌词解析与详情页（v3.7.0）');
  const Lyr = W.LXLyr;
  check('LXLyr 已挂载', !!Lyr);
  const ly1 = Lyr.parse('[ti:测试]\n[offset:500]\n[00:01.50]第一行\n[00:12.34]第二行\n[00:20.00]第三行');
  check('解析出 3 行', ly1.lines.length === 3, String(ly1.lines.length));
  check('offset 让歌词提前 0.5s', Math.abs(ly1.lines[0].t - 1) < 0.01, String(ly1.lines[0].t));
  check('时间精确到百分秒', Math.abs(ly1.lines[1].t - 11.84) < 0.01, String(ly1.lines[1].t));
  const ly2 = Lyr.parse('[00:10.00][01:20.00]副歌');
  check('一行多个时间标签展开', ly2.lines.length === 2 && Math.abs(ly2.lines[1].t - 80) < 0.01,
    ly2.lines.map(function (l) { return l.t; }).join(','));
  const ly3 = Lyr.parse('[00:05.00]原文\n[00:05.00]翻译');
  check('同时间戳第二行作为翻译', ly3.lines.length === 1 && ly3.lines[0].trans === '翻译',
    JSON.stringify(ly3.lines));
  const ly4 = Lyr.parse('[00:03.00]<00:03.00>逐字<00:04.00>清理');
  check('去掉逐字标签', ly4.lines[0].text === '逐字清理', ly4.lines[0].text);
  check('第一行之前返回 -1', Lyr.indexAt(ly1.lines, 0.5) === -1);
  check('命中第二行', Lyr.indexAt(ly1.lines, 12) === 1, String(Lyr.indexAt(ly1.lines, 12)));
  check('超过末行返回最后一行', Lyr.indexAt(ly1.lines, 999) === 2);
  const lyPlain = Lyr.parse('只有文本\n第二句');
  check('无时间标签按纯文本处理',
    lyPlain.lines.length === 0 && lyPlain.plain.length === 2 && !lyPlain.hasTime);

  const lbox = document.getElementById('lyricBox');
  Lyr.render(lbox, ly1, 't1');
  check('渲染 3 行 lc-line', (lbox.innerHTML.match(/lc-line/g) || []).length === 3,
    String((lbox.innerHTML.match(/lc-line/g) || []).length));
  check('行上带跳转时间', lbox.innerHTML.indexOf('data-t="11.84"') >= 0, lbox.innerHTML.slice(0, 120));
  Lyr.render(lbox, null, 'x');
  check('没有歌词时给出提示', lbox.innerHTML.indexOf('暂无歌词') >= 0);

  W.LXData.addExternalTracks([{
    id: 'kw_detail_1', platform: 'kw', songmid: 'dd', name: '详情曲', singer: '测试',
    album: 'QA', duration: 100, qualitys: ['128k']
  }]);
  W.LXApp.openOverlay('detail', 'kw_detail_1');
  const ovHtml = document.getElementById('overlay').innerHTML;
  check('详情页含歌词容器', ovHtml.indexOf('lyricBox') >= 0);
  check('详情页含「下载」按钮', ovHtml.indexOf('detail-download') >= 0);
  check('详情页含「音效」按钮', ovHtml.indexOf('detail-effects') >= 0);
  check('详情页含「歌词」开关', ovHtml.indexOf('detail-lyric') >= 0);
  // v3.13.6：详情页「收藏」→ 弹列表选择 → 加进对应列表
  check('详情页含「收藏」按钮', ovHtml.indexOf('detail-collect') >= 0);
  fire('click', 'detail-collect');
  const md = html('modalRoot');
  check('点收藏弹出列表选择', md.indexOf('收藏到列表') >= 0);
  check('弹窗列出所有列表',
    (md.match(/data-act="collect-to"/g) || []).length === W.LXApp.state.lists.length,
    String((md.match(/data-act="collect-to"/g) || []).length));
  const rid = W.LXApp.state.lists[0].id;
  fire('click', 'collect-to', rid, { dataset: { track: 'kw_detail_1' } });
  const target = W.LXApp.state.lists.filter(function (l) { return l.id === rid; })[0];
  check('选列表后歌曲被加进去', target.trackIds.indexOf('kw_detail_1') >= 0, rid);
  fire('click', 'detail-collect');
  check('已收藏的列表在弹窗里标「已收藏」', html('modalRoot').indexOf('已收藏') >= 0);
  fire('click', 'collect-to', rid, { dataset: { track: 'kw_detail_1' } });
  check('重复收藏不会加两次',
    target.trackIds.filter(function (x) { return x === 'kw_detail_1'; }).length === 1);
  fire('click', 'close-modal');
  check('收藏弹窗认的是详情页那首歌（不是碰巧正在播放的）',
    (function () {
      W.LXApp.openOverlay('detail', 'kw_detail_1');
      fire('click', 'detail-collect');
      const h = html('modalRoot');
      fire('click', 'close-modal');
      return h.indexOf('详情曲') >= 0;
    })());
  fire('click', 'detail-effects');
  check('音效页可打开', W.LXApp.state.overlay === 'effects');
  const fxHtml = document.getElementById('overlay').innerHTML;
  check('音效页有 9 个预设', (fxHtml.match(/data-act="fx-preset"/g) || []).length === 9,
    String((fxHtml.match(/data-act="fx-preset"/g) || []).length));
  check('音效页有 10 段 EQ', (fxHtml.match(/data-act="fx-band"/g) || []).length === 10);
  check('音效页有混响与环绕',
    fxHtml.indexOf('data-act="fx-reverb"') >= 0 && fxHtml.indexOf('data-act="fx-surround"') >= 0);
  W.LXApp.closeOverlay();

  group('17. 下载音质尊重手动选择（不再预先降档）');
  S.settings.audioQuality = 'master';
  W.LXData.addExternalTracks([{
    id: 'kw_q_master', platform: 'kw', apiId: imp.api.id, songmid: 'qm',
    name: '母带直选', singer: '测试', album: '', duration: 60, qualitys: ['128k', '320k', 'flac']
  }]);
  fire('click', 'menu-download', 'kw_q_master');
  const qJob = DL.all().filter(function (x) { return x.trackId === 'kw_q_master'; })[0];
  check('未指定档位时按设置里的母带入队',
    !!qJob && qJob.quality === 'master', qJob && qJob.quality);
  check('入队档位不会被「可用档位」改写',
    !!qJob && qJob.quality === 'master');
  S.settings.audioQuality = '320k';

  group('18. 默认音源与音源更新（v3.8.0）');
  check('已不再提供逐平台绑定 API', typeof W.LXSources.bind === 'undefined' &&
    typeof W.LXSources.bindingOf === 'undefined');
  const defScript = [
    '/**', ' * @name 默认音源甲', ' * @version 1.0.0', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, () => Promise.reject(new Error("unsupported")))',
    'send(EVENT_NAMES.inited, { sources: { kg: { name: "默认音源甲", type: "music",',
    '  actions: ["musicUrl"], qualitys: ["128k"] } } })'
  ].join('\n');
  const dImp = SR.importScript(defScript, 'online:https://example.com/a.js');
  check('导入默认音源候选', dImp.ok, dImp.message);
  check('在线源可识别为可更新', /^online:/.test(SR.byId(dImp.api.id).origin),
    SR.byId(dImp.api.id).origin);

  // 另有一个声明 kg 的源排在前面（先导入的），验证默认优先
  check('默认前：kg 取第一个自动匹配的源', SR.forPlatform('kg') !== '', SR.forPlatform('kg'));
  const setRes = SR.setDefault(dImp.api.id);
  check('设置默认音源', setRes.ok && SR.isDefault(dImp.api.id), setRes.message);
  check('默认音源优先于自动匹配', SR.forPlatform('kg') === dImp.api.id, SR.forPlatform('kg'));
  check('默认音源未声明的平台仍自动匹配',
    SR.forPlatform('wy') !== dImp.api.id, SR.forPlatform('wy'));
  check('默认设置已持久化',
    localStorage.getItem('lx_default_api_v1') === dImp.api.id, localStorage.getItem('lx_default_api_v1'));
  check('默认音源显示在管理页',
    (function () { W.LXApp.openOverlay('userapi'); var h = document.getElementById('overlay').innerHTML;
      return h.indexOf('ua-tag') >= 0 && h.indexOf('取消默认') >= 0; })());
  check('在线音源有「更新」按钮',
    document.getElementById('overlay').innerHTML.indexOf('api-refresh') >= 0);
  SR.setDefault('');
  check('可取消默认音源', localStorage.getItem('lx_default_api_v1') === '', localStorage.getItem('lx_default_api_v1'));
  W.LXApp.closeOverlay();

  group('19. 系统返回键 / 在线歌单 / 音频代理（v3.9.0）');
  check('LXApp 暴露 handleBack', typeof W.LXApp.handleBack === 'function');
  // 非搜索页按返回：回到搜索主页，而不是退出
  fire('click', 'nav', 'nav_setting');
  check('当前在设置页', S.nav === 'nav_setting', S.nav);
  check('返回键消费：设置页 → 搜索页', W.LXApp.handleBack() === true && S.nav === 'nav_search', S.nav);
  // 搜索页有结果：先清空结果
  S.search.results = [{ id: 'x1', name: 'x', singer: 'y', album: '', duration: 1, time: '00:01' }];
  S.nav = 'nav_search';
  check('返回键清空搜索结果', W.LXApp.handleBack() === true && S.search.results === null);
  S.search.text = '';
  check('搜索主页再无内容时不消费（交给系统退出）', W.LXApp.handleBack() === false);

  // 歌单页：平台推荐歌单入口
  check('歌单页有「换一批」入口', typeof W.LXPlatform.recommendLists === 'function');
  check('歌单页有歌单详情加载器', typeof W.LXPlatform.listDetail === 'function');
  fire('click', 'nav', 'nav_songlist');
  check('歌单页渲染平台选择条', html('view').indexOf('pf-bar') >= 0);
  check('歌单页有「换一批」按钮', html('view').indexOf('pl-refresh') >= 0);
  fire('click', 'nav', 'nav_search');

  // 音频代理：无原生桥时回退为空（浏览器直连），有桥时给出本源地址
  check('浏览器环境不启用媒体代理', W.LXMediaProxy.wrap('https://cdn.example.com/a.mp3') === '');
  const oldBase = W.EchoBridge.mediaProxyBase;
  W.EchoBridge.mediaProxyBase = () => 'https://app.echo.local/__media';
  const proxied = W.LXMediaProxy.wrap('https://cdn.example.com/a.mp3?x=1', { Referer: 'https://m.example.com/' });
  check('原生环境走媒体代理', proxied.indexOf('https://app.echo.local/__media?u=') === 0, proxied.slice(0, 60));
  check('代理地址是本源（不会被跨域静音）', proxied.indexOf('app.echo.local') > 0);
  check('音源 headers 一并带上', proxied.indexOf('&h=') > 0);
  W.EchoBridge.mediaProxyBase = oldBase;

  group('20. 音源失败时回退到同平台的其他音源（v3.9.0）');
  const fbA = [
    '/**', ' * @name 回退源A', ' * @description qa', ' * @version 1.0.0', ' * @author qa', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, () => Promise.reject(new Error("A 取地址失败")))',
    'send(EVENT_NAMES.inited, { sources: { kw: { name: "回退源A", type: "music", actions: ["musicUrl"], qualitys: ["128k"] } } })'
  ].join('\n');
  const fbB = [
    '/**', ' * @name 回退源B', ' * @description qa', ' * @version 1.0.0', ' * @author qa', ' */',
    'const { EVENT_NAMES, on, send } = globalThis.lx',
    'on(EVENT_NAMES.request, () => Promise.resolve({ url: "https://cdn.example.com/ok.mp3", mime: "audio/mpeg", ext: "mp3" }))',
    'send(EVENT_NAMES.inited, { sources: { kw: { name: "回退源B", type: "music", actions: ["musicUrl", "lyric"], qualitys: ["128k"] } } })'
  ].join('\n');
  // 清空已有音源，确保候选链里只有 A / B，断言才不会被前面的测试源干扰
  W.LXSources.list().forEach(a => W.LXSources.remove(a.id));
  const fbImpA = SR.importScript(fbA, 'qa-fb-a');
  const fbImpB = SR.importScript(fbB, 'qa-fb-b');
  check('两个回退音源均导入成功', fbImpA.ok && fbImpB.ok, fbImpA.message + '/' + fbImpB.message);
  SR.setDefault(fbImpA.api.id);
  const fbTrack = {
    id: 'kw_qa_fb', platform: 'kw', songmid: 'qa-fb', name: '回退测试', singer: 'QA',
    album: '', duration: 100, time: '01:40', qualitys: ['128k'], _raw: { songmid: 'qa-fb' }
  };
  W.LXData.addExternalTracks([fbTrack]);
  const chainNames = SR.sourceChain(fbTrack).map(a => a.name);
  check('候选链把默认音源排在第一位', chainNames[0] === '回退源A', chainNames.join(' > '));
  check('候选链包含同平台的其它音源', chainNames.indexOf('回退源B') > 0, chainNames.join(' > '));
  const fbMedia = await SR.playableUrl(fbTrack, '128k');
  check('默认音源失败后自动回退并拿到地址', !!fbMedia && /ok\.mp3$/.test(fbMedia.url),
    fbMedia && fbMedia.url);
  check('回退成功后不再记录错误', !SR.lastError(fbTrack), SR.lastError(fbTrack));
  SR.setDefault('');
  W.LXSources.list().forEach(a => { if (/回退源/.test(a.name || '')) W.LXSources.remove(a.id); });

  group('21. 设置项真正可改：速率 / 歌词字号 / 界面字号 / 下载音质（v3.10.0）');
  S.nav = 'nav_setting'; W.LXApp.renderView();
  const setHtml = html('view');
  check('「播放速率」有滑块', setHtml.indexOf('type="range" data-act="set-num" data-id="playbackRate"') >= 0);
  check('「播放速率」有数字框',
    setHtml.indexOf('class="sr-num" type="number" data-act="set-num" data-id="playbackRate"') >= 0);
  check('「歌词字体大小」可输入', setHtml.indexOf('data-act="set-num" data-id="lyricFontSize"') >= 0);
  check('「界面字体大小」可输入', setHtml.indexOf('data-act="set-num" data-id="fontSize"') >= 0);
  const dqSeg = (setHtml.split('data-act="dl-quality"')[1] || '');
  const dqOpts = (dqSeg.slice(0, dqSeg.indexOf('</select>')).match(/<option value=/g) || []).length;
  check('「下载音质」下拉 9 档', dqOpts === 9, String(dqOpts));

  const viewBeforeClick = html('view');
  (docEvents.click || []).forEach(fn => fn({
    target: { closest: () => ({ tagName: 'INPUT', dataset: { act: 'set-num', id: 'fontSize' }, value: '17' }) },
    clientX: 1, clientY: 1
  }));
  check('点击数字框不再重建设置页（旧版「改不了」的根因回归）', html('view') === viewBeforeClick);

  fire('change', 'set-num', 'playbackRate', { value: '1.5' });
  check('播放速率可改（1.5×）', S.settings.playbackRate === 1.5 && S.rate === 1.5,
    String(S.settings.playbackRate));
  fire('change', 'set-num', 'fontSize', { value: '17' });
  check('界面字体大小生效（--ui-fs=1.214）', cssVars['--ui-fs'] === '1.214', cssVars['--ui-fs']);
  fire('change', 'set-num', 'lyricFontSize', { value: '20' });
  check('歌词字体大小生效（--lyric-size=20px）', cssVars['--lyric-size'] === '20px', cssVars['--lyric-size']);
  fire('change', 'dl-quality', undefined, { value: 'flac' });
  check('下载音质可改并写入设置/队列',
    S.settings.downloadQuality === 'flac' && DL.opts.quality === 'flac',
    S.settings.downloadQuality + '/' + DL.opts.quality);
  check('style.css 不再有裸 px 字号（全部跟随 --ui-fs）',
    (styleCss.match(/font-size:\s*[0-9.]+px/g) || []).length === 0,
    String((styleCss.match(/font-size:\s*[0-9.]+px/g) || []).length));

  group('22. 播放详情：下一首 / 队列剩余 / 点选切歌（v3.11.0）');
  const qTracks = [1, 2, 3, 4, 5].map(function (i) {
    return {
      id: 'kw_q' + i, platform: 'kw', songmid: 'q' + i, name: '队列歌' + i,
      singer: '歌手' + i, album: '', duration: 100 + i, time: '01:4' + i, qualitys: ['128k']
    };
  });
  W.LXData.addExternalTracks(qTracks);
  S.queue = qTracks.map(function (t) { return t.id; });
  S.index = 0; S.mode = 'listLoop'; S.playing = true;
  W.LXApp.openOverlay('detail');
  const dqHtml = html('overlay');
  check('详情页常驻「下一首」信息条', dqHtml.indexOf('下一首') >= 0);
  check('下一首显示队列里的第二首', dqHtml.indexOf('队列歌2') >= 0 && dqHtml.indexOf('歌手2') >= 0);
  check('显示当前位置与剩余首数', dqHtml.indexOf('第 1 / 5 首 · 还剩 4 首') >= 0);
  check('信息条标注当前播放模式', dqHtml.indexOf('列表循环') >= 0);
  check('详情页新增「列表」入口', dqHtml.indexOf('data-act="open-queue"') >= 0);
  check('信息条可点进队列页', dqHtml.indexOf('class="dq" data-act="open-queue"') >= 0);

  S.index = 4; S.mode = 'list';
  W.LXApp.renderOverlay();
  check('顺序播放到底时剩余为 0 首', html('overlay').indexOf('第 5 / 5 首 · 还剩 0 首') >= 0);
  S.index = 0;
  S.mode = 'random';
  W.LXApp.renderOverlay();
  check('随机模式不预告具体下一首', html('overlay').indexOf('每次从 5 首里抽一首') >= 0);
  S.mode = 'singleLoop';
  W.LXApp.renderOverlay();
  check('单曲循环提示播完重来', html('overlay').indexOf('播完重来这一首') >= 0);

  S.mode = 'random'; S.index = 2; S.playing = false;
  let sameHits = 0;
  for (let i = 0; i < 20; i++) {
    const before = S.index;
    fire('click', 'next');
    if (S.index === before) sameHits++;
  }
  check('随机播放 20 次都不会停在原曲', sameHits === 0, 'sameHits=' + sameHits);

  fire('click', 'open-queue');
  const qHtml = html('overlay');
  check('队列页列出全部 5 首', (qHtml.match(/data-act="queue-play"/g) || []).length === 5);
  check('队列页高亮当前曲目', qHtml.indexOf('q-item on') >= 0);
  check('队列页显示总首数与当前位置', /共 5 首 · 当前第 [1-5] 首/.test(qHtml), qHtml.match(/共 5 首 · 当前第 [1-5] 首/) + '');
  S.mode = 'listLoop';
  fire('click', 'queue-play', undefined, { dataset: { val: '1' } });
  check('点选队列任一曲目即切换', S.index === 1, S.index);
  W.LXApp.openOverlay('detail');
  check('切换后详情页同步到第 2 首', html('overlay').indexOf('第 2 / 5 首') >= 0);
  W.LXApp.closeOverlay();
  S.queue = []; S.index = -1; S.mode = 'listLoop';

  group('23. 下载目录可选（v3.12.0）');
  S.nav = 'nav_setting'; W.LXApp.renderView();
  const dirHtml = html('view');
  check('设置页有「下载目录」一行', dirHtml.indexOf('下载目录') >= 0);
  check('「下载目录」是可选择的下拉（不是只读文字）', dirHtml.indexOf('data-act="dl-path"') >= 0);
  const dirSeg = (dirHtml.split('data-act="dl-path"')[1] || '');
  const dirOpts = (dirSeg.slice(0, dirSeg.indexOf('</select>')).match(/<option value=/g) || []).length;
  check('预置 4 个常用目录 + 1 个自定义', dirOpts === 5, String(dirOpts));
  check('默认落在 Download/LX Music', DL.opts.dir === 'Download/LX Music', DL.opts.dir);
  check('行内展示解析后的完整路径',
    dirHtml.indexOf('/storage/emulated/0/Download/LX Music') >= 0);

  fire('change', 'dl-path', undefined, { value: 'Music/LX Music' });
  check('切到 Music/LX Music 生效（设置 + 下载队列同步）',
    S.settings.downloadDir === 'Music/LX Music' && DL.opts.dir === 'Music/LX Music',
    S.settings.downloadDir + '/' + DL.opts.dir);
  check('切换后仍然不需要存储权限（只改 RELATIVE_PATH）', dirHtml.indexOf('无需存储权限') >= 0);

  fire('change', 'dl-path', undefined, { value: '__custom' });
  const modalHtml = (document.getElementById('modalRoot') || {}).innerHTML || '';
  check('选「自定义目录」弹出输入框', modalHtml.indexOf('id="dlPathInput"') >= 0);
  check('弹窗解释 Android 分区存储的可写范围',
    modalHtml.indexOf('Download') >= 0 && modalHtml.indexOf('Music') >= 0);
  fire('click', 'dl-path-cancel');
  check('取消自定义后落盘目录不变', DL.opts.dir === 'Music/LX Music', DL.opts.dir);

  check('只写子目录时归到 Download 下',
    W.LXApp.setDlPath('我的音乐') === 'Download/我的音乐', String(W.LXApp.setDlPath('我的音乐')));
  check('未知根目录也归到 Download 下',
    W.LXApp.setDlPath('Music2/歌') === 'Download/Music2/歌', String(W.LXApp.setDlPath('Music2/歌')));
  check('自定义中文目录原样保留',
    W.LXApp.setDlPath('Music/我的歌') === 'Music/我的歌', String(W.LXApp.setDlPath('Music/我的歌')));
  check('带 ../ 的路径被拒绝并回默认',
    W.LXApp.setDlPath('../etc/passwd') === 'Download/LX Music', String(W.LXApp.setDlPath('../etc/passwd')));
  check('过长路径被拒绝并回默认',
    W.LXApp.setDlPath('Download/' + 'x'.repeat(90)) === 'Download/LX Music');
  DL.opts.dir = 'Music/我的歌';
  check('dirOf 归一化后即为下一首下载使用的目录', DL.dirOf() === 'Music/我的歌', DL.dirOf());
  check('非法控制字符目录被清洗回默认',
    (function () { var o = DL.opts.dir; DL.opts.dir = 'Music/坏\u0001名'; var r = DL.dirOf();
      DL.opts.dir = o; return r; })() === 'Download/LX Music');

  group('24. 下载页点行播放 + 音效接管（v3.13.0）');
  // 复用第 12 组那张已完成的原生下载任务（落盘路径已知）
  check('已保存任务能取回落盘路径',
    DL.getSavedPath && DL.getSavedPath('kw_http_dl_1') === 'Download/LX Music/网源 - 网页音频.mp3',
    String(DL.getSavedPath && DL.getSavedPath('kw_http_dl_1')));
  S.nav = 'nav_download'; W.LXApp.renderView();
  const dlHtml = html('view');
  check('已完成任务整行就是播放按钮（不用另找按钮）',
    dlHtml.indexOf('class="dl-item hit" data-act="dl-play"') >= 0);
  check('不再单独放「播放」按钮', dlHtml.indexOf('<button data-act="dl-play"') < 0);
  check('行内仍有移除按钮', dlHtml.indexOf('data-act="dl-remove"') >= 0);

  bridge.localPaths.length = 0;
  await W.LXApp.playFrom('kw_http_dl_1', ['kw_http_dl_1']);
  await waitFor(() => String(W.LXApp.engine._lastUrl || '').indexOf('__local') >= 0, 4000);
  check('已下载曲目改播本地文件（不再回头向音源要地址）',
    String(W.LXApp.engine._lastUrl).indexOf('/__local?p=') >= 0, String(W.LXApp.engine._lastUrl));
  check('本地地址带上了落盘路径',
    /__local\?p=Download%2FLX%20Music%2F/.test(String(W.LXApp.engine._lastUrl)),
    String(W.LXApp.engine._lastUrl));
  check('同源地址不再套一层媒体代理',
    W.LXMediaProxy.wrap('https://app.echo.local/__local?p=x') === '',
    String(W.LXMediaProxy.wrap('https://app.echo.local/__local?p=x')));

  W.LXSound.setEnabled(false);
  check('音效关闭时不接管音频图', W.LXApp.engine.graphEnabled() === false);
  W.LXSound.setEnabled(true);
  check('音效一开就接管音频图（参数全平也算，不再「开了没反应」）',
    W.LXApp.engine.graphEnabled() === true);
  W.LXSound.setEnabled(false);

  // 收尾：停掉引擎定时器，避免进程挂起
  try { W.LXApp.engine.stop(true); } catch (e) {}
  console.log('\n========================================');
  console.log('  PASS ' + pass + ' / ' + (pass + fail));
  if (fail) { console.log('  FAILED:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n[冒烟测试异常] ' + (e && e.stack || e));
  process.exit(1);
});
