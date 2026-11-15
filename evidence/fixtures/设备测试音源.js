/**
 * @name 设备测试音源
 * @description 仅用于设备端验收：搜索 / 排行榜 / 在线播放 / 按 WAV 格式下载
 * @version 1.0.0
 * @author qa
 * @homepage https://example.com
 */
const { EVENT_NAMES, on, send, utils } = globalThis.lx
const list = [
  { songmid: 'dv1', name: '夜测一', singer: '设备歌手', album: 'QA', duration: 60, ext: 'wav' },
  { songmid: 'dv2', name: '夜测二', singer: '设备歌手', album: 'QA', duration: 70, ext: 'wav' },
  { songmid: 'dv3', name: '夜测三', singer: '设备歌手', album: 'QA', duration: 80, ext: 'wav' }
]
function wavUrl() {
  // 8 秒音频：足够覆盖 5 行歌词的时间轴（0/2/4/6/8s）
  const sr = 6000, n = sr * 8, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
  function str(o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let k = 0; k < n; k++) {
    v.setInt16(44 + k * 2, Math.sin(2 * Math.PI * 440 * k / sr) * 8000, true)
  }
  return 'data:audio/wav;base64,' + utils.buffer.bufToString(new Uint8Array(buf), 'base64')
}
function withMeta(x, source) {
  return Object.assign({}, x, { source, qualitys: ['128k'], ext: 'wav', mime: 'audio/wav' })
}
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'search') {
    const kw = String(info.keyword || '')
    return Promise.resolve(list.filter(x => !kw || (x.name + x.singer).indexOf(kw) >= 0)
      .map(x => withMeta(x, source)))
  }
  if (action === 'leaderboard') return Promise.resolve(list.map(x => withMeta(x, source)))
  if (action === 'musicUrl') return Promise.resolve(wavUrl())
  if (action === 'downloadUrl') {
    return Promise.resolve({
      data: wavUrl(), mime: 'audio/wav', ext: 'wav',
      filename: info.musicInfo.name + ' - ' + info.musicInfo.singer + '.wav'
    })
  }
  if (action === 'lyric') return Promise.resolve({ lyric: [
    '[00:00.00]设备测试歌词 · 第一行',
    '[00:02.00]第二行 · 验证时间轴高亮',
    '[00:04.00]第三行 · 验证自动滚动',
    '[00:06.00]第四行 · 点击可跳转',
    '[00:08.00]第五行 · 段落结束'
  ].join('\n') })
  return Promise.reject(new Error('unsupported action: ' + action))
})
const ACTIONS = ['search', 'leaderboard', 'musicUrl', 'downloadUrl', 'lyric']
const QUALITYS = ['128k']
send(EVENT_NAMES.inited, {
  sources: {
    // 真实音源就是用平台 id 声明自己能服务哪些平台（相当于给这些平台提供账号）
    kw: { name: '设备测试音源', type: 'music', actions: ACTIONS, qualitys: QUALITYS },
    kg: { name: '设备测试音源', type: 'music', actions: ACTIONS, qualitys: QUALITYS },
    mg: { name: '设备测试音源', type: 'music', actions: ACTIONS, qualitys: QUALITYS }
  }
})
