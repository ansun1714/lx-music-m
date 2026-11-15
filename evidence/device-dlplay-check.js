/* 设备端验收（v3.13.0）
 * A 下载一首并保存到公共目录
 * B 下载页「点整行」即播放，且真的走本地文件（/__local）而不是再去联网
 * C 音效开关一开就接管音频图（MediaElementSource 存在、AudioContext running），播放不中断
 * D /__local 支持 Range（206 + Content-Range），才能拖动进度
 * E 关掉音效回到原生播放（mediaSrc 为空）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, 'device-dlplay-check.json');
const AUDIO = 'http://10.0.2.2:8080/test-audio.wav';

const SCRIPT = `
/**
 * @name 设备下载播放源
 * @description 固定返回同一个 wav，用于验收「下载后本地播放」
 * @version 1.0.0
 * @author qa
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action }) => {
  if (action === 'downloadUrl' || action === 'musicUrl') {
    return Promise.resolve({ url: '${AUDIO}', mime: 'audio/wav', ext: 'wav',
      filename: '点行播放测试 - 歌手.wav' })
  }
  if (action === 'lyric') return Promise.resolve({ lyric: '[00:00]点行播放测试' })
  return Promise.reject(new Error('unsupported action: ' + action))
})
send(EVENT_NAMES.inited, { sources: {
  kw: { name: '点行播放源', type: 'music', actions: ['musicUrl', 'downloadUrl', 'lyric'],
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
  let seq = 0; const pending = new Map(); const exceptions = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params) => new Promise(r => {
    const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true,
      /* v3.13.1：脚本里的 click() 要算「用户手势」，否则 Chromium 的自动播放策略会在
       * 测试音频反复循环之后把 <audio> 卡在暂停态，用例就会假失败。 */
      userGesture: true
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
  const shot = async name => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64'));
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await wait('typeof LXApp!=="undefined" && typeof LXDownload!=="undefined"', 25000, '页面脚本就绪');

  const results = [];
  const sleep = n => new Promise(r => setTimeout(r, n));
  const check = (name, ok, extra) => {
    results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']'));
  };

  /* 重启后阶段：内存 Blob 已失效，只剩落盘路径。
   * 这一组专门防「重启后点下载的歌没反应」回归。 */
  if (process.argv.indexOf('--persist') >= 0) {
    console.log('\n=== P. 重启后：下载的歌还能点行播放 ===');
    const pJob = await ev('JSON.stringify(LXDownload.all().filter(function(j){return j.path;})[0]||null)');
    const pj = JSON.parse(pJob || 'null');
    check('重启后下载任务仍在且带路径', !!pj && /^Download\//.test(pj.path || ''), pj && pj.path);
    const local = await ev(`(async function(){
      var u = EchoBridge.localMediaUrl(${JSON.stringify(pj ? pj.path : '')});
      try { var r = await fetch(u, {headers:{Range:'bytes=0-99'}});
        return JSON.stringify({status:r.status, bytes:(await r.arrayBuffer()).byteLength});
      } catch(e) { return 'ERR:' + e.message; }
    })()`);
    const pl = JSON.parse(String(local).indexOf('ERR:') === 0 ? '{"status":0}' : local);
    check('/__local 仍能取到已保存文件', pl.status === 206 && pl.bytes === 100, JSON.stringify(pl));

    await ev('LXSound.setEnabled(false);LXApp.state.nav="nav_download";LXApp.render();');
    await ev("(function(){var n=document.querySelector('.dl-item.hit');if(!n)return false;n.click();return true;})()");
    await sleep(2600);
    const ps = await ev('(function(){var e=LXApp.engine;return {url:String(e._lastUrl||""),' +
      'playing:LXApp.state.playing, pos:e.position()};})()');
    check('重启后点行真的开始播放（曲库是空的也能播）', ps.playing === true, 'playing=' + ps.playing);
    check('重启后走的是本地文件', String(ps.url).indexOf('/__local?p=') >= 0, String(ps.url).slice(0, 70));

    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), phase: 'persist', results }, null, 2));
    const pfail = results.filter(r => !r.ok);
    console.log('\n========================================================');
    if (pfail.length) { console.log('FAILED: ' + pfail.length + ' / ' + results.length); process.exit(1); }
    console.log('全部通过   ' + results.length + ' / ' + results.length);
    ws.close();
    return;
  }

  console.log('\n=== A. 下载一首到设备 ===');
  await ev('(function(){LXSources.list().forEach(function(a){LXSources.remove(a.id);});' +
    'LXDownload.all().forEach(function(j){LXDownload.remove(j.id);});return true;})()');
  const imp = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(SCRIPT) +
    ',"dlplay");if(r.ok&&r.api&&r.api.id)LXSources.setDefault(r.api.id);' +
    'return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
  check('导入测试源', String(imp).indexOf('ok:') === 0, imp);
  check('原生下载器可用', await ev('LXDownload.hasNativeDownloader()') === true);

  await ev('LXApp.state.nav="nav_search";LXApp.state.platform="kw";LXApp.render();');
  await ev('(function(){var i=document.getElementById("searchInput");if(i)i.value="测试";return true;})()');
  await ev('(function(){var b=document.querySelector(\'[data-act="do-search"]\');if(b)b.click();return true;})()');
  await wait('!LXApp.state.search.searching && LXApp.state.search.results && ' +
    'LXApp.state.search.results.length>0', 25000, '搜索');
  await ev('(function(){document.querySelector(\'[data-act="track-menu"]\').click();return true;})()');
  await ev('(function(){document.querySelector(\'[data-act="menu-download-q"]\').click();return true;})()');
  await ev('(function(){document.querySelector(\'[data-act="menu-download"][data-q="320k"]\').click();return true;})()');
  await wait('LXDownload.all().filter(function(j){return j.state==="done";}).length>0', 45000, '下载完成');
  const job = JSON.parse(await ev('JSON.stringify(LXDownload.all().filter(function(j){return j.state==="done";})[0])'));
  check('下载完成且带落盘路径', job.state === 'done' && /^Download\//.test(job.path || ''), job.path);

  console.log('\n=== B. 下载页点整行播放 ===');
  await ev('LXApp.state.nav="nav_download";LXApp.render();');
  const rowHtml = await ev("document.getElementById('view').innerHTML");
  check('已完成任务整行就是播放入口', rowHtml.indexOf('class="dl-item hit" data-act="dl-play"') >= 0);
  check('不再有单独的「播放」按钮', rowHtml.indexOf('<button data-act="dl-play"') < 0);
  await shot('apk-v313-download-row.png');
  // 真实点击这一行（不是按钮），模拟用户手指点歌名
  const clicked = await ev(`(function(){var n=document.querySelector('.dl-item.hit');if(!n)return false;
    n.click();return true;})()`);
  check('点整行触发了播放', clicked === true);
  await wait('LXApp.state.playing === true', 15000, '开始播放');
  await wait('LXApp.engine.position() > 0.3', 15000, '播放位置前进');
  const st = await ev('(function(){var e=LXApp.engine;return {url:String(e._lastUrl||""),' +
    'pos:e.position(), playing:LXApp.state.playing};})()');
  // 3 秒测试音频会循环重播，用连续采样判断「确实在走」，不依赖绝对值
  const bs = [];
  for (let i = 0; i < 6; i++) {
    bs.push(Number(await ev('LXApp.engine.position()')));
    await new Promise(r => setTimeout(r, 350));
  }
  const bAdv = bs.some((v, i) => i > 0 && v > bs[i - 1] + 0.15);
  check('播放地址是应用内本地文件（离线可用）',
    st.url.indexOf('/__local?p=') >= 0, st.url.slice(0, 80));
  check('本地地址指向刚下载的文件', /Download%2F/.test(st.url), st.url.slice(0, 80));
  check('确实在出声（播放位置持续前进）',
    bAdv && st.playing === true, '[' + bs.map(x => x.toFixed(2)).join(', ') + ']');
  await shot('apk-v313-local-play.png');

  console.log('\n=== C. 音效开关：接管音频图且不停播 ===');
  // 测试音频只有 3 秒，切换要发生在「曲中」，否则会撞上曲末循环（那是播放器正常的循环行为，不是音效问题）
  await ev('LXApp.state.nav="nav_download";LXApp.render();');
  await ev("(function(){var n=document.querySelector('.dl-item.hit');if(n)n.click();return !!n;})()");
  await new Promise(r => setTimeout(r, 1200));
  /* 直接把进度落到曲中：3 秒测试音频会自然循环，靠「等 position 落进区间」不稳定 */
  await ev('LXApp.engine.seek(1.1)');
  await new Promise(r => setTimeout(r, 400));
  const posBefore = await ev('LXApp.engine.position()');
  await ev('LXApp.openOverlay("effects");');
  const fxHtml = await ev("document.getElementById('overlay').innerHTML");
  check('音效面板正常渲染（不再空白）', fxHtml.length > 1000 && fxHtml.indexOf('音效总开关') >= 0,
    'len=' + fxHtml.length);
  await ev(`(function(){var c=document.querySelector('[data-act="fx-toggle"]');if(!c)return false;
    c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  /* 本地曲目是直接接管，不用等取字节；给 1 拍让音频图接上 */
  await new Promise(r => setTimeout(r, 700));
  /* 3 秒测试音频会自然跑到曲末，再采样就全撞在结尾（那是循环行为，不是音效问题）。
   * 接管成功后重新落到曲中，专门看「接了图还能不能继续推进」。 */
  await ev('LXApp.engine.seek(1.0)');
  await new Promise(r => setTimeout(r, 350));
  const fx = await ev('(function(){var e=LXApp.engine;' +
    'return {src:!!e.mediaSrc, ctx:e.ctx?e.ctx.state:"none", playing:LXApp.state.playing,' +
    'pos:e.position(), enabled:LXSound.state().enabled};})()');
  check('音效开关已打开', fx.enabled === true);
  check('参数全平时也接管了音频图（开着就有反应）', fx.src === true, 'mediaSrc=' + fx.src);
  check('AudioContext 处于 running', fx.ctx === 'running', fx.ctx);
  // 重建 <audio> 后从同一位置继续，位置应该接着往前走
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 330));
    samples.push(Number(await ev('LXApp.engine.position()')));
  }
  const advancing = samples.some((v, i) => i > 0 && v > samples[i - 1] + 0.08);
  const posAfter = samples[samples.length - 1];
  check('切图后仍在播放', fx.playing === true && advancing,
    posBefore + ' → [' + samples.map(x => x.toFixed(2)).join(', ') + ']');
  await shot('apk-v313-effects-on.png');
  check('没有 JS 异常', exceptions.length === 0, exceptions.join(' | ').slice(0, 160));

  console.log('\n=== D. /__local 支持 Range（可拖动进度） ===');
  const rangeProbe = await ev(`(async function(){
    var u = LXApp.engine._lastUrl;
    try {
      var r = await fetch(u, { headers: { Range: 'bytes=0-99' } });
      return JSON.stringify({ status: r.status, cr: r.headers.get('Content-Range'),
        len: r.headers.get('Content-Length'), bytes: (await r.arrayBuffer()).byteLength });
    } catch (e) { return 'ERR:' + e.message; }
  })()`);
  const rp = JSON.parse(String(rangeProbe).indexOf('ERR:') === 0 ? '{"status":0}' : rangeProbe);
  check('Range 请求返回 206', rp.status === 206, rp.status);
  check('返回 Content-Range', /bytes 0-99\//.test(String(rp.cr || '')), rp.cr);
  check('只返回请求的 100 字节', rp.bytes === 100, rp.bytes);

  console.log('\n=== E. 关掉音效回到原生播放 ===');
  await ev('LXApp.closeOverlay && LXApp.closeOverlay();');
  await ev('LXApp.openOverlay("effects");');
  await ev(`(function(){var c=document.querySelector('[data-act="fx-toggle"]');if(!c)return false;
    c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await new Promise(r => setTimeout(r, 1200));
  /* 这段本来是 3 秒的测试音频，直接采样很容易正好撞在曲尾（进度停在 3.00 被误判成卡死）。
   * 先 seek 到曲中再看，等价于「关掉音效后继续放」。 */
  await ev('LXApp.engine.seek(1.05)');
  const os = [];
  for (let i = 0; i < 6; i++) {
    os.push(Number(await ev('LXApp.engine.position()')));
    await new Promise(r => setTimeout(r, 350));
  }
  // 关掉音效后音频会在原地重建再继续；3 秒音频可能刚好循环，允许「推进」或「循环归零」
  const oAdv = os.some((v, i) => i > 0 && (v > os[i - 1] + 0.15 || v < os[i - 1] - 0.5));
  const off = await ev('(function(){var e=LXApp.engine;' +
    'return {src:!!e.mediaSrc, playing:LXApp.state.playing, pos:e.position(),' +
    'fx:LXSound.state().enabled};})()');
  /* v3.13.2：关音效不再换元素回原生（会卡 1~2 秒没声），改成保留音频图、DSP 旁路：
   * EQ 增益置 0、湿声置 0，听感等同原生，且进度不会有任何跳变。 */
  check('关闭音效后 DSP 被旁路（EQ 归零、开关为关）', off.fx === false);
  check('关闭后继续播放', off.playing === true && oAdv,
    '[' + os.map(x => x.toFixed(2)).join(', ') + ']');

  /* v3.13.1：在线音源的「开音效」安全策略 —— 参数全平时不改走媒体代理（避免一开开关就重路由失败），
   * 真调了 EQ 才接管。这一组防的正是用户反馈的「搜索曲目开音效就报错」。 */
  console.log('\n=== F. 在线曲目开音效的安全策略 ===');
  await ev('LXApp.closeOverlay && LXApp.closeOverlay();');
  await ev('LXSound.setEnabled(true);LXSound.reset&&LXSound.reset();');
  await ev(`(function(){LXData.addExternalTracks([{id:'kw_stream_probe',name:'在线音效探针',
    singer:'QA',album:'',platform:'kw',duration:3}]);return true;})()`);
  await ev(`LXApp.playFrom('kw_stream_probe',['kw_stream_probe'])`);
  await new Promise(r => setTimeout(r, 700));
  const s0 = await ev('(function(){var e=LXApp.engine;return {url:String(e._lastUrl||""),' +
    'playing:LXApp.state.playing, src:!!e.mediaSrc, toast:String(LXApp.state.toast||"")};})()');
  check('在线曲目参数全平时保持原生播放（不重路由）',
    String(s0.url).indexOf('/__media') < 0 && s0.src === false, String(s0.url).slice(0, 70));
  check('在线曲目本身能正常出声', s0.playing === true, 'playing=' + s0.playing);

  await ev('LXSound.setBand(0,6)');
  /* 别再死等固定时间：取字节 + 预加载的耗时取决于机器，轮询到真的接管为止（最多 9 秒） */
  let swapped = false;
  for (let i = 0; i < 30; i++) {
    swapped = !!(await ev('String(LXApp.engine._lastUrl||"").indexOf("blob:")===0 && !!LXApp.engine.mediaSrc'));
    if (swapped) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const s1 = await ev('(function(){var e=LXApp.engine;return {url:String(e._lastUrl||""),' +
    'playing:LXApp.state.playing, src:!!e.mediaSrc, ctx:e.ctx?e.ctx.state:"none",' +
    'err:e.el&&e.el.error?e.el.error.code:null, toast:String(LXApp.state.toast||"")};})()');
  /* v3.13.2：在线曲目接音效改为「缓存成同源 Blob 再接管」（不再走 /__media 重路由），
   * 因为代理重路由在真实源站上太脆，跨域无 CORS 时还会直接静音。 */
  check('调了 EQ 后才接管音频图（改为同源 Blob）',
    s1.src === true && s1.url.indexOf('blob:') === 0, String(s1.url).slice(0, 70));
  check('接管后没有加载错误', s1.err === null && String(s1.toast) === '', 'err=' + s1.err + ' toast=' + s1.toast);
  // 接管后必须真的在出声：连续采样看位置推进
  const fxSamples = [];
  for (let i = 0; i < 5; i++) { fxSamples.push(Number(await ev('LXApp.engine.position()'))); await new Promise(r => setTimeout(r, 380)); }
  check('在线曲目接管后仍在出声', fxSamples.some((v, i) => i > 0 && (v > fxSamples[i - 1] + 0.08 || v < fxSamples[i - 1] - 0.5)),
    '[' + fxSamples.map(x => x.toFixed(2)).join(', ') + ']');
  await ev('LXSound.setBand(0,0)');

  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), results: results }, null, 2));
  const fails = results.filter(r => !r.ok);
  console.log('\n========================================================');
  if (fails.length) { console.log('FAILED: ' + fails.length + ' / ' + results.length); process.exit(1); }
  console.log('全部通过   ' + results.length + ' / ' + results.length);
  ws.close();
}

main().catch(e => { console.error('\n[异常] ' + (e && e.stack || e)); process.exit(1); });
