# LX Music 界面复现版 v3.13.7 · 构建与安装说明

> 目标：界面与功能对齐 `E:\AI\原软件\lx-music.apk`（LX Music Mobile 1.9.2），并新增原版未实现的歌曲下载。
> v3.1.0 追加：自制 JS 音源导入、按音源搜索歌曲、在线收听、按歌曲来源格式下载。
> v3.1.1 修复：自定义源管理「本地导入」选完文件没反应（真机 WebView 忽略游离 `<input>.click()`）。
> v3.2.0：主界面可选搜索平台、排行榜改由音源提供、内置演示音乐全部清空。
> v3.3.0：按 lxserver 源码对齐——**平台负责搜索/榜单，音源是该平台的账号凭证**（按脚本 `sources` 自动匹配）。
> v3.4.0：对齐 lxserver web 播放器的下载能力——原生流式下载、真实进度/速度/剩余时间、暂停续传、失败重试、歌词随下载保存。
> v3.5.0：歌曲菜单「下载」改为**先选品质**（9 档，最高母带），音源按所选档位解析，档位不可用时自动降级并在任务上标注。
> v3.6.0：补齐**网易云 / QQ 音乐内置搜索**（eapi 加密与 zzcSign 签名），音源取链失败时透传原始原因。
> v3.7.0：下载音质可手选到**母带**（不再预先降档）；播放器新增**歌词**、**音效**、**当前曲目下载**。
> v3.8.0：修复真机「点歌不加载 / 播放没声音」（音效不再无条件接管音频图）；音源改为**一个默认音源**，去掉逐平台绑定；在线音源支持**更新**。
> v3.9.0：音效全平台可用（原生同源媒体代理，不再因 CDN 无 CORS 被静音）；返回键先回搜索主页；排行榜五个平台都接内置榜单；歌单改为各平台官方推荐歌单；音源失败自动回退、下载断流自动续传。
> v3.10.0：修复设置页四个「改不了」——播放速率倍率、歌词字体大小、界面字体大小、下载音质（含最高档）。根因是点击 `<input>`/`<select>` 会立即重建设置页，控件在被输入/选择前就被销毁；同时字号设置从未真正应用。现改为滑块 + 数字框并列、`input` 事件实时生效不重渲染、字号统一走 CSS 变量、下载音质落盘。
> v3.11.0：播放详情页补「队列视角」——常驻显示**下一首**与**第几首 / 共几首 / 还剩几首**（含当前播放模式），底部新增**列表**入口可看整张歌单并点选任意一首直接切歌；随机模式保证不会停在原曲。
> v3.12.0：设置页新增**下载目录**——4 个常用落盘目录可选（`Download/LX Music` / `Music/LX Music` / `Download/Music/LX Music` / `Music/下载`）+ 自定义相对路径；原生化 `MediaStore` 写入按根目录自动选 Downloads / Audio 集合，仍是「无需存储权限」。
> v3.13.0：下载页**点整行即播放**（不再先找「播放」按钮）；已下载的歌曲改为**真·本地文件播放**（新增同源 `/__local` 端点，离线可播，不再向音源要地址而撞上混合内容拦截）；**音效开关一开就接管音频图**（原来参数全平时不接管，用户感觉「开了没反应」），接管失败会自动退回原生播放并提示。
> v3.13.1（修订）：修两处用户真机回归——**重启后点已下载的歌没反应**（`playFrom()` 开头 `D.byId()` 查不到曲目就静默 return，曲库是内存态；现按下载任务重建曲目对象并注入 external 池）；**搜索曲目开音效报错**（v3.13.0 让所有在线曲目都改走 `/__media` 重路由，源站一有波动就加载失败，回退原生再撞混合内容 → 报错；现改为本地/已下载「开关即接管」，在线曲目只在 EQ/混响/环绕**真的非平**时才改走代理，并由 `LXSound.onChange` 主动同步音频图）。
> v3.13.2（重构）：**在线曲目接音效彻底换路**——不再靠 `/__media` 代理重路由，改为「原生桥取字节 → 同源 Blob → 接管音频图」，取不到字节就保持原生播放并**只提示一次**、绝不静音；同时修掉这一路上暴露的一串致命细节（旧 `<audio>` 解码器不释放、`playing` 误判导致 `play()` 提前 return、曲末 `startAt` 触发 `_ended` 自激、取字节耗时造成的位置回跳、关音效时换元素卡 1~2 秒、`_blobPending` 不清导致再也不接管、自动播放策略拦下新元素）。

> v3.13.3（修闪退）：**真机「点歌就闪退」已定性为 Java 侧 OOM**——`EchoBridge.doHttp` 把整首歌读成 `byte[]`、再整体 `Base64.encodeToString` 造出 4/3 倍大的 `String`，一首 30–50MB 的无损同时持有 byte[]、base64 串和 `ByteArrayOutputStream` 扩容副本（日志里 `Arrays.copyOf` 一次要 202MB），超过 256MB 堆就 `OutOfMemoryError`，而 `lx-http` 线程没有兜住 → 进程直接死。现在改成「按 3 字节对齐的整块边读边 Base64、逐块回传」+ 二进制 24MB / 文本 8MB 上限，JS 侧按 512KB 分片解码成 Blob，全程不再出现大对象；30MB 文件 1.5 秒内明确报「文件过大，已跳过音效」，页面存活、Java 堆仅 5.4MB。

> v3.13.4（榜单目录 / 播放条常驻）：**排行榜的大图标不再「点了没反应」**——点卡片直接进入该榜的**目录页**（标题 + 播放全部 + 曲目列表），曲目不再铺在卡片下方；**歌单目录与榜单目录都让底部播放条留在页面上**（浮层底边上移一个播放条高度，播放条本身固定在 `.page` 末端，上下滑列表既不消失也盖不住）。顺带修掉「目录还在加载时点播放全部没有任何反应」的竞态。

---

## 1. 直接安装（推荐）

```bash
adb install -r LXMusic-v3.13.7.apk
adb shell am start -n com.lxmusic.replica/.MainActivity
```

| 属性 | 值 |
|---|---|
| 文件 | `LXMusic-v3.13.7.apk` |
| 大小 | 160,284 B |
| SHA-256 | `53ecdb2d583c8e0be52aed7b04fc6daf372aa7dacfafd5196df1363418d09f45` |
| 包名 | `com.lxmusic.replica` |
| 版本 | `3.13.7` / `versionCode 24` |
| minSdk / targetSdk | 23 / 34 |
| 签名 | v1 + v2 + v3，`apksigner verify` 通过 |
| 权限 | **仅 `android.permission.INTERNET`**（v3.0.0 无任何权限）；无存储权限 |
| 网络 | 页面资源仍全部离线 assets；仅用户导入的自定义 JS 音源可经 Java 桥访问自己的接口 |

> 覆盖安装不会丢数据：签名密钥固定在 `C:\temp\lx-replica-keystore\lx-replica.jks`，不随构建临时目录清理。

---

## 2. 自定义音源（v3.1.0 新增）

### 2.1 在哪里用

设置 → 「自定义源」分组 → `自定义源管理`，或搜索页点左上角来源按钮切换到
「全部自定义音源」/ 某个已启用音源。首次启动已预置一个**离线示例音源**
（`示例音源 · 本地曲库`），无需联网即可完整体验。

### 2.2 导入方式

| 方式 | 操作 |
|---|---|
| 本地导入 | 选择 `.js` / `.txt` 文件。**Android 走原生 `EchoBridge.pickScript()` 直接读文件并回传文本**（v3.1.1 起），不经过 `<input type=file>` / `content://` / `FileReader`，无需存储权限 |
| 在线导入 | 输入 HTTP(S) 链接，由 `EchoBridge.httpRequest` 下载脚本文本后导入 |
| 粘贴脚本 | 在文本框里粘贴 JS，可先点「示例脚本」或「HTTP 模板」载入模板再改 |
| 导出 | 管理页每个音源可导出 `.js` 到 `Download/LX Music` |

最多 20 个源（原版 `user_api_max_tip`）；每项可启用/停用、允许更新弹窗、设为当前源、搜索测试、移除。

### 2.3 脚本协议（兼容原版 user-api v2.0.0）

```js
/**
 * @name 我的音源
 * @description 描述
 * @version 1.0.0
 * @author me
 * @homepage https://example.com
 */
const { EVENT_NAMES, request, on, send, utils } = globalThis.lx

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'search':       // 扩展：返回歌曲数组或 {list:[...]}
    case 'musicUrl':     // 原版：返回在线播放 URL（http/https、data:、blob: 或 {url,mime,ext}）
    case 'downloadUrl':  // 扩展：返回下载直链/数据 + mime/ext/filename
    case 'lyric':        // 原版：{lyric,tlyric,rlyric,lxlyric}
    case 'pic':          // 原版：封面 URL
  }
})

send(EVENT_NAMES.inited, {
  sources: {
    kw: { name: '我的音源', type: 'music',
          actions: ['musicUrl', 'lyric', 'search', 'downloadUrl'],
          qualitys: ['128k', '320k'] }
  }
})
```

- `lx.request(url, {method,headers,body,timeout,binary}, cb)` 由 Java `HttpURLConnection` 发起，
  **不受浏览器跨域限制**（等同原版语义）；`binary:true` 返回 base64 字节。
- `lx.utils.buffer.{from,bufToString}`、`lx.utils.crypto.{md5,randomBytes}` 可用；
  `aesEncrypt/rsaEncrypt/zlib` 与原版移动版一样未实现。
- 脚本在受限函数作用域执行，拿不到 `window/document/localStorage/fetch/EchoBridge/LXApp`。
  请只导入可信脚本（界面保留原版安全提示）。
- 只声明原版 `musicUrl/lyric/pic` 的脚本可直接导入使用，用于给内置曲目换源取 URL。
- 完整字段表与取证结论见 `docs/界面还原规格.md` 第 11 节、`evidence/custom-source-forensics.md`。

### 2.4 按来源格式下载 / 在线收听

- 在线收听：`playFrom()` 先向音源请求 `musicUrl`，把 URL 交给 `<audio>`（`engine.mode='stream'`）。
- 下载：`download.js` 优先请求 `downloadUrl`，把返回的真实字节按 `mime/ext/filename`
  **原样保存**（不重新编码）；音源不可用时回退生成 16-bit PCM WAV。
- 音质档位「音源音质」在设置里选（128k / 320k / flac / flac24bit），作为 `info.type` 传给脚本。

---

### 2.5 搜索平台 / 排行榜 / 空曲库（v3.2.0）

