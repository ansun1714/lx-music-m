# 原版自定义音源（user-api）静态取证

取证对象：`E:/AI/原软件/lx-music.apk`（SHA-256 `9f63c064608bc304e873520f20927f30c8c821098c96fffe8c7cc68db4810ba0`），
交叉验证 `lyswhut/lx-music-mobile` tag `v1.9.2` 源码与官方文档。全程静态，未运行目标 APK、未插桩、未连接其服务端。

## 1. APK 内直接证据

`assets/script/user-api-preload.js`（594 行，QuickJS 预加载脚本）是该功能最权威的运行时契约：

```js
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const supportQualitys = {
  kw: ['128k','320k','flac','flac24bit'], kg: [...], tx: [...], wy: [...], mg: [...], local: []
}
const supportActions = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'], wy: ['musicUrl'],
  mg: ['musicUrl'], local: ['musicUrl','lyric','pic']
}
globalThis.lx = {
  EVENT_NAMES,
  request(url, { method, timeout, headers, body, form, formData, binary }, callback) { ... },
  send(eventName, data) { ... },   // inited / updateAlert
  on(eventName, handler) { ... },  // request
  utils,                            // buffer / crypto / zlib(未实现)
  currentScriptInfo: { name, description, version, author, homepage, rawScript },
  version: '2.0.0',
  env: 'mobile',
}
globalThis.setTimeout = _setTimeout
globalThis.eval = function () { throw new Error('eval is not available') }
```

`handleRequest` 中对 `musicUrl` / `pic` 的返回值强制要求 `^https?:` 字符串，对 `lyric` 校验 `{lyric,tlyric,rlyric,lxlyric}`。
`handleInit` 把脚本声明的 `sources` 按 `allSources / supportQualitys / supportActions` 过滤后上报应用。

安全约束：`Function.prototype.constructor` 被 Proxy 拦截、禁用动态代码执行、`globalThis` 属性冻结、`lx` 冻结。

## 2. 官方文档（源编写说明）

来源：`https://lyswhut.github.io/lx-music-doc/mobile/custom-source`（重定向到 `https://lxmusic.toside.cn/mobile/custom-source`）。

- 文件必须 UTF-8、JavaScript ES6+，开头必须有注释头：
  ```js
  /**
   * @name 测试脚本
   * @description 我只是一个测试脚本
   * @version 1.0.0
   * @author xxx
   * @homepage http://xxx
   */
  ```
  `@name` 必填（建议 ≤24 字），其余选填。
- 基本脚本骨架：
  ```js
  const { EVENT_NAMES, request, on, send } = globalThis.lx
  const httpRequest = (url, options) => new Promise((resolve, reject) => {
    request(url, options, (err, resp) => { if (err) return reject(err); resolve(resp.body) })
  })
  on(EVENT_NAMES.request, ({ source, action, info }) => {
    switch (action) {
      case 'musicUrl': return apis[source].musicUrl(info.musicInfo, qualitys[source][info.type])
      case 'lyric': ...
      case 'pic': ...
    }
  })
  send(EVENT_NAMES.inited, {
    sources: {
      kw: { name:'酷我音乐', type:'music', actions:['musicUrl'],
            qualitys:['128k','320k','flac','flac24bit'] },
      local: { name:'本地音乐', type:'music', actions:['musicUrl','lyric','pic'], qualitys:[] },
    },
  })
  ```
- `lx.request` 不受跨域规则限制（由原生层发 HTTP）；`lx.on` 回调必须返回 Promise；`inited` 发送前的任何异常视为初始化失败。
- 可用宿主 API 只有 `setTimeout` / `clearTimeout`；浏览器 / Node API 不可用。
- 移动版 `zlib` 未实现，`utils.buffer` 只支持 base64 / hex / utf8。
- **重要边界**：移动版 user-api v2.0.0 的 `actions` 只覆盖 `musicUrl / lyric / pic`，即脚本只负责为**内置 SDK 检索到的歌曲**补 URL / 歌词 / 封面；搜索、歌单、榜单仍由内置音源完成。

