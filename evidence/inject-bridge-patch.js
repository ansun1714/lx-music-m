/* 把 android/bridge-patch.js 注入 standalone.html，产出 HAP 用的 rawfile/index.html。
 * APK 那边由 android/build.py 做同样的事，这里保持一份独立实现，避免两边互相耦合。
 * 用法：node evidence/inject-bridge-patch.js <in.html> <patch.js> <out.html>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [src, patchPath, dest] = process.argv.slice(2);
if (!src || !patchPath || !dest) {
  console.error('用法: node evidence/inject-bridge-patch.js <in.html> <patch.js> <out.html>');
  process.exit(1);
}

const html = fs.readFileSync(src, 'utf8');
const patch = fs.readFileSync(patchPath, 'utf8');
const block = '\n<script>\n/* bridge-patch.js（与 APK 同一份） */\n' + patch + '\n</script>\n';

const out = html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + block;

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out, 'utf8');
console.log('已注入 bridge-patch.js -> ' + dest + '（' + out.length + ' B）');
