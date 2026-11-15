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
            'exportDownload',
            'pickScript', 'pickScriptPull', 'pickScriptAck',
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
        .onPageEnd(() => {
          hilog.info(0x0D00, TAG, 'web page loaded');
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
