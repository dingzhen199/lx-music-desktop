import { describe, expect, it } from 'vitest'
import { parseSongListUrl } from './songListUrl'

describe('歌单链接音源识别', () => {
  it('识别各平台常规歌单链接', () => {
    expect(parseSongListUrl('https://music.163.com/#/playlist?id=123')).toEqual({ source: 'wy', id: '123' })
    expect(parseSongListUrl('https://y.qq.com/n/yqq/playlist/456.html')).toEqual({ source: 'tx', id: '456' })
    expect(parseSongListUrl('https://www.kugou.com/yy/special/single/789.html')).toEqual({ source: 'kg', id: '789' })
    expect(parseSongListUrl('https://www.kuwo.cn/playlist_detail/321')).toEqual({ source: 'kw', id: '321' })
    expect(parseSongListUrl('https://music.migu.cn/v3/music/playlist/654')).toEqual({ source: 'mg', id: '654' })
  })

  it('酷狗用户歌单链接保留原 URL 交给 SDK 继续解析', () => {
    const urls = [
      'https://www.kugou.com/songlist/abc/?uid=1',
      'https://www.kugou.com/yy/zlist.html?pagesize=30',
      'https://www.kugou.com/share/gcid_abc123',
      'https://www.kugou.com/share/index.html?chain=abc123',
      'https://www.kugou.com/share/index.html?global_collection_id=abc123&chain=def456',
    ]
    for (const url of urls) expect(parseSongListUrl(url)).toEqual({ source: 'kg', id: url })
  })

  it('分享文字、网易 token 和末尾标点可以识别', () => {
    expect(parseSongListUrl('打开歌单：https://y.qq.com/n/yqq/playlist/456.html。')).toEqual({ source: 'tx', id: '456' })
    expect(parseSongListUrl('https://music.163.com/#/playlist?id=123###token')).toEqual({ source: 'wy', id: '123' })
  })

  it('纯数字 id 不自动猜测音源', () => {
    expect(parseSongListUrl('123456')).toBeNull()
  })
})
