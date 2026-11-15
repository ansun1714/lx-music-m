package com.lxmusic.replica;

/* LX Music v1.9.2 界面复现版 · 原生 WebView 外壳
 *
 * - 页面资源全部来自 assets/index.html（由 evidence/build-standalone.js 打包）
 * - 通过 shouldInterceptRequest 把 https://app.echo.local/ 伪装成安全源，
 *   使 localStorage / IndexedDB / Web Audio / Blob 都能在稳定同源下工作
 * - EchoBridge 提供下载分块桥（按音源返回的 mime/ext 写入系统 Download 目录）、备份导出桥
 *   与原生 HTTP 桥（lx.request / 在线导入 / 音频二进制下载，不受浏览器跨域限制）
 * - PickedProvider 提供 content:// 文件，让 WebView 的 <input type=file> 可用于备份与音源导入
 * - v3.1.0 起申请 INTERNET 权限，仅用于用户导入的自定义音源；内置功能仍全部离线
 */

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String ORIGIN_HOST = "app.echo.local";
    private static final String START_URL = "https://" + ORIGIN_HOST + "/index.html";
    /** 允许读写的公共根目录（Android 10+ 分区存储能落盘的公共集合） */
    private static final String[] PUBLIC_ROOTS =
        { "Download", "Music", "Documents", "Pictures", "Movies" };
    /* 下载写入时拿到并记住的 content uri：相对路径 -> uri。
     * Android 13 分区存储下，应用只能读自己写入的那一行，靠 MediaStore 再查一遍可能查不到，
     * 所以写入成功时就把 uri 存下来（内存 + SharedPreferences），/__local 直接按它取流。 */
    private static final java.util.HashMap<String, String> LOCAL_URI_MAP =
        new java.util.HashMap<String, String>();

    private void rememberLocalUri(String relPath, String uri) {
        if (relPath == null || uri == null) return;
        LOCAL_URI_MAP.put(relPath, uri);
        try {
            getSharedPreferences("lx_local", MODE_PRIVATE).edit().putString(relPath, uri).apply();
        } catch (Exception ignored) { }
    }

    private String localUriFor(String relPath) {
        if (relPath == null) return null;
        String u = LOCAL_URI_MAP.get(relPath);
        if (u != null) return u;
        try {
            u = getSharedPreferences("lx_local", MODE_PRIVATE).getString(relPath, null);
        } catch (Exception ignored) { }
        if (u != null) LOCAL_URI_MAP.put(relPath, u);
        return u;
    }
    private static final String AUTHORITY = "com.lxmusic.replica.picked";
    private static final int REQ_PICK_FILE = 1001;
    private static final int REQ_PICK_SCRIPT = 1002;
    private static final int PICK_CHUNK = 120000;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    /* 原生文件选择结果暂存：用户从系统文件选择器返回时，WebView 可能已被系统回收，
     * 结果会丢失。这里保存在进程内存中，页面重建后由 pickScriptPull() 主动取回。 */
    private static String sPickName = null;
    private static String sPickText = null;
    private static boolean sPickNeedDeliver = false;
    private static boolean sPickAcked = true;

    /* 返回键：交给页面处理（关浮层 → 回搜索主页），页面不消费时才退出。
     * v3.9.0 修正：evaluateJavascript 会把字符串结果序列化成带引号的 JSON（"true"），
     * 老实现用 "true".equals(value) 永远不成立 —— 这才是「按返回直接退出」的真正原因。
     * 现在 JS 直接返回布尔值，Java 侧再去一次引号兜底。 */
    private static final String BACK_JS =
        "(function(){try{" +
        "if(window.LXApp&&typeof LXApp.handleBack==='function')" +
        "return !!LXApp.handleBack();" +
        "var r=document.getElementById('modalRoot')," +
        "m=document.getElementById('contextMenu')," +
        "d=document.getElementById('drawer')," +
        "o=window.LXApp&&window.LXApp.state&&window.LXApp.state.overlay;" +
        "var open=!!o||(r&&!r.classList.contains('hidden'))||" +
        "(m&&!m.classList.contains('hidden'))||(d&&d.classList.contains('open'));" +
        "if(open){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;}" +
        "return false;}catch(e){return false;}})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        WebView.setWebContentsDebuggingEnabled(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 页面是伪 https 安全源；自定义音源常返回 http 音频/接口，需允许混合内容
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // 只接管离线资产域；音源返回的在线音频 / 图片交给 WebView 走真实网络
                if (!ORIGIN_HOST.equals(request.getUrl().getHost())) return null;
                return serve(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                return !(ORIGIN_HOST.equals(u.getHost()) && "https".equals(u.getScheme()));
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // 资源全部离线，忽略 favicon 之类的可选项
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent;
                try {
                    intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                } catch (Exception e) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(intent, REQ_PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new EchoBridge(), "EchoBridge");
        web.loadUrl(START_URL);
    }

    /* ---------------------------------------------------------- 离线资产服务 */
    private WebResourceResponse serve(WebResourceRequest req) {
        Uri u = req.getUrl();
        if (!ORIGIN_HOST.equals(u.getHost())) return emptyResponse();
        String path = u.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        // 媒体代理：把远端音频搬到本源下转发，Web Audio 才不会因跨域被静音
        if ("/__media".equals(path)) return proxyMedia(req, u);
        // 本地文件回放：已下载并保存到公共目录的歌曲直接在应用内播放（离线可用、不用再联网）
        if ("/__local".equals(path)) return serveLocalMedia(req, u);
        String asset = path.startsWith("/") ? path.substring(1) : path;
        try {
            AssetManager am = getAssets();
            InputStream in = am.open(asset);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mimeOf(asset), "UTF-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return emptyResponse();
        }
    }

    /* 媒体代理实现
     * - 透传 Range，返回真实状态码（206 + Content-Range），否则 <audio> 无法拖动进度
     * - 音源地址需要的 Referer / UA 等由 JS 侧以 base64(JSON) 传入
     * - 流式返回，边读边给 WebView，不会把整首歌读进内存 */
    private WebResourceResponse proxyMedia(WebResourceRequest req, Uri u) {
        HttpURLConnection conn = null;
        try {
            String target = decodeB64(u.getQueryParameter("u"));
            if (target == null || target.length() == 0) return emptyResponse();
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(25000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/110 Mobile Safari/537.36");
            conn.setRequestProperty("Accept", "*/*");
            String hs = decodeB64(u.getQueryParameter("h"));
            if (hs != null && hs.length() > 1) {
                JSONObject o = new JSONObject(hs);
                Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if ("Range".equalsIgnoreCase(k) || "Accept-Encoding".equalsIgnoreCase(k)) continue;
                    conn.setRequestProperty(k, o.optString(k, ""));
                }
            }
            String range = null;
            Map<String, String> rh = req.getRequestHeaders();
            if (rh != null) {
                for (Map.Entry<String, String> e : rh.entrySet()) {
                    if ("range".equalsIgnoreCase(e.getKey())) { range = e.getValue(); break; }
                }
            }
            if (range != null) conn.setRequestProperty("Range", range);

            int code = conn.getResponseCode();
            Map<String, String> h = new HashMap<String, String>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Access-Control-Allow-Headers", "*");
            h.put("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
            h.put("Accept-Ranges", "bytes");
            h.put("Cache-Control", "no-store");
            String cr = conn.getHeaderField("Content-Range");
            if (cr != null) h.put("Content-Range", cr);
            String cl = conn.getHeaderField("Content-Length");
            if (cl != null) h.put("Content-Length", cl);
            String ct = conn.getHeaderField("Content-Type");
            String mime = ct == null ? mimeOfMedia(target) : ct.split(";")[0].trim();
            if (!mime.startsWith("audio/") && !mime.startsWith("video/")) mime = mimeOfMedia(target);

            boolean ok = code >= 200 && code < 400;
            InputStream in = ok ? conn.getInputStream() : conn.getErrorStream();
            if (in == null) in = new java.io.ByteArrayInputStream(new byte[0]);
            final HttpURLConnection fc = conn;
            InputStream wrapped = new java.io.FilterInputStream(in) {
                @Override
                public void close() throws IOException {
                    try { super.close(); } catch (IOException ignored) { }
                    try { fc.disconnect(); } catch (Exception ignored) { }
                }
            };
            String reason = code == 206 ? "Partial Content" : (ok ? "OK" : "Error");
            return new WebResourceResponse(mime, null, code, reason, h, wrapped);
        } catch (Exception e) {
            if (conn != null) { try { conn.disconnect(); } catch (Exception ignored) { } }
            Map<String, String> h = new HashMap<String, String>();
            h.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse("audio/mpeg", null, 502, "Bad Gateway", h, null);
        }
    }

    /* 本地已下载文件回放
     * 参数 p = 相对外部存储的路径（例如 Download/LX Music/歌.wav），由下载完成时回报的 path 得来。
     * 用 MediaStore 反查 content uri 再读，避免直接文件系统读取受分区存储限制；
     * 支持 Range（206 + Content-Range），<audio> 才能拖动进度。 */
    private WebResourceResponse serveLocalMedia(WebResourceRequest req, Uri u) {
        InputStream in = null;
        try {
            String rel = u.getQueryParameter("p");
            if (rel == null) return emptyResponse();
            rel = rel.replace('\\', '/');
            while (rel.startsWith("/")) rel = rel.substring(1);
            if (rel.isEmpty() || rel.length() > 120 || rel.contains("..")) return emptyResponse();
            int slash = rel.lastIndexOf('/');
            if (slash < 0) return emptyResponse();
            String dir = rel.substring(0, slash + 1);          // 以 / 结尾，匹配 RELATIVE_PATH
            String name = rel.substring(slash + 1);
            String root = rel.split("/")[0];
            boolean okRoot = false;
            for (String r : PUBLIC_ROOTS) if (r.equalsIgnoreCase(root)) okRoot = true;
            if (!okRoot) return emptyResponse();

            // 1) 下载写入时记下的 content uri：Android 13 分区存储下这是唯一稳定可读的路子
            android.content.res.AssetFileDescriptor afd = null;
            long total = -1;
            String mapped = localUriFor(rel);
            if (mapped != null) {
                try {
                    afd = getContentResolver().openAssetFileDescriptor(Uri.parse(mapped), "r");
                    if (afd != null) total = afd.getLength();
                } catch (Exception e) {
                }
            }
            // 2) 直读路径（旧系统或应用自建文件可用）
            File direct = new File(Environment.getExternalStorageDirectory(), rel);
            boolean directOk = total <= 0 && direct.isFile() && direct.canRead();
            if (directOk) total = direct.length();
            // 3) 媒体库反查兜底
            Uri media = null;
            if (total <= 0 && !directOk && mapped == null) {
                media = findMediaByPath(dir, name);
                if (media != null) {
                    try {
                        afd = getContentResolver().openAssetFileDescriptor(media, "r");
                        if (afd != null) total = afd.getLength();
                    } catch (Exception e) {
                    }
                }
            }
            if (total <= 0 && afd == null && !directOk) {
                return emptyResponse();
            }
            if (total <= 0) total = -1;
            String requestedRange = null;
            Map<String, String> rh = req.getRequestHeaders();
            if (rh != null) {
                for (Map.Entry<String, String> e : rh.entrySet()) {
                    if ("range".equalsIgnoreCase(e.getKey())) { requestedRange = e.getValue(); break; }
                }
            }
            long start = 0, end = total > 0 ? total - 1 : -1;
            boolean partial = false;
            if (requestedRange != null && total > 0) {
                String r = requestedRange.replace("bytes=", "").trim();
                String[] parts = r.split("-");
                try {
                    if (parts.length >= 1 && parts[0].length() > 0) start = Long.parseLong(parts[0].trim());
                    if (parts.length >= 2 && parts[1].length() > 0) end = Long.parseLong(parts[1].trim());
                } catch (NumberFormatException ignored) { start = 0; end = total - 1; }
                if (end < start || end >= total) end = total - 1;
                if (start > 0 || end < total - 1) partial = true;
            }
            if (end < 0) end = -1;

            if (directOk) {
                final java.io.RandomAccessFile raf = new java.io.RandomAccessFile(direct, "r");
                if (start > 0) raf.seek(start);
                in = new java.io.BufferedInputStream(new java.io.FileInputStream(raf.getFD())) {
                    @Override public void close() throws IOException {
                        try { super.close(); } catch (IOException ignored) { }
                        try { raf.close(); } catch (IOException ignored) { }
                    }
                };
            } else {
                if (afd == null) return emptyResponse();
                long skip = afd.getStartOffset() + start;
                in = afd.createInputStream();
                if (skip > 0) {
                    long left = skip;
                    while (left > 0) {
                        long s = in.skip(left);
                        if (s <= 0) break;
                        left -= s;
                    }
                }
            }
            final InputStream fin = in;
            final long limit = (end >= 0 && start >= 0) ? (end - start + 1) : -1;
            InputStream body = new java.io.FilterInputStream(fin) {
                private long left = limit;
                @Override public int read() throws IOException {
                    if (left == 0) return -1;
                    int v = super.read();
                    if (v >= 0 && left > 0) left--;
                    return v;
                }
                @Override public int read(byte[] b, int off, int len) throws IOException {
                    if (left == 0) return -1;
                    if (left > 0 && len > left) len = (int) left;
                    int n = super.read(b, off, len);
                    if (n > 0 && left > 0) left -= n;
                    return n;
                }
            };
            Map<String, String> h = new HashMap<String, String>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
            h.put("Accept-Ranges", "bytes");
            h.put("Cache-Control", "no-cache");
            if (total > 0) {
                h.put("Content-Length", String.valueOf(partial ? (end - start + 1) : total));
                if (partial) h.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
            }
            String mime = mimeOfMedia(name);
            if (partial) return new WebResourceResponse(mime, null, 206, "Partial Content", h, body);
            return new WebResourceResponse(mime, null, 200, "OK", h, body);
        } catch (Exception e) {
            if (in != null) { try { in.close(); } catch (IOException ignored) { } }
            Map<String, String> h = new HashMap<String, String>();
            h.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse("audio/mpeg", null, 404, "Not Found", h, null);
        }
    }

    /** 按 relative_path + display_name 在 MediaStore 里找到刚下载的那一行 */
    private Uri findMediaByPath(String dir, String name) {
        Uri[] pools = new Uri[] {
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            MediaStore.Files.getContentUri("external")
        };
        String sel = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " +
            MediaStore.MediaColumns.DISPLAY_NAME + "=?";
        for (Uri pool : pools) {
            try {
                android.database.Cursor c = getContentResolver().query(pool,
                    new String[] { MediaStore.MediaColumns._ID }, sel, new String[] { dir, name }, null);
                if (c != null) {
                    try {
                        if (c.moveToFirst()) {
                            long id = c.getLong(0);
                            return android.content.ContentUris.withAppendedId(pool, id);
                        }
                    } finally { c.close(); }
                }
            } catch (Exception e) {
            }
        }
        return null;
    }

    private static String decodeB64(String s) {
        if (s == null || s.length() == 0) return null;
        try {
            byte[] raw = Base64.decode(s, Base64.DEFAULT);
            return new String(raw, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private static String mimeOfMedia(String url) {
        String u = String.valueOf(url).toLowerCase();
        int q = u.indexOf('?');
        if (q > 0) u = u.substring(0, q);
        if (u.endsWith(".m4a") || u.endsWith(".mp4") || u.endsWith(".aac")) return "audio/mp4";
        if (u.endsWith(".flac")) return "audio/flac";
        if (u.endsWith(".ogg") || u.endsWith(".opus")) return "audio/ogg";
        if (u.endsWith(".wav")) return "audio/wav";
        return "audio/mpeg";
    }

    private WebResourceResponse emptyResponse() {
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", h, null);
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".ttf")) return "font/ttf";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /* ---------------------------------------------------------- 文件选择回调 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_SCRIPT) {
            onScriptPicked(resultCode, data);
            return;
        }
        if (requestCode != REQ_PICK_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            Uri src = data.getData();
            // 部分厂商文件选择器只返回 ClipData，getData() 为 null
            if (src == null && data.getClipData() != null && data.getClipData().getItemCount() > 0)
                src = data.getClipData().getItemAt(0).getUri();
            if (src != null) {
                try {
                    byte[] bytes = readAll(getContentResolver().openInputStream(src));
                    String name = displayName(src);
                    PickedProvider.put(name, bytes);
                    Uri picked = new Uri.Builder().scheme("content")
                        .authority(AUTHORITY).path("picked/" + name).build();
                    // WebView 渲染进程是独立 UID，需显式授权读取
                    try {
                        grantUriPermission(getPackageName(), picked, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (Exception ignored) { }
                    results = new Uri[] { picked };
                } catch (Exception e) {
                    Toast.makeText(this, "读取文件失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            }
        } else {
            Toast.makeText(this, "未选择文件", Toast.LENGTH_SHORT).show();
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    /* ------------------------------------------------ 原生音源脚本选择（v3.1.1）
     * 不经过 WebView 的 <input type=file> / onShowFileChooser / content:// / FileReader：
     * Java 直接读字节并按 UTF-8 解码，分块 evaluateJavascript 回传脚本文本，
     * 从根上避开「游离 <input>.click() 被 WebView 忽略」与跨进程 content 权限问题。 */
    private void onScriptPicked(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            failPick("已取消选择");
            return;
        }
        Uri uri = data.getData();
        if (uri == null && data.getClipData() != null && data.getClipData().getItemCount() > 0)
            uri = data.getClipData().getItemAt(0).getUri();
        if (uri == null) { failPick("未选择文件"); return; }
        try {
            byte[] bytes = readAll(getContentResolver().openInputStream(uri));
            String name = displayName(uri);
            String text = new String(bytes, "UTF-8");
            if (text.length() > 0 && text.charAt(0) == '\uFEFF') text = text.substring(1);
            sPickName = name;
            sPickText = text;
            sPickAcked = false;
            sPickNeedDeliver = false;
            deliverPick();
        } catch (Exception e) {
            failPick("读取文件失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private void deliverPick() {
        if (sPickText == null) return;
        final String name = sPickName == null ? "script.js" : sPickName;
        final String text = sPickText;
        final List<String> scripts = new ArrayList<String>();
        scripts.add("if(window.LXFilePick)window.LXFilePick.__onStart(" + JSONObject.quote(name) + ");");
        for (int i = 0; i < text.length(); i += PICK_CHUNK) {
            scripts.add("if(window.LXFilePick)window.LXFilePick.__onChunk(" +
                JSONObject.quote(text.substring(i, Math.min(text.length(), i + PICK_CHUNK))) + ");");
        }
        scripts.add("if(window.LXFilePick)window.LXFilePick.__onDone(" + JSONObject.quote(name) + ");");
        sPickNeedDeliver = true;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web == null) return;
                for (String js : scripts) web.evaluateJavascript(js, null);
            }
        });
    }

    private void failPick(final String msg) {
        sPickText = null;
        sPickNeedDeliver = false;
        sPickAcked = true;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                String js = "if(window.LXFilePick)window.LXFilePick.__onFail(" + JSONObject.quote(msg) + ");" +
                    "else if(window.LXApp&&window.LXApp.toast)window.LXApp.toast(" + JSONObject.quote(msg) + ");";
                // 提示统一由页面 toast 呈现，避免与 Java Toast 重复
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private static byte[] readAll(InputStream in) throws IOException {
        return readAll(in, 0);
    }

    /** 读取全部字节；limit > 0 时超过上限直接抛错，避免大响应把 Java 堆撑爆（v3.13.3）。 */
    private static byte[] readAll(InputStream in, int limit) throws IOException {
        if (in == null) throw new IOException("empty stream");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (limit > 0 && out.size() + n > limit) throw new IOException("响应过大（超过 " + (limit / 1048576) + "MB）");
            out.write(buf, 0, n);
        }
        in.close();
        return out.toByteArray();
    }

    private String displayName(Uri uri) {
        String name = null;
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) name = c.getString(i);
            }
        } catch (Exception e) {
            name = null;
        } finally {
            if (c != null) c.close();
        }
        if (name == null || name.length() == 0) name = "import.json";
        return new File(name).getName();
    }

    /* ---------------------------------------------------------- 系统返回键 */
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript(BACK_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                // 页面消费了（关浮层 / 回搜索主页）就留在原地，否则才退出
                String v = value == null ? "" : value.replace("\"", "").trim();
                if ("true".equals(v)) return;
                if (isFinishing() || isDestroyed()) return;
                MainActivity.this.finish();
            }
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) { onBackPressed(); return true; }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------------------------------------------------- JS 桥 */
    private class EchoBridge {

        private final StringBuilder pending = new StringBuilder();
        private String pendingName = "";
        private String pendingMime = "audio/wav";
        private final Map<String, HttpURLConnection> httpCalls =
            Collections.synchronizedMap(new HashMap<String, HttpURLConnection>());
        private static final int HTTP_CHUNK = 180000;
        /* v3.13.3：httpRequest 的体积上限。二进制（音效接管取字节）限 24MB，
         * 保证「一首歌（128k/320k MP3、短的无损）能取」，同时不会因为几十 MB 的
         * 无损文件把 Java 堆撑爆（曾经的闪退就是整份 Base64 造成的 OutOfMemoryError）。 */
        private static final int HTTP_BINARY_LIMIT = 24 * 1024 * 1024;
        /* 文本响应（音源接口 JSON / 脚本）限 8MB，防止异常的大响应同样撑爆内存。 */
        private static final int HTTP_TEXT_LIMIT = 8 * 1024 * 1024;

        /* ------------------------------------------------------ 流式下载（v3.4.0）
         * 真实音频动辄几十 MB，不能用 httpRequest 一次性取回 base64。
         * 这里由 Java 直接流式写文件：每 250ms 回传一次进度，支持取消与 Range 续传。
         * 完成后写入 MediaStore 的 Download/LX Music。 */
        private final Map<String, Boolean> downloadCancels =
            Collections.synchronizedMap(new HashMap<String, Boolean>());
        private final Map<String, HttpURLConnection> downloadConns =
            Collections.synchronizedMap(new HashMap<String, HttpURLConnection>());

        /* 音频代理前缀：JS 把远端地址 base64 后拼到 ?u=，由 proxyMedia() 在本源下转发。
         * 目的：音源 CDN 普遍不带 CORS 头，直接接入 Web Audio 会被静音。 */
        @JavascriptInterface
        public String mediaProxyBase() {
            return "https://" + ORIGIN_HOST + "/__media";
        }

        /** v3.13.0：把已保存到公共目录的文件包成应用内可播放的同源地址（离线播放用） */
        @JavascriptInterface
        public String localMediaUrl(String relPath) {
            if (relPath == null || relPath.length() == 0) return "";
            String p = relPath.replace('\\', '/');
            while (p.startsWith("/")) p = p.substring(1);
            if (p.contains("..")) return "";
            try {
                return "https://" + ORIGIN_HOST + "/__local?p=" + java.net.URLEncoder.encode(p, "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void downloadStart(final String key, final String url, final String headersJson,
                                  final String filename, final String mime) {
            downloadStart(key, url, headersJson, filename, mime, null);
        }

        /** v3.12.0：多了 dir 参数，允许设置页自定义落盘目录（相对外部存储，如 Music/LX Music） */
        @JavascriptInterface
        public void downloadStart(final String key, final String url, final String headersJson,
                                  final String filename, final String mime, final String dir) {
            downloadCancels.put(key, false);
            final String relDir = safeRelDir(dir);
            new Thread(new Runnable() {
                @Override public void run() {
                    doStreamDownload(key, url, headersJson, filename, mime, relDir);
                }
            }, "lx-download").start();
        }

        @JavascriptInterface
        public void downloadCancel(final String key) {
            downloadCancels.put(key, true);
            HttpURLConnection c = downloadConns.get(key);
            if (c != null) { try { c.disconnect(); } catch (Exception ignored) { } }
        }

        @JavascriptInterface
        public void downloadClear(final String key) {
            File f = new File(new File(getCacheDir(), "lx-dl"), safeKey(key) + ".part");
            if (f.exists()) f.delete();
        }

        /** 查询某个任务已下载的字节数，用于暂停后续传 */
        @JavascriptInterface
        public long downloadPartialSize(final String key) {
            File f = new File(new File(getCacheDir(), "lx-dl"), safeKey(key) + ".part");
            return f.exists() ? f.length() : 0;
        }

        private String safeKey(String key) {
            return String.valueOf(key).replaceAll("[^A-Za-z0-9_-]", "_");
        }

        private boolean isCancelled(String key) {
            Boolean v = downloadCancels.get(key);
            return v != null && v;
        }

        private void doStreamDownload(String key, String url, String headersJson,
                                      String filename, String mime, String relDir) {
            File dir = new File(getCacheDir(), "lx-dl");
            if (!dir.exists()) dir.mkdirs();
            File part = new File(dir, safeKey(key) + ".part");
            HttpURLConnection conn = null;
            InputStream in = null;
            FileOutputStream out = null;
            try {
                long offset = part.exists() ? part.length() : 0;
                conn = (HttpURLConnection) new URL(url).openConnection();
                downloadConns.put(key, conn);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/110 Mobile Safari/537.36");
                try {
                    JSONObject hs = new JSONObject(headersJson == null ? "{}" : headersJson);
                    Iterator<String> it = hs.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        conn.setRequestProperty(k, hs.optString(k, ""));
                    }
                } catch (Exception ignored) { }
                if (offset > 0) conn.setRequestProperty("Range", "bytes=" + offset + "-");
                int code = conn.getResponseCode();
                if (code >= 400) {
                    replyDownloadError(key, "HTTP " + code);
                    return;
                }
                long total = -1;
                String lenHeader = conn.getHeaderField("Content-Length");
                if (lenHeader != null) {
                    try { total = Long.parseLong(lenHeader.trim()); } catch (Exception ignored) { }
                }
                boolean resume = offset > 0 && code == 206;
                if (!resume) { offset = 0; }
                if (total > 0) total += offset;

                in = conn.getInputStream();
                out = new FileOutputStream(part, resume);
                byte[] buf = new byte[16384];
                long received = offset, lastReport = 0;
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (isCancelled(key)) {
                        replyDownloadError(key, "已暂停");
                        return;
                    }
                    out.write(buf, 0, n);
                    received += n;
                    long now = System.currentTimeMillis();
                    if (now - lastReport > 250) {
                        lastReport = now;
                        replyDownloadProgress(key, received, total);
                    }
                }
                out.flush();
                out.close();
                out = null;
                in.close();
                in = null;

                String path = writeFileToDownloads(filename, mime, part, relDir);
                if (path == null) {
                    replyDownloadError(key, "写入下载目录失败");
                    return;
                }
                long size = part.length();
                part.delete();
                replyDownloadDone(key, path, size);
            } catch (Exception e) {
                String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                replyDownloadError(key, isCancelled(key) ? "已暂停" : msg);
            } finally {
                if (out != null) { try { out.close(); } catch (IOException ignored) { } }
                if (in != null) { try { in.close(); } catch (IOException ignored) { } }
                if (conn != null) { try { conn.disconnect(); } catch (Exception ignored) { } }
                downloadConns.remove(key);
            }
        }

        /** 允许写入的公共根目录（Android 10+ 分区存储能落盘的公共集合） */
        private final String[] PUBLIC_ROOTS = MainActivity.PUBLIC_ROOTS;

        /** 清洗用户填的相对目录：只接受 <公共根>/<子目录...>，默认 Download/LX Music */
        private String safeRelDir(String dir) {
            String def = Environment.DIRECTORY_DOWNLOADS + "/LX Music";   // Download/LX Music
            String d = dir == null ? "" : dir.replace('\\', '/').replaceAll("/{2,}", "/").trim();
            while (d.startsWith("/")) d = d.substring(1);
            while (d.endsWith("/")) d = d.substring(0, d.length() - 1);
            if (d.isEmpty() || d.length() > 80 || d.contains("..")) return def;
            if (!d.matches("[^\\\\:*?\"<>|\\x00-\\x1f]+")) return def;    // 非法字符
            int slash = d.indexOf('/');
            if (slash < 0) return Environment.DIRECTORY_DOWNLOADS + "/" + d;  // 只写子目录 → Download 下
            String root = d.substring(0, slash);
            for (String r : PUBLIC_ROOTS) if (r.equalsIgnoreCase(root)) return d;
            return Environment.DIRECTORY_DOWNLOADS + "/" + d;
        }

        /** 把临时文件写入用户选定的目录（API 29+ 用 MediaStore，无需权限） */
        private String writeFileToDownloads(String name, String mime, File src, String relDir) {
            final String safe = new File(name == null ? "audio.bin" : name).getName();
            final String dir = safeRelDir(relDir);
            String relPath = dir + "/" + safe;
            // Music/ 下的子目录属于 Audio 集合，塞进 Downloads 集合会被系统拒绝（返回 null 或抛 IAE）
            final boolean isMusic = dir.startsWith(Environment.DIRECTORY_MUSIC + "/") ||
                dir.equals(Environment.DIRECTORY_MUSIC);
            InputStream in = null;
            OutputStream os = null;
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, mime == null ? "audio/mpeg" : mime);
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
                    cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri collection = isMusic
                        ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    Uri uri = getContentResolver().insert(collection, cv);
                    if (uri == null && isMusic) {
                        // 少数机型对 Audio 集合的 pending 写入更严格，退回 Downloads 集合再试一次
                        cv.remove(MediaStore.MediaColumns.RELATIVE_PATH);
                        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LX Music");
                        uri = getContentResolver().insert(
                            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                    }
                    if (uri == null) return null;
                    os = getContentResolver().openOutputStream(uri);
                    if (os == null) { getContentResolver().delete(uri, null, null); return null; }
                    in = new FileInputStream(src);
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) >= 0) os.write(buf, 0, n);
                    os.flush();
                    try { os.close(); } catch (IOException ignored) { }
                    os = null;
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(uri, done, null, null);
                    // 系统可能因重名把文件改成 "歌 (1).wav"，回读真实文件名再落记录
                    String actual = safe;
                    try {
                        android.database.Cursor c = getContentResolver().query(uri,
                            new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null);
                        if (c != null) {
                            if (c.moveToFirst()) {
                                String dn = c.getString(0);
                                if (dn != null && dn.length() > 0) actual = dn;
                            }
                            c.close();
                        }
                    } catch (Exception ignored) { }
                    relPath = dir + "/" + actual;
                    rememberLocalUri(relPath, uri.toString());
                } else {
                    File base = getExternalFilesDir(null);
                    if (base == null) base = getFilesDir();
                    File target = new File(base, dir);
                    if (!target.exists() && !target.mkdirs()) return null;
                    File f = new File(target, safe);
                    in = new FileInputStream(src);
                    os = new FileOutputStream(f);
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) >= 0) os.write(buf, 0, n);
                    os.flush();
                    try { os.close(); } catch (IOException ignored) { }
                    os = null;
                    return f.getAbsolutePath();
                }
                return relPath;
            } catch (Exception e) {
                return null;
            } finally {
                if (os != null) { try { os.close(); } catch (IOException ignored) { } }
                if (in != null) { try { in.close(); } catch (IOException ignored) { } }
            }
        }

        private void replyDownloadProgress(final String key, final long received, final long total) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (web == null) return;
                    web.evaluateJavascript("if(window.LXDownloadBridge&&LXDownloadBridge.onProgress){" +
                        "LXDownloadBridge.onProgress(" + JSONObject.quote(key) + "," + received + "," + total + ");}",
                        null);
                }
            });
        }

        private void replyDownloadDone(final String key, final String path, final long size) {
            downloadCancels.remove(key);
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (web == null) return;
                    web.evaluateJavascript("if(window.LXDownloadBridge&&LXDownloadBridge.onDone){" +
                        "LXDownloadBridge.onDone(" + JSONObject.quote(key) + "," +
                        JSONObject.quote(path) + "," + size + ");}", null);
                    Toast.makeText(MainActivity.this, "已保存到 " + path, Toast.LENGTH_LONG).show();
                }
            });
        }

        private void replyDownloadError(final String key, final String msg) {
            if (!isCancelled(key)) downloadCancels.remove(key);
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (web == null) return;
                    web.evaluateJavascript("if(window.LXDownloadBridge&&LXDownloadBridge.onError){" +
                        "LXDownloadBridge.onError(" + JSONObject.quote(key) + "," +
                        JSONObject.quote(msg) + ");}", null);
                }
            });
        }

        @JavascriptInterface
        public void saveDownloadStart(final String name, final String mime) {
            synchronized (pending) {
                pending.setLength(0);
                // 只取文件名部分，绝不 sanitize：中文曲名是 onDeviceSaved 回调的匹配键
                pendingName = new File(name == null ? "track.wav" : name).getName();
                pendingMime = mime == null ? "audio/wav" : mime;
            }
        }

        @JavascriptInterface
        public void saveDownloadChunk(final String b64) {
            if (b64 == null) return;
            synchronized (pending) { pending.append(b64); }
        }

        @JavascriptInterface
        public void saveDownloadFinish() {
            final String name;
            final String mime;
            final byte[] data;
            synchronized (pending) {
                name = pendingName;
                mime = pendingMime;
                try {
                    data = Base64.decode(pending.toString(), Base64.DEFAULT);
                } catch (Exception e) {
                    notifySaved(name, false, "");
                    return;
                }
                pending.setLength(0);
            }
            writeAsync(name, mime, data);
        }

        /** 备份/设置导出的 JSON 文本（页面用 <a download> + blob:，由 bridge-patch.js 转接） */
        @JavascriptInterface
        public void saveText(final String name, final String text) {
            final String n = new File(name == null ? "lx-music-backup.json" : name).getName();
            byte[] data;
            try { data = (text == null ? "" : text).getBytes("UTF-8"); }
            catch (Exception e) { data = new byte[0]; }
            String lower = n.toLowerCase();
            String mime = lower.endsWith(".js") ? "application/javascript"
                : (lower.endsWith(".lrc") || lower.endsWith(".txt")) ? "text/plain"
                : "application/json";
            writeAsync(n, mime, data);
        }

        /* ------------------------------------------------------ 本地音源脚本选择
         * 供「自定义源管理 → 本地导入」调用；结果由 onScriptPicked → deliverPick 回传，
         * 不依赖 WebView 的 input[type=file]，真机各 ROM 行为一致。 */
        @JavascriptInterface
        public void pickScript() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    sPickName = "script.js";
                    sPickText = null;
                    sPickNeedDeliver = false;
                    sPickAcked = true;
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivityForResult(intent, REQ_PICK_SCRIPT);
                    } catch (ActivityNotFoundException e) {
                        Intent alt = new Intent(Intent.ACTION_GET_CONTENT);
                        alt.addCategory(Intent.CATEGORY_OPENABLE);
                        alt.setType("*/*");
                        try {
                            startActivityForResult(alt, REQ_PICK_SCRIPT);
                        } catch (ActivityNotFoundException e2) {
                            failPick("没有可用的文件选择器");
                        }
                    }
                }
            });
        }

        /** 页面重建后主动取回尚未确认的选择结果 */
        @JavascriptInterface
        public void pickScriptPull() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (sPickText != null && !sPickAcked && sPickNeedDeliver) deliverPick();
                }
            });
        }

        /** JS 侧已消费结果，避免重复导入 */
        @JavascriptInterface
        public void pickScriptAck() { sPickAcked = true; }

        /* ------------------------------------------------------ 原生 HTTP 桥
         * JS 音源通过 lx.request 调用；由 Java 发起请求，绕过 WebView 跨域与 CORS。
         * binary=1 时响应体以 base64 返回，用于按来源格式下载真实音频字节。
         * 大响应分块回传，避免 evaluateJavascript 单次载荷过大。 */
        @JavascriptInterface
        public void httpRequest(final String key, final String url, final String method,
                                final String headersJson, final String body,
                                final String timeoutStr, final String binary) {
            new Thread(new Runnable() {
                @Override public void run() {
                    doHttp(key, url, method, headersJson, body, timeoutStr, "1".equals(binary));
                }
            }, "lx-http").start();
        }

        @JavascriptInterface
        public void cancelRequest(final String key) {
            HttpURLConnection c = httpCalls.get(key);
            if (c != null) { try { c.disconnect(); } catch (Exception ignored) { } }
        }

        private void doHttp(String key, String url, String method, String headersJson,
                            String body, String timeoutStr, boolean binary) {
            HttpURLConnection conn = null;
            try {
                int timeout = 30000;
                try { timeout = Math.min(Math.max(Integer.parseInt(timeoutStr), 1000), 60000); }
                catch (Exception ignored) { }
                String m = (method == null || method.length() == 0) ? "GET" : method.toUpperCase();
                conn = (HttpURLConnection) new URL(url).openConnection();
                httpCalls.put(key, conn);
                conn.setRequestMethod(m);
                conn.setConnectTimeout(timeout);
                conn.setReadTimeout(timeout);
                conn.setInstanceFollowRedirects(true);
                JSONObject hs = new JSONObject(headersJson == null ? "{}" : headersJson);
                Iterator<String> it = hs.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    conn.setRequestProperty(k, hs.optString(k, ""));
                }
                if (body != null && body.length() > 0 && !"GET".equals(m) && !"HEAD".equals(m)) {
                    conn.setDoOutput(true);
                    OutputStream os = conn.getOutputStream();
                    os.write(body.getBytes("UTF-8"));
                    os.flush();
                    try { os.close(); } catch (IOException ignored) { }
                }
                int code = conn.getResponseCode();
                String msg = conn.getResponseMessage() == null ? "" : conn.getResponseMessage();
                JSONObject respHeaders = new JSONObject();
                for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                    if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                    respHeaders.put(e.getKey(), e.getValue().get(0));
                }
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in == null) {
                    replyHttp(key, null, code, msg, respHeaders.toString(), "", binary);
                    return;
                }
                if (binary) {
                    /* v3.13.3 关键修复：以前这里是「整份读进 byte[] → 整体 Base64 → 塞进一个 String」。
                     * 一首 40MB 的无损会同时存在 40MB 的 byte[]、53MB 的 base64 String、以及
                     * ByteArrayOutputStream 扩容时的 200MB 临时拷贝 —— 真机直接 OutOfMemoryError 闪退
                     * （日志：lx-http 线程 Base64.encodeToString / Arrays.copyOf）。
                     * 现在改成「按 256KB 边读边编码、边分块回传」，Java 侧峰值只有一块的字节；
                     * 同时给出体积上限，超限就明确报错让页面保持原生播放，绝不冒险。 */
                    long cl = conn.getContentLength();
                    if (cl > HTTP_BINARY_LIMIT) {
                        replyHttp(key, "文件过大（" + (cl / 1048576) + "MB，上限 " + (HTTP_BINARY_LIMIT / 1048576) + "MB），已跳过音效",
                            0, "", "{}", "", false);
                        return;
                    }
                    streamBinary(key, in, code, msg, respHeaders.toString());
                    return;
                }
                byte[] bytes = readAll(in, HTTP_TEXT_LIMIT);
                String out = new String(bytes, "UTF-8");
                replyHttp(key, null, code, msg, respHeaders.toString(), out, false);
            } catch (Exception e) {
                String em = e.getMessage() == null ? "request failed" : e.getMessage();
                replyHttp(key, em, 0, "", "{}", "", false);
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) { }
                    httpCalls.remove(key);
                }
            }
        }

        /** 二进制响应分块回传：边读边 Base64，每个分块单独 evaluateJavascript，峰值只有一块的尺寸。 */
        private void streamBinary(final String key, InputStream in, int code, String msg, String headers) {
            /* 262143 = 3 × 87381：**必须是 3 的倍数**。Base64 每 3 字节一组，
             * 若块长不是 3 的倍数，末尾会补 '='；多块拼成整串后中间的 '=' 会让 atob 报
             * 「string is not correctly encoded」，整段解码失败（v3.13.3 踩过这个坑）。 */
            int blockSize = 262143;
            byte[] buf = new byte[blockSize];
            long total = 0;
            int index = 0;
            boolean failed = false;
            String errMsg = null;
            try {
                postJs("if(window.LXHttp&&window.LXHttp.onChunkStart)window.LXHttp.onChunkStart("
                    + JSONObject.quote(key) + ",0);");
                while (true) {
                    /* 必须「凑满一整块」再编码：InputStream.read 常常只返回 8KB，
                     * 每段单独 Base64 会各自补 '='，拼起来整串就非法（atob 报 not correctly encoded）。
                     * 块长取 3 的倍数，块内 base64 就没有填充字符。 */
                    int filled = 0;
                    int n;
                    while (filled < blockSize && (n = in.read(buf, filled, blockSize - filled)) > 0) filled += n;
                    if (filled == 0) break;
                    total += filled;
                    if (total > HTTP_BINARY_LIMIT) {
                        failed = true;
                        errMsg = "文件过大（超过 " + (HTTP_BINARY_LIMIT / 1048576) + "MB），已跳过音效";
                        break;
                    }
                    byte[] part = (filled == buf.length) ? buf : java.util.Arrays.copyOf(buf, filled);
                    String b64 = Base64.encodeToString(part, Base64.NO_WRAP);
                    postJs("if(window.LXHttp&&window.LXHttp.onChunk)window.LXHttp.onChunk("
                        + JSONObject.quote(key) + "," + index + "," + JSONObject.quote(b64) + ");");
                    index++;
                }
            } catch (Exception e) {
                failed = true;
                errMsg = e.getMessage() == null ? "读取音频失败" : e.getMessage();
            } finally {
                try { in.close(); } catch (IOException ignored) { }
            }
            if (failed) replyHttp(key, errMsg, 0, "", "{}", "", false);
            else replyHttp(key, null, code, msg, headers, "", true);
        }

        private void postJs(final String js) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (web != null) web.evaluateJavascript(js, null);
                }
            });
        }

        private void replyHttp(final String key, final String error, final int code,
                               final String msg, final String headers, final String body,
                               final boolean binary) {
            final List<String> scripts = new ArrayList<String>();
            String payload = body == null ? "" : body;
            if (payload.length() > HTTP_CHUNK) {
                int total = (payload.length() + HTTP_CHUNK - 1) / HTTP_CHUNK;
                scripts.add("if(window.LXHttp&&window.LXHttp.onChunkStart)window.LXHttp.onChunkStart("
                    + JSONObject.quote(key) + "," + total + ");");
                for (int i = 0; i < total; i++) {
                    int from = i * HTTP_CHUNK;
                    int to = Math.min(payload.length(), from + HTTP_CHUNK);
                    scripts.add("if(window.LXHttp&&window.LXHttp.onChunk)window.LXHttp.onChunk("
                        + JSONObject.quote(key) + "," + i + "," + JSONObject.quote(payload.substring(from, to)) + ");");
                }
                payload = "";
            }
            scripts.add("if(window.LXHttp&&window.LXHttp.onResponse)window.LXHttp.onResponse("
                + JSONObject.quote(key) + ","
                + (error == null ? "null" : JSONObject.quote(error)) + ","
                + code + "," + JSONObject.quote(msg) + "," + JSONObject.quote(headers) + ","
                + JSONObject.quote(payload) + "," + (binary ? "1" : "0") + ");");
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (web == null) return;
                    for (String js : scripts) web.evaluateJavascript(js, null);
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void exitApp() { finish(); }

        private void writeAsync(final String name, final String mime, final byte[] data) {
            new Thread(new Runnable() {
                @Override public void run() {
                    String path = writeToDownloads(name, mime, data);
                    notifySaved(name, path != null, path == null ? "" : path);
                }
            }, "lx-save").start();
        }

        private void notifySaved(final String name, final boolean ok, final String path) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    String js = "if(window.LXDownload&&window.LXDownload.onDeviceSaved){" +
                        "window.LXDownload.onDeviceSaved(" + JSONObject.quote(name) + "," +
                        (ok ? "true" : "false") + "," + JSONObject.quote(path) + ");}";
                    if (web != null) web.evaluateJavascript(js, null);
                    Toast.makeText(MainActivity.this,
                        ok ? "已保存到 " + path : "保存失败", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    /* ---------------------------------------------------------- 写入系统下载目录 */
    private String writeToDownloads(String name, String mime, byte[] data) {
        final String safe = new File(name).getName();
        OutputStream os = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                cv.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/LX Music");
                cv.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return null;
                os = getContentResolver().openOutputStream(uri);
                if (os == null) return null;
                os.write(data);
                os.flush();
                try { os.close(); } catch (IOException ignored) { }
                os = null;
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                return Environment.DIRECTORY_DOWNLOADS + "/LX Music/" + safe;
            } else {
                File base = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (base == null) base = getFilesDir();
                File dir = new File(base, "LX Music");
                if (!dir.exists() && !dir.mkdirs()) return null;
                File f = new File(dir, safe);
                os = new FileOutputStream(f);
                os.write(data);
                os.flush();
                return f.getAbsolutePath();
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (os != null) { try { os.close(); } catch (IOException ignored) { } }
        }
    }
}