- **主界面搜索平台**：搜索框左侧的来源按钮列出**全部已启用音源**。只实现 `musicUrl` 的原版脚本也会出现，并标注「· 仅解析播放」；选中它搜索会明确提示「未实现 search 动作」，不会静默返回本地结果。
- **排行榜**：榜单名沿用原版 24 个，曲目改为调用音源的 `leaderboard` 动作（`{ id, boardId, source, page, limit }`）。点「播放全部」播的就是音源返回的列表；没有音源实现该动作时会显示提示。
- **空曲库**：v3.2.0 删除了全部内置演示音乐（48 首曲目、12 个歌单、热门词、歌词、评论），也不再预置示例音源。首次启动看到的只有界面骨架 + 「还没有导入音源」的引导。
- **数据迁移**：从 v3.1.x 升级时，会自动清掉播放列表/队列/进度/下载任务里指向演示曲目（`kw_*`）的残留；自己导入的音源不受影响。

最小可用音源脚本（含搜索 + 排行榜 + 播放 + 下载）：

```js
/**
 * @name 我的音源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'search') return Promise.resolve([])            // 返回歌曲数组
  if (action === 'leaderboard') return Promise.resolve([])       // 返回榜单数组
  if (action === 'musicUrl') return Promise.resolve('https://.../a.mp3')
  if (action === 'downloadUrl') return Promise.resolve({ url: 'https://.../a.mp3', ext: 'mp3', mime: 'audio/mpeg' })
  return Promise.reject(new Error('unsupported'))
})
send(EVENT_NAMES.inited, {
  sources: { kw: { name: '我的音源', type: 'music',
    actions: ['search', 'leaderboard', 'musicUrl', 'downloadUrl'], qualitys: ['128k', '320k'] } }
})
```

### 2.6 平台与音源（v3.3.0 的正确用法）

**平台是主体，音源是账号。** 主界面顶部的平台条（酷我 / 酷狗 / 咪咕 / 网易 / QQ）决定「用谁搜索」；
你导入的 `.js` 音源只负责给对应平台提供播放/下载地址，相当于该平台的账号凭证。

| 平台 | 内置搜索 | 内置榜单 | 说明 |
|---|---|---|---|
| 酷我音乐 | ✅ | — | 选平台即可搜索；播放/下载需要音源提供地址 |
| 酷狗音乐 | ✅ | ✅ 24 个榜单 | 搜索 + 榜单都可用；播放/下载需要音源 |
| 咪咕音乐 | ✅ | — | 同酷我 |
| 网易云音乐 | ✅ | — | eapi 加密搜索；播放/下载需要音源提供地址 |
| QQ音乐 | ✅ | — | musics.fcg + zzcSign 搜索；播放/下载需要音源提供地址 |

**音源怎么被「验证」并服务平台**：脚本 `send(inited, { sources })` 里的 key 就是平台 id。
例如声明了 `kw`，这个音源就能给酷我提供播放地址；**不需要逐平台绑定**：

```js
send(EVENT_NAMES.inited, {
  sources: {
    kw: { name: '我的音源', type: 'music', actions: ['musicUrl', 'downloadUrl'], qualitys: ['128k', '320k'] },
    kg: { name: '我的音源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }
  }
})
```

- 导入成功后的 toast 会直接告诉你「可服务：酷我音乐 / 酷狗音乐」。
- 音源管理页的「设为默认」决定优先级：默认音源声明了哪些平台，就优先服务哪些平台；没声明的平台自动匹配其它音源。
- 平台 chip 右上角的圆点 = 该平台已有可用音源（来自默认音源或自动匹配）。
- 没有任何音源时：平台仍能搜索出结果，但点播放会明确提示「需要导入声明了该平台的音源」，不会静默失败。

### 2.7 下载（v3.4.0）

设置好平台与音源后，在搜索结果、榜单或列表里点「下载当前列表 / 搜索结果」或单曲菜单的「下载」。

- **走原生流式下载**：Java 直接 `HttpURLConnection` 边下边写 `Download/LX Music`，几十 MB 的歌曲不会占满内存。
- **真实进度**：每 250ms 刷新，显示 `已下载 / 总大小`、`速度`、`剩余时间`、百分比。
- **暂停 / 继续**：暂停会保留 `.part`，继续时带 `Range` 头续传，不用从头再来。
- **失败可重试**：错误原因直接显示（如 `HTTP 403`），顶部有「重试失败 (N)」。
- **歌词随下载保存**：音源实现 `lyric` 时，下载完成会同时写入同名 `.lrc`。
- **小文件与演示曲目**：音源返回 `data:` / `blob:` 时仍走内存 + 分块桥，保持应用内离线播放。

### 2.8 下载品质选择（v3.5.0）

歌曲行右侧「⋮」→「**下载…**」，会先弹出品质菜单（共 9 档，从高到低）：

| 档位 | 显示名 | 说明 |
|---|---|---|
| `master` | 母带音质 | 最高档，通常 24bit/96kHz 以上 |
| `atmos_plus` | 增强空间音频 | 需要音源支持 |
| `atmos` | 空间音频 | 需要音源支持 |
| `hires` | 高解析度 | 通常 24bit |
| `flac24bit` | 24bit 无损 | |
| `flac` | 无损音质 | 约 30–40MB/首 |
| `320k` | 高音质 | |
| `192k` | 192k 音质 | |
| `128k` | 标准音质 | 体积最小 |

- 右侧标「**可用**」= 这首曲目在平台接口 / 音源里明确声明了该档；
  没标的（灰色）也可以点，是否真有资源由音源决定，属于主动尝试。
- 选中的档位会作为 `info.type` 传给音源的 `musicUrl / downloadUrl`，**不是固定档位**。
- 该档解析不到地址时，会按优先级**自动降一档**（最多 3 档），
  任务行标注「母带音质 → 无损音质」，不会静默给你别的档位。
- 所有档位都拿不到地址时如实报错（列出尝试过的档位），不再用合成音轨冒充。
- 批量下载（多选 / 下载当前列表）同样先选品质，整批用同一档。
- 下载页顶部「下载音质」是**默认档**，只影响未指定品质的入队；设置页「音源音质」影响在线试听。

### 2.9 网易 / QQ 搜索（v3.6.0）

这两家的搜索是**平台自己做的**，不需要音源提供 search：

| 平台 | 接口 | 关键点 |
|---|---|---|
| 网易云 | `POST http://interface.music.163.com/eapi/batch` | `params = AES-128-ECB(url-36cd479b6b5-json-36cd479b6b5-md5)`，输出大写 hex |
| QQ | `POST https://u.y.qq.com/cgi-bin/musics.fcg?sign=...` | `zzcSign`：SHA1 取位 + XOR + base64 去 `/+=` |

所以只要选平台就能搜到歌，**音源只负责给这些歌提供播放/下载地址**（脚本 `sources` 里声明 `wy` / `tx`）。

#### 音源声明母带时，菜单会跟着变

`quality.js` 会把「该曲目绑定音源」声明的 `qualitys` 并入可用档位。
例如星海音乐源声明 `tx: [...,'master']`，那么 QQ 曲目的品质菜单里「母带音质」会直接标 **可用**，
不必靠灰色项去猜。

#### 取链失败会显示音源的原话

以前失败只提示「音源没有返回播放地址」，看不出问题。现在直接透传：

```
没有解析到播放地址：后端失败: 触发人机验证
音源取链失败：该音源仅对认证用户开放：请使用卡密（已尝试：128k）
```

> 星海音乐源的 QQ 取链走它自己的后端，未认证时返回 403「仅对认证用户开放」。
> 这是音源的授权策略，与搜索无关。把脚本里的 `LICENSE_CONFIG.code`（卡密）或
> `CHKSZ_CONFIG.apikey` 填好后**同名重新导入**即可覆盖（同名音源按「更新」处理）。

### 2.10 下载音质与播放器（v3.7.0）

#### 下载音质：手动选的档位就是最终档位

下载页「下载音质」下拉是 9 档，**最高「母带音质」**。选中后：

- 入队即按该档请求音源（不再被「曲目可用档位」悄悄改成无损）；
- 音源拿不到该档时，按 `母带 → 24bit 无损 → 无损` 逐档降级，任务行标「母带音质 → 无损音质」；
- 全档都失败才报错，并列出尝试过的档位。

单曲菜单「下载…」、批量下载、详情页「下载」按钮用的是同一套菜单。

#### 播放详情页

点播放条进入详情页，底部一排三个按钮：

| 按钮 | 作用 |
|---|---|
| 下载 | 对当前播放的歌曲弹 9 档品质菜单 |
| 音效 | 打开音效设置页 |
| 歌词 | 显示 / 隐藏歌词（记住选择） |

**歌词**：从当前曲目绑定的音源取 LRC（平台曲目也能取），解析时间轴、翻译与 offset，
播放时高亮当前行并滚动到中间，点任意行跳转到该句。没有歌词时显示提示，不影响播放。

**音效**（对齐 web 播放器 `player/sound-effects.js`）：

| 能力 | 参数 |
|---|---|
| 均衡器 | 10 段：31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k，±12 dB |
| 预设 | 流行 / 舞曲 / 摇滚 / 古典 / 人声 / 慢歌 / 电子乐 / 重低音 / 柔和 |
| 混响 | 关闭 / 房间 / 大厅 / 教堂（程序生成脉冲响应） |
| 环绕 | 3D 环绕，声音绕听者旋转 |
| 开关 | 关闭只旁路，已配参数全部保留 |

配置持久化在 `lx_sound_effects_v1`，下次启动自动恢复。

### 2.11 音源管理（v3.8.0）

| 操作 | 说明 |
|---|---|
| 设为默认 | 全局只有一个默认音源。搜索、切平台、解析播放/下载地址都优先用它；它声明了哪些平台就服务哪些平台 |
| 取消默认 | 回到「按脚本声明自动匹配」 |
| 更新 | 只对在线导入的源出现。按原地址重新拉取脚本，走同名更新，保留 id 与默认标记 |
| 移除 | 自动清掉默认标记 |

**已去掉「每个平台单独绑定」**：设置页不再有「平台账号（音源验证）」。

#### 音效与播放的关系（v3.8.0 修复）

音效开启且 EQ/混响/环绕非空时，`<audio>` 才会接进 Web Audio；否则走原生播放。
原因是 `MediaElementSource` 会让没有 CORS 头的音频被浏览器静音 —— 表现为「在播放但没声音」。
接管时若音源服务器不支持跨域，会自动退回原生播放并提示，同时关闭音效开关。

### 2.12 设置项：速率 / 字号 / 下载音质（v3.10.0）

设置页这四项以前「点不动、改了没反应」，v3.10.0 已修复：

