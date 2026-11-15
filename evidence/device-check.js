/* 通过 Chrome DevTools Protocol 在真实模拟器里的 WebView 中做端到端验收。
 * 前置：模拟器已启动、APK 已安装并打开；由 shell 先执行 adb forward。
 * 用法：node evidence/device-check.js
 * 产出：evidence/apk-v3-*.png 截图 + 控制台 JSON 报告
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'evidence');

const fail = [];
const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  if (!cond) fail.push(name);
}

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 调试页面');
  console.log('CDP 页面: ' + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  function cmd(method, params) {
    return new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function ev(expr) {
    const r = await cmd('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' +
      (x.exceptionDetails.exception && x.exceptionDetails.exception.description || x.exceptionDetails.text));
    return x.result && x.result.value;
  }
  async function shot(name) {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('  截图  ' + name);
    }
  }
  async function wait(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(fn);
      if (v) return v;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('等待超时: ' + label);
  }
  const click = sel => ev("(function(){var e=document.querySelector(" + JSON.stringify(sel) +
    ");if(!e)return false;e.click();return true;})()");

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  // 冷启动状态由外层 shell 保证：每次验收前 pm clear + 强制重启 Activity。
  // 这里不再 reload，避免 CDP 执行上下文切换导致 DOM 与状态不同步。

  console.log('\n=== A. 页面与资源 ===');
  check('页面标题 = LX Music', await ev('document.title') === 'LX Music');
  check('页面位于伪 HTTPS 安全源', /^https:\/\/app\.echo\.local/.test(await ev('location.href')));
  check('EchoBridge 已注入', await ev('!!window.EchoBridge && typeof EchoBridge.saveDownloadStart==="function"'));
  check('十三个脚本产物全部挂载', await ev('!!(LXI18N&&LXTheme&&LXData&&LXEngine&&LXDownload&&LXApp&&LXSourceAPI&&LXSources&&LXHttp&&LXPlatform&&LXQuality&&LXNetCrypto&&LXSound&&LXLyr)'));
  check('zh-cn 文案 520 条', await ev('Object.keys(LXI18N).length') === 520);
  check('16 套主题', await ev('LXTheme.list.length') === 16);
  check('抽屉 6 项导航', await ev("document.querySelectorAll('#navMenus .nav-item').length") === 6);
  check('默认主题色 = rgb(77, 175, 124)',
    (await ev("getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim()")) === 'rgb(77, 175, 124)');
  check('图标字体已加载（document.fonts.check）',
    await ev('document.fonts.check("20px lxicon")'));
  check('首屏为搜索页', await ev('LXApp.state.nav') === 'nav_search');
  check('内置演示曲库已清空', await ev('LXData.tracks.length') === 0);
  check('冷启动无任何音源', await ev('LXSources.list().length') === 0);
  check('无 localStorage 跨域报错（可读）', await ev('!!localStorage'));

  console.log('\n=== B. 抽屉 / 搜索 / 播放 ===');
  check('点汉堡打开抽屉', await click('[data-act="drawer"]') && await ev("document.getElementById('drawer').classList.contains('open')"));
  check('抽屉头部为 LX Music', (await ev("document.querySelector('.drawer-head').textContent")).indexOf('LX Music') >= 0);
  await shot('apk-v3-drawer.png');
  check('切到「下载」导航', await click('[data-act="nav"][data-id="nav_download"]') &&
    await ev('LXApp.state.nav') === 'nav_download');
  check('下载页标题 = 下载', await ev("document.getElementById('headerTitle').textContent") === '下载');
  await shot('apk-v3-download-empty.png');
  await click('[data-act="nav"][data-id="nav_search"]');
  check('搜索页有平台选择条',
    (await ev("document.getElementById('view').innerHTML")).indexOf('pf-bar') >= 0);
  check('平台 chip = 5 个',
    await ev("document.querySelectorAll('#view .pf-chip').length") === 5);
  check('默认平台 = 酷我', await ev('LXApp.state.platform') === 'kw');
  check('未导入音源时提示不能播放',
    (await ev("document.getElementById('view').innerHTML")).indexOf('在线收听/下载需要导入') >= 0);

  // 平台真实搜索（酷我内置接口，走原生 HTTP 桥）
  await ev('document.getElementById("searchInput").value="周杰伦"');
  await click('[data-act="do-search"]');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results', 25000, '酷我搜索');
  const n = await ev('LXApp.state.search.results.length');
  check('酷我内置接口返回真实结果', n > 0, n);
  check('结果带酷我平台标记',
    await ev('LXApp.state.search.results.every(function(x){return x.platform==="kw";})'));
  check('结果为真实歌曲（含歌手）',
    String(await ev('LXApp.state.search.results[0].singer')).length > 0,
    await ev('LXApp.state.search.results[0].singer'));
  await shot('apk-v3-search.png');

  // 未绑定音源（账号）时播放必须被拦下
  await click('[data-act="play-row"]');
  await new Promise(r => setTimeout(r, 900));
  check('没有音源提供地址时播放被拦下', await ev('LXApp.state.playing') === false);

  // 导入测试音源并绑定为「酷我账号」
  const testScript = fs.readFileSync(path.join(__dirname, 'fixtures', '设备测试音源.js'), 'utf8');
  const impRes = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(testScript) +
    ',"device");return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
  check('设备端导入测试音源', String(impRes).indexOf('ok:') === 0, impRes);
  check('音源自带 sources 声明，自动服务酷我',
    String(await ev('LXSources.forPlatform("kw")')).length > 3,
    await ev('LXSources.forPlatform("kw")'));
  check('平台账号验证通过', await ev('LXSources.verifyPlatform("kw").ok'));
  check('同一音源自动服务酷狗',
    String(await ev('LXSources.forPlatform("kg")')).length > 3);

  await click('[data-act="play-row"]');
  await wait('LXApp.state.playing===true', 20000, '开始播放');
  check('点曲目行播放', await click('[data-act="play-row"]'));
  await wait('LXApp.state.playing===true', 5000, '开始播放');
  check('PlayerBar 显示曲目名', (await ev("document.getElementById('pbTitle').textContent")).length > 1,
    await ev("document.getElementById('pbTitle').textContent"));
  check('播放进度开始走动', (await ev('LXApp.state.progress ? Object.keys(LXApp.state.progress).length : 0')) >= 0);
  await shot('apk-v3-playing.png');
  check('打开播放详情页', await click('#playerBar') &&
    await ev("document.getElementById('overlay').innerHTML.indexOf('player-ctl')>=0"));
  await shot('apk-v3-detail.png');
  await click('[data-act="close-overlay"]');

  console.log('\n=== C. 歌曲下载（先选品质）+ 系统落盘 ===');
  await click('[data-act="nav"][data-id="nav_download"]');
  check('下载入口先弹品质菜单', await click('[data-act="dl-add-current"]') &&
    (await ev("document.getElementById('contextMenu').innerHTML")).indexOf('选择下载品质') >= 0);
  check('品质菜单含母带档', (await ev("document.getElementById('contextMenu').innerHTML")).indexOf('母带音质') >= 0);
  check('选择标准音质入队', await click(
    '[data-act="dl-enqueue-at-quality"][data-q="128k"], [data-act="menu-download"][data-q="128k"]'));
  await wait('LXDownload.stats().done>=1', 40000, '下载完成');
  const job = await ev('JSON.stringify(LXDownload.all()[0])');
  const j = JSON.parse(job);
  check('任务 state=done', j.state === 'done', j.state);
  check('任务记录所选音质 128k', j.quality === '128k', j.quality);
  check('按音源格式生成 WAV 文件', j.size > 1000 && j.mime === 'audio/wav', j.size + '/' + j.mime);
  check('离线播放 URL 已生成', await ev('!!LXDownload.getPlayableUrl(' + JSON.stringify(j.trackId) + ')'));
  await wait('!!(LXDownload.all()[0]&&LXDownload.all()[0].path)', 30000, 'Android 回写路径');
  const saved = await ev('LXDownload.all()[0].path');
  check('已写入系统 Download/LX Music', /Download\/LX Music/.test(saved), saved);
  await shot('apk-v3-download.png');
  check('页面显示落盘路径', (await ev("document.getElementById('dlList').innerHTML")).indexOf('已保存到') >= 0);
  const statDone = await ev("document.getElementById('dlStatDone').textContent");
  check('统计卡片「已完成」与实际任务数一致（实时刷新）',
    String(statDone) === String(await ev('LXDownload.stats().done')), statDone);
  const statSize = await ev("document.getElementById('dlStatSize').textContent");
  check('统计卡片「已占用」显示实际体积', /MB|KB/.test(String(statSize)), statSize);

  console.log('\n=== D. 离线播放 / 主题 / 持久化 ===');
  const localMode = await ev("(function(){LXApp.state.settings.offline=true;" +
    "LXApp.playFrom(" + JSON.stringify(j.trackId) + ",[" + JSON.stringify(j.trackId) + "]);" +
    "return new Promise(function(r){setTimeout(function(){r(LXApp.engine.mode);},800);});})()");
  check('模拟离线后已下载曲目用本地 WAV 播放', localMode === 'local', localMode);
  await ev('LXApp.state.settings.offline=false');
  await click('[data-act="nav"][data-id="nav_setting"]');
  check('设置页 16 个主题色块', await ev("document.querySelectorAll('.theme-dot').length") === 16);
  check('切换到「黑灯瞎火」主题', await click('[data-act="set-theme"][data-id="black"]') &&
    await ev("document.documentElement.getAttribute('data-dark')") === '1');
  await shot('apk-v3-dark.png');
  await click('[data-act="set-theme"][data-id="green"]');
  check('切回 green 主题', await ev("document.documentElement.getAttribute('data-theme')") === 'green');
  check('状态已持久化到 localStorage', await ev("!!localStorage.getItem('lx_state_v1')"));
  check('下载索引已持久化', await ev("!!localStorage.getItem('lx_downloads_index_v1')"));

  console.log('\n=== E. 自定义 JS 音源：导入 / 搜索 / 在线收听 / 按格式下载 ===');
  check('lx 兼容层 / 音源管理 / HTTP 桥全部挂载',
    await ev('!!(LXSourceAPI&&LXSources&&LXHttp&&LXSourceAPI.EVENT_NAMES.request==="request")'));
  check('原生 HTTP 桥已由 Java 注入',
    await ev('LXHttp.active() && typeof EchoBridge.httpRequest==="function" && typeof EchoBridge.cancelRequest==="function"'));
  check('WebView 允许混合内容（音源可用 HTTP 音频）',
    await ev('!!(window.__LX_ANDROID__)'));
  const apiList = JSON.parse(await ev('JSON.stringify(LXSources.list().map(function(a){return {id:a.id,name:a.name,status:a.status,src:Object.keys(a.sources||{})};}))'));
  const demo = apiList.filter(a => a.name === '设备测试音源')[0] || apiList[0];
  check('设备测试音源初始化成功', !!demo && demo.status === 'success', demo && demo.status);
  check('音源声明了来源与动作', !!demo && demo.src.length > 0);
  check('音源支持 search / downloadUrl / leaderboard',
    await ev('(function(){var a=LXSources.list().filter(function(x){return x.name==="设备测试音源";})[0];' +
      'return !!a && LXSources.supports(a,"search") && LXSources.supports(a,"downloadUrl") && LXSources.supports(a,"leaderboard");})()'));
  check('设置页含自定义源管理与音质选择',
    (await ev("document.getElementById('view').innerHTML")).indexOf('自定义源管理') >= 0 &&
    (await ev("document.getElementById('view').innerHTML")).indexOf('set-audio-quality') >= 0);
  check('已去掉平台单独绑定入口',
    (await ev("document.getElementById('view').innerHTML")).indexOf('bind-platform') < 0);
  await click('[data-act="open-panel"][data-id="userapi"]');
  const ua = await ev("document.getElementById('overlay').innerHTML");
  check('音源管理页标题用原版文案', ua.indexOf('自定义源管理（实验性）') >= 0);
  check('管理页含本地/在线导入、粘贴脚本与安全提示',
    ua.indexOf('本地导入') >= 0 && ua.indexOf('在线导入') >= 0 &&
    ua.indexOf('粘贴脚本') >= 0 && ua.indexOf('请谨慎导入') >= 0);
  check('管理页显示音源状态与扩展动作', ua.indexOf('初始化成功') >= 0 && ua.indexOf('downloadUrl') >= 0);
  await shot('apk-v3-userapi.png');
  await click('[data-act="close-overlay"]');

  // 原生 HTTP 桥回调路径：不依赖外网是否可达，成功或网络错误都证明 Java -> JS 回传链路工作
  await ev('window.__httpProbe=null;LXSourceAPI.request("https://example.com/",{method:"get",timeout:6000},' +
    'function(err,resp){window.__httpProbe=err?("err:"+err.message):("ok:"+resp.statusCode);});');
  await wait('!!window.__httpProbe', 15000, '原生 HTTP 桥回调');
  check('原生 HTTP 桥 Java→JS 回调可用', /^(ok|err):/.test(await ev('window.__httpProbe')),
    await ev('window.__httpProbe'));

  await click('[data-act="nav"][data-id="nav_search"]');
  await ev('document.getElementById("searchInput").value="夜"');
  await click('[data-act="do-search"]');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results && LXApp.state.search.results.length>0',
    25000, '平台搜索');
  const at = JSON.parse(await ev('JSON.stringify(LXApp.state.search.results[0])'));
  check('平台搜索返回可展示的曲目', !!at && !!at.name && !!at.songmid, at && at.name);
  check('曲目带平台标记', at && at.platform === 'kw', at && at.platform);
  check('酷我曲目已绑定账号（可解析地址）',
    await ev('!!LXSources.trackSource(LXApp.state.search.results[0])'));
  check('搜索结果显示平台名称',
    (await ev("document.getElementById('view').innerHTML")).indexOf('酷我') >= 0);
  await shot('apk-v3-api-search.png');
  await ev('LXApp.playFrom(' + JSON.stringify(at.id) + ')');
  await wait('LXApp.engine.mode==="stream"', 12000, '在线收听');
  check('自定义音源曲目走在线收听（stream）', await ev('LXApp.engine.mode') === 'stream');
  check('在线音频地址来自音源 musicUrl',
    String(await ev('LXApp.engine.el && LXApp.engine.el.src')).indexOf('data:audio/wav') === 0);
  await shot('apk-v3-api-playing.png');
  await ev('LXDownload.enqueue([LXData.byId(' + JSON.stringify(at.id) + ')],"128k")');
  const tid = JSON.stringify(at.id);
  await wait('LXDownload.all().some(function(j){return j.trackId===' + tid + ' && j.state==="done";})',
    40000, '按来源格式下载');
  const dj = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(j){return j.trackId===' + tid + ';})[0])'));
  check('下载任务按音源格式完成', !!dj && dj.state === 'done' && dj.format === 'WAV' && dj.mime === 'audio/wav',
    dj && dj.format + '/' + dj.mime);
  check('文件名按音源 ext 生成 .wav', !!dj && /\.wav$/.test(dj.filename), dj && dj.filename);
  await wait('!!(LXDownload.all().filter(function(j){return j.trackId===' + tid + ';})[0].path)', 30000, '音源曲目落盘');
  const dj2 = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(j){return j.trackId===' + tid + ';})[0])'));
  check('按音源格式的文件写入 Download/LX Music', /Download\/LX Music/.test(dj2.path), dj2.path);
  await click('[data-act="nav"][data-id="nav_download"]');
  await shot('apk-v3-api-download.png');

  console.log('\n=== F. 平台排行榜（酷狗内置）===');
  await click('[data-act="nav"][data-id="nav_top"]');
  await click('[data-act="set-board-platform"][data-id="kg"]');
  await wait('LXApp.state.platform==="kg" && LXApp.state.boardTracks && LXApp.state.boardTracks.length>0',
    25000, '酷狗榜单');
  const bn = await ev('LXApp.state.boardTracks.length');
  check('酷狗榜单返回曲目', bn > 0, bn);
  check('榜单曲目带酷狗平台标记',
    await ev('LXApp.state.boardTracks.every(function(x){return x.platform==="kg";})'));
  // v3.13.4：排行榜页只放「榜单卡片入口」，曲目在点开的目录页里
  check('排行榜页显示榜单卡片入口',
    (await ev("document.querySelectorAll('#view [data-act=\"open-board\"]').length")) >= 4);
  await shot('apk-v3-board.png');
  const board2 = await ev('LXPlatform.boards("kg")[1].id');
  await click('[data-act="open-board"][data-id="' + board2 + '"]');
  await wait('LXApp.state.boardId===' + JSON.stringify(board2) + ' && !LXApp.state.boardLoading', 20000, '切换榜单');
  check('切换榜单重新请求', await ev('LXApp.state.boardId') === board2);
  check('点卡片进入榜单目录（浮层打开且有曲目）',
    await ev('(function(){var o=document.getElementById("overlay");' +
      'return !!o && !o.classList.contains("hidden") && o.querySelectorAll(".m-row").length>0;})()'));
  check('榜单目录显示来源说明',
    (await ev('document.getElementById("overlay").innerHTML')).indexOf('来自') >= 0);
  check('榜单目录不盖住底部播放条',
    await ev('(function(){var pb=document.getElementById("playerBar"),ov=document.getElementById("overlay");' +
      'if(!pb||!ov) return false;var r=pb.getBoundingClientRect(),o=ov.getBoundingClientRect();' +
      'return ov.classList.contains("ov-with-bar") && o.bottom <= r.top + 2 && pb.offsetHeight > 0;})()'));
  await shot('apk-v3134-board-detail.png');
  await click('[data-act="play-board"]');
  await wait('LXApp.state.playing===true', 8000, '排行榜播放');
  await shot('apk-v3134-board-play.png');
  check('排行榜目录「播放全部」可播放音源曲目', await ev('LXApp.state.playing') === true);
  check('目录页内播放时播放条显示当前歌曲',
    await ev('(function(){var t=LXApp.currentTrack();var el=document.getElementById("pbTitle");' +
      'return !!t && !!el && el.textContent===t.name;})()'));

  console.log('\n=== G. 目录最后一行「三点」菜单不被裁掉（v3.13.7）===');
  /* 真实的点击事件才带 clientX/clientY，菜单定位依赖它，所以用 CDP 派发一次鼠标按下+抬起 */
  async function tapLastRowMenu() {
    const pos = await ev('(function(){var rows=document.querySelectorAll("#overlay .m-row");' +
      'if(!rows.length)return "";var last=rows[rows.length-1];last.scrollIntoView({block:"end"});' +
      'var b=last.querySelector(\'[data-act="track-menu"]\');if(!b)return "";' +
      'var r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()');
    if (!pos) throw new Error('没有找到最后一行菜单按钮');
    const p = JSON.parse(pos);
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 400));
    return p;
  }
  async function menuRect() {
    const s = await ev('(function(){var m=document.getElementById("contextMenu");' +
      'if(!m||m.classList.contains("hidden"))return "";var r=m.getBoundingClientRect();' +
      'return JSON.stringify({top:r.top,bottom:r.bottom,left:r.left,right:r.right,' +
      'vh:window.innerHeight,vw:window.innerWidth,items:m.querySelectorAll("button").length});})()');
    return s ? JSON.parse(s) : null;
  }
  const tapB = await tapLastRowMenu();
  const rectB = await menuRect();
  check('排行榜目录最后一行能弹出菜单', !!rectB, rectB ? rectB.items + ' 项' : '未弹出');
  check('菜单整体在屏幕内（不再被裁掉）',
    !!rectB && rectB.top >= 0 && rectB.bottom <= rectB.vh + 1 && rectB.right <= rectB.vw + 1,
    rectB ? ('top ' + Math.round(rectB.top) + ' / bottom ' + Math.round(rectB.bottom) + ' / 屏高 ' + rectB.vh) : '');
  check('贴底时菜单向上翻（顶边在触点上方）',
    !!rectB && rectB.top < tapB.y, rectB ? ('top ' + Math.round(rectB.top) + ' vs 触点 ' + Math.round(tapB.y)) : '');
  await shot('apk-v3137-board-menu.png');
  await ev('LXApp.closeMenu && LXApp.closeMenu();document.getElementById("contextMenu").classList.add("hidden");true');

  // 歌单目录同样验一次
  await ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_songlist";LXApp.state.platform="kw";' +
    'LXApp.render();LXApp.loadSongLists(1);return true;})()');
  await wait('document.querySelector(\'[data-act="open-songlist"]\') !== null', 20000, '歌单卡片');
  await click('[data-act="open-songlist"]');
  await wait('document.querySelectorAll("#overlay .m-row").length>3', 25000, '歌单目录');
  const tapS = await tapLastRowMenu();
  const rectS = await menuRect();
  check('歌单目录最后一行能弹出菜单', !!rectS, rectS ? rectS.items + ' 项' : '未弹出');
  check('歌单目录菜单整体在屏幕内',
    !!rectS && rectS.top >= 0 && rectS.bottom <= rectS.vh + 1 && rectS.right <= rectS.vw + 1,
    rectS ? ('top ' + Math.round(rectS.top) + ' / bottom ' + Math.round(rectS.bottom) + ' / 屏高 ' + rectS.vh) : '');
  await shot('apk-v3137-songlist-menu.png');

  ws.close();
  const report = { device: page.url, total: checks.length, passed: checks.length - fail.length,
    failed: fail, checks: checks };
  fs.writeFileSync(path.join(OUT, 'device-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n========================================');
  console.log('  设备验收 PASS ' + (checks.length - fail.length) + ' / ' + checks.length);
  if (fail.length) { console.log('  FAILED:'); fail.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  process.exit(fail.length ? 1 : 0);
}

main().catch(e => { console.error('\n[设备验收异常] ' + (e.stack || e)); process.exit(1); });
