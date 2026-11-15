/* 设备端验收（v3.12.0）：设置页「下载目录」可选，且下载真的落到所选目录
 *
 * 关键点：不只是断言设置存下来了，而是真的下载一首歌，然后核对
 *   1) 下载任务回报的 path 前缀 = 所选目录；
 *   2) 宿主机 adb 能看到该目录下的文件（证据交给调用方 run-dlpath-check.ps1）。
 *
 * 用法：node evidence/device-dlpath-check.js [--persist]
 *   --persist：不重跑下载，只核对重启后设置仍然生效（配合外层重启应用）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, 'device-dlpath-check.json');
const AUDIO = 'http://10.0.2.2:8080/test-audio.wav';
const PERSIST = process.argv.indexOf('--persist') >= 0;

const SCRIPT = `
/**
 * @name 设备下载目录源
 * @description 固定返回同一个 wav，用于验收落盘目录
 * @version 1.0.0
 * @author qa
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const AUDIO = '${AUDIO}'
on(EVENT_NAMES.request, ({ action, info }) => {
  if (action === 'downloadUrl' || action === 'musicUrl') {
    return Promise.resolve({ url: AUDIO, mime: 'audio/wav', ext: 'wav',
      filename: '目录测试 - 歌手.wav' })
  }
  if (action === 'lyric') return Promise.resolve({ lyric: '[00:00]测试歌词' })
  return Promise.reject(new Error('unsupported action: ' + action))
})
send(EVENT_NAMES.inited, { sources: {
  kw: { name: '设备目录源', type: 'music', actions: ['musicUrl', 'downloadUrl', 'lyric'],
    qualitys: ['128k', '320k'] }
} })
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
  const clickNth = async (sel, i) => ev(`(function(){var n=document.querySelectorAll(${JSON.stringify(sel)})[${i}];
    if(!n) return false; n.click(); return true;})()`);
  const shot = async name => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64'));
  };
  /* 用真实 change 事件改下拉，走的就是用户点选的同一条路径 */
  const pickDir = async v => ev(`(function(){var s=document.querySelector('[data-act="dl-path"]');
    if(!s) return 'no-select'; s.value=${JSON.stringify(v)};
    s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  // 冷启动后 WebView 的脚本是异步加载的，先等 LXApp / LXDownload 就绪再断言
  await wait('typeof LXApp!=="undefined" && typeof LXDownload!=="undefined" && ' +
    'typeof LXDownload.dirOf==="function"', 25000, '页面脚本就绪');

  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']'));
  };

  if (PERSIST) {
    console.log('\n=== E. 重启后设置仍然生效 ===');
    await ev('LXApp.state.nav="nav_setting";LXApp.render();');
    const dir = await ev('LXApp.state.settings.downloadDir');
    check('重启后下载目录仍是上次选的（设置已落盘）', dir === 'Download/我的音乐', dir);
    const opts = await ev('LXDownload.opts.dir');
    check('下载队列启动时回填了该目录', opts === 'Download/我的音乐', opts);
    const html = await ev("document.getElementById('view').innerHTML");
    check('设置页仍显示自定义目录',
      html.indexOf('自定义目录…') >= 0 && html.indexOf('Download/我的音乐') >= 0);
    const desc = /保存到 \/storage\/emulated\/0\/([^（]+)/.exec(html || '');
    check('行内展示的完整路径同步为自定义目录',
      desc && desc[1] === 'Download/我的音乐', desc && desc[1]);
  } else {
    console.log('\n=== A. 设置页出现「下载目录」 ===');
    await ev('LXApp.state.nav="nav_setting";LXApp.render();');
    const html = await ev("document.getElementById('view').innerHTML");
    check('设置页有「下载目录」一行', html.indexOf('下载目录') >= 0);
    check('是可点选的下拉', html.indexOf('data-act="dl-path"') >= 0);
    const cur = await ev('LXApp.state.settings.downloadDir');
    check('默认 Download/LX Music', cur === 'Download/LX Music', cur);
    check('行内展示完整路径', html.indexOf('/storage/emulated/0/Download/LX Music') >= 0);

    console.log('\n=== B. 切到 Music/LX Music 并真的下载一首 ===');
    const picked = await pickDir('Music/LX Music');
    check('下拉可选到 Music/LX Music', picked === 'Music/LX Music', picked);
    const d1 = await ev('LXApp.state.settings.downloadDir');
    check('设置写入 Music/LX Music', d1 === 'Music/LX Music', d1);
    const o1 = await ev('LXDownload.opts.dir');
    check('下载队列立刻改用新目录', o1 === 'Music/LX Music', o1);
    await shot('apk-v312-dlpath.png');

    await ev('(function(){LXSources.list().forEach(function(a){LXSources.remove(a.id);});' +
      'LXDownload.all().forEach(function(j){LXDownload.remove(j.id);});return true;})()');
    const imp = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(SCRIPT) +
      ',"device");if(r.ok&&r.api&&r.api.id)LXSources.setDefault(r.api.id);' +
      'return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
    check('导入下载目录测试源', String(imp).indexOf('ok:') === 0, imp);

    await ev('LXApp.state.nav="nav_search";LXApp.state.platform="kw";LXApp.render();');
    await ev('(function(){var i=document.getElementById("searchInput");if(i)i.value="测试";return true;})()');
    await click('[data-act="do-search"]');
    await wait('!LXApp.state.search.searching && LXApp.state.search.results && ' +
      'LXApp.state.search.results.length>0', 25000, '酷我搜索');
    check('搜到结果', (await ev('LXApp.state.search.results.length')) > 0);

    await click('[data-act="track-menu"]');
    await click('[data-act="menu-download-q"]');
    await click('[data-act="menu-download"][data-q="320k"]');
    const tid = await ev('LXApp.state.search.results[0].id');
    await wait('(function(){var j=LXDownload.all().filter(function(x){return x.trackId===' +
      JSON.stringify(tid) + ';})[0];return j&&j.state==="done";})()', 40000, '第一首下载完成');
    const job1 = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(x){return x.trackId===' +
      JSON.stringify(tid) + ';})[0])'));
    check('下载完成', job1.state === 'done', job1.state);
    check('落盘路径前缀 = Music/LX Music',
      /^Music\/LX Music\//.test(job1.path || ''), job1.path);

    console.log('\n=== C. 自定义目录 Download/我的音乐 ===');
    // 上一步为了下载已切到搜索页，这里先回到设置页才有「下载目录」下拉
    await ev('LXApp.state.nav="nav_setting";LXApp.render();');
    await pickDir('__custom');
    const modal = await ev("document.getElementById('modalRoot').innerHTML");
    check('选「自定义」弹出输入框', modal.indexOf('id="dlPathInput"') >= 0);
    await ev('(function(){var i=document.getElementById("dlPathInput");if(i)i.value="我的音乐";return true;})()');
    await click('[data-act="dl-path-apply"]');
    const d2 = await ev('LXApp.state.settings.downloadDir');
    check('只写子目录自动归到 Download 下', d2 === 'Download/我的音乐', d2);
    const o2 = await ev('LXDownload.opts.dir');
    check('下载队列同步自定义目录', o2 === 'Download/我的音乐', o2);
    const html2 = await ev("document.getElementById('view').innerHTML");
    check('设置页显示自定义目录',
      html2.indexOf('自定义目录…') >= 0 && html2.indexOf('Download/我的音乐') >= 0);
    await shot('apk-v312-dlpath-custom.png');

    const t2 = await ev('LXApp.state.search.results[1] ? LXApp.state.search.results[1].id : ' +
      'LXApp.state.search.results[0].id');
    // 回搜索页，点第二行的菜单按钮（每行各有一个 track-menu，别点到第一行）
    await ev('LXApp.state.nav="nav_search";LXApp.render();');
    const idx = await ev('LXApp.state.search.results[1] ? 1 : 0');
    await clickNth('[data-act="track-menu"]', idx);
    await click('[data-act="menu-download-q"]');
    await click('[data-act="menu-download"][data-q="320k"]');
    await wait('(function(){var j=LXDownload.all().filter(function(x){return x.trackId===' +
      JSON.stringify(t2) + ';})[0];return j&&j.state==="done";})()', 40000, '第二首下载完成');
    const job2 = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(x){return x.trackId===' +
      JSON.stringify(t2) + ';})[0])'));
    check('自定义目录下载完成', job2.state === 'done', job2.state);
    check('落盘路径前缀 = Download/我的音乐',
      /^Download\/我的音乐\//.test(job2.path || ''), job2.path);

    console.log('\n=== D. 非法路径不越权 ===');
    const bad = await ev('LXApp.setDlPath("../etc")');
    check('带 ../ 的路径被拒绝并回默认', bad === 'Download/LX Music', bad);
    const bad2 = await ev('LXApp.setDlPath("Download/" + new Array(90).join("x"))');
    check('超长路径被拒绝并回默认', bad2 === 'Download/LX Music', bad2);
    await ev('LXApp.setDlPath("Download/我的音乐")');   // 留作重启验证

    results.push({ name: 'PATHS', ok: true, extra: JSON.stringify({ p1: job1.path, p2: job2.path }) });
  }

  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), persist: PERSIST, results: results
  }, null, 2));

  const fails = results.filter(r => !r.ok);
  console.log('\n========================================================');
  if (fails.length) { console.log('FAILED: ' + fails.length + ' / ' + results.length); process.exit(1); }
  console.log('全部通过   ' + results.length + ' / ' + results.length);
  ws.close();
}

main().catch(e => { console.error('\n[异常] ' + (e && e.stack || e)); process.exit(1); });