| 设置项 | 位置 | 现在的行为 | 取值范围 |
|---|---|---|---|
| 播放速率倍率 | 播放 分组 | 滑块拖动或数字框键入**立即改变播放速度**，两者互相同步 | 0.5×–2.0×，步进 0.1 |
| 界面字体大小 | 列表 分组 | 文字与图标一起缩放，**当场生效** | 12–18（14 为 1.0 基准） |
| 歌词字体大小 | 歌词 分组 | 歌词正文、当前行、翻译行按比例一起变 | 12–24（16 为默认） |
| 下载音质 | 下载 分组 | 9 档可选（含最高「母带音质」），选定后**重启仍保留** | master … 128k |

**根因**：页面统一的 `document` click 派发器对任何带 `data-act` 的元素都会直接执行动作。
设置项控件本身就是 `data-act="set-num" / "set-select" / "dl-quality"`，
所以手指刚点到输入框/下拉，就先跑了一次设置逻辑并 `renderView()` **重建整个设置页**：
输入框还没聚焦就被替换（键盘弹出来打的字进不去）、原生下拉在选择前就被替换（选完立刻回弹）。
旧版「下载音质永远显示母带/改不了」也是同一原因。

**修法**：
- 表单控件（`input/select/textarea`）的**点击不再派发**，只在 `change` 事件里执行；
- 拖动与键入走 `input` 事件，实时改状态、实时生效，但**不重渲染**，交互不会被打断；
- 界面字号：CSS 所有 `font-size` 已统一为 `calc(Npx * var(--ui-fs))`，`init()` 启动即应用；
- 歌词字号：独立变量 `--lyric-size`（正文 1.0 / 当前行 1.12 / 翻译行 0.82）；
- 下载音质 / 同时下载数量 / 完成后自动保存：写入 `settings` 持久化，启动回填下载队列。

> 界面字体大小改的是**文字与图标**，不动布局尺寸（42dp Header、54dp 列表项等仍按原版口径），
> 所以放到 18px 也不会把界面撑破。

### 2.13 播放详情：下一首 / 队列 / 点选切歌（v3.11.0）

从歌单或搜索结果点「播放全部」，整张列表会作为**播放队列**灌进播放器（酷我歌单实测 100 首）。进入播放详情页后：

| 位置 | 内容 |
|---|---|
| 歌曲信息下方 | `下一首  <歌名> · <歌手>` |
| 同一信息条第二行 | `队列  第 3 / 100 首 · 还剩 97 首 · 列表循环`（实时跟着当前曲目走） |
| 底部动作栏 | `列表` 新增在「下载 / 音效 / 歌词」之前 |

- **下一首**按当前模式给：列表循环 / 顺序播放给出真实第二首；随机播放显示「每次从 N 首里抽一首」；单曲循环显示「播完重来这一首」。
- **还剩几首** = 当前之后、还没播过的曲目数（各模式同一口径，播到末尾自然变 0）。
- 点信息条任一位置 → 进入**播放列表**页：顶部「共 N 首 · 当前第 M 首」+ 模式按钮（点一下切换模式），下面逐条列出序号、歌名、歌手、时长，当前曲目高亮并显示暂停/播放图标。
- **点任意一条即切歌**：直接按该索引播放，详情页信息条同步更新。
- **随机播放不会停在原曲**：抽到自己时自动顺延一首（单曲队列除外）。

> 队列信息只在播放页出现，不占用设置页版面；曲目信息全部来自当前 `S.queue`，队列为空时整条不渲染。

### 2.14 下载目录可选（v3.12.0）

设置页「下载（本版新增）」分组第一行是 **下载目录**：左侧显示解析后的完整路径，右侧是可点选的下拉。

| 预设 | 落盘位置 |
|---|---|
| 系统下载目录 · Download/LX Music（默认） | `/storage/emulated/0/Download/LX Music` |
| 媒体库音乐目录 · Music/LX Music | `/storage/emulated/0/Music/LX Music`（系统音乐库能扫到） |
| 下载目录下的 Music 子目录 | `/storage/emulated/0/Download/Music/LX Music` |
| 媒体库音乐目录 · 中文子目录 | `/storage/emulated/0/Music/下载` |
| 自定义目录… | 弹窗输入相对路径，例：`我的音乐` → `/storage/emulated/0/Download/我的音乐` |

规则与实现要点：

- 只接受**相对路径**（相对外部存储根），只写子目录时自动补成 `Download/<子目录>`；未知根目录也归到 `Download/` 下。
- 拒绝 `..`、长度 > 80、含 `\ : * ? " < > |` 与控制字符的输入 → 直接回默认，不会越权写到应用私有目录或别处。
- Android 10+ 走 MediaStore：`Music/…` 写入 **Audio 集合**（`MediaStore.Audio.Media`），其余写入 **Downloads 集合**；仍**不需要任何存储权限**，卸载应用也不会删掉已下载文件。
  早期版本把 `Music/LX Music` 塞进 Downloads 集合会被系统拒绝——这就是要按根目录分集合的原因。
- 老系统（< Android 10）落到 `getExternalFilesDir()` 下同名目录，行为一致。
- 该设置与 `downloadQuality / dlParallel / dlAuto` 一样在 `init()` 回填，重启后仍然生效；下载页/详情页触发下载时都经同一个 `dirOf()` 归一化后传给原生桥第 6 个参数。

### 2.15 下载页点行播放 · 已下载本地播放 · 音效开关即接管（v3.13.0）

三件事一起修，都是「下载完的歌唱不了 / 开了音效没反应」这一条体验链上的：

**① 下载页点整行就播**

已完成的下载任务，整行就是播放入口——行首多一个绿色播放图标，点歌名/歌手/任意空白处都直接播放并进入播放页；行内「保存到设备」「移除」两个按钮仍是各自独立的点击目标（派发器优先命中最近的 `[data-act]`）。不再需要先找那个小小的「播放」按钮。

**② 已下载的歌曲是真·本地播放**

原来已下载任务只有内存 Blob（页面重启就没了），`getPlayableUrl()` 返回 null 时 `playFrom()` 会回头向音源再要一次地址 —— 在 `https://app.echo.local` 页面里拿到 `http://…` 会被 **Mixed Content** 拦掉，于是出现「在线音频加载失败 / 没有解析到播放地址」的报错；断网时同样必然失败。

现在：下载写入成功时记住该文件的 `content uri`（内存 + `SharedPreferences`），页面侧 `DL.getSavedPath(trackId)` 取回落盘路径，原生桥 `localMediaUrl(relPath)` 生成同源地址：

```
https://app.echo.local/__local?p=Download%2FLX+Music%2F歌名.wav
```

`/__local` 由 Java 侧 `serveLocalMedia()` 提供，支持 **Range（206 + `Content-Range`）**，所以能拖动进度；只接受 `Download/Music/Documents/Pictures/Movies` 这些公共根，路径里的 `..` 一律拒绝。这样已下载歌曲**离线可播**，也不再经过音源与网络。

> 分区存储的两点实测经验：① 直接按路径 `File.canRead()` 对别的应用写入的公共文件返回 false；② 仅按 `RELATIVE_PATH + DISPLAY_NAME` 去 `MediaStore.Files/Downloads/Audio` 反查，本应用可能一行都查不到。所以「写入时就记住 uri」是唯一稳的路子。系统因重名把文件改成 `歌 (1).wav` 时，会回读真实 `DISPLAY_NAME` 再记录。

**③ 音效开关打开就接管音频图**

`graphEnabled()` 原本要求「开关打开 **且** EQ/混响/环绕至少一项非平」，于是刚打开开关、参数全 0 时不会重建 `<audio>`、不会创建 `MediaElementSource` —— 用户听不出任何变化，观感就是「开了没反应」。现在只看总开关：打开即接管（后续调任何参数都立刻生效），关闭则回到原生播放。切图失败不再抛错，会 toast「音效接管失败，已切回原生播放：…」并把开关关掉。

同源地址不再套一层 `/__media` 代理（`MediaProxy.wrap()` 对与本页同 host 的 URL 直接放行），避免自己绕自己。

---

### 2.16 重启后点已下载歌曲没反应 · 在线曲目开音效报错（v3.13.1 修订）

用户装 v3.13.0 后反馈两条回归，都是 v3.13.0 自己引入或放大的：

**① 已下载的歌曲点开后播放器不加载（重启后必现）**

`playFrom()` 的第一行是：

```js
var tr = D.byId(id); if (!tr) return;      // ← 静默 return，一点提示都没有
```

而 `D.byId()` 只查两张表：`data.js` 的 `tracks`（从 v3.2.0 起必须为空）和 `external` 动态池（**纯内存，页面重启就没了**）。已经下载好的任务只剩 `localStorage` 里的 job（`name/singer/path/trackId`），曲目对象不存在 → 点行时直接 return，用户看到的就是「点了没加载」。

修法：`trackFromDownload(id)` 用下载任务把曲目对象重建回来，注入 `external` 池后整条链路（`currentTrack()` / `renderPlayer()` / `D.byId()`）全部可用；实在取不到才 toast「这首曲目已不在当前曲库中，请重新搜索后再播放」。

```js
var tr = D.byId(id);
if (!tr) { tr = trackFromDownload(id); if (tr) D.addExternalTracks([tr]); }
if (!tr) { toast('这首曲目已不在当前曲库中，请重新搜索后再播放'); return; }
```

**② 搜索曲目播放后打开音效报错（v3.13.0 放大的脆弱路径）**

回溯：v3.8.0 修过「音效无条件接管音频图」，v3.9.0 用同源 `/__media` 代理解决「无 CORS 的 CDN 接进 Web Audio 被静音」，v3.13.0 又把 `graphEnabled()` 改成「开关即接管」—— 等于让**所有**在线曲目都改走代理重路由。源站稍有波动（502 / 不支持 Range / 需要特殊头）→ 代理地址加载失败 → `_createEl` 回退到原始地址 → 再失败 → toast 报错。v3.12.0 之前只有「参数真非平」时才走这条路，所以没这么脆。

修法（保留 v3.13.0 想要的观感，去掉脆弱路径）：

```js
// engine.js
AudioEngine.prototype.wantGraph = function (ref) {
  if (!this.graphEnabled()) return false;                 // 总开关关 → 原生
  var kind = (ref && ref.kind) || this.mode;
  if (kind === 'downloaded' || kind === 'local') return true;  // 本地/已下载：开关即接管
  return this.graphMatters();                              // 在线：EQ/混响/环绕真非平才接管
};
```

