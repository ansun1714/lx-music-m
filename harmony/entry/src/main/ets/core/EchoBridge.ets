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
import { util, taskpool } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { fileShare } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { promptAction } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0D00;
const TAG: string = 'LXMusicBridge';

/** 与 APK 一致的上限：二进制 24MB（音效取字节），文本 8MB（音源接口 / 脚本） */
const LIMIT_BINARY: number = 24 * 1024 * 1024;
const LIMIT_TEXT: number = 8 * 1024 * 1024;
/** 单次注入 JS 的 Base64 块上限，控制 runJavaScript 载荷 */
const CHUNK_BYTES: number = 120000;
/** 下载进度回调节流 */
const PROGRESS_MS: number = 250;

/**
 * 把沙箱文件复制到 picker 返回的目标 URI。
 * 必须在 taskpool 子线程执行：几十到几百 MB 的同步读写放在主线程会触发
 * THREAD_BLOCK_6S，直接被系统强杀（真机实测）。
 */
@Concurrent
function copyFileToUri(srcPath: string, dstUri: string): number {
  const src: fs.File = fs.openSync(srcPath, fs.OpenMode.READ_ONLY);
  const dst: fs.File = fs.openSync(dstUri, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  const step: number = 262144;
  const buf: ArrayBuffer = new ArrayBuffer(step);
  let total: number = 0;
  try {
    while (true) {
      // 注意：ReadOptions.offset 是文件偏移，传 0 会每轮从头重读、无限追加（真机曾写出 4.4GB 坏文件）。
      // 这里不传 options，按 fd 当前位置顺序读，读到 EOF 返回 0。
      const n: number = fs.readSync(src.fd, buf);
      if (n <= 0) {
        break;
      }
      fs.writeSync(dst.fd, buf.slice(0, n));
      total += n;
    }
  } finally {
    fs.closeSync(src.fd);
    fs.closeSync(dst.fd);
  }
  return total;
}

interface SaveItem {
  path: string;
  name: string;
}

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
  /** 尚未执行完成的 runJavaScript 数量，用于保证分块先于 onResponse 落地 */
  private jsPending: number = 0;
  /** 下载完成后是否自动拉起系统保存框（对应设置项「完成后自动保存到设备」） */
  private autoExport: boolean = true;
  /** 用户选定的导出目录 URI（通过「选择文件夹」拿到并持久化授权）；非空时下载完成直接写入，不再弹框 */
  private saveDirUri: string = '';
  /** 保存目录是否已从 preferences 回推给 JS（防止每次 onPageEnd 重复回推） */
  private dirRestored: boolean = false;

  init(ctx: common.UIAbilityContext, web: webview.WebviewController): void {
    this.ctx = ctx;
    this.web = web;
    this.loadSaveDir();
  }

  /* ------------------------------------------------------------ 基础设施 */

  private runJs(code: string): void {
    const w = this.web;
    if (w === null) {
      return;
    }
    this.jsPending++;
    w.runJavaScript(code).then(() => {
      this.jsPending--;
    }).catch((err: BusinessError) => {
      this.jsPending--;
      hilog.error(DOMAIN, TAG, 'runJavaScript failed: %{public}s', err.message);
    });
  }

  /** 等 queue 里的 JS 注入全部执行完再回调，避免 onResponse 抢在分块前面 */
  private waitJsIdle(fn: () => void, tries: number): void {
    if (this.jsPending === 0 || tries <= 0) {
      fn();
      return;
    }
    setTimeout(() => {
      this.waitJsIdle(fn, tries - 1);
    }, 20);
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
    hilog.info(DOMAIN, TAG, 'httpRequest %{public}s %{public}s timeout=%{public}d bin=%{public}d',
      method, url, timeout, binary ? 1 : 0);

    const req: http.HttpRequest = http.createHttp();
    this.httpCalls.set(key, req);

    let received: number = 0;
    let chunkIndex: number = 0;
    let respHeaders: string = '{}';
    let finished: boolean = false;
    const textBuffers: Uint8Array[] = [];

    const settleError = (msg: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.httpCalls.delete(key);
      hilog.error(DOMAIN, TAG, 'httpRequest failed: %{public}s', msg);
      try {
        req.destroy();
      } catch (e) {
      }
      this.waitJsIdle(() => {
        this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',' + this.jsJson(msg) +
          ',0,"","{}","",false)');
      }, 4);
    };

    const emitBinary = (u8: Uint8Array): void => {
      const helper: util.Base64Helper = new util.Base64Helper();
      for (let off: number = 0; off < u8.length; off += CHUNK_BYTES) {
        const end: number = Math.min(off + CHUNK_BYTES, u8.length);
        const part: string = helper.encodeToStringSync(u8.slice(off, end));
        this.runJs('window.LXHttp&&LXHttp.onChunk(' + this.jsJson(key) + ',' + chunkIndex + ',' +
          this.jsJson(part) + ')');
        chunkIndex++;
      }
    };

    const decodeText = (): string => {
      let total: number = 0;
      for (let i: number = 0; i < textBuffers.length; i++) {
        total += textBuffers[i].length;
      }
      const all: Uint8Array = new Uint8Array(total);
      let off: number = 0;
      for (let i: number = 0; i < textBuffers.length; i++) {
        all.set(textBuffers[i], off);
        off += textBuffers[i].length;
      }
      const dec: util.TextDecoder = util.TextDecoder.create('utf-8');
      return dec.decodeToString(all);
    };

    /* 文本响应给 JS 的是原文（不是 Base64），与 APK 桥保持一致，否则 JSON.parse 必失败 */
    const finishOk = (code: number): void => {
      let bodyText: string = '';
      let chunked: number = 0;
      if (!binary) {
        bodyText = decodeText();
        if (bodyText.length > 1000000) {
          for (let i: number = 0; i < bodyText.length; i += CHUNK_BYTES) {
            this.runJs('window.LXHttp&&LXHttp.onChunk(' + this.jsJson(key) + ',' + chunkIndex + ',' +
              this.jsJson(bodyText.substring(i, Math.min(i + CHUNK_BYTES, bodyText.length))) + ')');
            chunkIndex++;
          }
          bodyText = '';
          chunked = 1;
        }
      }
      const jsChars: number = chunked === 1 ? 0 : bodyText.length;
      hilog.info(DOMAIN, TAG, 'done code=%{public}d bytes=%{public}d chars=%{public}d chunked=%{public}d',
        code, received, jsChars, chunked);
      const script: string = 'window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',null,' + code +
        ',"",' + this.jsJson(respHeaders) + ',' + this.jsJson(bodyText) + ',' + binary + ')';
      this.waitJsIdle(() => {
        this.runJs(script);
      }, 4);
    };

    this.runJs('window.LXHttp&&LXHttp.onChunkStart(' + this.jsJson(key) + ',0)');

    req.on('headersReceive', (h: Object) => {
      try {
        const s: string = JSON.stringify(h);
        respHeaders = s.length === 0 ? '{}' : s;
      } catch (e) {
        respHeaders = '{}';
      }
      hilog.info(DOMAIN, TAG, 'headers received');
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
      if (binary) {
        emitBinary(u8);
      } else {
        textBuffers.push(u8.slice(0));
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

    let streamStarted: boolean = false;
    try {
      req.requestInStream(url, options, (err: BusinessError, code: number) => {
        if (finished) {
          return;
        }
        finished = true;
        this.httpCalls.delete(key);
        if (err) {
          hilog.error(DOMAIN, TAG, 'stream callback err: %{public}s', err.message || String(err.code));
          this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',' +
            this.jsJson(err.message || 'request failed') + ',0,"","{}","",false)');
          return;
        }
        finishOk(code);
        try {
          req.destroy();
        } catch (e) {
        }
      });
      streamStarted = true;
      hilog.info(DOMAIN, TAG, 'requestInStream started');
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'requestInStream threw: %{public}s',
        err !== null && err !== undefined && err.message !== undefined ? err.message : String(e));
    }

    if (!streamStarted) {
      hilog.info(DOMAIN, TAG, 'fallback to request()');
      req.request(url, options).then((resp: http.HttpResponse) => {
        if (finished) {
          return;
        }
        finished = true;
        this.httpCalls.delete(key);
        const code: number = resp.responseCode;
        const payload: Object = resp.result;
        if (payload !== null && payload !== undefined && typeof payload === 'object') {
          const u8: Uint8Array = new Uint8Array(payload as ArrayBuffer);
          received = u8.length;
          if (received > limit) {
            settleError('响应过大（超过 ' + Math.floor(limit / 1048576) + 'MB）');
            return;
          }
          emitBinary(u8);
          hilog.info(DOMAIN, TAG, 'request done code=%{public}d bytes=%{public}d', code, received);
          this.waitJsIdle(() => {
            this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',null,' + code +
              ',"",' + this.jsJson(respHeaders) + ',"",true)');
          }, 4);
        } else {
          const text: string = payload === null || payload === undefined ? '' : String(payload);
          hilog.info(DOMAIN, TAG, 'request done code=%{public}d chars=%{public}d', code, text.length);
          this.waitJsIdle(() => {
            this.runJs('window.LXHttp&&LXHttp.onResponse(' + this.jsJson(key) + ',null,' + code +
              ',"",' + this.jsJson(respHeaders) + ',' + this.jsJson(text) + ',false)');
          }, 4);
        }
        try {
          req.destroy();
        } catch (e) {
        }
      }).catch((err: BusinessError) => {
        settleError(err !== null && err !== undefined && err.message !== undefined
          ? err.message : 'request failed');
      });
    }
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
      // 已设置保存文件夹 + 开启「完成后自动保存」：静默写入用户目录，不弹任何框。
      // 这是 Android「下载落 Download/LX Music」在鸿蒙上的等价物（系统不允许应用直写公共目录，
      // 必须用户先经文件夹选择器授权，再由 fileShare.persistPermission 持久化）。
      // 本机 SystemCapability.FileManagement.UserFileService.FolderSelection 缺失：picker 无法选文件夹、
      // fileShare 也拿不到目录授权，故这里不再尝试自动写入（详见 README 的下载章节）。
      if (false) {
        const name: string = job.destPath.substring(job.destPath.lastIndexOf('/') + 1);
        this.saveToDir(job.destPath, this.safeName(name), true);
      }
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

  /** 沙箱路径归一化：JS 可能传绝对路径、file:// 前缀或 downloads/ 相对路径 */
  private resolveDownloadPath(p: string): string {
    if (p === null || p === undefined || p.length === 0) {
      return '';
    }
    let rel: string = p;
    if (rel.startsWith('file://')) {
      rel = rel.substring(7);
    }
    let full: string = rel;
    if (!rel.startsWith('/')) {
      full = rel.startsWith('downloads/') ? this.filesDir() + '/' + rel : this.filesDir() + '/downloads/' + rel;
    }
    try {
      if (!fs.accessSync(full)) {
        return '';
      }
    } catch (e) {
      return '';
    }
    return full;
  }

  /** 把沙箱文件写到用户选定的位置（文件管理器可见），HarmonyOS 无公共目录直写权限 */
  private saveSandboxToUserFile(srcPath: string, name: string, mime: string): void {
    if (this.ctx === null) {
      this.toast('保存失败：上下文未就绪');
      return;
    }
    const opt: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    opt.newFileNames = [name];
    hilog.info(DOMAIN, TAG, 'export picker open: %{public}s', name);
    const vp: picker.DocumentViewPicker = new picker.DocumentViewPicker(this.ctx);
    vp.save(opt).then((uris: string[]) => {
      if (uris === null || uris === undefined || uris.length === 0) {
        return;
      }
      const uri: string = uris[0];
      taskpool.execute(copyFileToUri, srcPath, uri).then((res: Object) => {
        hilog.info(DOMAIN, TAG, 'export ok: %{public}s bytes=%{public}s', uri, String(res));
        // 记住这次保存所在的目录：下次下载完成尝试直接写入，成功即零弹框
        const slash: number = uri.lastIndexOf('/');
        if (slash > 0 && uri.indexOf('://') > 0) {
          this.applySaveDir(uri.substring(0, slash));
        }
        this.toast('已保存到文件管理器');
      }).catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'export write failed: %{public}s',
          err !== null && err !== undefined && err.message !== undefined ? err.message : String(err));
        this.toast('保存失败');
      });
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'export cancelled: %{public}s',
        err !== null && err !== undefined && err.message !== undefined ? err.message : '');
      this.toast('已取消保存');
    });
  }

  /**
   * 设置开关：下载完成后是否自动弹出系统保存框。
   * JS: EchoBridge.setAutoExport('1' | '0')
   */
  setAutoExport(flag: string): void {
    this.autoExport = String(flag) === '1';
    hilog.info(DOMAIN, TAG, 'autoExport=%{public}d', this.autoExport ? 1 : 0);
  }

  /**
   * 让用户选一个「下载保存文件夹」，并持久化读写授权。
   * 之后下载完成即可零弹框直接写入该目录。
   * JS: EchoBridge.pickExportDir() → window.LXSaveDir.onDir(uri) / onFail(msg)
   */
  pickExportDir(): void {
    const c: common.UIAbilityContext | null = this.ctx;
    if (c === null) {
      return;
    }
    const opts: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    // SDK 15 的枚举只声明了 FILE；FOLDER(1) 在新系统上才生效，不支持时 select() 会抛错并走回退
    opts.selectMode = 1 as picker.DocumentSelectMode;
    opts.maxSelectNumber = 1;
    hilog.info(DOMAIN, TAG, 'pick dir: open picker mode=%{public}d', opts.selectMode as number);
    const vp: picker.DocumentViewPicker = new picker.DocumentViewPicker(c);
    vp.select(opts).then((uris: string[]) => {
      const n: number = (uris === null || uris === undefined) ? 0 : uris.length;
      hilog.info(DOMAIN, TAG, 'pick dir: returned %{public}d uri, first=%{public}s', n, n > 0 ? uris[0] : 'none');
      if (n === 0) {
        this.toast('没有选到文件夹（当前系统可能只支持选文件）');
        this.runJs('window.LXSaveDir&&window.LXSaveDir.onFail(' + this.jsJson('未选择文件夹') + ')');
        return;
      }
      let uri: string = uris[0];
      if (uri.endsWith('/')) {
        uri = uri.substring(0, uri.length - 1);
      }
      this.applySaveDir(uri);
      this.toast('已设置保存文件夹');
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'pick dir failed: %{public}s', err.message);
      this.runJs('window.LXSaveDir&&window.LXSaveDir.onFail(' + this.jsJson('当前系统不支持选择文件夹') + ')');
      this.toast('当前系统不支持选文件夹，先「保存到文件」一次即可自动记住目录');
    });
  }

  /** 记住目录并持久化读写授权 */
  private applySaveDir(uri: string): void {
    this.saveDirUri = uri;
    this.persistSaveDir(uri);
    hilog.info(DOMAIN, TAG, 'export dir set: %{public}s', uri);
    fileShare.persistPermission([{
      uri: uri,
      operationMode: (fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE) as fileShare.OperationMode
    }]).then(() => {
      hilog.info(DOMAIN, TAG, 'export dir permission persisted');
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'persist dir permission failed: %{public}s', err.message);
    });
    this.runJs('window.LXSaveDir&&window.LXSaveDir.onDir(' + this.jsJson(uri) + ')');
  }

  /** JS 就绪后由页面调用：把上次选定的保存文件夹回推给前端（只做一次，避免页面反复刷新） */
  restoreExportDir(): void {
    if (this.dirRestored) {
      return;
    }
    this.dirRestored = true;
    this.loadSaveDir();
  }

  /** 把已设置的目录记到 preferences，重启后自动恢复 */
  private persistSaveDir(uri: string): void {
    if (this.ctx === null) {
      return;
    }
    preferences.getPreferences(this.ctx, 'lx_settings').then((pref: preferences.Preferences) => {
      pref.putSync('export_dir', uri);
      pref.flush();
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'save export dir pref failed: %{public}s', err.message);
    });
  }

  /** 启动时恢复上次选的目录，并重新激活持久化授权 */
  private loadSaveDir(): void {
    if (this.ctx === null) {
      return;
    }
    preferences.getPreferences(this.ctx, 'lx_settings').then((pref: preferences.Preferences) => {
      const uri: string = pref.getSync('export_dir', '') as string;
      if (uri === null || uri === undefined || uri.length === 0) {
        return;
      }
      this.saveDirUri = uri;
      fileShare.activatePermission([{
        uri: uri,
        operationMode: (fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE) as fileShare.OperationMode
      }])
        .then(() => {
          hilog.info(DOMAIN, TAG, 'export dir restored: %{public}s', uri);
          this.runJs('window.LXSaveDir&&window.LXSaveDir.onDir(' + this.jsJson(uri) + ')');
        })
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'activate dir permission failed: %{public}s', err.message);
          this.saveDirUri = '';
        });
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'load export dir pref failed: %{public}s', err.message);
    });
  }

  /**
   * 直接写入已选目录（零弹框）。allowRetry 控制权限类失败时是否先重新激活持久授权再试一次。
   * 失败时按错误码分类：目录失效 → 清掉设置让用户重选；其它 → 提示手动导出（绝不弹保存框，
   * 否则批量下载完成时会一串系统弹窗，这正是当初体验崩坏的原因）。
   */
  private saveToDir(srcPath: string, name: string, allowRetry: boolean): void {
    // docs:// 目录 URI 里的文件名需要按 URI 约定编码，否则中文文件名会打不开目标文件
    let safe: string = name;
    try {
      safe = encodeURIComponent(name);
    } catch (e) {
      safe = name;
    }
    const target: string = this.saveDirUri + '/' + safe;
    hilog.info(DOMAIN, TAG, 'export to dir: %{public}s', target);
    taskpool.execute(copyFileToUri, srcPath, target).then((res: Object) => {
      hilog.info(DOMAIN, TAG, 'export to dir ok bytes=%{public}s', String(res));
      this.toast('已自动保存到所选文件夹');
    }).catch((err: BusinessError) => {
      const code: number = err !== null && err !== undefined && err.code !== undefined ? err.code : 0;
      const msg: string = err !== null && err !== undefined && err.message !== undefined ? err.message : String(err);
      hilog.warn(DOMAIN, TAG, 'export to dir failed: %{public}s code=%{public}d', msg, code);
      // 常见权限类错误（EPERM 13900001 / EACCES 13900013 / 13900042）：
      // 系统可能回收了授权，重新激活一次再写；仍失败走下面的分类提示
      if (allowRetry && (code === 13900001 || code === 13900013 || code === 13900042)) {
        const uri: string = this.saveDirUri;
        const mode: fileShare.OperationMode =
          (fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE) as fileShare.OperationMode;
        fileShare.activatePermission([{ uri: uri, operationMode: mode }]).then(() => {
          hilog.info(DOMAIN, TAG, 'dir permission re-activated, retry write');
          this.saveToDir(srcPath, name, false);
        }).catch((e2: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 're-activate failed: %{public}s', e2.message);
          this.saveToDir(srcPath, name, false);
        });
        return;
      }
      if (code === 13900002) {
        // 目录本身不存在（用户删了文件夹 / 换了存储介质）：清空设置，避免之后每次下载都失败
        this.saveDirUri = '';
        this.forgetSaveDir();
        this.toast('保存文件夹已不存在，请到 设置 → 下载目录 重新选择');
      } else {
        this.toast('写入失败(' + String(code) + ')，可在下载页点「保存到文件」导出');
      }
      this.runJs('window.LXSaveDir&&window.LXSaveDir.onFail(' + this.jsJson(String(code) + ' ' + msg) + ')');
    });
  }

  /** 从 preferences 里删掉失效的保存目录 */
  private forgetSaveDir(): void {
    const c = this.ctx;
    if (c === null) {
      return;
    }
    preferences.getPreferences(c, 'lx_settings').then((pref: preferences.Preferences) => {
      pref.deleteSync('export_dir');
      pref.flush();
      hilog.info(DOMAIN, TAG, 'export dir forgotten');
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'forget export dir failed: %{public}s', err.message);
    });
  }

  /**
   * 一键保存所有已完成下载：把文件名一次性交给系统保存框，返回多个 URI 后逐个复制。
   * JS: EchoBridge.saveAllDownloads(JSON.stringify([{path,name},...]))
   */
  saveAllDownloads(listJson: string): void {
    const c = this.ctx;
    if (c === null) {
      return;
    }
    let items: SaveItem[] = [];
    try {
      items = JSON.parse(listJson) as SaveItem[];
    } catch (e) {
      this.toast('参数错误');
      return;
    }
    if (items === null || items === undefined || items.length === 0) {
      return;
    }
    const names: string[] = [];
    const srcs: string[] = [];
    for (let i: number = 0; i < items.length; i++) {
      const src: string = this.resolveDownloadPath(items[i].path);
      if (src === '') {
        continue;
      }
      srcs.push(src);
      // 文件名统一取沙箱里的实际文件名（含「歌名 - 艺术家」），与单首「保存到文件」保持一致
      let nm: string = this.safeName(decodeURIComponent(src.substring(src.lastIndexOf('/') + 1)));
      if (nm.lastIndexOf('.') < 0) {
        const dot: number = src.lastIndexOf('.');
        if (dot > 0) {
          nm = nm + src.substring(dot);
        }
      }
      names.push(nm);
    }
    if (srcs.length === 0) {
      this.toast('文件不存在');
      return;
    }
    const opt: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    opt.newFileNames = names;
    const vp: picker.DocumentViewPicker = new picker.DocumentViewPicker(c);
    vp.save(opt).then((uris: string[]) => {
      if (uris === null || uris === undefined || uris.length === 0) {
        return;
      }
      let okCount: number = 0;
      for (let i: number = 0; i < uris.length && i < srcs.length; i++) {
        // 每个文件单独复制，串行避免同时读写多个大文件
        taskpool.execute(copyFileToUri, srcs[i], uris[i]).then(() => {
          okCount++;
        }).catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'save all item failed: %{public}s', err.message);
        });
      }
      this.toast('已开始保存 ' + srcs.length + ' 个文件');
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'save all failed: %{public}s', err.message);
      this.toast('批量保存失败');
    });
  }

  /**
   * 导出已下载的文件到用户可见目录。
   * JS: EchoBridge.exportDownload(path | 文件名, mime)
   */
  exportDownload(path: string, mime: string): void {
    const src: string = this.resolveDownloadPath(path);
    if (src === '') {
      this.toast('文件不存在');
      return;
    }
    const name: string = this.safeName(src.substring(src.lastIndexOf('/') + 1));
    hilog.info(DOMAIN, TAG, 'export download: %{public}s', src);
    this.saveSandboxToUserFile(src, name, mime);
  }

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
    if (ok) {
      // 沙箱只是中转站，最终要落到用户可见目录，否则系统「文件」里找不到
      this.saveSandboxToUserFile(path, this.saveName, 'audio/mpeg');
    } else {
      this.toast('保存失败');
    }
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
