/* 设备端验收：歌曲隐藏菜单 → 下载 → 选择品质（最高母带）
 *
 * 用宿主机本地 HTTP 服务（模拟器经 10.0.2.2）提供音频，音源按 info.type 返回不同文件名，
 * 以此证明「用户选的品质确实传到了音源并被使用」，而不是固定档位。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, 'device-quality-check.json');
const AUDIO = 'http://10.0.2.2:8080/test-audio.wav';

const SCRIPT = `
/**
 * @name 设备音质源
 * @description 按请求品质返回不同文件，用于验收音质选择
 * @version 1.0.0
 * @author qa
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const AUDIO = '${AUDIO}'
function pack(t) {
  return {
    url: AUDIO, mime: 'audio/wav', ext: 'wav',
    filename: String(t || 'default').toUpperCase() + '测试 - 歌手.wav'
  }
}
on(EVENT_NAMES.request, ({ action, info }) => {
  const t = String((info && info.type) || '')
  if (action === 'downloadUrl' || action === 'musicUrl') return Promise.resolve(pack(t))
  if (action === 'lyric') return Promise.resolve({ lyric: '[00:00]测试歌词' })
  return Promise.reject(new Error('unsupported action: ' + action))
})
const ACTIONS = ['musicUrl', 'downloadUrl', 'lyric']
const QUALITYS = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']
send(EVENT_NAMES.inited, {
  sources: {
    kw: { name: '设备音质源', type: 'music', actions: ACTIONS, qualitys: QUALITYS },
    kg: { name: '设备音质源', type: 'music', actions: ACTIONS, qualitys: QUALITYS }
  }
})
`;

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 页面，先 adb forward tcp:9222');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let seq = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params) => new Promise(r => {
    const id = ++seq; pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails.exception || {}));
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      if (await ev(expr)) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('等待超时：' + (label || expr));
  };
  const click = async sel => ev(`(function(){var n=document.querySelector(${JSON.stringify(sel)});
    if(!n) return false; n.click(); return true;})()`);

  await cmd('Runtime.enable');
  await cmd('Page.enable');

  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']'));
  };

  console.log('\n=== A. 数据与音源 ===');
  // 冷启动后页面脚本是异步加载的，等齐再断言（否则会撞上 LXDownload 还没就绪）
  await wait('typeof LXApp!=="undefined" && typeof LXDownload!=="undefined" && ' +
    'typeof LXSources!=="undefined" && typeof LXData!=="undefined"', 25000, '页面脚本就绪');
  check('内置曲库为空', await ev('LXData.tracks.length') === 0);
  await ev('(function(){LXSources.list().forEach(function(a){LXSources.remove(a.id);});return true;})()');
  // 上一次验收可能留下同名曲目的下载任务，不清掉会读到旧任务的档位
  await ev('(function(){LXDownload.all().forEach(function(j){LXDownload.remove(j.id);});return true;})()');
  const imp = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(SCRIPT) +
    ',"device");if(r.ok&&r.api&&r.api.id)LXSources.setDefault(r.api.id);' +
    'return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
  check('导入设备音质源', String(imp).indexOf('ok:') === 0, imp);
  check('音源服务酷我平台', String(await ev('LXSources.forPlatform("kw")')).length > 3);

  console.log('\n=== B. 平台搜索 ===');
  await ev('LXApp.state.nav="nav_search";LXApp.state.platform="kw";LXApp.render();');
  await ev('(function(){var i=document.getElementById("searchInput");if(i)i.value="周杰伦";return true;})()');
  await click('[data-act="do-search"]');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results && LXApp.state.search.results.length>0',
    25000, '酷我搜索');
  const n = await ev('LXApp.state.search.results.length');
  check('酷我返回真实结果', n > 0, n);

  console.log('\n=== C. 歌曲菜单 → 下载 → 选品质 ===');
  check('歌曲行有隐藏菜单按钮', await click('[data-act="track-menu"]'));
  const mainMenu = await ev("document.getElementById('contextMenu').innerHTML");
  check('主菜单「下载…」', mainMenu.indexOf('下载…') >= 0, mainMenu.slice(0, 120));
  check('点「下载…」打开品质菜单', await click('[data-act="menu-download-q"]'));
  const qMenu = await ev("document.getElementById('contextMenu').innerHTML");
  check('品质菜单含母带音质', qMenu.indexOf('母带音质') >= 0);
  const qCount = await ev("document.querySelectorAll('#contextMenu [data-q]').length");
  check('品质菜单 9 档', qCount === 9, qCount);
  check('品质菜单显示档位代号', /MASTER/.test(qMenu) || /master/.test(qMenu));
  check('品质菜单有返回项', qMenu.indexOf('返回') >= 0);
  const shotA = 'apk-v3-quality-menu.png';
  await cmd('Page.captureScreenshot', {}).then(async r => {
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(__dirname, shotA), Buffer.from(r.result.data, 'base64'));
    }
  });

  // 选母带
  const tid = await ev('LXApp.state.search.results[0].id');
  await ev('LXApp.state.search.results[0].qualitys=' +
    JSON.stringify(['128k', '320k', 'flac', 'flac24bit', 'hires', 'master']));
  await click('[data-act="menu-download"][data-q="master"]');
  const job = JSON.parse(await ev('JSON.stringify((LXDownload.all().filter(function(j){return j.trackId===' +
    JSON.stringify(tid) + ';})[0])||null)'));
  check('按母带入队', !!job && job.quality === 'master', job && job.quality);
  await wait('(function(){var j=LXDownload.all().filter(function(x){return x.trackId===' +
    JSON.stringify(tid) + ';})[0];return j && (j.state==="running"||j.state==="done");})()', 25000, '母带下载');
  await wait('(function(){var j=LXDownload.all().filter(function(x){return x.trackId===' +
    JSON.stringify(tid) + ';})[0];return j && j.state==="done";})()', 60000, '母带下载完成');
  const done = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(x){return x.trackId===' +
    JSON.stringify(tid) + ';})[0])'));
  check('下载完成', done.state === 'done', done.state);
  check('文件名来自母带请求', /MASTER/.test(done.filename || ''), done.filename);
  check('实际交付音质 = master', done.deliveredQuality === 'master', done.deliveredQuality);

  console.log('\n=== D. 下载页显示与切档 ===');
  await ev('LXApp.state.nav="nav_download";LXApp.render();');
  await new Promise(r => setTimeout(r, 600));
  const dlHtml = await ev("document.getElementById('view').innerHTML");
  check('下载页显示母带音质', dlHtml.indexOf('母带音质') >= 0);
  check('下载页音质下拉含母带', /value="master"/.test(dlHtml));
  await cmd('Page.captureScreenshot', {}).then(async r => {
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(__dirname, 'apk-v3-download-master.png'), Buffer.from(r.result.data, 'base64'));
    }
  });

  // 换 320k 再下一次，验证选档真的生效
  await ev('LXApp.state.nav="nav_search";LXApp.render();');
  await new Promise(r => setTimeout(r, 400));
  await ev('(function(){var t=LXData.byId(' + JSON.stringify(tid) + ');' +
    'LXDownload.remove(LXDownload.all().filter(function(j){return j.trackId===t.id;})[0].id);return true;})()');
  await ev('document.querySelector(\'[data-act="track-menu"]\').click();');
  await ev('document.querySelector(\'[data-act="menu-download-q"]\').click();');
  await click('[data-act="menu-download"][data-q="320k"]');
  await wait('(function(){var j=LXDownload.all().filter(function(x){return x.trackId===' +
    JSON.stringify(tid) + ';})[0];return j && j.state==="done";})()', 60000, '320k 下载');
  const done2 = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(x){return x.trackId===' +
    JSON.stringify(tid) + ';})[0])'));
  check('320k 请求生效', /320K/.test(done2.filename || ''), done2.filename);
  check('320k 交付音质 = 320k', done2.deliveredQuality === '320k', done2.deliveredQuality);

  ws.close();
  const passed = results.filter(r => r.ok).length;
  const report = { device: page.url, passed, total: results.length, failed: results.length - passed, results };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n' + passed + ' / ' + results.length + ' 通过，报告：' + OUT);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('[失败]', e && e.message || e); process.exit(1); });