- `_createEl()` 与 `syncAudioGraph()` 都用 `wantGraph()` 判定，两边不再打架；
- 在线曲目「刚打开开关、参数全平」时**保持原生播放不动**（不重路由，也就没有失败机会）；
- 真的调了 EQ / 混响 / 环绕，才切到 `/__media` + `MediaElementSource`（即 v3.9.0 验过 40 项的那条路）；
- 新增 `Snd.onChange(() => syncAudioGraph())`：参数一变就和音频图对齐。原来只有 EQ 滑块 UI 事件会同步，脚本/预设改参数时音频图不会重建，表现为「改了没效果」。

**③ 顺带修掉的两处**

- 本地文件加载失败的提示改为「本地文件读取失败（可能未保存到设备或已被删除）」，不再一律说「在线音频加载失败」。
- 验收脚本 `device-dlplay-check.js`：`Runtime.evaluate` 加 `userGesture: true`（否则 Chromium 自动播放策略会在 3 秒测试音频反复循环后把 `<audio>` 卡在暂停态）；C 组改为先 `seek` 到曲中再切音效；新增 F 组 4 项专测「在线曲目开音效的安全策略」；新增 `--persist` 阶段 4 项专测「重启后点已下载歌曲仍能播放」。

---

### 2.17 搜索曲目开音效「大部分时候没声音/报错」（v3.13.2 重构）

用户对 v3.13.1 仍不买账：**「搜索出来的歌，点了播放，打开音效，大部分时候还是不行 —— 没有声音，或者报错，偶尔才成功」**。这不是偶发，是 v3.13.1 那条 `/__media` 代理重路由在真实源站上的固有脆弱性：代理要重新去源站取一遍数据（源站可能 502、不认 Range、要 Referer、302 到别的 CDN），只要一处不对，`<audio>` 就 `readyState=0`；而跨域且无 CORS 的 `<audio>` 接进 `MediaElementSource` 会**静默**（不报 error、也没声音）。

**改法：不再重路由，改成「先取字节、再同源播放」**

```js
_fetchBytes(url, headers, cb)     // 优先 window.LXSourceAPI.request（EchoBridge.httpRequest，binary='1'，base64 回传，可带 Referer/UA）
                                  // 浏览器预览无原生桥时退回 window.fetch（必须 var F = window.fetch; F.call(...)，否则冒烟断言「非音源模块无网络 API」失败）
_swapToGraphable(url, ref, pos)   // 预加载：新建隐藏 <audio>（volume=0、preload=auto），等 canplay/readyState>=3（12s 超时）
                                  // 就绪后一次性切换：暂停并摘掉旧元素 src → load() 释放解码器 → 断开旧 mediaSrc → 接图 + 从当前位置播放
```

关键点是**「旧的一直在出声」**：`load()` 先按原生播（`_wantBlob = ref`），`play()` 里再触发 `_swapViaBlob`。取字节、预加载全过程都在后台，用户听不到中断；取不到就 `onGraphUnavailable` 提示一次（60 秒内不重复），**不关开关、不停播**。

**这一路踩到的七个坑（都是「打开音效没声音」的直接原因）**

| 坑 | 现象 | 修法 |
|---|---|---|
| 旧 `<audio>` 解码器不释放 | 新元素 `readyState` 永远 0；`_ended` 4 秒触发 29 次、`_createEl` 53 次（自激） | `stop()` 从「只 pause」改为 `pause()` + `removeAttribute('src')` + `load()` |
| `_createEl` 不重置 `playing` | autoplay 的 `play()` 被「已在播」提前 return，新元素永不启动 | `this.el = el` 之后立刻 `this.playing = false` |
| 曲末 `startAt` | `currentTime` 设到时长处 → 立刻 `ended` → 重建 → 再 ended 死循环 | `startAt` 只在 `< duration-0.1` 时 seek；`_ended` 加 `_ending` 防重入；`play()` 若已在曲末则先归零 |
| 取字节耗时造成回跳 | 位置从 1.53 跳回 0.67（听到重复） | 切换时用**当下**位置，且必须在摘 src 之前取（`removeAttribute('src')` 会把 `currentTime` 归零） |
| 关音效时换元素 | 要摘 src、重建解码器，实测卡 1~2 秒没声音 | 关音效**不再换元素**：`sound-effects.apply()` 关闭时已把 EQ 增益与湿声置 0，音频图本身就是干净旁路，留着它继续放 |
| `_blobPending` 不清 | 成功接管后标记还在，后续 rebuild 被「正在取字节」挡住，再也不会接管 | 成功切换后清空 `_blobPending` |
| 自动播放策略拦下新元素 | 换元素后 `play()` 被拒且不报错，元素 paused | `play()` 捕获 promise 拒绝 → 260ms 后重试；`_timer` 每拍自愈（`paused && readyState>=2` 再推一次） |

设备实测（同一测试源 `http://10.0.2.2:8080/test-audio.wav`，无 CORS 头）：
- 3 秒音频、播到 1.1s 后开音效：`+600ms` 仍在原生出声，`+1800ms` 已切到 `blob:` 且 `rs=4`，位置 0.49 → 1.24 连续推进；
- 60 秒音频、播到 5.5s 后开音效：位置 `5.55 → 5.83 → 6.46 → 7.23` 无缝接管，`err=null`、`toast=''`；
- 反复开关 5 轮：每轮都 `playing=true`、`rs>=2`、位置前进 ≥0.5s，5/5 稳定。

验收脚本同步改为「等真的接管再断言」（轮询 `_lastUrl` 以 `blob:` 开头且 `mediaSrc` 为真，最多 9 秒），C/E 组在采样前先 `seek` 到曲中，避免 3 秒测试音频撞曲末被误判成卡死。

---

### 2.18 真机「点歌就闪退」（v3.13.3 · Java 侧 OOM）

用户在真机（vivo V2011A / 序列号 `6d11ebf9`）装上 v3.13.2 后反馈「我操作操作，它就会闪退」。`adb -s 6d11ebf9 logcat -d -b crash` 抓到三次 FATAL，全部同源：

| 时间 | 崩点 | 要分配的内存 |
|---|---|---|
| 18:03:53 | `Base64.encodeToString`（`MainActivity.doHttp:1107`） | 66,557,984 B |
| 18:04:04 | `Base64.encodeToString` | 162,456,312 B |
| 18:05:01 | `ByteArrayOutputStream.grow` → `Arrays.copyOf`（`MainActivity.readAll:599`） | 202,899,472 B |

根因链：`doHttp` 用 `readAll` 把**整个响应**读成 `byte[]` → `Base64.encodeToString(bytes, NO_WRAP)` 再产出一个 **4/3 倍大小**的 `String` → `replyHttp` 才按 180,000 字符切片。一份 30–50MB 的无损会同时持有 byte[]、base64 String、`ByteArrayOutputStream` 扩容副本，超过 App 的 256MB 堆上限即 OOM；`lx-http` 线程没有兜异常，进程当场被杀。也就是说：**这不是界面 bug，是取音频字节的实现把内存撑爆了。**

**改法（Java `MainActivity.EchoBridge`）**

```java
HTTP_BINARY_LIMIT = 24 * 1024 * 1024;   // 音效取字节上限
HTTP_TEXT_LIMIT   = 8 * 1024 * 1024;    // 音源 JSON/脚本文本上限
```

- `doHttp` 二进制的分支：先看 `Content-Length`，超 24MB **立刻回错误字符串**（`"文件过大（30MB，上限 24MB），已跳过音效"`），一个字节都不读；否则交给 `streamBinary()`。
- `streamBinary()`：**凑满一整块再 Base64**（块长 262143 = 3×87381），逐块 `onChunk(key, i, b64)` 下发，Java 峰值只有一块 ≈ 350KB；累计超限或异常就回错误，成功时 `replyHttp(..., body="", binary=true)`。
- 文本分支 `readAll(in, HTTP_TEXT_LIMIT)`，超限抛「响应过大」。

**两个现场才暴露的细节**

1. **块长必须是 3 的倍数**。Base64 每 3 字节一组，块长不对齐时每块末尾会补 `=`，多块拼起来中间的 `=` 让前端 `atob` 直接报 `The string to be decoded is not correctly encoded` —— 整段解码失败，音效永远不接管（回归就是这么挂的）。
2. **`InputStream.read()` 不保证填满缓冲区**。真机上它每次只返回 8KB，于是「每读一次就编码一次」等于把 8KB 小块各自补 `=` 再拼接，同样非法。现在用 `while (filled < blockSize && (n = in.read(buf, filled, blockSize - filled)) > 0)` 凑满整块。

**JS 侧（`app/engine.js`）**

- 新增 `_b64ToParts(b64, maxBytes)`：按 512KB 分片 `atob`，直接把 `Uint8Array` 片段塞进数组，累计超限抛「文件过大…跳过音效」。
- `_fetchBytes` 改为返回 **Blob**（不再造一个巨型 `Uint8Array`），浏览器分支换成 `r.blob()` 并校验 24MB。
- `_swapViaBlob` 兼容 Blob / Uint8Array，空音频直接报错，mime 不一致时 `blob.slice(0, size, mime)`。

**设备验证（模拟器 Android 13 / `emulator-5554`）**

| 项 | 结果 |
|---|---|
| 30MB 二进制请求 | 1.5s 内返回 `文件过大（30MB，上限 24MB），已跳过音效`，页面存活，`logcat -b crash` 空 |
| 内存 | `dumpsys meminfo`：Java Heap 5,384 KB / 19,828 KB，Total 71MB（旧实现同场景必崩） |
| 132KB 正常音频 | `_fetchBytes` 回调 `size=132,344`、`type=audio/mpeg`，单块 base64 176,460 字符，一个分块、末尾仅 1 个 `=` |
| 点行播放 + 开音效专项 | 25/25 通过（含 F 组「调了 EQ 后才接管音频图 → blob:」） |
| `--persist` 重启复测 | 4/4 通过 |

> 取舍：**超过 24MB 的音频不再尝试接管音效**（保持原生播放 + 一次性 toast），因为把几十 MB 塞进 WebView 一样会拖死页面；24MB 覆盖 128k/320k MP3 整曲、以及 5 分钟上下的无损。需要更大上限时同步改 `HTTP_BINARY_LIMIT` 与 JS 里的 `MAXB`。

---

### 2.19 排行榜「点大图标没动作」→ 改成目录页；播放条在目录里常驻（v3.13.4）

用户原话：**「排行榜上面部分的大图标，点击后在下面显示歌曲，用户还以为没有动作。其实歌曲在下面刷新了，把它改掉，点击大图标则进入目录，在目录里面显示歌曲」**，并要求「无论是在歌单还是在排行榜里面点歌，播放器都要显示在下面，上下滑动歌曲时不能隐藏」。

**① 排行榜：卡片 = 目录入口**