## 3. 界面与文案证据（`src/lang/zh-cn.json`）

```
setting_basic_source            = 自定义源
setting_basic_source_title      = 选择自定义源
setting_basic_source_user_api_btn = 自定义源管理
setting_basic_source_test/temp/direct = 测试接口 / 临时接口 / 试听接口
setting_basic_source_status_initing/success/failed = 初始化中 / 初始化成功 / 初始化失败
user_api_title                 = 自定义源管理（实验性）
user_api_btn_import            = 导入
user_api_btn_import_local      = 本地导入
user_api_btn_import_online     = 在线导入
user_api_btn_import_online_input_tip = 请输入 HTTP 链接
user_api_empty                 = 这里竟然是空的 😲
user_api_add_failed_tip        = 无效的自定义源文件
user_api_import_success_tip    = 导入成功 🎉
user_api_import_failed_tip     = 自定义源导入失败：\n{message}
user_api_max_tip               = 最多只能同时存在 20 个源哦🤪...
user_api_note                  = 提示：虽然我们已经尽可能地隔离了脚本的运行环境...
user_api_readme                = 源编写说明：
user_api_remove_tip            = 你真的要移除「{name}」吗？
user_api_allow_show_update_alert = 允许显示更新弹窗
user_api_update_alert          = 自定义源「{name}」发现新版本
setting_other_log_user_api_log = 记录自定义源日志
```

界面入口（`src/screens/Home/Views/Setting/settings/Basic/Source.tsx`）：`SubTitle title=自定义源` 内列出内置接口
（测试/临时/试听）与已导入自定义源单选，当前选中项显示 `[初始化成功]` 等状态，下方按钮 `自定义源管理` 打开
`UserApiEditModal` 对话框。对话框（`UserApiEditModal/index.tsx`）含标题、列表、提示区（`源编写说明：` + FAQ 链接
`https://lyswhut.github.io/lx-music-doc/mobile/custom-source` + 安全提示）以及底部 `导入` / `关闭` 按钮。
`ImportBtn.tsx` 的下拉为 `本地导入` / `在线导入`，导入前检查 `state.list.length > 20`（`user_api_max_tip`），
本地导入文件过滤 `USER_API_SOURCE_FILE_EXT_RXP`，在线导入要求 HTTP 链接。

`src/types/user_api.d.ts` 定义 `UserApiInfo { id,name,description,allowShowUpdateAlert,author,homepage,version,sources? }`、
`UserApiSourceInfoActions = 'musicUrl'|'lyric'|'pic'`、`UserApiSourceInfoType='music'`。

## 4. 与本次需求的关系

用户要求：「原版可以添加自己的音源，是自制音源导入……根据 JS 格式的音源来搜索歌曲。根据歌曲来源格式来提供下载，在线收听。」

- 导入 JS 音源 → 完全对齐上列原版协议与界面文案。
- 「根据 JS 音源搜索歌曲 / 按来源格式下载 / 在线收听」→ 原版移动版 v2.0.0 协议**不提供 search 与 downloadUrl**（只有
  `musicUrl/lyric/pic`），因此本版在**完全兼容原版脚本**的前提下扩展可选 `actions`：`search`、`downloadUrl`、
  `songList`、`leaderboard`，并让 `musicUrl` 结果支持 `http(s)` / `data:` / `blob:` / base64 描述对象。
  只声明原版三类 action 的脚本仍可直接使用（为内置曲目换源取 URL）。
- 「按歌曲来源格式」→ 扩展返回 `{ url|data, mime, ext, filename }`，下载中心据 `mime/ext` 决定文件后缀与
  MediaStore MIME，不再强制重编码为 WAV；无真实 URL 时保留原有 16-bit PCM WAV 生成作为离线回退。
