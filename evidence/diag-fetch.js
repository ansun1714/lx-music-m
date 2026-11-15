/* 单档位取地址诊断：node evidence/diag-fetch.js [quality] [trackId]
 * 直接调用 LXSources.fetchMedia，打印返回的 url / filename / 错误。
 */
'use strict';
const quality = process.argv[2] || '320k';
const trackId = process.argv[3] || '';

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

  const id = trackId || await ev('(LXApp.state.search.results && LXApp.state.search.results[0] && LXApp.state.search.results[0].id) || ""');
  console.log('trackId: ' + id + '  quality: ' + quality);
  console.log('qualitys: ' + await ev(`JSON.stringify((LXData.byId(${JSON.stringify(id)}) || {}).qualitys || [])`));
  console.log('plan: ' + await ev(`JSON.stringify(LXQuality.downgradeChain(${JSON.stringify(quality)}, LXData.byId(${JSON.stringify(id)}), 3))`));
  console.log('chain: ' + await ev(`JSON.stringify((LXSources.sourceChain(LXData.byId(${JSON.stringify(id)})) || []).map(function(a){return a.name}))`));
  const res = await ev(`(async function(){
    try {
      var m = await LXSources.fetchMedia(LXData.byId(${JSON.stringify(id)}), ${JSON.stringify(quality)});
      return JSON.stringify(m ? { url: String(m.url).slice(0, 90), mime: m.mime, ext: m.ext, filename: m.filename } : null);
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  console.log('fetchMedia: ' + res);
  console.log('lastError: ' + await ev(`LXSources.lastError(${JSON.stringify(id)})`));
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
