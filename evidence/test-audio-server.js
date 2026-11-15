/* 本地测试音频服务（验收用）：支持 Range / 并发 / keep-alive
 * 用法：node evidence/test-audio-server.js [port] [file]
 * 模拟器通过 http://10.0.2.2:<port>/test-audio.wav 访问。
 */
'use strict';
const http = require('http');
const fs = require('fs');

const PORT = Number(process.argv[2] || 8080);
const FILE = process.argv[3] || process.env.WAV || 'C:/temp/lx-audio/test-audio.wav';

if (!fs.existsSync(FILE)) {
  console.error('找不到测试音频：' + FILE);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let stat;
  try { stat = fs.statSync(FILE); } catch (e) { res.writeHead(500); res.end('no file'); return; }
  const total = stat.size;
  const range = req.headers.range;
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': 'audio/wav',
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(FILE, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(FILE).pipe(res);
});

server.keepAliveTimeout = 5000;
server.listen(PORT, '0.0.0.0', () => console.log('test-audio-server on :' + PORT + ' → ' + FILE));
