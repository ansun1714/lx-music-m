/* 下载诊断：打印队列任务状态 / 报错 / 文件大小（v3.10.0 排查用） */
'use strict';
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
    if (x.exceptionDetails) return 'EXC: ' + (x.exceptionDetails.text || '') +
      (x.exceptionDetails.exception ? ' ' + x.exceptionDetails.exception.description : '');
    return x.result && x.result.value;
  };
  await cmd('Runtime.enable');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (await ev('typeof window.LXApp !== "undefined"')) break;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(await ev('JSON.stringify(LXDownload.all(), null, 1)'));
  console.log('opts=' + await ev('JSON.stringify(LXDownload.opts)'));
  console.log('states=' + await ev('(LXDownload.states||[]).join(",")'));
}
main().catch(e => { console.error(e && e.stack || e); process.exit(2); });
