/* 通用页面截图：node evidence/shot-page.js [nav] [outfile] [platform]
 * 例：node evidence/shot-page.js nav_songlist apk-v39-songlist-page.png kw
 */
'use strict';
const fs = require('fs');
const path = require('path');

const nav = process.argv[2] || 'nav_search';
const out = process.argv[3] || ('shot-' + nav + '.png');
const platform = process.argv[4] || '';

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
  await cmd('Page.enable');
  if (platform) await ev(`(function(){LXApp.state.platform='${platform}';return true;})()`);
  await ev(`(function(){LXApp.closeOverlay();LXApp.state.nav='${nav}';LXApp.render();return true;})()`);
  if (nav === 'nav_songlist') {
    await ev('(function(){ if(!(LXApp.state||{}).__x) LXApp.loadSongLists(1); return true; })()');
    for (let i = 0; i < 30; i++) {
      const n = await ev("document.querySelectorAll('#view [data-act=\"open-songlist\"]').length");
      if (n > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  await new Promise(r => setTimeout(r, 800));
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result && r.result.data) {
    fs.writeFileSync(path.join(__dirname, out), Buffer.from(r.result.data, 'base64'));
    console.log('截图 ' + out);
  }
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
