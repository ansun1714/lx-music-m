import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'LXMusicHos';

/**
 * 全屏 ArkWeb 容器。
 *
 * - src 用 $rawfile('index.html')：界面被打包进 HAP，不依赖网络。
 * - domStorageAccess / databaseAccess 必须开，界面靠 localStorage 记播放队列和设置。
 * - 鸿蒙侧暂无 EchoBridge 桥接，app.js 会自动退化（fetch 直连 + <input type=file> 导音源）。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .zoomAccess(false)
        .onPageEnd(() => {
          hilog.info(0x0001, TAG, 'web page loaded');
        })
        .onErrorReceive((event) => {
          if (event) {
            hilog.error(0x0001, TAG, 'web error: %{public}s', event.error.errorMsg);
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
