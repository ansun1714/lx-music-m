/* 在设备 WebView 里通过原生 HTTP 桥探测各平台搜索接口可达性。 */
'use strict';
const KW = 'http://search.kuwo.cn/r.s?client=kt&all=' + encodeURIComponent('周杰伦') +
  '&pn=0&rn=2&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
const KG = 'http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=' +
  encodeURIComponent('周杰伦') + '&hifiquality=0&pagesize=2&PrivilegeFilter=0&page=1';
const KGRANK = 'http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=2&area_code=1&page=1&rankid=8888&with_res_tag=0&show_portrait_mv=1';

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
    if (x.exceptionDetails) throw new Error(x.exceptionDetails.text || 'JS error');
    return x.result && x.result.value;
  };
  await cmd('Runtime.enable');

  async function probe(name, url) {
    const out = await ev(`new Promise(function(resolve){
      var t0 = Date.now();
      LXSourceAPI.request(${JSON.stringify(url)}, { method: 'get', timeout: 20000 }, function(err, resp, body){
        if (err) return resolve({ name: ${JSON.stringify(name)}, ok: false, error: String(err.message || err), ms: Date.now()-t0 });
        var head = String(body || '').slice(0, 120);
        resolve({ name: ${JSON.stringify(name)}, ok: resp.statusCode === 200, status: resp.statusCode,
          len: String(body || '').length, head: head, ms: Date.now()-t0 });
      });
    })`);
    console.log(JSON.stringify(out));
    return out;
  }

  const r1 = await probe('kuwo-search', KW);
  const r2 = await probe('kugou-search', KG);
  const r3 = await probe('kugou-rank', KGRANK);
  ws.close();
  const ok = [r1, r2, r3].filter(x => x && x.ok).length;
  console.log('\n可达 ' + ok + ' / 3');
  process.exit(ok === 3 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
