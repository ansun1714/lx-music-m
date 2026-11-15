/**
 * EchoBridge（HarmonyOS 版）
 *
 * 与 Android 的 MainActivity 保持同一套 ABI：JS 侧 app/ 目录下的代码一行都不用改。
 *   JS → 原生：httpRequest / cancelRequest / downloadStart / downloadCancel / downloadClear /
 *              downloadPartialSize / saveDownloadStart|Chunk|Finish / saveText /
 *              pickScript / pickScriptPull / pickScriptAck / toast / exitApp /
 *              localMediaUrl / mediaProxyBase
 *   原生 → JS：window.LXHttp.onChunkStart|onChunk|onResponse
 *              window.LXDownloadBridge.onProgress|onDone|onError
 *              window.LXFilePick.__onChunk|__onDone|__onFail
 *
 * 与 Android 的两处语义差异（鸿蒙没有等价能力）：
 *   1. 落盘位置：Android 写 MediaStore 的 Download/LX Music，这里写应用沙箱 filesDir/downloads，
 *      localMediaUrl() 负责把它变成页面可播的地址。
 *   2. mediaProxyBase() 返回空串：不启用应用内 HTTPS 代理，音效改走 httpRequest 取字节 → Blob。
 */
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { promptAction } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0001;
const TAG: string = 'LXMusicBridge';

/** 与 APK 一致的上限：二进制 24MB（音效取字节），文本 8MB（音源接口 / 脚本） */
const LIMIT_BINARY: number = 24 * 1024 * 1024;
const LIMIT_TEXT: number = 8 * 1024 * 1024;
/** 单次注入 JS 的 Base64 块上限，控制 runJavaScript 载荷 */
const CHUNK_BYTES: number = 120000;
/** 下载进度回调节流 */
const PROGRESS_MS: number = 250;

interface DownloadJob {
  partPath: string;
  destPath: string;
  fd: number;
  received: number;
  total: number;
  lastEmit: number;
  cancelled: boolean;
}

export class EchoBridge {
  private ctx: common.UIAbilityContext | null = null;
  private web: webview.WebviewController | null = null;
  private httpCalls: Map<string, http.HttpRequest> = new Map<string, http.HttpRequest>();
  private downloads: Map<string, DownloadJob> = new Map<string, DownloadJob>();
  private pickAcked: boolean = false;

  init(ctx: common.UIAbilityContext, web: webview.WebviewController): void {
    this.ctx = ctx;
    this.web = web;
  }

  /* ------------------------------------------------------------ 基础设施 */

