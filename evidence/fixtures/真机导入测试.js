/**
 * @name 真机导入测试音源
 * @description 用于复现本地文件导入链路
 * @version 1.0.0
 * @author qa
 * @homepage https://example.com
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'search') return Promise.resolve([
    { songmid: 'real-01', name: '真机导入的歌', singer: '测试歌手', album: 'QA', duration: 100, ext: 'wav' }
  ])
  if (action === 'musicUrl') return Promise.resolve('')
  return Promise.reject(new Error('unsupported action: ' + action))
})
send(EVENT_NAMES.inited, {
  sources: {
    test: { name: '测试源', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k'] }
  }
})
