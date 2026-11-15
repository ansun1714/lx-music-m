/* APK 专用注入补丁（只写进 assets/index.html，不修改桌面版 app/ 源码）
 * 桌面浏览器的 <a download> + blob: 在 WebView 里不会触发系统下载，
 * 这里把备份/设置导出的 Blob 文本读出后交给 EchoBridge.saveText 写入
 * Download/LX Music 目录。歌曲 WAV 走 download.js 的 EchoBridge 分块桥，不经过这里。
 */
(function () {
  'use strict';
  window.__LX_ANDROID__ = true;
  if (!window.EchoBridge || !window.EchoBridge.saveText) return;

  function readBlobText(url, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.responseType = 'text';
      x.onload = function () { cb(String(x.responseText || x.response || '')); };
      x.onerror = function () { cb(''); };
      x.send();
    } catch (e) { cb(''); }
  }

  try {
    var proto = HTMLAnchorElement.prototype;
    var orig = proto.click;
    proto.click = function () {
      try {
        var name = this.getAttribute('download');
        var href = this.href || '';
        if (name && href.indexOf('blob:') === 0) {
          readBlobText(href, function (txt) {
            window.EchoBridge.saveText(name, txt);
            if (window.LXApp && window.LXApp.toast) window.LXApp.toast('已保存到 Download/LX Music');
          });
          return;
        }
      } catch (e) { /* 回退到浏览器默认行为 */ }
      return orig.apply(this, arguments);
    };
  } catch (e) { /* 环境不支持时保持原状 */ }
})();
