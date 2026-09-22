import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recallPlatformSimilar } from './platformRecall'
import type { PlatformRecallAnchor } from './platformRecall'
import { SimilarCandidateCache } from './similarCache'

const mocks = vi.hoisted(() => ({
  wySearch: vi.fn(),
  txSearch: vi.fn(),
  wySimi: vi.fn(),
  txSimi: vi.fn(),
}))
vi.mock('@renderer/utils', () => ({
  toNewMusicInfo: (raw: any) => ({
    id: `${raw.source}_${raw.songmid}`,
    name: raw.name,
    singer: raw.singer,
    source: raw.source,
    interval: raw.interval,
    meta: { albumName: raw.albumName },
  }),
}))
vi.mock('@renderer/utils/musicSdk', () => ({
  default: {
    wy: { musicSearch: { search: mocks.wySearch }, simiSong: { getSimiSong: mocks.wySimi } },
    tx: { musicSearch: { search: mocks.txSearch }, simiSong: { getSimiSong: mocks.txSimi } },
  },
}))

const anchor: PlatformRecallAnchor = {
  artist: '周杰伦',
  title: '晴天',
  album: '叶惠美',
  intervalSec: 269,
  id: 'wy_186016',
  source: 'wy',
  seedIds: { wy: '186016' },
}

/** 搜索结果行（与 SDK 归一化同构）。 */
const searchRow = (over: Record<string, any> = {}) => ({
  singer: '周杰伦',
  name: '晴天',
  albumName: '叶惠美',
  interval: '04:29',
  songmid: '186016',
  songId: 97773,
  source: 'wy',
  ...over,
})
/** 相似结果行。 */
const simiRow = (name: string, singer: string, over: Record<string, any> = {}) => ({
  singer, name, albumName: 'Album', interval: '04:00', songmid: `id-${name}`, source: 'wy', ...over,
})

const searchResult = (rows: any[]) => ({ list: rows, allPage: 1, limit: 30, total: rows.length, source: 'wy' })
const simiResult = (rows: any[]) => ({ source: 'wy', list: rows })

/** 每次调用注入全新缓存（模块级单例会跨测试泄漏状态）。 */
const freshCache = () => new SimilarCandidateCache()
const call = async(anchorArg: PlatformRecallAnchor, options: Record<string, unknown> = {}) =>
  recallPlatformSimilar(anchorArg, { ...options, cache: freshCache() } as any)

beforeEach(() => {
  vi.clearAllMocks()
  // 默认：wy 原生种子直接可用（不走搜索）；tx 搜索可定位；两源默认空结果
  mocks.wySearch.mockResolvedValue(searchResult([searchRow()]))
  mocks.wySimi.mockResolvedValue(simiResult([]))
  mocks.txSearch.mockResolvedValue(searchResult([searchRow({ songmid: '0039MnYb0qxYhV', songId: 97773, source: 'tx' })]))
  mocks.txSimi.mockResolvedValue({ source: 'tx', list: [] })
})

