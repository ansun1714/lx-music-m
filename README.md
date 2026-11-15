# LX Music 界面复现版（Android）

按洛雪音乐（LX Music）移动端 v1.9.2 的界面与交互复刻的安卓客户端：**WebView 渲染界面 + Java 原生桥**，音源由用户自行导入的自定义 JS 音源提供，APK 内不内置任何音源与曲库。

> 仅个人学习与界面研究用；不随包分发音频内容，音源脚本由使用者自行准备，请遵守各音乐平台的授权条款。

## 当前状态

- 版本：**3.13.7**（versionCode 24），产物 `LXMusic-v3.13.7.apk`（160,284 B）
- 包名：`com.lxmusic.replica`；minSdk 23 / targetSdk 34
- 模拟器回归全绿：逻辑冒烟 463/463、设备验收 85/85、平台 35/35、播放器 41/41、队列 22/22、点行播放 25/25 + 重启 4/4

## 目录结构

```
app/                 界面与逻辑（纯前端，可直接在浏览器打开 standalone.html）
  index.html         页面骨架
  app.js             视图 / 事件 / 播放调度
  engine.js          音频引擎、Web Audio 接管（音效）
  platform.js        五个平台（酷我/酷狗/咪咕/网易/QQ）的搜索、榜单、歌单适配
  source-api.js      自定义 JS 音源（user-api 2.0.0 兼容层）
  sources.js         音源导入与校验
  download.js        下载队列、落盘、本地播放
  sound-effects.js   9 个预设 + 10 段 EQ + 混响/环绕
  quality.js         音质档位与降级链
  styles.css         对齐原版的样式（含 16 套主题变量）
android/             Java 壳 + 原生桥（EchoBridge）
  src/com/lxmusic/replica/MainActivity.java
  build.py          aapt2/d8/apksigner 一把构建，产出根目录 APK
docs/               构建说明、界面还原规格
evidence/           验收脚本（smoke / device-check / device-platform / device-player /
                    device-queue / device-dlplay / device-settings）与报告 JSON
                    fixtures 内是自造测试音源（返回本地 WAV，不联网）
```

## 构建

```powershell
node evidence/build-standalone.js          # app/*.js → app/standalone.html（供 WebView 加载）
node evidence/smoke-test.js                # 纯 Node 逻辑回归，无需设备
python android/build.py                    # 需要 JDK 21 在 PATH 内
```

APK 输出到仓库根目录，版本号在 `android/build.py` 的 `VERSION_NAME / VERSION_CODE`
与 `android/AndroidManifest.xml` 两处同步（CI 会校验一致性）。

构建脚本不依赖 Gradle，只用 SDK 里的 `aapt2 / javac / d8 / zipalign / apksigner`，
以下环境变量可覆盖默认行为：

| 变量 | 默认 | 用途 |
|---|---|---|
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` | `C:\Users\maoxu\tools\android-sdk` | Android SDK 根目录 |
| `ANDROID_BUILD_TOOLS_VERSION` | `35.0.0` | build-tools 版本（34.0.0 的 R8 在 JDK 21 下会 NPE） |
| `LX_BUILD_WORK` | `%TEMP%\lx-build` | 中间产物目录（必须是纯 ASCII 路径） |
| `LX_KEYSTORE_DIR` | `%TEMP%\lx-replica-keystore` | 签名密钥目录 |
| `LX_KS_PASS` / `LX_KS_ALIAS` | `lxmusic-replica` / `lxreplica` | 密钥口令与别名 |
| `LX_VERSION_NAME` / `LX_VERSION_CODE` | 脚本内常量 | 临时覆盖版本号 |
| `LX_FINAL_APK` | 仓库根 `LXMusic-v<版本>.apk` | 产物输出路径 |

## 自动构建（GitHub Actions）

`.github/workflows/build-apk.yml`：推送到 `main`、开 PR、打 `v*` tag 或手动
`workflow_dispatch` 都会在 `ubuntu-latest` 上跑

```
setup JDK21 + Android SDK（platform 34 / build-tools 35.0.0）
→ build-standalone.js → smoke-test.js（463 项，不过直接失败）
→ python android/build.py（签名 + apksigner verify + aapt badging 校验）
→ 上传 artifact「LXMusic-apk」→ 打 tag 时自动挂到 Release
```

产物信息（文件名、字节数、SHA-256）写在每次运行的 Step Summary 里。artifact 保留 14 天。

**签名说明**：CI 每次跑都是全新容器，默认会在临时目录新生成一个 keystore，
因此 CI 出的包签名与本地 `%TEMP%\lx-replica-keystore` 的包不同，直接覆盖安装会失败
（需先卸载旧包）。要固定签名，把本地 keystore 转 base64 存成仓库 Secret `LX_KEYSTORE_B64`：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\lx-replica-keystore\lx-replica.jks")) |
  Set-Clipboard
```

然后到仓库 Settings → Secrets and variables → Actions 新建 `LX_KEYSTORE_B64` 粘贴即可。

## 设备验收

```powershell
adb -s <serial> install -r LXMusic-v3.13.7.apk
pwsh C:\temp\run-one313.ps1 device-check.js   # 需先把 WebView devtools 转发到 127.0.0.1:9222
```

脚本通过 CDP 在真实 WebView 里模拟点击并断言 DOM 与状态，报告写到 `evidence/*.json`。

## 关键技术点

- **WebView + 原生桥**：`EchoBridge` 提供 HTTP（分块流式 + 24MB 二进制上限）、文件落盘、文件选择、通知栏等能力，避免 `fetch` 直连的跨域与证书问题。
- **音效接管**：原生播放时音效不介入；一旦开启音效或 EQ 偏离平直，才把音频取成本地 Blob 换 `<audio>` 元素接进 Web Audio（同源 + Blob 规避 CORS 污染）。
- **大文件保护**：Java 侧边读边 Base64 分块回传（块长取 3 的倍数），JS 侧按 512KB 分片 `atob` 组 Blob，全程不出现 `byte[] + 大字符串` 的 OOM（此前真机闪退即此因）。
- **目录页**：歌单与榜单都是浮层目录，浮层底边上移播放条高度，滚动列表时底部播放条常驻。
- **菜单定位**：`menu()` 先 `visibility:hidden` 参与布局量真实尺寸，再按视口三边夹住，贴底自动向上翻。

## 版本记录（节选）

| 版本 | 内容 |
|---|---|
| 3.13.2 | 原生桥取字节 + Blob 接管音频图，解决搜索曲目开音效无声/报错 |
| 3.13.3 | 修真机「点歌闪退」：OOM（整份 Base64）→ 分块流式 + 24MB 上限 |
| 3.13.4 | 榜单卡片进入目录页；歌单/榜单目录播放条常驻；修「加载中点播放全部无响应」 |
| 3.13.5 | 删除搜索页右上角「歌曲/歌单」死标签（只切高亮，不影响搜索） |
| 3.13.6 | 播放详情页「收藏」→ 选列表加入，重复不添加 |
| 3.13.7 | 修目录最后一行「⋮」菜单被屏幕底边裁掉 |

## 已知限制

- 音源需自行导入，APK 不内置、仓库也不附带第三方音源脚本。
- 二进制响应上限 24MB，超出直接提示「文件过大，已跳过音效」（无损整曲常见 30–50MB）。
- 真机（vivo V2011A）闪退修复目前只有模拟器证据与 30MB 大文件回归，仍待真机复测。
- 时间轴歌词依赖音源实现 `lyric` 动作，未实现时显示「暂无歌词」。
