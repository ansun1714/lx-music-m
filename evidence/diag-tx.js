/* 单平台播放诊断：node evidence/diag-tx.js [平台id] [关键词]
 * 打印：搜索结果、音源解析地址的完整结果与错误、页面 toast。
 */
'use strict';
const pf = process.argv[2] || 'tx';
const keyword = process.argv[3] || '周杰伦';

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

  console.log('平台: ' + pf + '  关键词: ' + keyword);
  console.log('音源: ' + await ev(`(LXSources.forPlatform('${pf}')||'')`));
  const search = await ev(`(async function(){
    try {
      var r = await LXPlatform.search('${pf}', ${JSON.stringify(keyword)}, { limit: 10 });
      var t = r.tracks[0];
      if (!t) return JSON.stringify({ n: 0, note: r.note, errors: r.errors });
      var m = null, err = '';
      try { m = await LXSources.playableUrl(t, '320k'); } catch (e) { err = String(e && e.message || e); }
      var last = '';
      try { last = LXSources.lastError ? (LXSources.lastError(t) || '') : ''; } catch (e) {}
      return JSON.stringify({
        n: r.tracks.length,
        first: { name: t.name, singer: t.singer, id: t.id, songmid: t.songmid, qualitys: t.qualitys },
        media: m ? { url: String(m.url).slice(0, 120), mime: m.mime } : null,
        playErr: err, lastError: last
      }, null, 1);
    } catch (e) { return JSON.stringify({ fatal: String(e && e.message || e) }); }
  })()`);
  console.log(search);
  console.log('toast: ' + await ev(`(document.getElementById('toast')||{}).textContent||''`));
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
