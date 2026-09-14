import { beforeEach, describe, expect, it, vi } from 'vitest'

// recall.ts 的顶层导入含 renderer 运行时模块（store/musicSdk 桶文件），
// vitest 下整体 mock，只保留本测试需要的行为出口；toNewMusicInfo 归一化以恒等替代
// （raw 直接按 MusicInfo 形状构造，rawHasId 需 songmid/hash 等任一 id 字段）。
const mocks = vi.hoisted(() => ({
  searchMusic: vi.fn(),
  getListMusics: vi.fn(),
}))

vi.mock('@renderer/utils/musicSdk', () => ({ default: { searchMusic: mocks.searchMusic } }))
vi.mock('@renderer/store/list/listManage/rendererListManage', () => ({ getListMusics: mocks.getListMusics }))
vi.mock('@renderer/store/list/listManage/state', () => ({ loveList: { id: 'likelist' }, userLists: [] }))
vi.mock('@renderer/store/player/state', () => ({ playedList: [] }))
vi.mock('@renderer/utils', () => ({ toNewMusicInfo: (raw: unknown) => raw }))

import { buildRecallQueries, recallCandidates } from './recall'
import type { RecallAnchor } from './recall'
import type { TrackAnalysis } from './prompts'

/** 光明正大的 raw 曲目（identity 归一化下即 MusicInfo），带 songmid 通过 rawHasId。 */
const rawSong = (id: string, singer: string, name: string) => ({
  id,
  songmid: id,
  singer,
  name,
  meta: { albumName: '' },
})

/** 一路方向生成 n 个语义关键词的分析形状。 */
const analysisWith = (keywords: string[]): Pick<TrackAnalysis, 'recallDirections'> => ({
  recallDirections: [{
    name: '方向A',
    reason: '理由A',
    aestheticBridge: '桥A',
    searchKeywords: keywords,
    searchArtists: [],
  } as unknown as TrackAnalysis['recallDirections'][number]],
})

const anchor: RecallAnchor = { artist: '某乐队', title: '某歌', singer: '某乐队', name: '某歌' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.searchMusic.mockImplementation(async() => [])
  mocks.getListMusics.mockImplementation(async() => [])
})

describe('buildRecallQueries - 召回查询构建', () => {
  it('同艺人查询置顶，语义查询跟随其后', () => {
    // arrange & act
    const queries = buildRecallQueries(anchor, analysisWith(['k1', 'k2']), 35)
    // assert
    expect(queries.map(q => q.kind)).toEqual(['same-artist', 'semantic', 'semantic'])
    expect(queries[0].keyword).toBe('某乐队')
    expect(queries.slice(1).map(q => q.keyword)).toEqual(['k1', 'k2'])
  })

  it('同艺人关键词按 singer→artist→name 回退', () => {
    // arrange & act & assert
    expect(buildRecallQueries({ artist: 'a', title: 't', singer: '', name: '' }, null, 35)[0].keyword).toBe('a')
    expect(buildRecallQueries({ artist: '', title: 't', singer: '', name: 'n' }, null, 35)[0].keyword).toBe('n')
  })

  it('sameArtistAllowed 为 false 时不发同艺人查询', () => {
    // arrange & act
    const queries = buildRecallQueries(anchor, analysisWith(['k1']), 35, { sameArtistAllowed: false })
    // assert
    expect(queries.every(q => q.kind === 'semantic')).toBe(true)
  })

  it('锚点关键词为空时省略同艺人查询', () => {
    // arrange & act
    const queries = buildRecallQueries({ artist: '  ', title: 't', singer: '', name: '' }, null, 35)
    // assert
    expect(queries).toEqual([])
  })

  it('语义理由按方向字段拼接携带，同艺人查询带固定理由（现值钉死）', () => {
    // arrange & act：同艺人查询的 reason 当前为固定串（搜索时被 kind 三元覆盖，属死值——重构将删除）
    const queries = buildRecallQueries(anchor, analysisWith(['k1']), 35)
    // assert
    expect(queries[0]).toEqual({ keyword: '某乐队', reason: '围绕当前艺人保持较近的听感边界', kind: 'same-artist' })
    expect(queries[1]).toEqual({ keyword: 'k1', reason: '桥A；理由A；方向A', kind: 'semantic' })
  })
})

describe('recallCandidates - 跨源召回标注', () => {
  it('同艺人候选：距离恒 8、source=same-artist、理由为保持熟悉听感、不回写 semanticReason', async() => {
    // arrange
    mocks.searchMusic.mockImplementation(async({ name }: { name: string }) => {
      if (name === '某乐队') return [{ list: [rawSong('sa1', '某乐队', '同艺人歌')], source: 'wy' }]
      return []
    })
    // act
    const { items } = await recallCandidates(anchor, null, 35)
    // assert
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      encryptedId: 'sa1',
      distance: 8,
      source: 'same-artist',
      reason: '保留起点熟悉的声音与表达方式',
      semanticReason: undefined,
    })
  })

  it('语义候选：距离按语义序号 24+7*i 递增，理由为继续展开，逐条理由回写 semanticReason', async() => {
    // arrange
    mocks.searchMusic.mockImplementation(async({ name }: { name: string }) => {
      if (name === 'k1') return [{ list: [rawSong('k1id', '甲', '歌一')], source: 'wy' }]
      if (name === 'k2') return [{ list: [rawSong('k2id', '乙', '歌二')], source: 'tx' }]
      return []
    })
    // act
    const { items } = await recallCandidates(anchor, analysisWith(['k1', 'k2']), 35)
    // assert：顺序与查询序一致（同艺人无结果但占位最前，语义序号 0/1 → 24/31；
    // 若同艺人查询误消耗语义序号，k1 会是 31）
    expect(items.map(c => [c.encryptedId, c.distance])).toEqual([['k1id', 24], ['k2id', 31]])
    expect(items[0]).toMatchObject({
      source: 'semantic-search',
      reason: '沿着起点的声音气质继续展开',
      semanticReason: '桥A；理由A；方向A',
    })
  })

  it('距程裁剪：radius 35 时距离 38 的第三个语义查询不发起搜索', async() => {
    // arrange
    // act
    await recallCandidates(anchor, analysisWith(['k1', 'k2', 'k3']), 35)
    // assert：24/31 保留，38 > 35 终止后续语义查询
    const calledKeywords = mocks.searchMusic.mock.calls.map(([arg]) => (arg as { name: string }).name)
    expect(calledKeywords).toEqual(['某乐队', 'k1', 'k2'])
  })
})
