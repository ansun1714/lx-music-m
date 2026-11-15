/* 网易云 / QQ 音乐搜索专项验收（v3.6.0）
 * 用真实音源脚本（evidence/fixtures/星海音乐源v2.3.19.js）在模拟器里验证：
 * 1) 脚本 sources 声明 wy/tx 后被平台识别为「账号」
 * 2) 网易 eapi 加密搜索、QQ musics.fcg + zzcSign 搜索能拿到真实曲目
 * 3) 搜到的曲目能交给音源解析地址并在线收听
 * 4) 按所选品质下载
 * 前置：APK 已安装并冷启动；adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
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
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('等待超时: ' + label);
  }
  const click = sel => ev("(function(){var e=document.querySelector(" + JSON.stringify(sel) +
    ");if(!e)return false;e.click();return true;})()");

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  console.log('\n=== A. 加密模块与平台能力 ===');
  check('LXNetCrypto 已挂载', await ev('!!window.LXNetCrypto'));
  check('SHA1 在设备上执行正确',
    await ev('LXNetCrypto.sha1("abc")') === 'a9993e364706816aba3e25717850c26c9cd0d89d',
    await ev('LXNetCrypto.sha1("abc")'));
  check('AES-128-ECB 在设备上执行正确',
    await ev('LXNetCrypto.aesEcbHex("hello","e82ckenh8dichen8")') === '3329CABA8FB561FF0086A5823D14F529',
    await ev('LXNetCrypto.aesEcbHex("hello","e82ckenh8dichen8")'));
  check('zzcSign 在设备上执行正确',
    await ev('LXNetCrypto.zzcSign(\'{"a":1}\')') === 'zzc7746109xq501htmv4ipz7c8owlxfpihjm1fd695c7',
    await ev('LXNetCrypto.zzcSign(\'{"a":1}\')'));
  check('网易已具备内置搜索', await ev('LXPlatform.hasBuiltinSearch("wy")'));
  check('QQ 已具备内置搜索', await ev('LXPlatform.hasBuiltinSearch("tx")'));

  console.log('\n=== B. 导入真实音源（星海音乐源）===');
  const scriptText = fs.readFileSync(path.join(__dirname, 'fixtures', '星海音乐源v2.3.19.js'), 'utf8');
  const impRes = await ev('(function(){' +
    'LXSources.list().forEach(function(a){if(a.name&&a.name.indexOf("星海音乐源")>=0)LXSources.remove(a.id);});' +
    'var r=LXSources.importScript(' + JSON.stringify(scriptText) + ',"device");' +
    'return JSON.stringify({ok:r.ok,name:r.api&&r.api.name,version:r.api&&r.api.version,' +
    'msg:r.message,keys:r.api?Object.keys(r.api.sources||{}):[],' +
    'status:r.api&&r.api.status});})()');
  const imp = JSON.parse(impRes);
  check('音源导入成功', imp.ok, imp.msg);
  check('识别为星海音乐源', /星海音乐源/.test(imp.name || ''), imp.name);
  check('脚本声明了网易来源', (imp.keys || []).indexOf('wy') >= 0, (imp.keys || []).join(','));
  check('脚本声明了 QQ 来源', (imp.keys || []).indexOf('tx') >= 0);
  check('脚本初始化成功', imp.status === 'success', imp.status);
  check('平台账号：网易由该音源提供地址', await ev('LXSources.forPlatform("wy")') !== '', await ev('LXSources.forPlatform("wy")'));
  check('平台账号：QQ 由该音源提供地址', await ev('LXSources.forPlatform("tx")') !== '');
  check('网易验证通过', await ev('LXSources.verifyPlatform("wy").ok'), await ev('LXSources.verifyPlatform("wy").message'));

  console.log('\n=== C. 网易云搜索（eapi）===');
  await ev('(function(){LXApp.state.platform="wy";LXApp.state.search.results=null;' +
    'LXApp.state.search.apiNote="";LXApp.state.search.text="周杰伦";LXApp.render();' +
    'document.getElementById("searchInput").value="周杰伦";return true;})()');
  const t0 = Date.now();
  await click('[data-act="do-search"]');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results', 40000, '网易搜索');
  const wyCount = await ev('LXApp.state.search.results.length');
  const wyNote = await ev('LXApp.state.search.apiNote');
  console.log('  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  check('网易返回真实结果', wyCount > 0, wyCount);
  check('结果全部标记为网易平台',
    await ev('LXApp.state.search.results.every(function(x){return x.platform==="wy";})'));
  check('来源说明含「网易」', String(wyNote).indexOf('网易') >= 0, wyNote);
  const wyFirst = JSON.parse(await ev('JSON.stringify(LXApp.state.search.results[0])'));
  check('曲目含 songmid', !!wyFirst.songmid, wyFirst.songmid);
  check('曲目含歌手', !!wyFirst.singer, wyFirst.singer);
  check('曲目含 interval', /^\d{2}:\d{2}$/.test(wyFirst.interval || ''), wyFirst.interval);
  check('曲目带音源可用的 _raw 字段',
    !!(wyFirst._raw && wyFirst._raw.songmid), wyFirst._raw && wyFirst._raw.songmid);
  check('曲目声明了音质', Array.isArray(wyFirst.qualitys) && wyFirst.qualitys.length > 0,
    (wyFirst.qualitys || []).join(','));
  await shot('apk-v3-wy-search.png');

  console.log('\n=== D. 网易在线收听（音源解析 musicUrl）===');
  await click('[data-act="play-row"]');
  try {
    await wait('LXApp.engine && LXApp.engine.mode==="stream" && LXApp.state.playing', 60000, '网易在线播放');
  } catch (e) {
    console.log('  播放未就绪：' + e.message);
    console.log('  页面提示：' + await ev('(document.querySelector(".toast")||{}).textContent||""'));
  }
  const wyMode = await ev('LXApp.engine && LXApp.engine.mode');
  const wyPlaying = await ev('LXApp.state.playing');
  check('网易曲目进入在线收听（stream）', wyMode === 'stream', wyMode);
  check('播放状态为 true', wyPlaying === true);
  check('播放条显示当前曲目',
    (await ev('document.getElementById("pbTitle").textContent')).length > 0,
    await ev('document.getElementById("pbTitle").textContent'));
  await shot('apk-v3-wy-playing.png');

  console.log('\n=== E. QQ 音乐搜索（musics.fcg + zzcSign）===');
  await ev('(function(){LXApp.state.platform="tx";LXApp.state.search.results=null;' +
    'LXApp.state.search.apiNote="";LXApp.state.search.text="周杰伦";LXApp.render();' +
    'document.getElementById("searchInput").value="周杰伦";return true;})()');
  const t1 = Date.now();
  await click('[data-act="do-search"]');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results', 40000, 'QQ搜索');
  const txCount = await ev('LXApp.state.search.results.length');
  const txNote = await ev('LXApp.state.search.apiNote');
  console.log('  用时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
  check('QQ 返回真实结果', txCount > 0, txCount);
  check('结果全部标记为 QQ 平台',
    await ev('LXApp.state.search.results.every(function(x){return x.platform==="tx";})'));
  check('来源说明含「QQ」', String(txNote).indexOf('QQ') >= 0, txNote);
  const txFirst = JSON.parse(await ev('JSON.stringify(LXApp.state.search.results[0])'));
  check('QQ 曲目 songmid = mid', !!txFirst.songmid, txFirst.songmid);
  check('QQ 曲目带 media_mid', !!(txFirst._raw && txFirst._raw.media_mid),
    txFirst._raw && txFirst._raw.media_mid);
  check('QQ 曲目含歌手与专辑', !!txFirst.singer && !!txFirst.album,
    txFirst.singer + ' / ' + txFirst.album);
  check('QQ 曲目声明了音质', Array.isArray(txFirst.qualitys) && txFirst.qualitys.length > 0,
    (txFirst.qualitys || []).join(','));
  await shot('apk-v3-tx-search.png');

  console.log('\n=== F. QQ 在线收听 ===');
  await click('[data-act="play-row"]');
  let qqPlaying = false;
  try {
    await wait('LXApp.state.playing===true', 45000, 'QQ在线播放');
    qqPlaying = true;
  } catch (e) {
    console.log('  播放未就绪：' + e.message);
  }
  const qqToast = await ev('(document.getElementById("toast")||{}).textContent||""');
  const qqWhy = await ev('LXSources.lastError(' + JSON.stringify(txFirst.id) + ')');
  if (qqPlaying) {
    check('QQ 曲目进入在线收听（stream）', await ev('LXApp.engine.mode') === 'stream',
      await ev('LXApp.engine.mode'));
    check('QQ 播放状态为 true', true);
  } else {
    // 星海音源的 QQ 取链要卡密/认证（后端 403）。此时必须把原因如实告诉用户，
    // 而不是笼统的「没有地址」，否则用户不知道该去配置什么。
    check('QQ 播放失败时透传音源原因',
      /认证|卡密|403|开放|人机验证|验证/.test(String(qqWhy) + String(qqToast)),
      String(qqWhy).slice(0, 90) + ' | toast: ' + String(qqToast).slice(0, 60));
    check('QQ 播放失败不进入假播放状态', await ev('LXApp.state.playing') === false);
  }
  await shot('apk-v3-tx-playing.png');

  console.log('\n=== G. 按品质下载（网易曲目，走音源 downloadUrl）===');
  const dl = await ev('(function(){var t=LXData.byId(' + JSON.stringify(wyFirst.id) + ');' +
    'if(!t)return "no-track";' +
    'LXDownload.all().forEach(function(j){if(j.state!=="done")LXDownload.remove(j.id);});' +
    'LXDownload.enqueue([t],"128k");return "ok";})()');
  check('网易曲目入队成功', dl === 'ok', dl);
  let dlState = '';
  try {
    await wait('(function(){var a=LXDownload.all();return a.length&&(a[0].state==="done"||a[0].state==="error")?a[0].state:"";})()',
      180000, '下载完成');
    dlState = await ev('LXDownload.all()[0].state');
  } catch (e) {
    dlState = await ev('LXDownload.all()[0] ? LXDownload.all()[0].state : "none"');
    console.log('  下载未完成：' + dlState);
  }
  const dlJob = JSON.parse(await ev('JSON.stringify(LXDownload.all()[0]||{})'));
  check('下载任务完成', dlState === 'done', dlState + ' / ' + (dlJob.error || ''));
  if (dlState === 'done') {
    check('文件已保存到系统下载目录', /Download\/LX Music/.test(dlJob.path || ''), dlJob.path);
    check('记录了交付音质', !!dlJob.deliveredQuality, dlJob.deliveredQuality);
    check('文件大小 > 100KB', (dlJob.size || 0) > 100000, dlJob.size);
    check('格式按音源返回', !!dlJob.format, dlJob.format + ' / ' + dlJob.mime);
  }
  await ev('(function(){LXApp.state.nav="nav_download";LXApp.render();return true;})()');
  await new Promise(r => setTimeout(r, 600));
  await shot('apk-v3-wy-tx-download.png');

  console.log('\n=== H. QQ 取链受限时如实报错 ===');
  const qdl = await ev('(function(){var t=LXData.byId(' + JSON.stringify(txFirst.id) + ');' +
    'if(!t)return "no-track";LXDownload.enqueue([t],"128k");return "ok";})()');
  check('QQ 曲目入队成功', qdl === 'ok', qdl);
  let qState = '';
  try {
    await wait('(function(){var a=LXDownload.all().filter(function(j){return j.trackId===' +
      JSON.stringify(txFirst.id) + ';});return a.length&&(a[0].state==="done"||a[0].state==="error")?a[0].state:"";})()',
      90000, 'QQ 下载结束');
    qState = await ev('(function(){var a=LXDownload.all().filter(function(j){return j.trackId===' +
      JSON.stringify(txFirst.id) + ';});return a[0]?a[0].state:"";})()');
  } catch (e) {
    qState = 'timeout';
  }
  const qJob = JSON.parse(await ev('(function(){var a=LXDownload.all().filter(function(j){return j.trackId===' +
    JSON.stringify(txFirst.id) + ';});return JSON.stringify(a[0]||{});})()'));
  if (qState === 'done') {
    check('QQ 下载完成（音源已认证）', true, qJob.size);
  } else {
    check('QQ 下载失败时给出音源原文原因',
      /认证|卡密|403|开放|人机验证|验证/.test(String(qJob.error || '')),
      String(qJob.error || qState).slice(0, 110));
  }

  ws.close();
  const report = {
    ranAt: new Date().toISOString(),
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    failed: fail.length,
    wyCount: wyCount,
    txCount: txCount,
    checks: checks
  };
  fs.writeFileSync(path.join(OUT, 'device-wy-tx-check.json'), JSON.stringify(report, null, 2));
  console.log('\n' + '='.repeat(56));
  console.log((fail.length ? 'FAILED: ' + fail.join(' | ') : '全部通过') +
    '   ' + report.passed + ' / ' + report.total);
  if (fail.length) process.exitCode = 1;
}

main().catch(e => {
  console.error('验收脚本异常: ' + (e && e.stack || e));
  process.exit(2);
});