describe('平台相似召回：种子定位', () => {
  it('已消费的同艺人前两首不占用下一批配额', async() => {
    const cache = freshCache()
    mocks.wySimi.mockResolvedValue(simiResult(['a', 'b', 'c', 'd'].map(name => simiRow(name, 'Other Artist'))))
    const first = await recallPlatformSimilar(anchor, { cache })
    const second = await recallPlatformSimilar(anchor, { cache, excludeIds: first.items.map(item => item.musicInfo.id) })
    expect(first.items.map(item => item.title)).toEqual(['a', 'b'])
    expect(second.items.map(item => item.title)).toEqual(['c', 'd'])
    expect(mocks.wySimi).toHaveBeenCalledTimes(1)
    const exhausted = await recallPlatformSimilar(anchor, { cache, excludeIds: [...first.items, ...second.items].map(item => item.musicInfo.id) })
    expect(exhausted.state).toBe('exhausted')
  })

  it('收藏的同艺人前两首不阻断后续候选', async() => {
    mocks.wySimi.mockResolvedValue(simiResult(['a', 'b', 'c'].map(name => simiRow(name, 'Other Artist'))))
    const result = await call(anchor, { lovedTracks: ['a', 'b'].map(title => ({ artist: 'Other Artist', title })) })
    expect(result.items.map(item => item.title)).toEqual(['c'])
  })

  it('已匹配平台的空结果优先于另一平台无匹配', async() => {
    mocks.txSearch.mockResolvedValue(searchResult([]))
    const result = await call(anchor)
    expect(result.state).toBe('empty')
    expect(result.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'wy', status: 'empty', seedId: '186016' }),
      expect.objectContaining({ provider: 'tx', status: 'no-match' }),
    ]))
  })

  it('原生平台标识直接使用，不发搜索请求', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦')]))
    const result = await call(anchor)
    expect(mocks.wySearch).not.toHaveBeenCalled()
    expect(mocks.wySimi).toHaveBeenCalledWith('186016')
    expect(result.state).toBe('ok')
  })

  it('其他来源按歌手+歌名搜索后严格匹配；匹配失败跳过平台（no-match），不取第一条充数', async() => {
    const other: PlatformRecallAnchor = { artist: '周杰伦', title: '晴天', intervalSec: 269, id: 'kw_x', source: 'kw' }
    // 搜索返回的全部是翻唱/错版本
    const covers = searchResult([
      searchRow({ singer: 'Lucky小爱', name: '晴天(深情版)', source: 'tx', songmid: 't1', songId: 1 }),
      searchRow({ name: '晴天 (Live)', source: 'tx', songmid: 't2', songId: 2 }),
    ])
    mocks.wySearch.mockResolvedValue(covers)
    mocks.txSearch.mockResolvedValue(covers)
    const result = await call(other)
    expect(result.state).toBe('no-match')
    expect(mocks.txSimi).not.toHaveBeenCalled()
    expect(mocks.wySimi).not.toHaveBeenCalled()
  })

  it('起点歌手缺失（元数据不足）不算匹配证据', async() => {
    const other: PlatformRecallAnchor = { artist: '', title: '晴天', id: 'local_x', source: 'local' }
    const result = await call(other)
    expect(result.state).toBe('no-match')
  })
})

describe('平台相似召回：单源失败隔离与状态区分', () => {
  it('单源失败不丢其他源结果；状态 ok 且携带失败来源信息', async() => {
    mocks.wySimi.mockRejectedValue(new Error('wy down'))
    mocks.txSimi.mockResolvedValue({
      source: 'tx',
      list: [
        { singer: '林俊杰', name: '江南', albumName: '第二天堂', interval: '04:27', songmid: 'tx_jn', source: 'tx' },
      ],
    })
    const result = await call(anchor)
    expect(result.state).toBe('ok')
    expect(result.items.map(i => i.title)).toEqual(['江南'])
    const wy = result.providers.find(p => p.provider === 'wy')!
    expect(wy.status).toBe('error')
    expect(result.error).toContain('wy down')
  })

  it('全部平台失败为 all-failed（可重试语义），不是空结果', async() => {
    mocks.wySimi.mockRejectedValue(new Error('wy down'))
    mocks.txSearch.mockRejectedValue(new Error('tx search down'))
    const result = await call(anchor)
    expect(result.state).toBe('all-failed')
    expect(result.error).toContain('wy down')
  })

  it('相似调用失败单层重试一次，仍失败才报错', async() => {
    mocks.wySimi.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(simiResult([simiRow('花海', '周杰伦')]))
    const result = await call(anchor)
    expect(mocks.wySimi).toHaveBeenCalledTimes(2)
    expect(result.state).toBe('ok')
  })

  it('平台真实返回空列表为 empty 状态（不是失败）', async() => {
    const result = await call(anchor)
    expect(result.state).toBe('empty')
  })

  it('候选用尽（全部为会话已消费）为 exhausted，不是网络失败', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦')]))
    const result = await call(anchor, {
      excludeTracks: [{ artist: '周杰伦', title: '花海' }],
    })
    expect(result.state).toBe('exhausted')
  })

  it('结果被非会话过滤（红心/队列/不再推荐）为 empty-after-filter', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦')]))
    const result = await call(anchor, {
      lovedTracks: [{ artist: '周杰伦', title: '花海' }],
    })
    expect(result.state).toBe('empty-after-filter')
  })

  it('起点自身及同曲变体不入候选', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([
      simiRow('晴天', '周杰伦', { songmid: '186016' }),
      simiRow('晴天 (Live)', '周杰伦'),
      simiRow('花海', '周杰伦'),
    ]))
    const result = await call(anchor)
    expect(result.items.map(i => i.title)).toEqual(['花海'])
  })

  it('当前队列同曲不重复插入', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦')]))
    const result = await call(anchor, {
      queueTracks: [{ artist: '周杰伦', title: '花海' }],
    })
    expect(result.state).toBe('empty-after-filter')
  })

  it('「不再推荐」曲目被排除', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦'), simiRow('七里香', '周杰伦')]))
    const result = await call(anchor, {
      dislikedTracks: [{ artist: '周杰伦', title: '花海' }],
    })
    expect(result.items.map(i => i.title)).toEqual(['七里香'])
  })

  it('取消状态不伪装成失败，也不写缓存', async() => {
    let cancelled = false
    mocks.wySimi.mockImplementation(async() => { cancelled = true; return simiResult([simiRow('花海', '周杰伦')]) })
    const cache = freshCache()
    const result = await recallPlatformSimilar(anchor, { isCancelled: () => cancelled, cache })
    expect(result.state).toBe('cancelled')
    expect(cache.size).toBe(0)
  })

  it('在途请求取消时调用适配器 cancel，不等待平台超时', async() => {
    let cancelled = false
    let cancelCalled = false
    mocks.wySimi.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      () => {
        const request = new Promise(() => {}) as Promise<unknown> & { cancel?: () => void }
        request.cancel = () => {
          cancelCalled = true
          cancelled = true
        }
        return request
      },
    )
    const pending = recallPlatformSimilar(anchor, { isCancelled: () => cancelled, cache: freshCache() })
    await new Promise(resolve => setTimeout(resolve, 80))
    cancelled = true
    const result = await pending
    expect(result.state).toBe('cancelled')
    expect(cancelCalled).toBe(true)
  })
})