  private runJs(code: string): void {
    const w = this.web;
    if (w === null) {
      return;
    }
    w.runJavaScript(code).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'runJavaScript failed: %{public}s', err.message);
    });
  }

  private jsJson(v: string | number | boolean): string {
    return JSON.stringify(v).toString();
  }

  private filesDir(): string {
    const c = this.ctx;
    return c === null ? '' : c.filesDir;
  }

  private cacheDir(): string {
    const c = this.ctx;
    return c === null ? '' : c.cacheDir;
  }

  private mkdirSafe(p: string): void {
    try {
      if (!fs.accessSync(p)) {
        fs.mkdirSync(p, true);
      }
    } catch (e) {
      try {
        fs.mkdirSync(p, true);
      } catch (e2) {
        hilog.error(DOMAIN, TAG, 'mkdir failed: %{public}s', p);
      }
    }
  }

  private safeName(name: string): string {
    let n: string = name.replace(/[\\/:*?"<>|]/g, '_');
    if (n.length === 0) {
      n = 'unnamed';
    }
    return n;
  }

  private safeKey(key: string): string {
    return this.safeName(key);
  }

  /* ------------------------------------------------------------ 媒体地址 */

  /** Android 返回应用内 HTTPS 代理前缀；鸿蒙没有等价物，返回空串＝不启用代理 */
  mediaProxyBase(): string {
    return '';
  }

  /** 把沙箱里的已下载文件变成页面可播地址 */
  localMediaUrl(relPath: string): string {
    if (relPath === null || relPath === undefined || relPath.length === 0) {
      return '';
    }
    let p: string = String(relPath).replace('\\', '/');
    while (p.startsWith('/')) {
      p = p.substring(1);
    }
    if (p.indexOf('..') >= 0) {
      return '';
    }
    const base: string = this.filesDir() + '/downloads/';
    const full: string = p.startsWith('downloads/') ? this.filesDir() + '/' + p : base + p;
    try {
      if (!fs.accessSync(full)) {
        return '';
      }
    } catch (e) {
      return '';
    }
    return 'file://' + full;
  }

  /* ------------------------------------------------------------ HTTP */

  httpRequest(key: string, url: string, method: string, headersJson: string,
               body: string, timeoutStr: string, binaryFlag: string): void {
    const binary: boolean = String(binaryFlag) === '1';
    const limit: number = binary ? LIMIT_BINARY : LIMIT_TEXT;
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(headersJson === null ? '{}' : headersJson) as Record<string, string>;
    } catch (e) {
      headers = {};
    }
    const timeout: number = Math.min(Number(timeoutStr) || 30000, 90000);
    const req: http.HttpRequest = http.createHttp();
    this.httpCalls.set(key, req);

    let received: number = 0;
    let chunkIndex: number = 0;
    let respHeaders: string = '{}';
    let finished: boolean = false;
    let statusCode: number = 0;

    const settleError = (msg: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.httpCalls.delete(key);
      try {
        req.destroy();
      } catch (e) {
      }
      this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',' + this.jsJson(msg) +
        ',0,"","{}","",false)');
    };

    this.runJs('window.LXHttp&&LXHttp.onChunkStart(' + this.jsJson(key) + ',0)');

    req.on('headersReceive', (h: Object) => {
      try {
        const s: string = JSON.stringify(h);
        respHeaders = s.length === 0 ? '{}' : s;
      } catch (e) {
        respHeaders = '{}';
      }
    });

    req.on('dataReceive', (data: ArrayBuffer) => {
      if (finished) {
        return;
      }
      if (data === null || data.byteLength === 0) {
        return;
      }
      received += data.byteLength;
      if (received > limit) {
        settleError('响应过大（超过 ' + Math.floor(limit / 1048576) + 'MB）');
        return;
      }
      const u8: Uint8Array = new Uint8Array(data);
      const helper: util.Base64Helper = new util.Base64Helper();
      for (let off: number = 0; off < u8.length; off += CHUNK_BYTES) {
        const end: number = Math.min(off + CHUNK_BYTES, u8.length);
        const part: string = helper.encodeToStringSync(u8.slice(off, end));
        this.runJs('window.LXHttp&&LXHttp.onChunk(' + this.jsJson(key) + ',' + chunkIndex + ',' +
          this.jsJson(part) + ')');
        chunkIndex++;
      }
    });

    const options: http.HttpRequestOptions = {
      method: method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
      header: headers,
      connectTimeout: timeout,
      readTimeout: timeout,
      expectDataType: http.HttpDataType.ARRAY_BUFFER
    };
    if (body !== null && body !== undefined && body.length > 0) {
      options.extraData = body;
    }

    req.requestInStream(url, options, (err: BusinessError, code: number) => {
      if (finished) {
        return;
      }
      finished = true;
      this.httpCalls.delete(key);
      if (err) {
        this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',' +
          this.jsJson(err.message || 'request failed') + ',0,"","{}","",false)');
        return;
      }
      statusCode = code;
      this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',null,' + statusCode +
        ',"",' + this.jsJson(respHeaders) + ',"",' + binary + ')');
      try {
        req.destroy();
      } catch (e) {
      }
    });
  }

  cancelRequest(key: string): void {
    const req = this.httpCalls.get(key);
    if (req !== undefined) {
      this.httpCalls.delete(key);
      try {
        req.destroy();
      } catch (e) {
      }
    }
  }

  /* ------------------------------------------------------------ 流式下载 */

  downloadStart(key: string, url: string, headersJson: string, filename: string,
                mime: string, dir: string): void {
    const name: string = this.safeName(filename === null || filename === undefined ? 'song.bin' : filename);
    const partDir: string = this.cacheDir() + '/lx-dl';
    const destDir: string = this.filesDir() + '/downloads';
    this.mkdirSafe(partDir);
    this.mkdirSafe(destDir);
    const partPath: string = partDir + '/' + this.safeKey(key) + '.part';
    const destPath: string = destDir + '/' + name;

    let offset: number = 0;
    try {
      if (fs.accessSync(partPath)) {
        offset = fs.statSync(partPath).size;
      }
    } catch (e) {
      offset = 0;
    }

    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(headersJson === null ? '{}' : headersJson) as Record<string, string>;
    } catch (e) {
      headers = {};
    }
    if (offset > 0) {
      headers['Range'] = 'bytes=' + offset + '-';
    }

    let fd: number = -1;
    try {
      fd = fs.openSync(partPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND).fd;
    } catch (e) {
      this.emitDownloadError(key, '无法创建临时文件');
      return;
    }

    const job: DownloadJob = {
      partPath: partPath,
      destPath: destPath,
      fd: fd,
      received: offset,
      total: 0,
      lastEmit: 0,
      cancelled: false
    };
    this.downloads.set(key, job);

    const req: http.HttpRequest = http.createHttp();
    this.httpCalls.set('dl:' + key, req);

    req.on('headersReceive', (h: Object) => {
      try {
        const parsed: Record<string, string> = JSON.parse(JSON.stringify(h)) as Record<string, string>;
        const len: string = parsed['content-length'];
        if (len !== undefined && len !== null) {
          job.total = Number(len) + offset;
        }
      } catch (e) {
      }
    });

    req.on('dataReceive', (data: ArrayBuffer) => {
      if (job.cancelled || data === null || data.byteLength === 0) {
        return;
      }
      try {
        fs.writeSync(job.fd, data);
      } catch (e) {
        this.emitDownloadError(key, '写入文件失败');
        return;
      }
      job.received += data.byteLength;
      const now: number = Date.now();
      if (now - job.lastEmit >= PROGRESS_MS) {
        job.lastEmit = now;
        this.runJs('window.LXDownloadBridge&&LXDownloadBridge.onProgress(' + this.jsJson(key) + ',' +
          job.received + ',' + job.total + ')');
      }
    });

    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: headers,
      connectTimeout: 30000,
      readTimeout: 60000,
      expectDataType: http.HttpDataType.ARRAY_BUFFER
    };

    req.requestInStream(url, options, (err: BusinessError, code: number) => {
      this.httpCalls.delete('dl:' + key);
      if (job.cancelled) {
        return;
      }
      try {
        fs.closeSync(job.fd);
      } catch (e) {
      }
      this.downloads.delete(key);
      if (err || code >= 400) {
        const msg: string = err ? (err.message || '下载失败') : ('HTTP ' + code);
        this.emitDownloadError(key, msg);
        return;
      }
      try {
        try {
          fs.unlinkSync(job.destPath);
        } catch (e) {
        }
        fs.renameSync(job.partPath, job.destPath);
      } catch (e) {
        this.emitDownloadError(key, '保存文件失败');
        return;
      }
      this.runJs('window.LXDownloadBridge&&LXDownloadBridge.onDone(' + this.jsJson(key) + ',' +
        this.jsJson(job.destPath) + ',' + job.received + ')');
    });
  }

  private emitDownloadError(key: string, msg: string): void {
    this.runJs('window.LXDownloadBridge&&LXDownloadBridge.onError(' + this.jsJson(key) + ',' +
      this.jsJson(msg) + ')');
  }

  downloadCancel(key: string): void {
    const job = this.downloads.get(key);
    if (job !== undefined) {
      job.cancelled = true;
      try {
        fs.closeSync(job.fd);
      } catch (e) {
      }
      this.downloads.delete(key);
    }
    const req = this.httpCalls.get('dl:' + key);
    if (req !== undefined) {
      this.httpCalls.delete('dl:' + key);
      try {
        req.destroy();
      } catch (e) {
      }
    }
    this.emitDownloadError(key, '已暂停');
  }

  downloadClear(key: string): void {
    const partPath: string = this.cacheDir() + '/lx-dl/' + this.safeKey(key) + '.part';
    try {
      fs.unlinkSync(partPath);
    } catch (e) {
    }
  }

  downloadPartialSize(key: string): number {
    const partPath: string = this.cacheDir() + '/lx-dl/' + this.safeKey(key) + '.part';
    try {
      if (fs.accessSync(partPath)) {
        return fs.statSync(partPath).size;
      }
    } catch (e) {
    }
    return 0;
  }

  /* ------------------------------------------------------------ 分块保存（设置导出 / 备份） */

  private saveBuf: string[] = [];
  private saveName: string = '';

  saveDownloadStart(name: string, mime: string): void {
    this.saveName = this.safeName(name === null || name === undefined ? 'export.bin' : name);
    this.saveBuf = [];
  }

  saveDownloadChunk(b64: string): void {
    if (b64 !== null && b64 !== undefined && b64.length > 0) {
      this.saveBuf.push(b64);
    }
  }

  saveDownloadFinish(): void {
    const dir: string = this.filesDir() + '/downloads';
    this.mkdirSafe(dir);
    const path: string = dir + '/' + this.saveName;
    let ok: boolean = true;
    try {
      const helper: util.Base64Helper = new util.Base64Helper();
      const data: Uint8Array = helper.decodeSync(this.saveBuf.join(''));
      const f = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(f.fd, data.buffer);
      fs.closeSync(f.fd);
    } catch (e) {
      ok = false;
    }
    this.saveBuf = [];
    this.toast(ok ? ('已保存到 ' + path) : '保存失败');
  }

  saveText(name: string, text: string): void {
    const dir: string = this.filesDir() + '/downloads';
    this.mkdirSafe(dir);
    const path: string = dir + '/' + this.safeName(name === null || name === undefined ? 'export.txt' : name);
    try {
      const f = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(f.fd, text === null ? '' : text);
      fs.closeSync(f.fd);
      this.toast('已保存到 ' + path);
    } catch (e) {
      this.toast('保存失败');
    }
  }

  /* ------------------------------------------------------------ 导入音源 */

  /**
   * 读 picker 返回的 uri。
   * 注意：picker 给的是 docs:// URI，fs.readTextSync(uri) 读不了（真机实测直接抛错，
   * 表现为「读取文件失败」），必须 openSync 后按字节读。
   */
  private readUriText(uri: string): string {
    const file: fs.File = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const parts: Uint8Array[] = [];
    let total: number = 0;
    try {
      while (total < LIMIT_TEXT) {
        const buf: ArrayBuffer = new ArrayBuffer(64 * 1024);
        const n: number = fs.readSync(file.fd, buf);
        if (n <= 0) {
          break;
        }
        parts.push(new Uint8Array(buf.slice(0, n)));
        total += n;
      }
    } finally {
      fs.closeSync(file);
    }
    hilog.info(DOMAIN, TAG, 'pick read %{public}d bytes', total);
    const merged: Uint8Array = new Uint8Array(total);
    let off: number = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.byteLength;
    }
    const dec: util.TextDecoder = util.TextDecoder.create('utf-8');
    return dec.decodeToString(merged);
  }

  pickScript(): void {
    this.pickAcked = false;
    const c = this.ctx;
    if (c === null) {
      this.runJs('window.LXFilePick&&LXFilePick.__onFail("没有应用上下文")');
      return;
    }
    const opts: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    opts.maxSelectNumber = 1;
    opts.fileSuffixFilters = ['音源脚本|.js,.json,.txt'];
    const p: picker.DocumentViewPicker = new picker.DocumentViewPicker(c);
    p.select(opts).then((uris: Array<string>) => {
      if (uris.length === 0) {
        this.runJs('window.LXFilePick&&LXFilePick.__onFail("未选择文件")');
        return;
      }
      const uri: string = uris[0];
      hilog.info(DOMAIN, TAG, 'picked uri: %{public}s', uri);
      const name: string = uri.substring(uri.lastIndexOf('/') + 1);
      // 与 Android 一致：先 __onStart 让 JS 进入接收态并计时，再分块投递
      this.runJs('window.LXFilePick&&LXFilePick.__onStart(' + this.jsJson(name) + ')');
      let text: string = '';
      try {
        text = this.readUriText(uri);
      } catch (e) {
        const err = e as BusinessError;
        const msg: string = err !== null && err !== undefined && err.message !== undefined
          ? err.message : String(e);
        hilog.error(DOMAIN, TAG, 'read uri failed: %{public}s', msg);
        this.runJs('window.LXFilePick&&LXFilePick.__onFail(' + this.jsJson('读取文件失败：' + msg) + ')');
        return;
      }
      if (text.length === 0) {
        this.runJs('window.LXFilePick&&LXFilePick.__onFail("文件内容为空")');
        return;
      }
      const slice: number = 512 * 1024;
      for (let off: number = 0; off < text.length; off += slice) {
        const end: number = Math.min(off + slice, text.length);
        this.runJs('window.LXFilePick&&LXFilePick.__onChunk(' + this.jsJson(text.substring(off, end)) + ')');
      }
      this.runJs('window.LXFilePick&&LXFilePick.__onDone(' + this.jsJson(name) + ')');
      hilog.info(DOMAIN, TAG, 'pick delivered %{public}d chars', text.length);
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'picker failed: %{public}s', err.message || String(err.code));
      if (err.code === 14000001 || (err.message || '').indexOf('cancel') >= 0) {
        this.runJs('window.LXFilePick&&LXFilePick.__onFail("未选择文件")');
        return;
      }
      this.runJs('window.LXFilePick&&LXFilePick.__onFail(' + this.jsJson(err.message || '打开文件选择器失败') + ')');
    });
  }

  pickScriptPull(): void {
    this.pickScript();
  }

  pickScriptAck(): void {
    this.pickAcked = true;
  }

  /* ------------------------------------------------------------ 杂项 */

  toast(msg: string): void {
    try {
      promptAction.showToast({ message: String(msg), duration: 2000 });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'toast failed');
    }
  }

  exitApp(): void {
    const c = this.ctx;
    if (c !== null) {
      c.terminateSelf();
    }
  }
}
