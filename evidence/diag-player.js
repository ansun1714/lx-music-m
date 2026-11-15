/* 播放问题诊断（v3.7.0 真机反馈：点歌不加载 / 播放无声）
 * 用真实音源取一条在线地址，检查 <audio> 状态、AudioContext 状态、
 * 是否接入了 MediaElementSource，以及音频服务器是否返回 CORS 头。
 */
'use strict';
const fs = require('fs');
const path = require('path');

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 调试页面');
  console.log('CDP 页面: ' + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params) => new Promise(r => {
    const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  async function ev(expr) {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' +
      (x.exceptionDetails.exception && x.exceptionDetails.exception.description || x.exceptionDetails.text));
    return x.result && x.result.value;
  }
  async function wait(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(fn);
      if (v) return v;
      await new Promise(r => setTimeout(r, 350));
    }
    throw new Error('等待超时: ' + label);
  }

  await cmd('Runtime.enable');

  console.log('\n=== 1. 环境 ===');
  console.log('音效状态: ' + await ev('JSON.stringify(LXSound.state())'));
  console.log('engine 已有 ctx: ' + await ev('!!LXApp.engine.ctx'));

  console.log('\n=== 2. 导入星海音源 ===');
  const script = fs.readFileSync(path.join(__dirname, 'fixtures', '星海音乐源v2.3.19.js'), 'utf8');
  const imp = await ev('(function(){' +
    'LXSources.list().forEach(function(a){if(a.name&&a.name.indexOf("星海音乐源")>=0)LXSources.remove(a.id);});' +
    'var r=LXSources.importScript(' + JSON.stringify(script) + ',"diag");' +
    'return JSON.stringify({ok:r.ok,msg:r.message,status:r.api&&r.api.status,' +
    'keys:r.api?Object.keys(r.api.sources||{}):[]});})()');
  console.log(imp);

  console.log('\n=== 3. 网易搜索并播放 ===');
  await ev('(function(){LXApp.state.platform="wy";LXApp.state.search.results=null;' +
    'LXApp.state.search.text="周杰伦";LXApp.render();' +
    'document.getElementById("searchInput").value="周杰伦";return true;})()');
  await ev('(function(){document.querySelector(\'[data-act="do-search"]\').click();return true;})()');
  await wait('LXApp.state.search.results && LXApp.state.search.results.length>0 && !LXApp.state.search.searching',
    30000, '搜索');
  const n = await ev('LXApp.state.search.results.length');
  console.log('搜索结果: ' + n);

  const track = JSON.parse(await ev('JSON.stringify(LXApp.state.search.results[0])'));
  console.log('第一首: ' + track.name + ' / ' + track.singer + ' / songmid=' + track.songmid);

  // 先单独取一次播放地址，看音源是否真的给了 URL
  const media = await ev('(function(){var t=LXApp.state.search.results[0];' +
    'return LXSources.fetchMedia(t,"128k").then(function(m){' +
    'return JSON.stringify({ok:!!m,url:m?String(m.url).slice(0,90):"",mime:m&&m.mime,ext:m&&m.ext,' +
    'err:LXSources.lastError(t)});}).catch(function(e){return JSON.stringify({err:String(e.message||e)});});})()');
  console.log('解析结果: ' + media);

  await ev('(function(){var t=LXApp.state.search.results[0];LXApp.playFrom(t.id,[t.id]);return true;})()');
  await new Promise(r => setTimeout(r, 4000));

  console.log('\n=== 4. 播放器状态 ===');
  const st = await ev('(function(){var e=LXApp.engine;return JSON.stringify({' +
    'mode:e.mode, hasEl:!!e.el, src:e.el?String(e.el.src).slice(0,90):"",' +
    'readyState:e.el?e.el.readyState:-1, networkState:e.el?e.el.networkState:-1,' +
    'paused:e.el?e.el.paused:-1, currentTime:e.el?e.el.currentTime:-1,' +
    'duration:e.el?e.el.duration:-1, volume:e.el?e.el.volume:-1,' +
    'elError:e.el&&e.el.error?e.el.error.code+":"+e.el.error.message:"none",' +
    'hasMediaSrc:!!e.mediaSrc, ctxState:e.ctx?e.ctx.state:"none",' +
    'soundMounted:LXSound.mounted(), appPlaying:LXApp.state.playing,' +
    'decoded:(e.el&&e.el.webkitAudioDecodedByteCount)||0' +
    '});})()');
  console.log(st);

  const parsed = JSON.parse(st);
  if (parsed.src) {
    console.log('\n=== 5. 该地址的 CORS 响应头 ===');
    const url = await ev('String(LXApp.engine.el.src)');
    const hdr = await ev('new Promise(function(resolve){' +
      'LXSourceAPI.request(' + JSON.stringify(url) + ',{method:"head",timeout:15000},' +
      'function(err,resp){ if(err){resolve("ERR "+err.message);return;}' +
      'var h=resp&&resp.headers||{}; var key=Object.keys(h).filter(function(k){' +
      'return /access-control|content-type|content-length/i.test(k);});' +
      'resolve(JSON.stringify({status:resp&&resp.statusCode,headers:key.map(function(k){return k+"="+h[k];})}));});})');
    console.log(hdr);
  }

  ws.close();
}

main().catch(e => { console.error('诊断异常: ' + (e && e.stack || e)); process.exit(2); });
