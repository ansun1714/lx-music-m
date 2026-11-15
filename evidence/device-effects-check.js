/* 设备端验收：音效 + 跨域修复（v3.9.0）
 * 用真实音源（evidence/fixtures/星海音乐源v2.3.19.js）在 WebView 里播放网易 / QQ 的真实曲目，
 * 验证「开启音效后音频走同源代理、能真的播放、不再提示跨域」。
 *
 * 前置：APK 已安装并打开；由 shell 先执行 adb forward tcp:9222。
 * 用法：node evidence/device-effects-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'evidence');
const fail = [];
let total = 0;
function check(name, cond, detail) {
  total += 1;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  if (!cond) fail.push(name);
}

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(x => x.type === 'page' && /app\.echo\.local/.test(x.url)) || list[0];
  if (!page) throw new Error('没有找到 WebView 调试页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  function cmd(method, params) {
    return new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function ev(expr) {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const x = r.result || {};
    if (x.exceptionDetails) throw new Error('JS 异常: ' +
      (x.exceptionDetails.exception && x.exceptionDetails.exception.description || x.exceptionDetails.text));
    return x.result && x.result.value;
  }
  async function shot(name) {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('  截图  ' + name);
    }
  }
  async function until(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(fn)) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }
  const click = sel => ev("(function(){var e=document.querySelector(" + JSON.stringify(sel) +
    ");if(!e)return false;e.click();return true;})()");

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  for (let i = 0; i < 50; i++) {
    if (await ev('!!(window.LXApp&&window.LXPlatform&&LXSound)')) break;
    await new Promise(r => setTimeout(r, 400));
  }

  const audioInfo = async () => JSON.parse(await ev(`(function(){
    var e = LXApp.engine, el = e && e.el;
    return JSON.stringify({
      src: el ? el.src : '',
      raw: e ? (e._rawUrl || '') : '',
      t: el ? Math.round((el.currentTime || 0) * 10) / 10 : 0,
      paused: el ? !!el.paused : true,
      err: el && el.error ? el.error.code : 0,
      mediaSrc: !!(e && e.mediaSrc),
      ctx: e && e.ctx ? e.ctx.state : '',
      mounted: !!(window.LXSound && LXSound.mounted()),
      fallback: !!(e && e._graphFallback),
      mode: e ? e.mode : ''
    });})()`));

  // ---------------------------------------------------------------- A. 导入真实音源
  console.log('\n=== A. 导入真实音源 ===');
  const scriptText = fs.readFileSync(path.join(__dirname, 'fixtures', '星海音乐源v2.3.19.js'), 'utf8');
  const impRes = await ev(`(function(){
    LXSources.list().forEach(function(a){
      if (a.name && (a.name.indexOf('星海音乐源')>=0 || a.name.indexOf('设备测试音源')>=0 ||
          a.name.indexOf('测试源')>=0)) LXSources.remove(a.id);
    });
    var r = LXSources.importScript(${JSON.stringify(scriptText)}, 'device-effects');
    // 前面的验收可能留下返回 data: WAV 的测试音源，必须让真实音源优先
    if (r.ok && r.api && r.api.id) LXSources.setDefault(r.api.id);
    return JSON.stringify({ ok: r.ok, id: r.api && r.api.id, name: r.api && r.api.name,
      status: r.api && r.api.status, msg: r.message });
  })()`);
  const imp = JSON.parse(impRes);
  check('音源导入成功', imp.ok, imp.name + ' / ' + imp.msg);
  check('音源可服务网易', (await ev("LXSources.forPlatform('wy')")) !== '');
  check('音源可服务 QQ', (await ev("LXSources.forPlatform('tx')")) !== '');

  // 关闭音效，先拿到一次「原始地址」作为基线
  await ev(`(function(){ LXSound.setEnabled(false); return true; })()`);

  async function playOn(pf, keyword, label, strict) {
    await ev(`(function(){
      LXApp.state.platform='${pf}';
      LXApp.state.search.results=null; LXApp.state.search.apiNote='';
      LXApp.state.search.text=${JSON.stringify(keyword)};
      LXApp.render();
      var i=document.getElementById('searchInput'); if(i) i.value=${JSON.stringify(keyword)};
      return true;
    })()`);
    await click('[data-act="do-search"]');
    const got = await until(`!LXApp.state.search.searching && LXApp.state.search.results && LXApp.state.search.results.length > 0`, 45000);
    check(`${label} 搜索到曲目`, got);
    if (!got) return false;
    await click('[data-act="play-row"]');
    const playing = await until(`LXApp.engine && LXApp.engine.mode==='stream' && LXApp.state.playing && LXApp.engine.el && LXApp.engine.el.currentTime > 0`, 60000);
    if (playing) { check(`${label} 进入在线播放`, true); return true; }
    const why = await ev(`(function(){
      var t = LXApp.state.search.results && LXApp.state.search.results[0];
      return (t && LXSources.lastError && LXSources.lastError(t)) || '';
    })()`);
    if (strict) check(`${label} 进入在线播放`, false, why);
    else console.log(`  SKIP  ${label} 取不到播放地址：${why || '音源未返回地址'}`);
    return false;
  }

  // ---------------------------------------------------------------- B. 网易：音效开启
  console.log('\n=== B. 网易云：开启音效播放 ===');
  const wyOk = await playOn('wy', '周杰伦', '网易', true);
  if (wyOk) {
    const before = await audioInfo();
    check('网易基线：未开音效时走原始地址', before.raw.indexOf('__media') < 0 && before.mode === 'stream',
      before.raw.slice(0, 80));

    await ev(`(function(){ LXSound.setEnabled(true); LXSound.setBand(0, 6); LXApp.engine.rebuild(); return true; })()`);
    const progressed = await until(`LXApp.engine.el && LXApp.engine.el.currentTime > 1.5 && !LXApp.engine.el.paused`, 40000);
    const after = await audioInfo();
    check('开启音效后仍在播放（currentTime 前进）', progressed, after.t + 's');
    check('音频改走同源代理（不再跨域）', /^https:\/\/app\.echo\.local\/__media\?u=/.test(after.src),
      after.src.slice(0, 80));
    check('已接入 Web Audio（createMediaElementSource）', after.mediaSrc === true);
    check('AudioContext 处于 running', after.ctx === 'running', after.ctx);
    check('音效链已挂载', after.mounted === true);
    check('没有触发跨域回退', after.fallback === false);
    check('播放器没有 MediaError', after.err === 0, after.err);

    // 代理探针：拿真实地址走一次带 Range 的请求
    const probe = JSON.parse(await ev(`(async function(){
      var e = LXApp.engine, u = e._rawUrl;
      if (!u) return JSON.stringify({ err: 'no url' });
      var p = LXMediaProxy.wrap(u, (e._lastRef || {}).headers);
      try {
        var r = await fetch(p, { headers: { Range: 'bytes=0-4095' } });
        var b = await r.arrayBuffer();
        return JSON.stringify({ status: r.status, ct: r.headers.get('content-type'),
          len: b.byteLength, cr: r.headers.get('content-range') });
      } catch (err) { return JSON.stringify({ err: String(err && err.message || err) }); }
    })()`));
    check('代理返回音频字节', probe.status === 200 || probe.status === 206, JSON.stringify(probe).slice(0, 120));
    check('代理 MIME 为音频', /^audio\//.test(probe.ct || ''), probe.ct);
    check('代理支持 Range', !!probe.cr, probe.cr);
    await shot('apk-v39-effects-wy.png');
  }

  // ---------------------------------------------------------------- C. 网易：关闭音效回落
  console.log('\n=== C. 关闭音效后回落原生播放 ===');
  if (wyOk) {
    await ev(`(function(){ LXSound.setEnabled(false); LXApp.engine.rebuild(); return true; })()`);
    const back = await until(`LXApp.engine.el && LXApp.engine.el.src.indexOf('__media') < 0 && LXApp.engine.el.currentTime > 0.5`, 30000);
    const info = await audioInfo();
    check('关闭音效后改回原始地址', back, info.src.slice(0, 80));
    check('关闭后仍是 stream 模式', info.mode === 'stream', info.mode);
  }

  // ---------------------------------------------------------------- D. 其他平台：音效开启
  console.log('\n=== D. 其余平台的音效链路 ===');
  for (const pf of ['kg', 'mg', 'kw', 'tx']) {
    const label = await ev(`LXPlatform.nameOf('${pf}')`);
    const ok = await playOn(pf, '周杰伦', label, false);
    if (!ok) continue;
    await ev(`(function(){ LXSound.setEnabled(true); LXSound.setBand(1, 4); LXApp.engine.rebuild(); return true; })()`);
    const progressed = await until(`LXApp.engine.el && LXApp.engine.el.currentTime > 1.5 && !LXApp.engine.el.paused`, 40000);
    const info = await audioInfo();
    check(`${label} 开启音效后仍在播放`, progressed, info.t + 's');
    check(`${label} 音频走同源代理`, /^https:\/\/app\.echo\.local\/__media\?u=/.test(info.src), info.src.slice(0, 70));
    check(`${label} 已接入 Web Audio`, info.mediaSrc === true);
    check(`${label} 没有触发跨域回退`, info.fallback === false);
    check(`${label} 播放器没有 MediaError`, info.err === 0, info.err);
  }
  await shot('apk-v39-effects-multi.png');

  await ev(`(function(){ LXSound.setEnabled(false); LXSources.setDefault(''); return true; })()`);

  console.log('\n========================================');
  console.log(`  音效验收 PASS ${total - fail.length} / ${total}`);
  if (fail.length) { console.log('  FAILED:'); fail.forEach(f => console.log('   - ' + f)); }
  console.log('========================================');
  ws.close();
  process.exit(fail.length ? 1 : 0);
}

main().catch(e => { console.error('\n[验收异常] ' + (e && e.stack || e)); process.exit(1); });
