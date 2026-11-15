/* 设置页控件专项验收（v3.10.0）
 * 验证：播放速率 / 歌词字体大小 / 界面字体大小 / 下载音质 四个设置项真的能改、能生效、能落盘。
 * 根因回归：点击 <input>/<select> 不再重建设置页（旧版点一下就重渲染，控件还没输入就被销毁）。
 *
 * 用法（两阶段，必须在同一次 shell 调用里做完 adb 操作，daemon 重启会丢 forward）：
 *   node evidence/device-settings-check.js            # 阶段一：改值 + 断言生效 + 截图
 *   node evidence/device-settings-check.js --persist  # 阶段二：冷启动后断言仍然保持
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'evidence');

const PERSIST = process.argv.indexOf('--persist') >= 0;
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
  const openSetting = () => ev('(function(){LXApp.closeOverlay();LXApp.state.nav="nav_setting";' +
    'LXApp.render();return true;})()');
  // 模拟真实用户操作：改值 → input → change（与手指拖动/键入一致）
  const setNum = (sel, v) => ev('(function(){var i=document.querySelector(' + JSON.stringify(sel) + ');' +
    'if(!i)return false;i.value=' + JSON.stringify(String(v)) + ';' +
    'i.dispatchEvent(new Event("input",{bubbles:true}));' +
    'i.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  const cssVar = k => ev("getComputedStyle(document.documentElement).getPropertyValue('" + k + "').trim()");

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  // 冷启动后 WebView 还没跑完 13 个脚本时 LXApp 尚未发布，先等它就绪
  const ready0 = Date.now();
  while (true) {
    let ok = false;
    try { ok = await ev('typeof window.LXApp !== "undefined" && !!LXApp.state'); } catch (e) { ok = false; }
    if (ok) break;
    if (Date.now() - ready0 > 25000) throw new Error('LXApp 未就绪（页面可能停在白屏）');
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('  页面就绪，等待 ' + (Date.now() - ready0) + 'ms');

  if (!PERSIST) {
    console.log('\n=== A. 设置页控件形态（v3.10.0） ===');
    await openSetting();
    const html = await ev('document.getElementById("view").innerHTML');
    check('「播放速率」有滑块', html.indexOf('type="range" data-act="set-num" data-id="playbackRate"') >= 0);
    check('「播放速率」有数字框',
      html.indexOf('class="sr-num" type="number" data-act="set-num" data-id="playbackRate"') >= 0);
    check('「歌词字体大小」有滑块+数字框', html.indexOf('data-act="set-num" data-id="lyricFontSize"') >= 0);
    check('「界面字体大小」有滑块+数字框', html.indexOf('data-act="set-num" data-id="fontSize"') >= 0);
    const dqOpts = await ev("Array.prototype.map.call(document.querySelectorAll('[data-act=\"dl-quality\"] option')," +
      "function(o){return o.value;}).join(',')");
    check('「下载音质」下拉 9 档', String(dqOpts).split(',').length === 9, dqOpts);

    console.log('\n=== B. 根因回归：点击控件不再重建设置页 ===');
    check('点数字框后控件未被重建（旧版可输入前就被销毁）',
      await ev('(function(){var n=document.querySelector(".sr-num[data-id=\\"playbackRate\\"]");' +
        'if(!n)return "no-node";n.setAttribute("data-probe","1");n.click();' +
        'var m=document.querySelector(".sr-num[data-id=\\"playbackRate\\"]");' +
        'return (m&&m.getAttribute("data-probe")==="1")?"kept":"rebuilt";})()') === 'kept');
    check('点下拉后控件未被重建（旧版选不中任何一档）',
      await ev('(function(){var s=document.querySelector(\'[data-act="dl-quality"]\');' +
        'if(!s)return "no-node";s.setAttribute("data-probe","1");s.click();' +
        'var m=document.querySelector(\'[data-act="dl-quality"]\');' +
        'return (m&&m.getAttribute("data-probe")==="1")?"kept":"rebuilt";})()') === 'kept');

    console.log('\n=== C. 播放速率可改 ===');
    await setNum('.sr-num[data-id="playbackRate"]', '1.5');
    check('设置值 = 1.5', await ev('LXApp.state.settings.playbackRate') === 1.5,
      await ev('LXApp.state.settings.playbackRate'));
    check('引擎速率 = 1.5', await ev('LXApp.engine.playbackRate') === 1.5,
      await ev('LXApp.engine.playbackRate'));
    // 空闲时 engine.el 为 null（音频元素在播放时才创建），只需确认引擎记住倍率、播放时会下发
    const elRate = await ev('LXApp.engine.el ? LXApp.engine.el.playbackRate : null');
    check('空闲时记住倍率（有音频元素时同步下发）',
      elRate === null || elRate === 1.5, String(elRate));
    check('滑块与数字框互相同步',
      await ev('document.querySelector(\'input[type=range][data-id="playbackRate"]\').value') === '1.5' &&
      await ev('document.querySelector(\'.sr-num[data-id="playbackRate"]\').value') === '1.5');
    await setNum('.sr-num[data-id="playbackRate"]', '0.8');
    check('反向也能调（0.8×）', await ev('LXApp.engine.playbackRate') === 0.8,
      await ev('LXApp.engine.playbackRate'));
    await setNum('.sr-num[data-id="playbackRate"]', '1.5');

    console.log('\n=== D. 界面字体大小可改 ===');
    const fsBefore = parseFloat(await ev('getComputedStyle(document.querySelector(".sr-name")).fontSize'));
    await setNum('.sr-num[data-id="fontSize"]', '17');
    check('--ui-fs = 1.214', await cssVar('--ui-fs') === '1.214', await cssVar('--ui-fs'));
    const fsAfter = parseFloat(await ev('getComputedStyle(document.querySelector(".sr-name")).fontSize'));
    check('文字实际变大（14→约 17px）', fsAfter > fsBefore + 1.5, fsBefore + ' → ' + fsAfter);
    const iconFs = parseFloat(await ev('getComputedStyle(document.querySelector(".h-btn .lx-icon")).fontSize'));
    check('图标一起缩放（基准 18px → 约 21.85px）', iconFs > 21 && iconFs < 23, iconFs);
    await shot('apk-v310-fontsize.png');
    await setNum('.sr-num[data-id="fontSize"]', '12');
    check('也能调小（12 → 0.857 + 文字变小）',
      await cssVar('--ui-fs') === '0.857' &&
      parseFloat(await ev('getComputedStyle(document.querySelector(".sr-name")).fontSize')) < fsBefore,
      await cssVar('--ui-fs'));
    await setNum('.sr-num[data-id="fontSize"]', '17');

    console.log('\n=== E. 歌词字体大小可改 ===');
    await setNum('.sr-num[data-id="lyricFontSize"]', '22');
    check('--lyric-size = 22px', await cssVar('--lyric-size') === '22px', await cssVar('--lyric-size'));
    const lyricFs = parseFloat(await ev('(function(){var d=document.createElement("div");' +
      'd.className="lyric";d.innerHTML=\'<p class="lc-line"><span class="lc-main">测</span>' +
      '<span class="lc-sub">sub</span></p>\';document.body.appendChild(d);' +
      'var v=parseFloat(getComputedStyle(d.querySelector(".lc-main")).fontSize);d.remove();return v;})()'));
    check('歌词正文实际 22px', lyricFs === 22, lyricFs);
    const subFs = parseFloat(await ev('(function(){var d=document.createElement("div");' +
      'd.className="lyric";d.innerHTML=\'<p class="lc-line"><span class="lc-main">测</span>' +
      '<span class="lc-sub">sub</span></p>\';document.body.appendChild(d);' +
      'var v=parseFloat(getComputedStyle(d.querySelector(".lc-sub")).fontSize);d.remove();return v;})()'));
    check('翻译行按比例（18px 左右）', subFs > 17 && subFs < 19, subFs);
    await setNum('.sr-num[data-id="lyricFontSize"]', '14');
    check('歌词也能调小到 14px', await cssVar('--lyric-size') === '14px', await cssVar('--lyric-size'));
    await setNum('.sr-num[data-id="lyricFontSize"]', '22');

    console.log('\n=== F. 下载音质可改 ===');
    await ev('(function(){var s=document.querySelector(\'[data-act="dl-quality"]\');' +
      's.value="flac";s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    check('下拉可切到「无损音质」', await ev('LXDownload.opts.quality') === 'flac',
      await ev('LXDownload.opts.quality'));
    check('同时写入设置', await ev('LXApp.state.settings.downloadQuality') === 'flac',
      await ev('LXApp.state.settings.downloadQuality'));
    check('切换后下拉仍显示所选档', await ev('document.querySelector(\'[data-act="dl-quality"]\').value') === 'flac',
      await ev('document.querySelector(\'[data-act="dl-quality"]\').value'));
    await new Promise(r => setTimeout(r, 500));
    check('已落盘 localStorage',
      await ev('JSON.parse(localStorage.getItem("lx_state_v1")||"{}").settings.downloadQuality') === 'flac',
      await ev('JSON.parse(localStorage.getItem("lx_state_v1")||"{}").settings.downloadQuality'));
    await ev('(function(){LXApp.state.nav="nav_download";LXApp.render();return true;})()');
    check('下载页的音质下拉同步为无损',
      await ev('document.querySelector(\'[data-act="dl-quality"]\').value') === 'flac',
      await ev('document.querySelector(\'[data-act="dl-quality"]\').value'));
    await openSetting();
    await shot('apk-v310-settings.png');

    // 落盘收尾：save() 是 120ms 防抖，冷启动前必须确认写入 localStorage，否则 kill 进程会丢
    await ev('LXApp.save()');
    await new Promise(r => setTimeout(r, 600));
    const saved = JSON.parse(await ev('localStorage.getItem("lx_state_v1")||"{}"'));
    check('四项设置全部落盘（重启前确认）',
      (saved.settings || {}).playbackRate === 1.5 && (saved.settings || {}).fontSize === 17 &&
      (saved.settings || {}).lyricFontSize === 22 && (saved.settings || {}).downloadQuality === 'flac',
      JSON.stringify(saved.settings || {}));
  } else {
    console.log('\n=== G. 冷启动后设置仍保持（持久化） ===');
    await openSetting();
    check('播放速率保持 1.5', await ev('LXApp.state.settings.playbackRate') === 1.5,
      await ev('LXApp.state.settings.playbackRate'));
    check('引擎启动即按 1.5', await ev('LXApp.engine.playbackRate') === 1.5,
      await ev('LXApp.engine.playbackRate'));
    check('界面字体大小保持 17', await ev('LXApp.state.settings.fontSize') === 17,
      await ev('LXApp.state.settings.fontSize'));
    check('启动即应用 --ui-fs=1.214', await cssVar('--ui-fs') === '1.214', await cssVar('--ui-fs'));
    check('文字确实是放大的',
      parseFloat(await ev('getComputedStyle(document.querySelector(".sr-name")).fontSize')) > 16.5,
      await ev('getComputedStyle(document.querySelector(".sr-name")).fontSize'));
    check('歌词字体大小保持 22', await ev('LXApp.state.settings.lyricFontSize') === 22,
      await ev('LXApp.state.settings.lyricFontSize'));
    check('启动即应用 --lyric-size=22px', await cssVar('--lyric-size') === '22px', await cssVar('--lyric-size'));
    check('下载音质保持无损', await ev('LXDownload.opts.quality') === 'flac',
      await ev('LXDownload.opts.quality'));
    check('设置页下拉显示无损', await ev('document.querySelector(\'[data-act="dl-quality"]\').value') === 'flac',
      await ev('document.querySelector(\'[data-act="dl-quality"]\').value'));
    check('设置页数字框显示 1.5',
      await ev('document.querySelector(\'.sr-num[data-id="playbackRate"]\').value') === '1.5',
      await ev('document.querySelector(\'.sr-num[data-id="playbackRate"]\').value'));
    await shot('apk-v310-persisted.png');
  }

  ws.close();
  const report = {
    ranAt: new Date().toISOString(),
    stage: PERSIST ? 'persist' : 'apply',
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    failed: fail.length,
    checks: checks
  };
  fs.writeFileSync(path.join(OUT, PERSIST ? 'device-settings-persist.json' : 'device-settings-check.json'),
    JSON.stringify(report, null, 2));
  console.log('\n' + '='.repeat(56));
  console.log((fail.length ? 'FAILED: ' + fail.join(' | ') : '全部通过') +
    '   ' + report.passed + ' / ' + report.total);
  if (fail.length) process.exitCode = 1;
}

main().catch(e => {
  console.error('验收脚本异常: ' + (e && e.stack || e));
  process.exit(2);
});
