/* 把 app/ 的多文件原型打包成单文件 HTML（供 Android WebView 外壳内嵌）
 * 用法：node evidence/build-standalone.js
 * 输出：app/standalone.html
 *
 * 说明：
 *  - 三个 CSS 内联；icomoon.ttf 以 base64 data URI 内联，避免 WebView 的 file/asset 路径问题
 *  - 八个脚本按 index.html 的加载顺序内联，保持冷启动顺序一致（音源运行时须早于 download/app）
 *  - 脚本里若出现 </script> 字面量会破坏 HTML，因此统一转义
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const OUT = path.join(APP, 'standalone.html');

const CSS = ['theme-fallback.css', 'icons.css', 'styles.css'];
const JS = ['i18n.js', 'themes.js', 'data.js', 'engine.js', 'sound-effects.js',
  'source-api.js', 'sources.js', 'net-crypto.js', 'platform.js', 'quality.js', 'lyrics.js', 'download.js', 'app.js'];

function read(rel) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) throw new Error('缺少文件: ' + p);
  return fs.readFileSync(p, 'utf8');
}

const fontPath = path.join(APP, 'fonts', 'icomoon.ttf');
if (!fs.existsSync(fontPath)) throw new Error('缺少图标字体: ' + fontPath);
const fontB64 = fs.readFileSync(fontPath).toString('base64');

let css = CSS.map(f => '/* ===== ' + f + ' ===== */\n' + read(f)).join('\n\n');
css = css.replace(/url\(["']?fonts\/icomoon\.ttf["']?\)/g,
  'url("data:font/ttf;base64,' + fontB64 + '")');

const scripts = JS.map(f =>
  '<script>/* ===== ' + f + ' ===== */\n' +
  read(f).replace(/<\/script/gi, '<\\/script') +
  '\n</script>'
).join('\n');

const html = read('index.html');
let out = html
  .replace(/<link rel="stylesheet" href="[^"]+">\s*/g, '')
  .replace('</head>', '<style>\n' + css + '\n</style>\n</head>')
  .replace(/<script src="[^"]+"><\/script>\s*/g, '')
  .replace('</body>', scripts + '\n</body>');

fs.writeFileSync(OUT, out, 'utf8');
const stat = fs.statSync(OUT);
console.log('生成 ' + OUT);
console.log('  大小 ' + stat.size + ' B');
console.log('  CSS ' + CSS.length + ' 个，脚本 ' + JS.length + ' 个，字体 base64 ' + fontB64.length + ' 字符');
// 只关心静态标签引用；JS 里拼接的 src="' + x + '" 是运行时封面图（失败自动隐藏），不算
console.log('  剩余外部引用: ' + (/(?:src|href)="(?!data:|#|'|https:\/\/app\.echo\.local\/)/.test(out) ? '有' : '无'));
