/* 引擎状态快照：node evidence/diag-engine.js
 * 不触发新的播放，只打印当前 <audio> / AudioContext / 音源状态。
 */
'use strict';

const SNAPSHOT = [
  'JSON.stringify((function(){',
  '  var e = LXApp.engine, el = e && e.el;',
  '  return {',
  '    nav: LXApp.state.nav, playing: LXApp.state.playing,',
  '    mode: e && e.mode,',
  '    src: el ? String(el.src).slice(0, 90) : "",',
  '    raw: (e && e._rawUrl || "").slice(0, 90),',
  '    readyState: el ? el.readyState : -1,',
  '    duration: el ? el.duration : -1,',
  '    paused: el ? el.paused : null,',
  '    err: el && el.error ? el.error.code : 0,',
  '    mediaSrc: !!(e && e.mediaSrc),',
  '    ctx: e && e.ctx ? e.ctx.state : "",',
  '    sound: window.LXSound ? LXSound.state().enabled : null,',
  '    settingQuality: LXApp.state.settings.audioQuality,',
  '    dl: LXDownload.all().map(function(j){ return { t: j.trackId, q: j.quality, dq: j.deliveredQuality, f: j.filename, st: j.state, note: j.note, err: j.error }; }),',
  '    defaultSource: LXSources.defaultApi() ? LXSources.defaultApi().name : "",',
  '    sources: LXSources.list().map(function(a){ return a.name + ":" + a.status; })',
  '  };',
  '})())'
].join('\n');

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
  async function ev(expr) {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' +
      (x.exceptionDetails.exception && x.exceptionDetails.exception.description || x.exceptionDetails.text));
    return x.result && x.result.value;
  }
  await cmd('Runtime.enable');
  const raw = await ev(SNAPSHOT);
  console.log(JSON.stringify(JSON.parse(raw), null, 2));
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
