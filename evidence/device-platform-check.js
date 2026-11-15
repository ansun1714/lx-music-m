/* 设备端验收：平台排行榜 / 在线歌单 / 系统返回键 / 音频代理（v3.9.0）
 * 前置：模拟器已启动、APK 已打开；由 shell 先执行 adb forward。
 * 用法：node evidence/device-platform-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.resolve(__dirname, '..', 'evidence');
const ADB = process.env.ADB || 'C:/Users/maoxu/tools/android-sdk/platform-tools/adb.exe';
const SERIAL = process.env.SERIAL || 'emulator-5554';

const fail = [];
let total = 0;
function check(name, cond, detail) {
  total += 1;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  if (!cond) fail.push(name);
}
function adb(args) {
  return execSync(`"${ADB}" -s ${SERIAL} ${args}`, { encoding: 'utf8' }).trim();
}

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 调试页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
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
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
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
  async function until(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(fn);
      if (v) return v;
      await new Promise(r => setTimeout(r, 400));
    }
    return '';
  }

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  // 冷启动后 WebView 还要加载并执行 13 个脚本，先等全局对象就绪
  for (let i = 0; i < 50; i++) {
    const ready = await ev('!!(window.LXApp&&window.LXPlatform&&window.LXApp.loadBoard)');
    if (ready) break;
    await new Promise(r => setTimeout(r, 400));
  }
  check('页面脚本已就绪（LXApp / LXPlatform）',
    await ev('!!(window.LXApp&&window.LXPlatform)'));

  // ---------------------------------------------------------------- A. 排行榜
  console.log('\n=== A. 五个平台的排行榜 ===');
  for (const pf of ['kw', 'kg', 'mg', 'wy', 'tx']) {
    const name = await ev(`LXPlatform.nameOf('${pf}')`);
    const n = await ev(`LXPlatform.boards('${pf}').length`);
    check(`${name} 榜单目录非空`, n > 0, n + ' 个');
    await ev(`(function(){
      LXApp.state.platform='${pf}';
      LXApp.state.boardId=LXPlatform.boards('${pf}')[0].id;
      LXApp.state.boardTracks=null;
      LXApp.state.boardNote='';
      LXApp.state.nav='nav_top';
      LXApp.loadBoard();
      return true;
    })()`);
    const got = await until(`(function(){
      var s=LXApp.state;
      if(s.boardLoading) return '';
      return (s.boardTracks&&s.boardTracks.length) ? String(s.boardTracks.length) : '';
    })()`, 25000, pf);
    const first = await ev(`(function(){
      var t=LXApp.state.boardTracks&&LXApp.state.boardTracks[0];
      return t? (t.name+' - '+t.singer+' ('+t.time+')') : '';
    })()`);
    check(`${name} 榜单取到曲目`, Number(got) > 0, got ? got + ' 首 · ' + first : '空');
    if (pf === 'wy' || pf === 'tx') await shot(`apk-v39-board-${pf}.png`);
  }

  // ---------------------------------------------------------------- B. 歌单
  console.log('\n=== B. 五个平台的推荐歌单 ===');
  for (const pf of ['kw', 'kg', 'mg', 'wy', 'tx']) {
    const name = await ev(`LXPlatform.nameOf('${pf}')`);
    const info = await ev(`(async function(){
      try {
        var r = await LXPlatform.recommendLists('${pf}', 1);
        var l = r.lists[0];
        if (!l) return { n: 0, note: r.note || '' };
        var d = await LXPlatform.listDetail('${pf}', l.id);
        return { n: r.lists.length, name: l.name, id: l.id, songs: d.tracks.length,
                 first: d.tracks[0] ? d.tracks[0].name + ' - ' + d.tracks[0].singer : '' };
      } catch (e) { return { err: String(e && e.message || e) }; }
    })()`);
    check(`${name} 推荐歌单非空`, info && info.n > 0, info && info.err ? info.err : `${info.n} 个 · ${info.name || ''}`);
    check(`${name} 歌单详情有曲目`, info && info.songs > 0,
      info && info.err ? info.err : `${info.songs} 首 · ${info.first || ''}`);
  }

  // 界面上点开第一张歌单，确认浮层渲染了真实曲目
  await ev(`(function(){
    LXApp.state.platform='kw'; LXApp.state.nav='nav_songlist';
    LXApp.loadSongLists(1); return true;
  })()`);
  await until(`!!(document.querySelector('#view [data-act="open-songlist"]'))`, 20000, 'songlist cards');
  const cards = await ev(`document.querySelectorAll('#view [data-act="open-songlist"]').length`);
  check('歌单页渲染出歌单卡片', cards > 0, cards + ' 张');
  await ev(`document.querySelector('#view [data-act="open-songlist"]').click()`);
  const rows = await until(`document.querySelectorAll('#overlay .m-row').length`, 25000, 'playlist rows');
  check('歌单详情浮层显示曲目', Number(rows) > 0, rows + ' 行');
  // v3.13.4：歌单目录也要把底部播放条留在页面上（上下滑列表不消失）
  check('歌单目录不盖住底部播放条',
    await ev('(function(){var o=document.getElementById("overlay"),pb=document.getElementById("playerBar");' +
      'if(!o||!pb) return false;var or=o.getBoundingClientRect(),pr=pb.getBoundingClientRect();' +
      'return o.classList.contains("ov-with-bar") && or.bottom <= pr.top + 2 && pb.offsetHeight > 0;})()'));
  await shot('apk-v39-songlist.png');
  await shot('apk-v3134-songlist.png');
  await ev(`LXApp.closeOverlay()`);

  // ---------------------------------------------------------------- C. 返回键
  console.log('\n=== C. 系统返回键 ===');
  adb('start-server');
  adb('shell echo ready');           // 预热：adbd 首次调用会重启 daemon，keyevent 会因此延迟
  await ev(`(function(){ LXApp.state.nav='nav_setting'; LXApp.render(); return true; })()`);
  check('准备工作：当前在设置页', await ev('LXApp.state.nav') === 'nav_setting');
  adb('shell input keyevent 4');
  const backOk = await until(`LXApp.state.nav==='nav_search'`, 6000, 'back to search');
  check('返回键：设置页 → 搜索主页', !!backOk, await ev('LXApp.state.nav'));
  const alive = adb(`shell pidof com.lxmusic.replica`);
  check('返回键后应用仍在运行（没有直接退出）', !!alive, alive);

  await ev(`(function(){ LXApp.state.nav='nav_top'; LXApp.render(); return true; })()`);
  adb('shell input keyevent 4');
  check('返回键：排行榜 → 搜索主页',
    !!await until(`LXApp.state.nav==='nav_search'`, 6000, 'back from top'));

  await ev(`LXApp.openOverlay('effects')`);
  adb('shell input keyevent 4');
  check('返回键：先关闭浮层',
    !!await until(`LXApp.state.overlay===null`, 6000, 'back close overlay'),
    await ev('LXApp.state.overlay'));

  await ev(`(function(){
    LXApp.state.overlay=null; LXApp.state.search.results=null; LXApp.state.search.text='';
    LXApp.state.search.apiNote=''; LXApp.state.nav='nav_search'; LXApp.render(); return true;
  })()`);
  check('搜索主页无内容时不消费返回键（交给系统退出）', await ev('LXApp.handleBack()') === false);

  // ---------------------------------------------------------------- D. 音频代理
  console.log('\n=== D. 音频代理（音效跨域修复）===');
  const base = await ev('(EchoBridge.mediaProxyBase ? EchoBridge.mediaProxyBase() : "")');
  check('原生桥提供代理前缀', /\/__media$/.test(base || ''), base);
  const wrapped = await ev(`LXMediaProxy.wrap('https://cdn.example.com/a.mp3')`);
  check('JS 侧生成同源代理地址', String(wrapped).indexOf((base || '') + '?u=') === 0, String(wrapped).slice(0, 70));
  // 真正走一次代理，确认能取到远端字节且带 Range 支持
  const proxied = await ev(`(async function(){
    var u = LXMediaProxy.wrap('https://www.baidu.com/robots.txt');
    try {
      var r = await fetch(u, { headers: { Range: 'bytes=0-1023' } });
      var t = await r.text();
      return { status: r.status, len: t.length, ar: r.headers.get('accept-ranges'), cr: r.headers.get('content-range') };
    } catch (e) { return { err: String(e && e.message || e) }; }
  })()`);
  check('代理能转发远端字节', proxied && (proxied.status === 200 || proxied.status === 206),
    JSON.stringify(proxied));
  check('代理支持 Range（进度条可拖动）', proxied && proxied.ar === 'bytes', proxied && proxied.ar);
  check('代理返回 Content-Range', proxied && !!proxied.cr, proxied && proxied.cr);

  console.log('\n========================================');
  console.log(`  设备分项验收 PASS ${total - fail.length} / ${total}`);
  if (fail.length) { console.log('  FAILED:'); fail.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  ws.close();
  process.exit(fail.length ? 1 : 0);
}

main().catch(e => { console.error('\n[验收异常] ' + (e && e.stack || e)); process.exit(1); });