以前点卡片只是把 `S.boardId` 换掉、再把曲目刷在卡片下方 —— 屏幕上看不出任何变化，因为用户的视线还停在卡片区。现在：

- 排行榜页只剩「榜单卡片」+ 一句说明（卡片副标题写「酷狗音乐 · 点击进入目录」）；
- 点卡片 → `openBoardDetail(id)` → 打开 `boardlist` 浮层页面：标题是榜单名，第一行是「播放全部」和「酷狗音乐 · 100 首」，下面是完整曲目；
- 加载态、来源说明（「100 首 · 来自酷狗音乐榜单」）、失败原因都写在浮层里，不再出现在主页。

**② 歌单 / 榜单目录：播放条常驻**

播放条本来就在 `.page` 的 flex 末端（不在 `.view` 的滚动容器里），问题只出在浮层：`.overlay` 是 `position: fixed; inset: 0`，刚好把它整个盖住。修法：

```css
.overlay.ov-with-bar { bottom: var(--pb-h, 56px); }   /* 歌单 / 榜单目录专用 */
```

- `renderOverlay()` 只在 `songlist` / `boardlist` 两种目录页加 `ov-with-bar`；
- `renderPlayer()` 把播放条实测高度写进 `--pb-h`，字号变大时高度变了也不会露馅；
- 目录的 `.ov-body` 自己滚动，播放条在浮层之外，所以**怎么上下滑都不会被顶走**，也不会遮住最后一首歌（浮层底边正好在播放条上沿）。

**③ 顺带修掉的竞态**

目录还在加载时点「播放全部」，原来 `contextIds()` 是空的 → 静默 return，用户又一次看到「点了没反应」。现在会等目录加载完（最多 10 秒）再按目录里的曲目建队列，超时才给提示。

**④ 点歌后的联动**

`playFrom()` 成功后，除 `detail` / `queue` 外，`songlist` / `boardlist` 也会 `renderOverlay()`，目录里当前播放的那一行立刻高亮（行首变成喇叭图标），播放条同步显示歌名与歌手。

**设备验证（模拟器 Android 13）**

| 项 | 结果 |
|---|---|
| 排行榜页渲染榜单卡片入口 | PASS（≥4 张卡片） |
| 点卡片进入目录（浮层打开且有 `.m-row`） | PASS |
| 目录显示来源说明（「来自…」） | PASS |
| 目录不盖住播放条（`ov-with-bar` + 底边 ≤ 播放条上沿） | PASS |
| 目录内「播放全部」可播放音源曲目 | PASS |
| 目录内播放后播放条显示当前歌曲 | PASS |
| 歌单目录同样不盖播放条 | PASS |
| 逻辑冒烟 | **463 / 463** |
| 设备分项验收 | **80 / 80** |
| 平台 / 歌单 / 返回键 / 代理 | **35 / 35** |
| 播放器 / 队列 | **41 / 41**、**22 / 22** |
| 点行播放 / 在线音效 | **25 / 25 + 4 / 4** |

> v3.13.5（删死控件）：搜索页右上角那对「歌曲 / 歌单」标签是个**死控件** —— 点下去只切换自己的高亮，`doSearch()` 从头到尾都没读过 `S.search.type`，无论选哪个都只返回歌曲。按用户要求整块删掉（连同 `.type-tabs` 样式和 `search-type` 动作），搜索页右上角现在留空，下载页的「清理已完成」按钮不受影响。

---

### 2.20 搜索页「歌曲 / 歌单」标签：确认无效后删除（v3.13.5）

**怎么确认它是死控件**

1. `renderHeader()` 只为 `nav_search` 渲染 `.type-tabs`，按钮动作是 `search-type`；
2. 唯一的处理器是 `case 'search-type': S.search.type = id; renderHeader(); renderView();` —— 只写状态、只重绘 Header，让按钮换个高亮；
3. 全仓检索 `S.search.type`：除了下面三处声明，**再没有任何读取**——
   `state.search.type` 初始化、以及上面两处渲染/写入；
4. `doSearch()` 用的是 `S.search.platform` 跟音源，从没按 type 分支；平台的 `ADAPTERS[id].search` 也只返回歌曲（`LXPlatform` 没有歌单搜索接口，`search` 的返回类型是 track 数组）。

结论：选了「歌单」也还是搜歌曲，等于给用户一个**按了没反应的按钮**。既然要真做歌单搜索得给五个平台各写一个歌单搜索适配器（工作量大、源站也不稳），按用户要求先删掉更合理。

**删了什么**

| 位置 | 处理 |
|---|---|
| `app.js` `renderHeader()` | 去掉 `nav_search` 分支的 `.type-tabs`，只保留下载页的「清理已完成」按钮 |
| `app.js` 事件 switch | 删除 `case 'search-type'` |
| `app.js` 初始状态 | `search` 去掉 `type: 'music'` |
| `app/styles.css` | 删除 `.type-tabs` / `.type-tabs button` / `.type-tabs button.on` 三条规则 |
| `evidence/smoke-test.js` | 新增 3 条断言：搜索页 header 不含 `search-type`/`type-tabs`、右上角为空、CSS 里已无 `.type-tabs` |

搜索页其余行为不变：平台选择条、搜索框、历史搜索、热门搜索（若开启）、平台状态说明、结果列表的「播放全部 / 多选 / 结果条数」。

**验证**

| 项 | 结果 |
|---|---|
| 逻辑冒烟（新增 3 条死控件断言） | **456 / 456** |
| 设备分项验收 | **80 / 80** |
| 实机截图 `evidence/apk-v3135-search.png` | 标题「搜索」右侧空白，标签已消失 |

> v3.13.6（详情页收藏）：播放详情页的按钮行里加了「收藏」——点一下弹出「收藏到列表」，列出所有列表（含首数与「已收藏」标记），点哪个就把当前这首歌加进哪个列表；已经存在的列表不会再重复添加。收藏按钮在有列表包含该歌时变主题色。

---

### 2.21 播放详情页「收藏」→ 选列表加入（v3.13.6）

**用户诉求**：在播放器页面加收藏标签，点了弹出歌单，选对应歌单把这首歌加进去。

**实现**

| 位置 | 说明 |
|---|---|
| `renderOverlay()` 的 `detail` 分支 | 按钮行从「列表 / 下载 / 音效 / 歌词」扩到 5 个：**列表 / 收藏 / 下载 / 音效 / 歌词**（`.detail-actions` 是 `space-around`，5 个按钮在 360dp 宽下每个约 72dp，放得下） |
| `collectPicker(id)` | 弹出标题「收藏到列表」+ 一句「把「歌名」添加到：」+ 每个列表一行（名字 / 首数 / 已在则标「已收藏」并显示实心心形） |
| `case 'detail-collect'` | 取**详情页正在展示的那首歌**（`D.byId(S.overlayId)`，从列表长按进来的详情不必是正在播放的），再打开选择器 |
| `case 'collect-to'` | 加入列表 → `save()`；已在则提示「「列表名」里已经有这首歌了」不重复；成功 toast「已收藏到「列表名」」并关窗 |
| 收藏按钮状态 | 只要任一列表含该歌，按钮加 `.on`（主题色），一眼能看出「已收藏过」 |

**踩到的一个坑**：第一版 `collectPicker` 用 `currentTrack()` 取歌，截图里详情页展示「我好像在哪见过你」，弹窗却写着「一场相逢一场梦」——因为那首歌是从列表长按进来的、并不在播放。改成以 `S.overlayId` 为准之后一致，并在冒烟里加了一条「收藏弹窗认的是详情页那首歌（不是碰巧正在播放的）」专门盯这个回归。

**验证**

| 项 | 结果 |
|---|---|
| 逻辑冒烟（新增 7 条收藏断言） | **463 / 463** |
| 设备分项验收 | **80 / 80** |
| 播放队列 | **22 / 22** |
| 播放器 | **41 / 41** |
| 点行播放 / 在线音效 | **25 / 25 + 4 / 4** |
| 真机级验证（模拟器 CDP） | 点「我的收藏」后 `trackIds = ['kw_ss_1']`、toast「已收藏到「我的收藏」」、按钮变主题色、重复点不再添加 |
| 截图 | `evidence/apk-v3136-detail.png`（5 个按钮）、`apk-v3136-collect.png`（弹窗）、`apk-v3136-collected.png`（收藏后变绿 + toast） |

> v3.13.7（贴底菜单被裁）：歌单 / 排行榜目录里点**最后一首歌**右侧「⋮」，弹出的子菜单原来会直接伸出屏幕底部被裁掉。根因是 `menu()` 在元素还带 `hidden`（`display:none`）时就量了 `offsetHeight`，拿到的永远是 0，所以「往上翻」那段限高计算从来没生效。现在先让菜单参与布局（`visibility:hidden`）量到真实宽高再定位：下方放不下就翻到触点上方，左右也按真实宽度夹住。

---

### 2.22 目录最后一行「⋮」菜单被屏幕裁掉（v3.13.7）

**现象**：歌单、排行榜的目录页里，滚到最后几首，点最下面那首歌右侧的三点菜单，弹出的子菜单下半截看不见（贴底那首几乎整个在屏幕外）。

**根因**（`app.js` 的 `menu()`）：

```js
// 旧代码
el.classList.toggle('tall', items.length > 8);
el.style.top = Math.max(8, Math.min(y || 120, innerHeight - el.offsetHeight - 14)) + 'px';
el.classList.remove('hidden');            // ← 到这一行才显示
```

`offsetHeight` 在 `hidden`（`display:none`）状态下恒为 0，于是 `min(y, innerHeight - 0 - 14) = y` —— 菜单永远从触点的下沿往下铺，屏幕底部之外的部分直接被裁掉。列表顶部的行不明显（下方空间够），**只有最下面一两行才暴露**。

**改法**：

```js
el.style.visibility = 'hidden';           // 先参与布局，但不显示
el.classList.remove('hidden');
var w = el.offsetWidth || 196, h = el.offsetHeight || 0;
var left = Math.max(8, Math.min(x || 60, Math.max(8, vw - w - 8)));
var top = (y || 120);
if (top + h + 8 > vh) top = top - h - 8;  // 下方放不下 → 翻到触点上方
top = Math.max(8, Math.min(top, Math.max(8, vh - h - 8)));
el.style.left = left + 'px'; el.style.top = top + 'px';
el.style.visibility = '';
```

- 三轴都按**真实尺寸**夹：右侧不越界、上方不越界、下方不越界；
- 贴底时菜单整个翻到触点上沿（截图里第 100 首的菜单顶边在第 94 首附近，不再被切）；
- 这个 `menu()` 是全局的，所以长按菜单、下载音质菜单、换源菜单、歌单操作菜单都一起修好了。

