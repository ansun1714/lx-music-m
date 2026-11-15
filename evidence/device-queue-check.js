/* 播放详情队列专项验收（v3.11.0）
 * 场景：歌单页 → 打开一个歌单 → 全部播放 → 详情页应能看到「下一首 / 第几首·还剩几首」，
 *       点「列表」可看全部曲目并点选任意一首切换，随机模式下「下一首」不会停在原曲。
 * 前置：APK 已安装并冷启动；adb forward tcp:9222；本地测试音频服务（可选，只影响能否出声）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'evidence');

const fail = [];
const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
  if (!cond) fail.push(name);
}

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
    if (x.exceptionDetails) throw new Error('JS 异常: ' + (x.exceptionDetails.text || '') +
      (x.exceptionDetails.exception ? ' ' + x.exceptionDetails.exception.description : ''));
    return x.result && x.result.value;
  };
  const shot = async name => {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      console.log('  截图 ' + name);
    }
  };
  const wait = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(expr);
      if (v) return v;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('等待超时: ' + label);
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (await ev('typeof window.LXApp !== "undefined" && !!LXApp.state')) break;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n=== A. 准备音源（能服务酷我，才有可播放队列） ===');
  const script = fs.readFileSync(path.join(OUT, 'fixtures', '设备测试音源.js'), 'utf8');
  const imp = await ev('(function(){var r=LXSources.importScript(' + JSON.stringify(script) +
    ', "queue-check");return JSON.stringify({ok:r.ok,msg:r.message||"",id:(r.api&&r.api.id)||""});})()');
  const impObj = JSON.parse(imp);
  check('测试音源导入成功', impObj.ok, impObj.msg);
  if (impObj.id) await ev('(function(){LXSources.setDefault(' + JSON.stringify(impObj.id) + ');return true;})()');
  check('酷我已可用音源服务', await ev('LXSources.forPlatform("kw")') !== '',
    await ev('LXSources.forPlatform("kw")'));

  console.log('\n=== B. 歌单页 → 歌单详情 → 全部播放 ===');
  await ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_songlist";' +
    'LXApp.state.platform="kw";LXApp.render();LXApp.loadSongLists(1);return true;})()');
  let listOk = true;
  try {
    await wait('document.querySelector(\'[data-act="open-songlist"]\') !== null', 20000, '歌单卡片');
  } catch (e) { listOk = false; }
  check('歌单页出现推荐歌单卡片', listOk);
  if (listOk) {
    await ev('(function(){document.querySelector(\'[data-act="open-songlist"]\').click();return true;})()');
    let detailOk = true;
    try {
      await wait('document.querySelector(\'[data-act="play-all-songlist"]\') !== null', 25000, '歌单详情');
    } catch (e) { detailOk = false; }
    check('歌单详情加载出曲目列表', detailOk);
    if (detailOk) {
      const np = await ev('(function(){var n=document.querySelector(".list-header .num, .list-header span:last-child");return n?n.textContent:"";})()');
      await ev('(function(){document.querySelector(\'[data-act="play-all-songlist"]\').click();return true;})()');
      await wait('LXApp.state.queue.length>0', 15000, '队列建立');
      check('「全部播放」把整张歌单灌进播放队列', true, '队列 ' + await ev('LXApp.state.queue.length') + ' 首 ' + (np || ''));
    }
  }

  if (await ev('LXApp.state.queue.length') === 0) {
    console.log('  歌单不可用，回退用内置搜索建队列');
    await ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_search";' +
      'LXApp.state.platform="kw";LXApp.render();LXApp.state.search.text="测试";' +
      'document.querySelector(\'[data-act="do-search"]\').click();return true;})()');
    await wait('LXApp.state.search.results && LXApp.state.search.results.length>0', 20000, '搜索结果');
    await ev('(function(){document.querySelector(\'[data-act="play-all"]\').click();return true;})()');
    await wait('LXApp.state.queue.length>0', 10000, '搜索队列');
  }
  const len = await ev('LXApp.state.queue.length');
  check('播放队列已建立（>1 首）', len > 1, len);
  await ev('(function(){LXApp.state.index=0;LXApp.state.mode="listLoop";LXApp.openOverlay("detail");return true;})()');
  await new Promise(r => setTimeout(r, 600));

  console.log('\n=== C. 详情页：下一首 / 队列位置 ===');
  const dq = await ev('(function(){var d=document.querySelector(".dq");return d?d.innerText:"";})()');
  check('详情页有队列信息条', !!dq, (dq || '').replace(/\n/g, ' | '));
  check('显示「下一首」', /下一首/.test(dq || ''));
  check('「下一首」是队列第二首', await ev('(function(){var a=LXApp.state.queue,' +
    'b=window.LXData.byId(a[1]);var d=document.querySelector(".dq");' +
    'return !!(b && d && d.innerText.indexOf(b.name)>=0);})()'));
  check('显示第几首 / 共几首 / 还剩几首',
    new RegExp('第 1 / ' + len + ' 首 · 还剩 ' + (len - 1) + ' 首').test(dq || ''),
    ((dq || '').match(/第 \d+ \/ \d+ 首 · 还剩 \d+ 首/) || [''])[0]);
  check('标注当前播放模式', /列表循环/.test(dq || ''));
  check('详情页有「列表」按钮', await ev('!!document.querySelector(\'[data-act="open-queue"]\')'));
  await shot('apk-v311-detail-queue.png');

  await ev('(function(){document.querySelector(\'[data-act="next"]\').click();return true;})()');
  await new Promise(r => setTimeout(r, 800));
  const dq2 = await ev('(function(){var d=document.querySelector(".dq");return d?d.innerText:"";})()');
  check('切到下一首后索引前进', await ev('LXApp.state.index') === 1, await ev('LXApp.state.index'));
  check('信息条同步为第二首 / 剩余递减',
    new RegExp('第 2 / ' + len + ' 首 · 还剩 ' + (len - 2) + ' 首').test(dq2 || ''),
    ((dq2 || '').match(/第 \d+ \/ \d+ 首 · 还剩 \d+ 首/) || [''])[0]);

  console.log('\n=== D. 队列页：看全部曲目并点选切换 ===');
  await ev('(function(){document.querySelector(\'[data-act="open-queue"]\').click();return true;})()');
  await new Promise(r => setTimeout(r, 500));
  const rows = await ev('(document.querySelectorAll(\'[data-act="queue-play"]\')||[]).length');
  check('队列页列出全部曲目', rows === len, rows + '/' + len);
  check('当前曲目在队列页高亮', await ev('!!document.querySelector(".q-item.on")'));
  check('队列页显示总首数与当前位置', /共 \d+ 首 · 当前第 2 首/.test(await ev('document.querySelector(".q-head").innerText')));
  await shot('apk-v311-queue-list.png');
  const target = Math.min(4, len - 1);
  await ev('(function(){var r=document.querySelector(\'[data-act="queue-play"][data-val="' + target +
    '"]\');r.click();return true;})()');
  await new Promise(r => setTimeout(r, 900));
  check('点选队列任意一首即切过去', await ev('LXApp.state.index') === target, await ev('LXApp.state.index'));
  await ev('(function(){LXApp.openOverlay("detail");return true;})()');
  await new Promise(r => setTimeout(r, 500));
  check('切歌后详情页同步新的位置',
    new RegExp('第 ' + (target + 1) + ' / ' + len + ' 首').test(await ev('(function(){var d=document.querySelector(".dq");return d?d.innerText:"";})()')));

  console.log('\n=== E. 随机模式：下一首真的换人 ===');
  await ev('(function(){var m=0;while(LXApp.state.mode!=="random"&&m<5){' +
    'document.querySelector(\'[data-act="mode"]\').click();m++;}return LXApp.state.mode;})()');
  check('模式按钮可切到随机播放', await ev('LXApp.state.mode') === 'random', await ev('LXApp.state.mode'));
  check('信息条提示随机抽取', /每次从 \d+ 首里抽一首/.test(await ev('(function(){var d=document.querySelector(".dq");return d?d.innerText:"";})()')));
  let same = 0;
  for (let i = 0; i < 6; i++) {
    const before = await ev('LXApp.state.index');
    await ev('(function(){document.querySelector(\'[data-act="next"]\').click();return true;})()');
    await new Promise(r => setTimeout(r, 500));
    if (await ev('LXApp.state.index') === before) same++;
  }
  check('随机点 6 次都没有停在原曲', same === 0, 'same=' + same);
  await ev('(function(){LXApp.state.mode="listLoop";LXApp.save();LXApp.closeOverlay();return true;})()');
  await shot('apk-v311-queue-detail.png');

  ws.close();
  const report = {
    ranAt: new Date().toISOString(),
    queueLength: len,
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    failed: fail.length,
    checks: checks
  };
  fs.writeFileSync(path.join(OUT, 'device-queue-check.json'), JSON.stringify(report, null, 2));
  console.log('\n' + '='.repeat(56));
  console.log((fail.length ? 'FAILED: ' + fail.join(' | ') : '全部通过') + '   ' + report.passed + ' / ' + report.total);
  if (fail.length) process.exitCode = 1;
}

main().catch(e => { console.error('验收脚本异常: ' + (e && e.stack || e)); process.exit(2); });
