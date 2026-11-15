/* 真机验收：点击「自定义源管理 → 本地导入」，由外层脚本在系统文件选择器中选中
 * /sdcard/Download/真机导入测试.js，验证原生桥 → Java 读文件 → 分块回传 → 音源导入。
 * 产出 evidence/device-pick-check.json 与 apk-v3-file-picked.png。
 */
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
  const cmd = (method, params) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' + (x.exceptionDetails.text || ''));
    return x.result && x.result.value;
  };
  await cmd('Page.enable');
  await cmd('Runtime.enable');

  const report = { steps: [], ok: false };
  const step = (name, cond, detail) => {
    report.steps.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
    if (!cond) report.failed = (report.failed || 0) + 1;
  };

  step('LXFilePick 已挂载', await ev('!!window.LXFilePick'));
  step('EchoBridge.pickScript 可用', await ev('!!(window.EchoBridge && typeof EchoBridge.pickScript==="function")'));

  await ev("LXApp.state.nav='nav_setting';LXApp.render();LXApp.openOverlay('userapi');true");
  step('自定义源管理页已打开', await ev("!!document.querySelector('[data-act=\"api-import-local\"]')"));

  // 注意：addJavascriptInterface 注入的 Java 对象方法在 JS 里不可覆写，
  // 因此不尝试 hook EchoBridge.pickScript；改由「等待态 + 系统选择器弹出（外层 shell 验证）」佐证。
  await ev(`(function(){
    window.__pickProbe = { before: LXSources.list().length, toasts: [] };
    var ot = LXApp.toast;
    LXApp.toast = function(m){ window.__pickProbe.toasts.push(String(m)); return ot.apply(this, arguments); };
    return true;
  })()`);

  await ev("(function(){document.querySelector('[data-act=\"api-import-local\"]').click();return true;})()");
  step('点击后进入等待态（取消/失败有反馈）', await ev('LXFilePick._active') === true);

  // 等待外层 UI 自动化完成文件选择
  const t0 = Date.now();
  let after = -1, probe = null;
  while (Date.now() - t0 < 100000) {
    probe = await ev(`(function(){var p=window.__pickProbe;return {
      before:p.before,after:LXSources.list().length,active:LXFilePick._active,
      names:LXSources.list().map(function(a){return a.name;}),
      origins:LXSources.list().map(function(a){return a.origin;}),
      toasts:p.toasts};})()`).catch(() => null);
    if (probe && probe.after > probe.before) { after = probe.after; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  step('选中文件后音源数量 +1', after > 0, JSON.stringify(probe));
  step('导入的音源名为「真机导入测试音源」',
    !!probe && probe.names.indexOf('真机导入测试音源') >= 0, JSON.stringify(probe && probe.names));
  step('origin 记录真实文件名',
    !!probe && probe.origins.some(o => o.indexOf('真机导入测试.js') >= 0), JSON.stringify(probe && probe.origins));
  step('等待态已结束', !!probe && probe.active === false);
  step('已向 Java 确认消费', await ev('!!(LXFilePick && !LXFilePick._active)'));
  const supports = await ev("(function(){var a=LXSources.list().filter(function(x){return x.name==='真机导入测试音源';})[0];return a?LXSources.supports(a,'search'):false;})()");
  step('导入的音源可用于搜索', supports);
  step('已持久化到 localStorage',
    await ev("(localStorage.getItem('lx_user_apis_v2')||'').indexOf('真机导入测试音源')>=0"));

  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result && r.result.data) {
    fs.writeFileSync(path.join(OUT, 'apk-v3-file-picked.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  截图  apk-v3-file-picked.png');
  }
  report.elapsedMs = Date.now() - t0;
  report.probe = probe;
  report.ok = !report.failed;
  fs.writeFileSync(path.join(OUT, 'device-pick-check.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\n设备文件导入验收全部通过' : '\n存在失败项');
  ws.close();
}
main().catch(e => { console.error('ERROR', e); process.exitCode = 1; });
