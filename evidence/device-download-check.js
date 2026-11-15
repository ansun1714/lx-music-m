/* 设备端验收：真实音频 URL 的原生流式下载（进度 / 速度 / 落盘 / 可播放）。
 * 前置：v3.4.0 已安装、CDP 已转发到 127.0.0.1:9222。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;

// 用宿主机本地 HTTP 服务（模拟器通过 10.0.2.2 访问）验证流式下载，避免公网断流
const AUDIO_URL = 'http://10.0.2.2:8080/test-audio.wav';

const SRC = `/**
 * @name 设备下载源
 * @description 给酷我平台提供真实音频地址，用于验证原生流式下载
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const AUDIO = ${JSON.stringify(AUDIO_URL)}
on(EVENT_NAMES.request, ({ action }) => {
  if (action === 'downloadUrl') {
    return Promise.resolve({ url: AUDIO, mime: 'audio/wav', ext: 'wav' })
  }
  if (action === 'musicUrl') return Promise.resolve(AUDIO)
  return Promise.reject(new Error('unsupported action: ' + action))
})
send(EVENT_NAMES.inited, {
  sources: {
    kw: { name: '设备下载源', type: 'music', actions: ['musicUrl', 'downloadUrl'], qualitys: ['128k'] }
  }
})
`;

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
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
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS: ' + (x.exceptionDetails.text || ''));
    return x.result && x.result.value;
  };
  await cmd('Runtime.enable');
  await cmd('Page.enable');

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  };

  // 0) 本地测试服务可达性（用 HEAD，不下载正文）
  const reach = await ev(`new Promise(function(resolve){
    LXSourceAPI.request(${JSON.stringify(AUDIO_URL)}, { method: 'head', timeout: 8000 },
      function(err, resp, body){ resolve(JSON.stringify({ err: err ? String(err.message || err) : null,
        status: resp && resp.statusCode })); });
  })`);
  const rj = JSON.parse(reach);
  check('本地音频服务可达', !rj.err && rj.status === 200, JSON.stringify(rj));

  // 1) 清理旧的同名音源，再导入（避免旧版本抢到 forPlatform）
  await ev('(function(){LXSources.list().filter(function(a){return a.name==="设备下载源";})' +
    '.forEach(function(a){LXSources.remove(a.id);});return true;})()');
  const imp = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(SRC) +
    ',"device-dl");return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
  check('导入设备下载源', String(imp).indexOf('ok:') === 0, imp);
  check('酷我平台由该源提供地址', String(await ev('LXSources.forPlatform("kw")')).length > 3);

  // 2) 酷我搜索拿一首真实歌曲
  await ev('LXApp.state.nav="nav_search";LXApp.state.platform="kw";LXApp.render();' +
    'document.getElementById("searchInput").value="周杰伦";true');
  await ev('document.querySelector("[data-act=\\"do-search\\"]").click();true');
  const t0 = Date.now();
  let track = null;
  while (Date.now() - t0 < 25000) {
    const n = await ev('LXApp.state.search.results ? LXApp.state.search.results.length : 0');
    if (n > 0) { track = JSON.parse(await ev('JSON.stringify(LXApp.state.search.results[0])')); break; }
    await new Promise(r => setTimeout(r, 500));
  }
  check('酷我搜索到真实歌曲', !!track && !!track.name, track && (track.name + ' - ' + track.singer));

  // 3) 加入下载队列，观察原生流式进度
  await ev('LXDownload.enqueue([LXData.byId(' + JSON.stringify(track.id) + ')],"128k");true');
  let maxProgress = 0, sawSpeed = 0, last = null, done = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    const st = JSON.parse(await ev(`(function(){
      var j = LXDownload.all().filter(function(x){return x.trackId === ${JSON.stringify(track.id)};})[0];
      return JSON.stringify(j || null);
    })()`));
    if (!st) { await new Promise(r => setTimeout(r, 300)); continue; }
    last = st;
    if (st.progress > maxProgress) maxProgress = st.progress;
    if (st.speed > sawSpeed) sawSpeed = st.speed;
    if (st.state === 'done' || st.state === 'error') { done = st; break; }
    await new Promise(r => setTimeout(r, 400));
  }
  check('下载任务完成', !!done && done.state === 'done', done && (done.state + ' ' + (done.error || '')));
  check('过程中有真实进度', maxProgress > 0, maxProgress + '%');
  check('过程中统计到下载速度', sawSpeed > 0, Math.round(sawSpeed / 1024) + ' KB/s');
  check('文件大小与源文件一致（4,096,044 B）', !!done && done.size === 4096044, done && done.size);
  check('扩展名按来源格式 = wav', !!done && /\.wav$/i.test(done.filename || ''), done && done.filename);
  check('落盘到 Download/LX Music', !!done && /Download\/LX Music/.test(done.path || ''), done && done.path);

  // 4) 下载页 UI 显示
  await ev('LXApp.state.nav="nav_download";LXApp.render();true');
  const ui = await ev("document.getElementById('dlList').innerHTML");
  check('下载页显示已保存路径', ui.indexOf('已保存到') >= 0);
  check('下载页显示音质/格式/来源', /WAV/.test(ui) && /设备下载源/.test(ui));

  const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(OUT, 'apk-v3-download-stream.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  截图  apk-v3-download-stream.png');
  }

  fs.writeFileSync(path.join(OUT, 'device-download-check.json'),
    JSON.stringify({ checks, passed: checks.filter(c => c.ok).length, total: checks.length, track, done }, null, 2));
  console.log('\n原生流式下载 PASS ' + checks.filter(c => c.ok).length + ' / ' + checks.length);
  ws.close();
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
