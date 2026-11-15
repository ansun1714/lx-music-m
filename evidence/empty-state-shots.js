/* 记录 v3.2.0 的干净初始状态：无音源时的搜索页与排行榜提示。 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;

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
    return r.result && r.result.result && r.result.result.value;
  };
  async function shot(name) {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('  截图 ' + name);
    }
  }
  await cmd('Page.enable');
  await cmd('Runtime.enable');

  console.log('曲目数 =', await ev('LXData.tracks.length'), '音源数 =', await ev('LXSources.list().length'));
  await ev("LXApp.state.nav='nav_search';LXApp.state.search.results=null;LXApp.state.search.text='';LXApp.render();true");
  await new Promise(r => setTimeout(r, 600));
  await shot('apk-v3-empty-search.png');

  // 通过真实导航点击触发 loadBoard，才能看到「没有音源实现 leaderboard」的提示
  await ev("(function(){var b=document.querySelector('[data-act=\"nav\"][data-id=\"nav_top\"]');" +
    "if(b)b.click();return true;})()");
  await new Promise(r => setTimeout(r, 1800));
  await shot('apk-v3-empty-board.png');
  console.log('排行榜提示：', await ev("(document.getElementById('view').innerHTML.match(/没有音源实现[^<]*/)||[''])[0]"));
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