**验收（新增 G 段，模拟器实测真点击）**

CDP 派发 `mousePressed/mouseReleased` 到「最后一首」的三点按钮中心（`getBoundingClientRect` 取坐标），再用 `getBoundingClientRect()` 量菜单：

| 断言 | 结果 |
|---|---|
| 排行榜目录最后一行能弹出菜单 | PASS（7 项） |
| 菜单整体在屏幕内（top ≥ 0 / bottom ≤ 屏高） | PASS |
| 贴底时菜单向上翻（顶边 < 触点 y） | PASS |
| 歌单目录最后一行能弹出菜单 | PASS（7 项） |
| 歌单目录菜单整体在屏幕内 | PASS |
| 设备验收总数 | **85 / 85**（原 80 + 新增 5） |

截图：`evidence/apk-v3137-board-menu.png`（第 100 首「你有没有真的爱过我」）、`apk-v3137-songlist-menu.png`（第 100 首「献天缘」）—— 两份菜单都完整可见，且都位于底部播放条之上。

---

## 3. 从源码重建

### 3.1 依赖

| 工具 | 路径 / 版本 |
|---|---|
| Node.js | 22.x（`node -v`） |
| Python | 3.13（`python --version`） |
| JDK | Temurin 21，实际路径 `C:\Users\maoxu\AppData\Roaming\craft-anything\engines\jdk\jdk-21.0.12.1+1`（**不在 PATH**，构建前需前置 `bin`） |
| Android SDK | `C:\Users\maoxu\tools\android-sdk` |
| build-tools | **35.0.0**（必须；34.0.0 的 R8 8.2.2 在 JDK 21 下处理 javac 类文件会抛内部 NPE） |
| platform | `android-34`（`android.jar`） |
| 模拟器 | AVD `shilv_test` / Android 13 / API 33 |
| adb | **必须显式使用** `C:\Users\maoxu\tools\android-sdk\platform-tools\adb.exe`（1.0.41）；PATH 里的 `C:\Windows\system32\adb.exe` 是 1.0.32，会报 `error = 109` 并拖垮 daemon |

### 3.2 三条命令

```bash
# JDK 不在 PATH：每次新 shell 都要前置，否则 build.py 找不到 javac/keytool
$env:PATH = 'C:\Users\maoxu\AppData\Roaming\craft-anything\engines\jdk\jdk-21.0.12.1+1\bin;' + $env:PATH

# 1) 把 app/ 的 3 个 CSS + 13 个 JS + icomoon 字体内联成单文件
node evidence/build-standalone.js          # -> app/standalone.html (416,539 B)

# 2) 逻辑冒烟测试（Node + DOM shim）
node evidence/smoke-test.js                # 449/449

# 3) 一键构建签名 APK
python android/build.py                   # -> LXMusic-v3.13.2.apk
```

**版本号要改两处**：`android/build.py` 的 `VERSION_NAME/VERSION_CODE/FINAL_APK`，
以及 `android/AndroidManifest.xml` 的 `android:versionCode/versionName`。
清单里写死的值会盖掉 `aapt2 --version-code`，只改 build.py 会得到「文件名 3.10.0、aapt 里仍是 13」。

`build.py` 链路：`aapt2 compile` → `aapt2 link`（`-A assets`）→ `javac` → `d8` → 合并 `classes.dex` → `zipalign` → `keytool`（仅首次）→ `apksigner` → `verify` + `aapt dump badging` + SHA-256。
**无 Gradle、构建过程不联网。**

### 3.3 关键实现点

- **伪 HTTPS 安全源**：`MainActivity` 用 `shouldInterceptRequest` 把 `https://app.echo.local/**` 映射到 `assets/`；v3.1.0 起**只接管该域名**，其他 URL 返回 `null` 交给 WebView 联网，否则在线 `<audio>` 会被 404 拦掉。
- **混合内容**：页面是伪 HTTPS，音源常返回 HTTP 音频/接口，故 `MIXED_CONTENT_ALWAYS_ALLOW` + `usesCleartextTraffic="true"`。
- **原生 HTTP 桥**：`EchoBridge.httpRequest(key,url,method,headers,body,timeout,binary)` 在后台线程执行 `HttpURLConnection`，结果经 `window.LXHttp.onResponse` 回传；二进制以 base64 返回，超过 180,000 字符自动 `onChunkStart/onChunk` 分块，避免单次 JS 注入过大。`cancelRequest(key)` 支持取消。
- **下载桥**：`download.js` 用 `saveDownloadStart/Chunk/Finish` 分块传 base64；Java 侧 `MediaStore.Downloads` 写 `Download/LX Music`（API 29+ `IS_PENDING`，无需运行时权限），完成后回调 `LXDownload.onDeviceSaved(name, ok, path)`。`saveDownloadStart` 只做 `new File(name).getName()`，**不能 sanitize 中文名**，否则回调匹配不上任务。v3.1.0 的 MIME 取音源返回的 `mime`。
- **本地回放端点（v3.13.0）**：`shouldInterceptRequest` 新增 `/__local?p=<相对路径>`。写入时把 MediaStore 返回的 `content uri` 按真实落盘路径记进 `SharedPreferences("lx_local")`，端点按它 `openAssetFileDescriptor(uri,"r")` 取流；只放行 `PUBLIC_ROOTS`（Download/Music/Documents/Pictures/Movies），`..` 拒绝，支持 Range → 206 + `Content-Range`，并带 `Access-Control-Allow-Origin: *`。实测「按路径直读」与「按 RELATIVE_PATH 反查」在 Android 13 分区存储下都可能失败，写入时记 uri 才是稳的。
- **曲目兜底重建（v3.13.1）**：曲库是纯内存态（`data.js.tracks` 必须为空 + `external` 动态池随页面重建而清空），所以 `playFrom()` 不能假设「id 一定查得到曲目」。先用 `D.byId()`，查不到就 `trackFromDownload(id)` 按下载任务重建并 `addExternalTracks()` 注入，再查不到才提示。否则重启后点已下载的歌会**静默无反应**。
- **音效接管的安全边界（v3.13.1）**：`AudioEngine.wantGraph(ref)` = 总开关开 **且**（本地/已下载音源 **或** EQ/混响/环绕真非平）。在线音源在「开关开但参数全平」时保持原生播放，不重路由到 `/__media`，避免源站波动时一开开关就报错；`syncAudioGraph()` 与 `_createEl()` 必须共用这一个判定，且 `LXSound.onChange` 要主动调用 `syncAudioGraph()`（参数变化即时生效，不依赖某个 UI 事件）。
- **在线音效只用同源 Blob（v3.13.2）**：`_fetchBytes` 走 `LXSourceAPI.request`（Java `HttpURLConnection`，可带 Referer/UA、不受 CORS 与混合内容限制）把整段音频取成字节 → `Blob` → `URL.createObjectURL` → 同源 `<audio>` → `MediaElementSource`。**不要**再指望 `/__media` 重路由：它要源站重来一遍，源站波动就 `readyState=0`，而跨域无 CORS 的媒体接进 Web Audio 是**静默**的。`_blobCache` 只留 3 个（超出 `revokeObjectURL`）；`_swapToGraphable` 先在后台把新元素预加载到 `canplay`，再「停旧 → 摘 src + `load()` 释放解码器 → 断开旧 `mediaSrc` → 接图 + 从当下位置播」。取不到字节就 `onGraphUnavailable` 提示一次（60s 内不重复），保持原生播放、不关开关。
- **关音效不换元素（v3.13.2）**：`snd.apply()` 在关闭时已把 EQ 增益与湿声置 0，音频图本身就是旁路；再换回原生元素要摘 src、重建解码器，实测会卡 1~2 秒没有声音，所以 `rebuild()` 在 `!want && mediaSrc` 时直接返回。
- **文件导入**：`WebChromeClient.onShowFileChooser` → `ACTION_GET_CONTENT` → `PickedProvider` 把选中文件缓存成字节再以自有 `content://` 回传，WebView 的 `<input type=file>` / `FileReader` 可读，无需存储权限。音源本地导入也复用此通道。
- **备份 / 音源脚本导出**：`android/bridge-patch.js` 仅注入 APK 资产，拦截 `<a download>` 的 `blob:` 链接交给 `EchoBridge.saveText`；Java 按后缀写 MIME（`.js` → `application/javascript`）。
- **返回键**：先派发 `Escape` 关闭弹层/抽屉，无弹层时才 `finish()`。

---

## 4. 环境与路径陷阱

1. **中文路径**：`aapt2` / `aapt` / `zipalign` 是原生程序，在 `E:\AI\重构软件\` 下会报 `failed to open directory` 或 `Illegal byte sequence`。`build.py` 已把全部中间产物放到纯 ASCII 的 `C:\temp\lx-build\`，`aapt dump badging` 也先复制到 `C:\temp\lx-v3-badging.apk`。
2. **adb 掉线**：跨工具调用时 daemon 常掉线。所有 adb 操作放在**同一次 shell 调用**里，先 `adb devices` / `adb wait-for-device`；必要时先 `adb kill-server && adb start-server`。
3. **Git Bash 路径转换**：`adb shell ls /sdcard/...` 会被 MSYS 转成 Windows 路径。用 `MSYS_NO_PATHCONV=1 adb shell '...'`。
4. **取设备二进制**：用 `adb exec-out cat <path> > file`，避开中文文件名；同名文件会被 MediaStore 自动加 ` (1)`、` (2)` 后缀。
5. **冷启动顺序**：八个脚本必须按 `i18n → themes → data → engine → source-api → sources → download → app` 顺序加载；`window.LXApp` 在脚本加载时即发布（早于 `DOMContentLoaded` 的首次 `render()`），否则扩展钩子首次渲染访问未定义对象会白屏。冒烟测试含该回归。
6. **设备验收的冷启动**：`device-check.js` 会切换导航并写 localStorage，重复运行时首屏断言会失败。每次跑前先 `pm clear` + `force-stop` + `am start`（不要在 CDP 里 reload，会导致执行上下文与 DOM 不同步）。
7. **WebView 文件选择（v3.1.1 踩坑）**：`document.createElement('input')` 后不 `appendChild` 直接 `.click()`，桌面浏览器可用，**Android WebView 会静默忽略**，表现为「点了没反应」。必须挂 DOM，且不要用 `display:none`。
8. **WebView 跨进程读文件**：`content://` Provider 声明 `exported="false"` 时，WebView 渲染进程（独立 UID）读不到，`FileReader` 静默失败。要么 `exported="true"` + `grantUriPermission`，要么像本版一样改用原生桥直接回传文本。
9. **JS 桥不可 hook**：`addJavascriptInterface` 注入的 Java 方法在 JS 里是只读代理，`EchoBridge.xxx = fn` 静默无效。验收不要靠覆盖方法计数，改看页面状态（等待态、数据变化）。
10. **uiautomator 两处坑**：`ET.Element` 的布尔值取决于子元素个数，`if elem:` 对空节点为假，必须 `is not None`；网格视图里模糊匹配会命中缩略图的 `content-desc="Preview the file …"`，点它只打开预览，必须精确匹配文件名 `text`。
11. **adb forward 每次新 shell 都会失效（v3.9.0 实测）**：本机 adb daemon 会在每次新进程的首个命令时重启，
    重启后 `forward` 全部丢失，`node evidence/device-*.js` 会报 `fetch failed`。所有 adb 操作（`start-server` →
    `forward` → `node 脚本`）必须写在**同一次** shell 调用里。
