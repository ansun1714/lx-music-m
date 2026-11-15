/* 截一张音源管理页：展示「默认」标签、更新按钮，以及已无平台单独绑定 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'evidence');

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params) => new Promise(r => {
    const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async x => {
    const r = await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await cmd('Runtime.enable');
  await cmd('Page.enable');

  const script = fs.readFileSync(path.join(__dirname, 'fixtures', '星海音乐源v2.3.19.js'), 'utf8');
  console.log(await ev('(function(){' +
    'LXSources.list().forEach(function(a){LXSources.remove(a.id);});' +
    'var r=LXSources.importScript(' + JSON.stringify(script) + ',"online:https://example.com/xinghai.js");' +
    'LXSources.setDefault(r.api.id);' +
    'LXApp.openOverlay("userapi");return r.ok;})()'));

  await new Promise(r => setTimeout(r, 700));
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(OUT, 'apk-v3-userapi-default.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('截图 apk-v3-userapi-default.png');
  }
  console.log('默认标签:', await ev("document.getElementById('overlay').innerHTML.indexOf('ua-tag')>=0"));
  console.log('更新按钮:', await ev("document.getElementById('overlay').innerHTML.indexOf('api-refresh')>=0"));
  console.log('平台绑定入口:', await ev("document.getElementById('overlay').innerHTML.indexOf('bind-platform')>=0"));
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
