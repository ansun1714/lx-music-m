/* 设置页滑块区域截图（v3.10.0）
 * 打开设置页 → 滚到「播放速率」行 → 截图；再把界面字号调到 18 截图，用于人工核对排版。
 * 前置：APK 已安装并冷启动；adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'evidence');

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cmd = (method, params) => new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' + (x.exceptionDetails.text || ''));
    return x.result && x.result.value;
  };
  const shot = async name => {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('  截图 ' + name);
    }
  };
  await cmd('Page.enable'); await cmd('Runtime.enable');

  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const ok = await ev('typeof window.LXApp !== "undefined" && !!LXApp.state');
    if (ok) break;
    await new Promise(r => setTimeout(r, 300));
  }

  await ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_setting";LXApp.render();' +
    'var r=document.querySelector(\'[data-id="playbackRate"]\').closest(".set-row");' +
    'if(r) r.scrollIntoView({block:"center"});return true;})()');
  await new Promise(r => setTimeout(r, 500));
  await shot('apk-v310-settings-sliders.png');

  await ev('(function(){var i=document.querySelector(\'.sr-num[data-id="fontSize"]\');' +
    'i.value="18";i.dispatchEvent(new Event("input",{bubbles:true}));' +
    'i.dispatchEvent(new Event("change",{bubbles:true}));' +
    'var r=document.querySelector(\'[data-id="fontSize"]\').closest(".set-row");' +
    'if(r) r.scrollIntoView({block:"center"});return true;})()');
  await new Promise(r => setTimeout(r, 500));
  await shot('apk-v310-settings-font18.png');

  // 复位为默认字号，避免影响后续截图对比
  await ev('(function(){var i=document.querySelector(\'.sr-num[data-id="fontSize"]\');' +
    'i.value="14";i.dispatchEvent(new Event("input",{bubbles:true}));' +
    'i.dispatchEvent(new Event("change",{bubbles:true}));LXApp.save();return true;})()');
  ws.close();
}

main().catch(e => { console.error('截图脚本异常: ' + (e && e.stack || e)); process.exit(2); });
