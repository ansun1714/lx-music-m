/**
 * LX Music 界面复现版 · HarmonyOS 壳
 *
 * 只做一件事：把同一份 Web 界面（rawfile/index.html，由 evidence/build-standalone.js
 * 从 app/ 打包而来）交给 ArkWeb 渲染。原生桥接（下载、文件选择、音源文件读取）还没
 * 移植到鸿蒙侧，所以界面会退化到浏览器模式：能浏览、能搜索，导音源走 <input type=file>。
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { EchoBridge } from '../core/EchoBridge';

const DOMAIN: number = 0x0001;
const TAG: string = 'LXMusicHos';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    EchoBridge.markBoot('ability onCreate');
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    EchoBridge.markBoot('windowStage create');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        EchoBridge.markBoot('loadContent failed');
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      EchoBridge.markBoot('loadContent done');
      hilog.info(DOMAIN, TAG, 'loadContent succeeded');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }
}
