/* 平台榜单 / 歌单在线联通性测试
 * 直接加载 app/platform.js 的真实解析逻辑，用 Node 的 fetch 顶替原生 HTTP 桥，
 * 逐平台验证：榜单目录 → 榜单曲目 → 推荐歌单 → 歌单曲目。
 *
 *   node evidence/platform-live-test.js
 *
 * 该脚本只访问平台公开接口，不涉及任何音源脚本，也不写文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'app', 'platform.js'), 'utf8');

const win = {
  LXData: { addExternalTracks() {} },
  LXSourceAPI: {
    request(url, req, cb) {
      const opt = { method: String((req && req.method) || 'get').toUpperCase(), headers: (req && req.headers) || {} };
      if (opt.method !== 'GET' && req && req.body != null) opt.body = req.body;
      fetch(url, opt).then(async (r) => {
        const text = await r.text();
        cb(null, { statusCode: r.status, headers: {}, body: text }, text);
      }).catch((e) => cb(e, null, null));
    }
  }
};

const sandbox = { window: win, console, setTimeout, clearTimeout, Promise, fetch, URL, JSON, Math, Date };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const P = win.LXPlatform;
const PLATFORMS = P.LIST.map((p) => p.id);

let fail = 0;
const rows = [];

function note(ok, label, detail) {
  rows.push({ ok, label, detail });
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function short(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return s.length > (n || 60) ? s.slice(0, n || 60) + '…' : s;
}

async function run() {
  for (const pf of PLATFORMS) {
    const name = P.nameOf(pf);

    // 1) 榜单目录
    const boards = P.boards(pf);
    note(!!boards.length, `${name} · 榜单目录`, `${boards.length} 个${boards[0] ? '（' + boards[0].name + '）' : ''}`);

    // 2) 榜单曲目
    if (boards.length) {
      const b = boards[0];
      try {
        const r = await P.board(pf, b.id, { limit: 30 });
        const t = r.tracks[0];
        note(r.tracks.length > 0, `${name} · 榜单「${b.name}」`,
          r.tracks.length + ' 首' + (t ? ` · 首曲：${short(t.name, 24)} - ${short(t.singer, 16)} (${t.time})` : ' · ' + short(r.note)));
      } catch (e) {
        note(false, `${name} · 榜单「${b.name}」`, String(e && e.message || e));
      }
    }

    // 3) 推荐歌单
    let lists = [];
    try {
      const r = await P.recommendLists(pf, 1);
      lists = r.lists;
      const l = lists[0];
      note(lists.length > 0, `${name} · 推荐歌单`,
        lists.length + ' 个' + (l ? ` · 首个：${short(l.name, 26)}（${l.count} 首，${short(l.author, 12)}）` : ' · ' + short(r.note)));
    } catch (e) {
      note(false, `${name} · 推荐歌单`, String(e && e.message || e));
    }

    // 4) 歌单曲目
    if (lists.length) {
      try {
        const r = await P.listDetail(pf, lists[0].id);
        const t = r.tracks[0];
        note(r.tracks.length > 0, `${name} · 歌单曲目`,
          r.tracks.length + ' 首' + (t ? ` · 首曲：${short(t.name, 24)} - ${short(t.singer, 16)} (${t.time})` : ''));
      } catch (e) {
        note(false, `${name} · 歌单曲目`, String(e && e.message || e));
      }
    }
  }

  console.log('\n—— 汇总 ——');
  console.log(`${rows.length - fail}/${rows.length} 通过`);
  if (fail) {
    console.log('失败项：');
    rows.filter((r) => !r.ok).forEach((r) => console.log('  · ' + r.label + ' — ' + r.detail));
  }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