12. **`evaluateJavascript` 的返回值是 JSON 序列化结果**：JS `return 'true'` 得到的是带引号的 `"true"`，
    Java 侧 `"true".equals(value)` 永远不成立。返回键的「一按就退出」就是这么来的 ——
    要么让 JS 返回布尔，要么在 Java 里先 `replace("\"","")`。

---

## 5. 验收

### 5.1 静态 / 逻辑

```bash
node evidence/build-standalone.js && node evidence/smoke-test.js
```

`449/449`：冷启动、520 条文案、16 套主题 / 232 个派生变量、52 个图标、24 个榜单（酷狗内置）、内置曲库为空、6 个视图、抽屉与 PlayerBar 尺寸、搜索/播放/全屏页、WAV 头（RIFF/WAVE/fmt/PCM/采样率/位深/data 长度）、下载队列状态机、Android 分块桥、离线播放、单文件版；自定义音源协议（EVENT_NAMES / md5 / base64 / 沙箱）、导入与 20 个上限、JS 音源搜索、stream 在线收听、按来源格式下载、管理页 UI；v3.1.1 的本地导入回归（`LXFilePick` 等待态、分块回传、文件名来源、ack 去重、取消不静默、错误原因、回退 input 挂 DOM）；v3.2.0 的空曲库与迁移；v3.3.0 的平台解析、平台搜索、按 `sources` 自动匹配账号、酷狗榜单；v3.4.0 的原生流式下载、进度/速度、取消与失败重试；v3.5.0 的音质模块（9 档 / 母带最高 / 平台可选表 / 降级链）、歌曲菜单品质选择、按所选档位请求音源、全档失败如实报错、批量下载选品质；**v3.6.0 的加密向量（MD5/SHA1/AES-128-ECB/zzcSign）、网易与 QQ 的请求形态与字段映射、音源声明母带时菜单标可用、取链失败原因透传**；v3.7.0 的音效（10 段 EQ / 9 预设 / 混响 / 环绕）、歌词解析与详情页下载；**v3.8.0 的默认音源优先级、音源更新、音频图按需接管**；**v3.10.0 第 21 组的 11 条设置项（滑块+数字框形态、点击不重建、速率/字号/歌词字号/下载音质实际生效、样式里再无裸 px 字号）**；以及 **v3.11.0 第 22 组的 16 条队列视角（下一首文案、剩余首数、三种模式提示、随机不重复、队列页高亮与点选切歌、切换后信息条同步）**；**v3.12.0 第 23 组的 18 条下载目录（下拉 5 项、默认路径、行内完整路径、切换生效、自定义弹窗、子目录归位、中文目录保留、`../` 与超长路径拒绝、原生桥带上目录参数）**；**v3.13.2 的字节缓存与音频图接管（`_fetchBytes` 双通道、`_blobCache` 上限 3 且超出 revoke、`_swapToGraphable` 预加载后才切换、`_ended` 防重入、`startAt` 曲末守卫、关音效只旁路不换元素、非音源模块仍无网络 API）**。

### 5.2 模拟器（CDP 驱动真实 WebView）

```bash
ADB="C:/Users/maoxu/tools/android-sdk/platform-tools/adb.exe"
"$ADB" shell am force-stop com.lxmusic.replica
"$ADB" shell pm clear com.lxmusic.replica
"$ADB" shell am start -n com.lxmusic.replica/.MainActivity
SOCK=$(MSYS_NO_PATHCONV=1 "$ADB" shell 'cat /proc/net/unix | grep webview_devtools_remote | head -1' | tr -d '\r' | sed 's/.*@//')
"$ADB" forward --remove-all
"$ADB" forward tcp:9222 "localabstract:$SOCK"
node evidence/device-check.js
```

`76/76`：页面资源与安全源、抽屉、搜索、播放、下载落盘、统计卡片、离线播放、深色主题、持久化；以及音源管理页、原生 HTTP 桥 Java→JS 回调（实测 `ok:200`）、JS 音源搜索、`stream` 在线收听、按格式落盘；以及酷我真实搜索 30 首、平台 chip、未导入音源提示、账号验证、酷狗榜单 100 首与切换；v3.5.0 的歌曲菜单品质菜单（9 档）与按档位下载；v3.6.0 的脚本挂载；v3.7.0 的音效频段与预设、EQ 钳制与持久化、歌词六类解析、详情页与音效页元素、母带入队不降档；以及 **v3.8.0 的默认音源优先级与持久化、管理页默认标签与更新按钮、已无逐平台绑定**。截图写到 `evidence/apk-v3-*.png`，报告 `evidence/device-check.json`。

### 5.3 真机文件导入（v3.1.1）

```bash
# 1) 把测试音源推到设备
MSYS_NO_PATHCONV=1 "$ADB" push "evidence/fixtures/真机导入测试.js" "/sdcard/Download/真机导入测试.js"
# 2) 冷启动 + CDP 转发（同上）
# 3) 后台运行验收：打开管理页 → 点「本地导入」→ 轮询音源数量
node evidence/device-pick-check.js &
# 4) 在系统文件选择器里真实选中该文件
python evidence/pick-file-ui.py
```

`11/11`：系统选择器 `com.google.android.documentsui/.picker.PickActivity` 正常弹出 → 选中文件 →
返回应用 → 音源 `1 → 2`（名称「真机导入测试音源」、`origin=local:真机导入测试.js`）→
已持久化、可立即搜索。报告 `evidence/device-pick-check.json`，截图 `evidence/apk-v3-file-picked.png`。

> 复现旧版 bug：`node evidence/repro-file-pick.js` 会输出 `clicks:1 / changes:0 / readAsText:0`，
> 且前台 Activity 始终是 `MainActivity` —— 即 `onShowFileChooser` 从未被调用。

### 5.4 搜索平台切换（v3.2.0）

```bash
node evidence/device-source-switch.js   # 需先 CDP 转发
```

`8/8`：导入「平台甲 / 平台乙 / 仅解析源」三个测试音源后 —— 选甲只返回 3 首甲的歌、
选乙只返回 2 首乙的歌、选仅 `musicUrl` 的源时提示「未实现 search 动作」且结果 0 条、
选「全部音源」聚合 5 首。脚本结束会自动移除自己导入的测试源。
报告 `evidence/device-source-switch.json`。

### 5.5 网易 / QQ 搜索专项（v3.6.0）

```bash
node evidence/device-wy-tx-check.js   # 需先 CDP 转发；会导入 evidence/fixtures/星海音乐源v2.3.19.js
```

`42 / 42`：

| 分组 | 结果 |
|---|---|
| 加密模块 | 设备上 MD5 / SHA1 / AES-128-ECB / zzcSign 与标准向量一致 |
| 音源导入 | 星海音乐源导入成功，声明 `wy,tx,kg,kw,mg,qs`，初始化 success |
| 平台账号 | `forPlatform('wy')` / `('tx')` 自动命中，网易「验证通过」 |
| 网易搜索 | 「周杰伦」→ **20 首**，0.5s，说明「来自网易云音乐内置接口」 |
| 网易播放 | `engine.mode='stream'`，播放条「想你就写信 (Live)」 |
| QQ 搜索 | 「周杰伦」→ **30 首**，1.0s，`songmid=0027oMO61wWi55`、`media_mid=002A6j2q1tdUUP` |
| 网易下载 | **3,820,077 B** MP3 → `Download/LX Music/想你就写信 (Live) - 周杰伦、李硕、张鑫.mp3` |
| QQ 取链受限 | 如实透传「后端失败: 触发人机验证」，不进入假播放 |

报告 `evidence/device-wy-tx-check.json`，截图 `apk-v3-wy-search.png`、`apk-v3-tx-search.png`、
`apk-v3-wy-playing.png`、`apk-v3-wy-tx-download.png`。

### 5.6 播放器专项（v3.8.0）

```bash
node evidence/device-player-check.js   # 需先 CDP 转发
```

`41 / 41`：音效关闭时不接管音频图、开启后接管且不打断播放、关闭后回退原生、音频元素已加载元数据（`readyState>=1` 且 `duration>0`）、歌词 5 行解析并按进度高亮到第三行、
详情页下载菜单 9 档、音效页 9 预设 / 10 滑块 / 混响 / 环绕可操作、关闭音效保留配置、
下载页下拉 9 档且选母带后任务 `quality=master`。
报告 `evidence/device-player-check.json`，截图 `apk-v3-detail-lyric.png`、`apk-v3-effects.png`、
`apk-v3-download-master-page.png`。

### 5.7 排行榜 / 歌单 / 返回键 / 音频代理专项（v3.9.0）

```bash
node evidence/device-platform-check.js   # 34 项
node evidence/device-effects-check.js     # 40 项（需要真实音源 fixtures）
```

`device-platform-check.js`（34/34）：五个平台的榜单目录与曲目（酷我 100 / 酷狗 100 / 咪咕 50 / 网易 200 / QQ 100）、
五个平台的推荐歌单与歌单详情、歌单页卡片与浮层曲目、返回键三级消费（设置页→搜索页、排行榜→搜索页、关闭浮层）、
搜索主页无内容时返回 `false`、`__media` 代理端点（206 + `Content-Range` + `Accept-Ranges`）。

`device-effects-check.js`（40/40）：用 `evidence/fixtures/星海音乐源v2.3.19.js` 播真实曲目，逐个平台验证
「开音效后 `<audio>.src` 变成 `https://app.echo.local/__media?u=…`、`mediaSrc` 存在、`AudioContext=running`、
`_graphFallback=false`、`MediaError=0`、currentTime 继续前进」，以及关闭音效后地址回到原始 CDN。
QQ 平台若音源返回「触发人机验证」，脚本记 `SKIP`（音源侧限制，不是播放链路问题）。

