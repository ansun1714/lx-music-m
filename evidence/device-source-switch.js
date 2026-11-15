/* 设备端验证「主界面搜索平台切换」：不同音源只返回自己的曲目。
 * 前置：CDP 已转发到 127.0.0.1:9222。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'device-source-switch.json');

const SRC_A = `/**
 * @name 平台甲
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const list = [
  { songmid: 'a1', name: '夜测一', singer: '甲歌手', duration: 60 },
  { songmid: 'a2', name: '夜测二', singer: '甲歌手', duration: 70 },
  { songmid: 'a3', name: '夜测三', singer: '甲歌手', duration: 80 }
]
on(EVENT_NAMES.request, ({ source, action }) => {
  if (action === 'search') return Promise.resolve(list.map(x => Object.assign({}, x, { source, qualitys: ['128k'], ext: 'mp3' })))
  return Promise.reject(new Error('unsupported'))
})
send(EVENT_NAMES.inited, { sources: { a: { name: '甲', type: 'music', actions: ['search'], qualitys: ['128k'] } } })
`;

const SRC_B = `/**
 * @name 平台乙
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const list = [
  { songmid: 'b1', name: '平台乙一', singer: '乙歌手', duration: 90 },
  { songmid: 'b2', name: '平台乙二', singer: '乙歌手', duration: 95 }
]
on(EVENT_NAMES.request, ({ source, action }) => {
  if (action === 'search') return Promise.resolve(list.map(x => Object.assign({}, x, { source, qualitys: ['320k'], ext: 'flac' })))
  return Promise.reject(new Error('unsupported'))
})
send(EVENT_NAMES.inited, { sources: { b: { name: '乙', type: 'music', actions: ['search'], qualitys: ['320k'] } } })
`;

const SRC_C = `/**
 * @name 仅解析源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action }) => {
  if (action === 'musicUrl') return Promise.resolve('https://example.com/a.mp3')
  return Promise.reject(new Error('unsupported'))
})
send(EVENT_NAMES.inited, { sources: { c: { name: 'c', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
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
    if (x.exceptionDetails) throw new Error('JS 异常: ' + (x.exceptionDetails.text || ''));
    return x.result && x.result.value;
  };
  await cmd('Runtime.enable');

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  };

  const imp = await ev(`(function(){
    var out = [];
    [${JSON.stringify(SRC_A)},${JSON.stringify(SRC_B)},${JSON.stringify(SRC_C)}].forEach(function(s){
      var r = LXSources.importScript(s, 'switch-test');
      out.push(r.ok ? r.api.name : ('FAIL:' + r.message));
    });
    return out;
  })()`);
  check('导入 3 个测试音源', Array.isArray(imp) && imp.filter(x => x.indexOf('FAIL') !== 0).length === 3, JSON.stringify(imp));

  const ids = JSON.parse(await ev(`(function(){
    var m = {};
    ['平台甲','平台乙','仅解析源'].forEach(function(n){
      var a = LXSources.list().filter(function(x){return x.name === n;})[0];
      if (a) m[n] = a.id;
    });
    return JSON.stringify(m);
  })()`));

  async function searchWith(apiId, kw) {
    return ev(`(function(){
      LXApp.state.nav = 'nav_search';
      LXApp.state.search.source = ${JSON.stringify('api:' + apiId)};
      LXApp.state.search.text = ${JSON.stringify(kw)};
      LXApp.render();
      document.getElementById('searchInput').value = ${JSON.stringify(kw)};
      document.querySelector('[data-act="do-search"]').click();
      return new Promise(function(resolve){
        var t0 = Date.now();
        (function poll(){
          var s = LXApp.state;
          if (!s.search.searching && s.search.results) return resolve(JSON.stringify({
            n: s.search.results.length,
            names: s.search.results.map(function(x){return x.name;}),
            apiIds: s.search.results.map(function(x){return x.apiId;}),
            note: s.search.apiNote
          }));
          if (Date.now() - t0 > 15000) return resolve(JSON.stringify({ timeout: true, note: s.search.apiNote }));
          setTimeout(poll, 200);
        })();
      });
    })()`);
  }

  const ra = JSON.parse(await searchWith(ids['平台甲'], '夜测'));
  check('选中平台甲只返回甲的结果', ra.n === 3 && ra.apiIds.every(x => x === ids['平台甲']), ra.n + ' 首');
  check('平台甲结果显示来源名', ra.names.every(x => /夜测/.test(x)), JSON.stringify(ra.names));

  const rb = JSON.parse(await searchWith(ids['平台乙'], '平台'));
  check('切到平台乙只返回乙的结果', rb.n === 2 && rb.apiIds.every(x => x === ids['平台乙']), rb.n + ' 首');
  check('平台乙结果与甲完全不同', rb.names.every(x => x.indexOf('平台乙') === 0), JSON.stringify(rb.names));

  const rc = JSON.parse(await searchWith(ids['仅解析源'], '夜测'));
  check('选中仅 musicUrl 的源时给出明确提示', (rc.note || '').indexOf('未实现 search') >= 0, rc.note);
  check('该情况下不返回兜底结果', rc.n === 0, rc.n);

  const rall = JSON.parse(await searchWith('all', '夜测'));
  check('「全部音源」聚合搜索', rall.n >= 3, rall.n);

  // 清理本次导入的测试源，保持设备干净
  await ev(`(function(){
    LXSources.list().filter(function(a){return a.origin === 'switch-test';})
      .forEach(function(a){ LXSources.remove(a.id); });
    LXApp.state.search.source = 'api:all';
    LXApp.state.search.results = null;
    LXApp.render();
    return true;
  })()`);

  fs.writeFileSync(OUT, JSON.stringify({ checks, passed: checks.filter(c => c.ok).length, total: checks.length }, null, 2));
  console.log('\n搜索平台切换 PASS ' + checks.filter(c => c.ok).length + ' / ' + checks.length);
  ws.close();
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