describe('平台相似召回：跨源融合与缓存', () => {
  it('两源共同推荐保留双来源证据并融合排名', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([
      simiRow('共同曲', '歌手A'),
      simiRow('仅网易', '歌手B'),
    ]))
    mocks.txSimi.mockResolvedValue({
      source: 'tx',
      list: [
        { singer: '歌手A', name: '共同曲', albumName: 'A', interval: '04:00', songmid: 'tx_same', source: 'tx' },
      ],
    })
    const result = await call(anchor)
    expect(result.state).toBe('ok')
    const both = result.items.find(i => i.title === '共同曲')!
    expect(both.sources.map(s => s.provider)).toEqual(['wy', 'tx'])
    expect(result.items[0].title).toBe('共同曲')
  })

  it('同种子第二次召回命中缓存，不再发相似请求', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦')]))
    const cache = freshCache()
    await recallPlatformSimilar(anchor, { cache })
    await recallPlatformSimilar(anchor, { cache })
    expect(mocks.wySimi).toHaveBeenCalledTimes(1)
    const result = await recallPlatformSimilar(anchor, { cache })
    expect(result.providers.find(p => p.provider === 'wy')!.fromCache).toBe(true)
  })

  it('失败结果不写缓存：重试耗尽后失败，下一次重新请求', async() => {
    mocks.wySimi
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(simiResult([simiRow('花海', '周杰伦')]))
    const cache = freshCache()
    const first = await recallPlatformSimilar(anchor, { cache })
    expect(first.state).toBe('empty') // wy 重试耗尽未取数 + tx 空结果 → empty（wy 未缓存）
    expect(mocks.wySimi).toHaveBeenCalledTimes(2)
    const second = await recallPlatformSimilar(anchor, { cache })
    expect(second.state).toBe('ok')
    expect(mocks.wySimi).toHaveBeenCalledTimes(3)
  })

  it('偏好变化后读缓存重新过滤（缓存不感知会话排除）', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([simiRow('花海', '周杰伦'), simiRow('七里香', '周杰伦')]))
    const cache = freshCache()
    const first = await recallPlatformSimilar(anchor, { cache })
    expect(first.items).toHaveLength(2)
    const second = await recallPlatformSimilar(anchor, { cache, dislikedTracks: [{ artist: '周杰伦', title: '花海' }] })
    expect(second.items.map(i => i.title)).toEqual(['七里香'])
    expect(mocks.wySimi).toHaveBeenCalledTimes(1)
  })

  it('maxItems 截断入队数量', async() => {
    mocks.wySimi.mockResolvedValue(simiResult([
      simiRow('S1', 'A1'), simiRow('S2', 'A2'), simiRow('S3', 'A3'), simiRow('S4', 'A4'),
    ]))
    const result = await call(anchor, { maxItems: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.state).toBe('ok')
  })
})
