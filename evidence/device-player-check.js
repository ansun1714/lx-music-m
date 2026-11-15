/* 播放器专项验收（v3.7.0）
 * 验证：详情页歌词（真实 LRC 解析/高亮）、当前曲目下载、音效设置（10 段 EQ / 预设 / 混响 / 环绕），
 * 以及下载页音质可以手动选到母带并按所选档位入队。
 * 前置：APK 已安装并冷启动；adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
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
  if (!page) throw new Error('没有找到 WebView 调试页面');
  console.log('CDP 页面: ' + page.url);

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
  function cmd(method, params) {
    return new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async function ev(expr) {
    const r = await cmd('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
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
  async function wait(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await ev(fn);
      if (v) return v;
      await new Promise(r => setTimeout(r, 350));
    }
    throw new Error('等待超时: ' + label);
  }
  const click = sel => ev("(function(){var e=document.querySelector(" + JSON.stringify(sel) +
    ");if(!e)return false;e.click();return true;})()");

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  console.log('\n=== A. 模块与平台 ===');
  // 页面脚本是异步加载的：等齐 LX 模块再断言，否则冷启动会误报「未挂载」
  await wait('typeof LXApp!=="undefined" && typeof LXSound!=="undefined" && ' +
    'typeof LXLyr!=="undefined" && typeof LXDownload!=="undefined"', 30000, '页面脚本就绪');  check('LXSound 已挂载', await ev('!!window.LXSound'));
  check('LXLyr 已挂载', await ev('!!window.LXLyr'));
  check('10 段均衡器频段正确',
    await ev('LXSound.FREQS.join(",")') === '31,62,125,250,500,1000,2000,4000,8000,16000',
    await ev('LXSound.FREQS.join(",")'));
  check('9 个官方预设', await ev('LXSound.PRESETS.length') === 9, await ev('LXSound.PRESETS.length'));

  console.log('\n=== B. 导入测试音源并播放 ===');
  const testScript = fs.readFileSync(path.join(__dirname, 'fixtures', '设备测试音源.js'), 'utf8');
  const impRes = await ev('(function(){' +
    'LXSources.list().forEach(function(a){if(a.name&&a.name.indexOf("设备测试音源")>=0)LXSources.remove(a.id);});' +
    'var r=LXSources.importScript(' + JSON.stringify(testScript) + ',"device");' +
    // 测试源要排在最前：前面的验收可能设置过其它默认音源
    'if(r.ok&&r.api&&r.api.id)LXSources.setDefault(r.api.id);' +
    'return r.ok?("ok:"+r.api.name):("fail:"+r.message);})()');
  check('测试音源导入成功', String(impRes).indexOf('ok:') === 0, impRes);

  await ev('(function(){LXApp.state.nav="nav_search";LXApp.state.platform="kw";' +
    'LXApp.state.search.results=null;LXApp.state.search.text="夜";LXApp.render();' +
    'document.getElementById("searchInput").value="夜";return true;})()');
  await click('[data-act="do-search"]');
  await wait('LXApp.state.search.results && LXApp.state.search.results.length>0 && !LXApp.state.search.searching',
    25000, '搜索');
  const trackId = await ev('LXApp.state.search.results[0].id');
  check('搜索有结果', !!trackId, trackId);

  await click('[data-act="play-row"]');
  await wait('LXApp.state.playing===true', 20000, '开始播放');
  await wait('LXApp.engine.el && LXApp.engine.el.readyState>=1 && LXApp.engine.el.duration>0',
    25000, '音频可播');
  check('音频元素已加载到可播状态',
    await ev('LXApp.engine.el && LXApp.engine.el.readyState>=1 && LXApp.engine.el.duration>0'),
    await ev('LXApp.engine.el ? (LXApp.engine.el.readyState + "/" + LXApp.engine.el.duration) : -1'));
  // 关键回归：音效关闭时不能接管音频图，否则没有 CORS 头的音源会被浏览器静音
  check('音效关闭时走原生播放（不接 MediaElementSource）',
    await ev('!LXApp.engine.mediaSrc'));

  // 测试音源只有 1 秒音频，先暂停避免自动切歌影响后续断言
  await ev('(function(){LXApp.engine.pause();LXApp.state.playing=false;LXApp.renderPlayer();return true;})()');

  console.log('\n=== C. 播放详情页：歌词 ===');
  await ev('LXApp.openOverlay("detail",' + JSON.stringify(trackId) + ');true');
  const detailHtml = await ev("document.getElementById('overlay').innerHTML");
  check('详情页含歌词容器', detailHtml.indexOf('lyricBox') >= 0);
  check('详情页含下载按钮', detailHtml.indexOf('detail-download') >= 0);
  check('详情页含音效按钮', detailHtml.indexOf('detail-effects') >= 0);
  check('详情页含歌词开关', detailHtml.indexOf('detail-lyric') >= 0);

  await wait('(function(){var b=document.getElementById("lyricBox");' +
    'return b && b.querySelectorAll(".lc-line").length>=5;})()', 25000, '歌词加载');
  const lyricLines = await ev('document.getElementById("lyricBox").querySelectorAll(".lc-line").length');
  check('音源歌词解析为 5 行', lyricLines === 5, lyricLines);
  const firstLyric = await ev('document.querySelector(".lc-line .lc-main").textContent');
  check('歌词首行内容正确', /第一行/.test(String(firstLyric)), firstLyric);
  check('歌词行带跳转时间', await ev('!!document.querySelector(".lc-line").dataset.t'));
  await shot('apk-v3-detail-lyric.png');

  // 高亮跟随：把播放位置设到第 3 行（4 秒）
  await ev('(function(){LXApp.engine.seek(4.2);return true;})()');
  await new Promise(r => setTimeout(r, 700));
  check('歌词高亮跟随播放进度',
    await ev('document.querySelectorAll(".lc-line.on").length') === 1 &&
    (await ev('document.querySelector(".lc-line.on").textContent')).indexOf('第三行') >= 0,
    await ev('document.querySelector(".lc-line.on") ? document.querySelector(".lc-line.on").textContent : "none"'));

  console.log('\n=== D. 详情页下载当前曲目 ===');
  await click('[data-act="detail-download"]');
  const qMenu = await ev("document.getElementById('contextMenu').innerHTML");
  check('弹出品质菜单', qMenu.indexOf('选择下载品质') >= 0, qMenu.slice(0, 60));
  check('品质菜单含母带', qMenu.indexOf('母带音质') >= 0);
  check('品质菜单 9 档', (qMenu.match(/data-q="/g) || []).length === 9,
    (qMenu.match(/data-q="/g) || []).length);
  await ev("document.getElementById('contextMenu').classList.add('hidden');true");

  console.log('\n=== E. 音效设置 ===');
  await click('[data-act="detail-effects"]');
  check('音效页已打开', await ev('LXApp.state.overlay') === 'effects');
  const fxHtml = await ev("document.getElementById('overlay').innerHTML");
  check('音效页有 9 个预设', (fxHtml.match(/data-act="fx-preset"/g) || []).length === 9);
  check('音效页有 10 段 EQ', (fxHtml.match(/data-act="fx-band"/g) || []).length === 10);
  check('音效页有混响与环绕',
    fxHtml.indexOf('data-act="fx-reverb"') >= 0 && fxHtml.indexOf('data-act="fx-surround"') >= 0);

  // 选「摇滚」预设
  // 恢复播放后再切音效，验证 rebuild 不会打断播放
  await ev('(function(){LXApp.engine.seek(0);LXApp.engine.play();LXApp.state.playing=true;' +
    'LXApp.renderPlayer();return true;})()');
  await new Promise(r => setTimeout(r, 400));
  await click('[data-act="fx-preset"][data-id="摇滚"]');
  await wait('!!LXApp.engine.mediaSrc', 10000, '音效接管音频图');
  check('开启音效后接入 Web Audio', await ev('!!LXApp.engine.mediaSrc'));
  check('接管后 AudioContext 运行中', await ev('LXApp.engine.ctx.state') === 'running',
    await ev('LXApp.engine.ctx.state'));
  check('切换音效后仍在播放', await ev('LXApp.state.playing') === true);
  check('套用摇滚预设',
    await ev('LXSound.state().eq.join(",")') === '7,6,2,1,-3,-4,2,1,4,5',
    await ev('LXSound.state().eq.join(",")'));
  check('音效自动开启', await ev('LXSound.state().enabled') === true);
  check('预设按钮高亮',
    await ev('document.querySelector(\'[data-act="fx-preset"][data-id="摇滚"]\').classList.contains("on")'));

  // 拖动第 1 段 EQ 到 +6，验证实时生效
  await ev('(function(){var e=document.querySelector(\'[data-act="fx-band"][data-i="0"]\');' +
    'e.value="6";e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
  check('EQ 滑块实时写入', await ev('LXSound.state().eq[0]') === 6, await ev('LXSound.state().eq[0]'));
  check('滑块数值标签同步',
    await ev('document.getElementById("fxVal0").textContent') === '+6',
    await ev('document.getElementById("fxVal0").textContent'));
  check('手动调 EQ 后预设变自定义', await ev('LXSound.state().preset') === '自定义');

  // 混响 + 环绕
  await click('[data-act="fx-reverb"][data-id="hall"]');
  check('混响切到大厅', await ev('LXSound.state().reverb') === 'hall');
  await ev('(function(){var e=document.querySelector(\'[data-act="fx-surround"]\');' +
    'e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  check('3D 环绕已开启', await ev('LXSound.state().surround') === true,
    await ev('LXSound.describe()'));
  await shot('apk-v3-effects.png');

  // 关闭音效后保留配置
  await ev('(function(){var e=document.querySelector(\'[data-act="fx-toggle"]\');' +
    'e.checked=false;e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  await wait('!LXApp.engine.mediaSrc', 10000, '回退原生播放');
  check('关闭音效后回退原生播放', await ev('!LXApp.engine.mediaSrc'));
  check('关闭音效后保留 EQ 与混响配置',
    await ev('LXSound.state().eq[0]') === 6 && await ev('LXSound.state().reverb') === 'hall');
  check('关闭后描述为已关闭', await ev('LXSound.describe()') === '音效已关闭');

  console.log('\n=== F. 下载页音质可手选母带 ===');
  await ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_download";LXApp.render();return true;})()');
  const dlOptions = await ev("Array.prototype.map.call(document.querySelectorAll('[data-act=\"dl-quality\"] option'),function(o){return o.value;}).join(',')");
  check('下载页音质下拉含母带', String(dlOptions).indexOf('master') >= 0, dlOptions);
  check('下拉共 9 档', String(dlOptions).split(',').length === 9,
    String(dlOptions).split(',').length);

  await ev('(function(){var s=document.querySelector(\'[data-act="dl-quality"]\');' +
    's.value="master";s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  check('手动选中母带', await ev('LXDownload.opts.quality') === 'master',
    await ev('LXDownload.opts.quality'));

  await click('[data-act="dl-add-current"]');
  await new Promise(r => setTimeout(r, 400));
  await click('[data-act="dl-enqueue-at-quality"][data-q="master"], [data-act="menu-download"][data-q="master"]');
  await new Promise(r => setTimeout(r, 800));
  const jobQ = await ev('(function(){var a=LXDownload.all();return a.length?a[0].quality:"";})()');
  check('任务按母带入队（不被预先降档）', jobQ === 'master', jobQ);
  await shot('apk-v3-download-master-page.png');

  ws.close();
  const report = {
    ranAt: new Date().toISOString(),
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    failed: fail.length,
    checks: checks
  };
  fs.writeFileSync(path.join(OUT, 'device-player-check.json'), JSON.stringify(report, null, 2));
  console.log('\n' + '='.repeat(56));
  console.log((fail.length ? 'FAILED: ' + fail.join(' | ') : '全部通过') +
    '   ' + report.passed + ' / ' + report.total);
  if (fail.length) process.exitCode = 1;
}

main().catch(e => {
  console.error('验收脚本异常: ' + (e && e.stack || e));
  process.exit(2);
});