截图：`apk-v39-songlist-page.png`、`apk-v39-songlist.png`、`apk-v39-board-wy.png`、`apk-v39-board-tx.png`、
`apk-v39-effects-wy.png`、`apk-v39-effects-multi.png`。

### 5.8 本地测试音频服务（下载 / 音质验收的前置）

`device-player-check.js` 与 `device-quality-check.js` 的测试音源指向 `http://10.0.2.2:8080/test-audio.wav`，
需要先在宿主机起一个**支持 Range** 的静态服务（`python -m http.server` 不返回 206，会让续传断言失真）：

```bash
node evidence/test-audio-server.js 8080 C:/temp/lx-audio/test-audio.wav
# 校验：curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" http://127.0.0.1:8080/test-audio.wav  → 206
```

> 该服务必须用工具的后台任务方式常驻；用 `(cmd &)` 启动会随 shell 退出被杀，表现为真机报
> `failed to connect to /10.0.2.2 (port 8080) after 20000ms`。

### 5.9 设置项专项（v3.10.0）

```bash
# 需先起本地测试音频服务（5.8），并完成 CDP 转发
node evidence/device-settings-check.js            # 阶段一：26 项
node evidence/device-settings-check.js --persist  # 阶段二：10 项（冷启动后仍保持）
```

阶段一 `26 / 26`：

| 分组 | 断言 |
|---|---|
| A 控件形态 | 播放速率 / 界面字体大小 / 歌词字体大小 都是「滑块 + 数字框」；下载音质下拉 9 档 |
| B 根因回归 | 点数字框、点下拉后**控件未被重建**（旧版可输入/可选中之前就被替换） |
| C 播放速率 | 改 1.5× 后设置值、引擎倍率一致；改 0.8× 生效；滑块与数字框互相同步 |
| D 界面字号 | `--ui-fs=1.214`，文字 14→16.996px，图标 18→21.852px；调到 12 也能变小 |
| E 歌词字号 | `--lyric-size=22px`，歌词正文实测 22px、翻译行 18.04px；调小到 14px 生效 |
| F 下载音质 | 切到「无损音质」后 `DL.opts.quality`、`settings.downloadQuality`、下拉显示、下载页下拉全部一致，并已写入 localStorage |

阶段二 `10 / 10`：冷启动后播放速率 1.5、字号 17、歌词 22、下载音质 flac 全部保持，
且启动即应用 `--ui-fs / --lyric-size`（证明不是只改了内存）。

截图：`apk-v310-settings.png`、`apk-v310-fontsize.png`、`apk-v310-settings-sliders.png`、
`apk-v310-settings-font18.png`、`apk-v310-persisted.png`。
报告：`device-settings-check.json`、`device-settings-persist.json`。

### 5.10 播放队列专项（v3.11.0）

```bash
# 需先起本地测试音频服务（5.8）+ CDP 转发；脚本会自己导入 evidence/fixtures/设备测试音源.js
node evidence/device-queue-check.js      # 22 项
```

`22 / 22`（真机 WebView，酷我歌单 100 首）：

| 分组 | 断言 |
|---|---|
| A 准备 | 测试音源导入成功并可服务酷我 |
| B 歌单 | 歌单页出现推荐卡片 → 歌单详情出曲目 → 「全部播放」把 **100 首**灌进队列 |
| C 详情页 | 信息条含「下一首 + 歌名·歌手」；`第 1 / 100 首 · 还剩 99 首 · 列表循环`；有「列表」按钮；点下一首后索引 1、信息条变 `还剩 98 首` |
| D 队列页 | 列出全部 100 条、当前高亮、`共 100 首 · 当前第 2 首`；点第 5 条即切过去，详情页同步 |
| E 随机 | 模式按钮切到 random、信息条改为「每次从 100 首里抽一首」、连点 6 次 next 均不停在原曲 |

截图：`apk-v311-detail-queue.png`、`apk-v311-queue-list.png`、`apk-v311-queue-detail.png`；
报告 `evidence/device-queue-check.json`。

### 5.11 下载目录专项（v3.12.0）

```bash
# 需先起本地测试音频服务（5.8）+ CDP 转发；脚本会自己导入测试源
node evidence/device-dlpath-check.js              # 20 项（含真实下载）
# 重启应用后再跑一次，核对设置落盘
node evidence/device-dlpath-check.js --persist    # 4 项
```

`20 / 20` + `4 / 4`（真机 WebView，真下载真落盘）：

| 分组 | 断言 |
|---|---|
| A 设置页 | 「下载目录」行存在且是下拉；默认 `Download/LX Music`；行内展示 `/storage/emulated/0/…` |
| B 切换 | 用真实 `change` 事件选到 `Music/LX Music` → 设置与下载队列同步；下载一首后 `path = Music/LX Music/目录测试 - 歌手.wav` |
| C 自定义 | 选「自定义→我的音乐」弹窗可输入 → 归一化为 `Download/我的音乐`；再下载一首，`path = Download/我的音乐/…` |
| D 越权 | `../etc` 与超长路径都被拒并回默认 |
| E 重启 | 冷启动后 `downloadDir` 仍为 `Download/我的音乐`，`DL.opts.dir` 已回填，设置页显示同一路径 |

宿主机侧同时核对（证据比断言更硬）：

```
/sdcard/Music/LX Music/目录测试 - 歌手.wav        132,344 B
/sdcard/Download/我的音乐/目录测试 - 歌手.wav      132,344 B
content query → relative_path=Music/LX Music/ 及 Download/我的音乐/
```

截图：`apk-v312-dlpath-row.png`、`apk-v312-dlpath-modal.png`、`apk-v312-dlpath-custom-row.png`；
报告 `evidence/device-dlpath-check.json`（`--persist` 覆盖写同一文件，`persist` 字段区分阶段）。

> 验收后已把设备上的目录设置恢复为默认 `Download/LX Music`，并删除两个测试目录里的测试音频。

### 5.12 点行播放 / 本地回放 / 音效接管专项（v3.13.0 → v3.13.2 扩到 25 + 4 项）

```bash
# 需先起本地测试音频服务（5.8）+ CDP 转发；脚本自己导入测试源、自己下载
node evidence/device-dlplay-check.js            # 25 项（真下载 + 真点击 + 真播放 + 在线音效接管）
node evidence/device-dlplay-check.js --persist  # 4 项（重启后点已下载歌曲，内存 Blob 已失效）
```

`25 / 25` + `--persist 4 / 4`（模拟器 Android 13 / WebView 109）：

| 分组 | 断言 |
|---|---|
| A 下载 | 导入测试源 → 搜一首 → 挂在 320k 下载 → `state=done` 且 `path` 以 `Download/` 开头 |
| B 点行 | 已完成任务整行 `class="dl-item.hit"` + `data-act="dl-play"`；**没有**独立「播放」按钮；真实 `click()` 整行后 `playing=true` |
| B 本地播放 | `engine._lastUrl` 是 `https://app.echo.local/__local?p=Download%2F…`；播放位置持续前进（1s 内增 > 0.6s） |
| C 音效 | 音效面板长度 3596 字符、开关可勾选；勾上后 `mediaSrc=true`、`ctx.state=running`（**参数全平也接管**）；切图后位置接着前进 |
| C 不报错 | 全程 `Runtime.exceptionThrown` 为 0 |
| D Range | `fetch(url, Range: bytes=0-99)` → `206` + `Content-Range: bytes 0-99/132344` + 实际 100 字节 |
| E 关闭 | 关掉音效后 DSP 被旁路（`LXSound.state().enabled=false`、EQ 增益归零），位置继续前进（v3.13.2 起不再换元素，避免卡 1~2 秒） |
| F 在线音效接管 | 在线曲目 + 音效开 + 参数全平 → 地址仍是原始 `http://…`、`mediaSrc=false`（不重路由、保持原生出声）；`playing=true`；`LXSound.setBand(0,6)` 后**轮询等到地址变 `blob:`**（最多 9 秒）、`mediaSrc=true`、`el.error=null`、`toast=''`；再采 5 次位置确认仍在出声 |
| P 重启后 | 任务仍在且 `path` 正常；`/__local` 仍返回 `206 + 100 字节`；点行 `playing=true`；地址是 `/__local?p=…` |

截图：`apk-v313-download-row.png`（下载页整行播放图标）、`apk-v313-local-play.png`（点行后本地播放中）、`apk-v313-effects-on.png`（音效开启后的详情页）；报告 `evidence/device-dlplay-check.json`。

### 5.13 已验证产物

```
# 音源 downloadUrl 返回的 WAV 原样落盘（未重编码）
/sdcard/Download/LX Music/夜测一 - 设备歌手.wav     12,044 B
Python wave: 1 声道 / 16-bit / 6000 Hz / 6,000 帧 / 1.0 秒

logcat: 无 FATAL EXCEPTION、无 Uncaught、无 JS ERROR
```

v3.13.4（榜单目录 / 播放条常驻）在模拟器 Android 13 上的完整回归：

| 专项 | 结果 |
|---|---|
| 逻辑冒烟 | **463 / 463** |
| 设备验收 `device-check.js` | **85 / 85**（新增贴底菜单不被裁断言） |
| 平台 / 歌单 / 返回键 / 代理 `device-platform-check.js` | **35 / 35** |
| 播放器 `device-player-check.js` | **41 / 41** |
| 设置 `device-settings-check.js` | **26 / 26** |
| 播放队列 `device-queue-check.js` | **22 / 22** |
| 点行播放 / 在线音效 `device-dlplay-check.js` | **25 / 25** |
| 重启后 `--persist` | **4 / 4** |
| 30MB 大文件请求 | 1.5s 内明确报「文件过大（30MB，上限 24MB），已跳过音效」，页面存活、crash 缓冲空、Java Heap 5.4MB |

> v3.2.0 验收结束后已删除 `Download/LX Music` 下的测试音频并 `pm clear` 应用数据，
> 安装包本身不含任何音乐文件。

---

## 6. 已知边界

- v3.2.0 起不含任何内置音乐：曲目、歌单、歌词、评论全部来自用户导入的 JS 音源；没有音源时界面会显式提示去导入。
- 曲目、歌单、歌词、评论仍取决于音源脚本返回的内容，本应用不内置任何音源。
- 音源脚本运行在 WebView 的受限函数作用域，不等价于原版 QuickJS 引擎的完整冻结与进程隔离；请只导入可信脚本。
- 通知栏 MediaSession、前台服务、桌面歌词悬浮窗、真实多端同步未原生实现，以页面内等价交互呈现。
- 本版是独立编写的 WebView 实现，不是对原 APK 的二进制改造；静态取证全程未运行目标程序、未连接其服务端。
