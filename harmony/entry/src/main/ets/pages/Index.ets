import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { EchoBridge } from '../core/EchoBridge';

const TAG: string = 'LXMusicHos';

/**
 * 全屏 ArkWeb 容器 + EchoBridge。
 *
 * 界面是 rawfile/index.html（由 evidence/build-standalone.js 打包同一份 app/），
 * 原生能力通过 javaScriptProxy 暴露成 window.EchoBridge，与 Android 壳同名同签名。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: EchoBridge = new EchoBridge();

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.bridge.init(ctx, this.controller);
    this.bridge.notePhase('ui aboutToAppear');
    hilog.info(0x0D00, TAG, 'bridge ready');
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .zoomAccess(false)
        .javaScriptProxy({
          object: this.bridge,
          name: 'EchoBridge',
          methodList: [
            'mediaProxyBase', 'localMediaUrl',
            'httpRequest', 'cancelRequest',
            'downloadStart', 'downloadCancel', 'downloadClear', 'downloadPartialSize',
            'saveDownloadStart', 'saveDownloadChunk', 'saveDownloadFinish', 'saveText',
            'exportDownload', 'setAutoExport', 'pickExportDir', 'saveAllDownloads',
            'pickScript', 'pickScriptPull', 'pickScriptAck',
            'nativeTrace',
            'toast', 'exitApp'
          ],
          controller: this.controller
        })
        .onConsole((event) => {
          if (event) {
            hilog.info(0x0D00, TAG, 'console %{public}s', event.message);
          }
          return false;
        })
        .onControllerAttached(() => {
          this.bridge.notePhase('web attach');
          hilog.info(0x0D00, TAG, 'web controller attached');
        })
        .onPageBegin(() => {
          this.bridge.notePhase('web pageBegin');
        })
        .onPageEnd(() => {
          this.bridge.notePhase('web pageEnd');
          hilog.info(0x0D00, TAG, 'web page loaded');
          // 注意：这里不要再调用 restoreExportDir()。它会触发 fileShare.activatePermission，
          // 在部分机型上表现为「一打开应用就弹出系统文件管理器」，而本机又缺少
          // FolderSelection 能力，目录授权本就不可用，故启动阶段完全不做任何 picker/授权动作。
        })
        /* ArkWeb 默认行为：页面一旦发起文件选择（input type=file / showOpenFilePicker），
         * 未注册本回调时会由系统直接拉起文件管理器。真机上「冷启动弹文件管理器」在原生桥
         * 轨迹为空的情况下仍然出现，故这里显式接管并**直接返回已处理**（不设置结果 = 选中 0 个文件），
         * 既避免系统弹窗，也把事件记进桥轨迹。音源导入走的是 EchoBridge.pickScript，不受影响。 */
        .onShowFileSelector((event) => {
          this.bridge.noteFileSelector();
          hilog.warn(0x0D00, TAG, 'page file selector intercepted (return handled, no system picker)');
          // 返回 true 表示应用已处理：不设置 fileSelectorResult 即等同于「选中 0 个文件」，
          // 系统不会再拉起文件管理器。
          return true;
        })
        .onErrorReceive(() => {
          hilog.error(0x0D00, TAG, 'web resource error');
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
