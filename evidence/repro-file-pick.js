/* 真机/模拟器复现「自定义源管理 → 本地导入 → 选文件后无反应」的诊断脚本。
 * 通过 CDP 注入探针，记录 input.click / change / FileReader 结果与音源列表变化。
 * 用法：node evidence/repro-file-pick.js（外层另用 adb 完成系统文件选择器交互）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'repro-file-pick.json');

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 调试页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
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
    if (x.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(x.exceptionDetails.text));
    return x.result && x.result.value;
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  // 进入设置 → 自定义源管理
  await ev("LXApp.state.nav='nav_setting'; LXApp.render(); LXApp.openOverlay('userapi'); true");
  const panelOpen = await ev("!!document.querySelector('[data-act=\"api-import-local\"]')");
  console.log('自定义源管理页已打开:', panelOpen);
  if (!panelOpen) throw new Error('找不到「本地导入」按钮');

  await ev(`(function(){
    window.__diag = { clicks:0, changes:0, files:-1, readAsText:0, frLoad:0,
      frError:'', fileSize:-1, fileName:'', text:null,
      errors:[], apisBefore: LXSources.list().length, apisAfter: -1, toasts: [] };
    var oc = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function(){
      if(this && this.tagName==='INPUT' && this.type==='file'){
        window.__diag.clicks++; window.__fileRef = this;
      }
      return oc.apply(this, arguments);
    };
    var or = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function(f){
      window.__diag.readAsText++;
      try { window.__diag.fileSize = f && f.size; window.__diag.fileName = f && f.name; } catch(e){}
      this.addEventListener('load', function(){ window.__diag.frLoad++; window.__diag.text = String(this.result||''); });
      this.addEventListener('error', function(){ window.__diag.frError = String(this.error && this.error.name || 'error'); });
      return or.apply(this, arguments);
    };
    document.addEventListener('change', function(e){
      if(e.target && e.target.type==='file'){
        window.__diag.changes++;
        window.__diag.files = e.target.files ? e.target.files.length : -1;
      }
    }, true);
    window.addEventListener('error', function(e){ window.__diag.errors.push(String(e.message)); });
    window.addEventListener('unhandledrejection', function(e){ window.__diag.errors.push('rejection: '+String(e.reason)); });
    var ot = window.LXApp.toast;
    window.LXApp.toast = function(m){ window.__diag.toasts.push(String(m)); return ot.apply(this, arguments); };
    return true;
  })()`);
  console.log('探针已注入');

  const clicked = await ev("(function(){var b=document.querySelector('[data-act=\"api-import-local\"]');if(!b)return false;b.click();return true;})()");
  console.log('已点击「本地导入」:', clicked);

  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 75000) {
    const d = await ev(`(function(){
      var x = window.__diag;
      if(!x) return { lost: true };
      x.apisAfter = LXSources.list().length;
      return JSON.parse(JSON.stringify(x));
    })()`).catch(e => ({ evalError: String(e.message) }));
    const compact = JSON.stringify({
      clicks: d.clicks, changes: d.changes, files: d.files, read: d.readAsText,
      load: d.frLoad, err: d.frError, size: d.fileSize,
      textLen: d.text == null ? null : d.text.length,
      apis: d.apisBefore + '->' + d.apisAfter, toasts: d.toasts, errors: d.errors
    });
    if (compact !== last) { console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + compact); last = compact; }
    d.elapsedMs = Date.now() - t0;
    fs.writeFileSync(OUT, JSON.stringify(d, null, 2));
    if (d.apisAfter > d.apisBefore || d.frError || (d.text && d.text.length)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('诊断结束，结果写入 ' + OUT);
  ws.close();
}

main().catch(e => { console.error('DIAG ERROR', e); process.exitCode = 1; });
