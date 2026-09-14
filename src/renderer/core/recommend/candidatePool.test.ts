/**
 * candidatePool 候选池纯函数测试。
 *
 * 覆盖：id 去重、锚点排除（sameSong）、红心排除（sameSong）、语言门控、
 * 同曲去重（保留先出现者），以及 engine 跨批次排除用的 filterExcludeTracks。
 */
import { describe, expect, it } from 'vitest'
import { buildCandidatePool, filterExcludeTracks } from './candidatePool'
import type { TrackLike } from './judgment'

const track = (id: string, artist: string, title: string, extra: Partial<TrackLike> = {}): TrackLike => ({
  encryptedId: id,
  artist,
  title,
  album: '',
  tags: [],
  source: 'semantic-search',
  reason: 'reason',
  distance: 24,
  ...extra,
})

const emptyOptions = {
  anchor: { artist: '起点艺人', title: '起点曲目' },
  lovedTracks: [],
  constraints: {},
}

describe('buildCandidatePool - 候选池构建', () => {
  it('同曲不同 id 的多个候选只保留先出现者', () => {
    // arrange
    const items = [
      track('a1', 'mpi, Laco, Benjamin, 薄野弘之', 'Möbius'),
      track('a2', 'Benjamin, Laco, 薄野弘之', 'Möbius'),
      track('a3', 'Adele', 'Hello'),
    ]
    // act
    const out = buildCandidatePool(items, emptyOptions)
    // assert
    expect(out.map(t => t.encryptedId)).toEqual(['a1', 'a3'])
  })

  it('锚点变体（sameSong 命中）被排除', () => {
    // arrange
    const items = [track('a1', 'mpi, Laco, Benjamin, 薄野弘之', 'Möbius')]
    // act
    const out = buildCandidatePool(items, {
      anchor: { artist: 'Benjamin, Laco, 薄野弘之', title: 'Möbius' },
      lovedTracks: [],
      constraints: {},
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('锚点自身（同 id + artist 变体）也被排除', () => {
    // arrange（锚点歌本身被同艺人搜索带回：id 相同、artist 串写法有差异）
    const items = [track('anchor-id', 'mpi, Laco, Benjamin, 薄野弘之', 'Möbius')]
    // act
    const out = buildCandidatePool(items, {
      anchor: { artist: 'Benjamin, Laco, 薄野弘之', title: 'Möbius' },
      lovedTracks: [],
      constraints: {},
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('同 id 且 artist 无交集（跨语言/元数据不一致）→ 排除（id 通道兜底）', () => {
    // arrange（锚点 id 命中但 artist 无 token 交集 → sameSong 不命中，靠 id 通道排除）
    const items = [track('anchor-id', '其他写法', 'Möbius')]
    // act
    const out = buildCandidatePool(items, {
      anchor: { artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius', id: 'anchor-id' },
      lovedTracks: [],
      constraints: {},
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('红心变体（lovedTracks sameSong 命中，id 不同）被排除', () => {
    // arrange
    const items = [track('a1', 'Adele', 'Hello')]
    // act
    const out = buildCandidatePool(items, {
      ...emptyOptions,
      lovedTracks: [{ artist: '  ADELE ', title: ' hello ' }],
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('红心直接命中 lovedTracks 语义（同曲不同 id）被排除', () => {
    // arrange（Inferno 案例：两条 artist 相同但 id 不同）
    const items = [track('id-2', 'mili', 'Inferno')]
    // act
    const out = buildCandidatePool(items, {
      ...emptyOptions,
      lovedTracks: [{ artist: 'mili', title: 'Inferno' }],
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('红心排除覆盖全量（>200 首的第 300 首也排除）', () => {
    // arrange（300 首喜欢列表，第 300 首即目标候选同曲）
    const lovedTracks = Array.from({ length: 300 }, (_, i) => (
      i === 299 ? { artist: 'simili', title: 'Lemon' } : { artist: `Artist${i}`, title: `Track${i}` }
    ))
    const items = [track('a1', 'simili', 'Lemon')]
    // act
    const out = buildCandidatePool(items, { ...emptyOptions, lovedTracks })
    // assert
    expect(out).toHaveLength(0)
  })

  it('title 不同但 artist 相同的喜欢曲不误排除（titleKey 分桶）', () => {
    // arrange（Lemon (Live) 与 Lemon 是不同曲；分桶按 titleKey，避免全量 O(n·m)）
    const items = [track('a1', 'simili', 'Lemon (Live)')]
    // act
    const out = buildCandidatePool(items, {
      ...emptyOptions,
      lovedTracks: [{ artist: 'simili', title: 'Lemon' }],
    })
    // assert
    expect(out.map(t => t.encryptedId)).toEqual(['a1'])
  })

  it('同名异曲（artist 无交集、双方非空）保留两条', () => {
    // arrange
    const items = [
      track('a1', '周杰伦', '晴天'),
      track('a2', '王菲', '晴天'),
    ]
    // act
    const out = buildCandidatePool(items, emptyOptions)
    // assert
    expect(out.map(t => t.encryptedId)).toEqual(['a1', 'a2'])
  })

  it('语言门控行为保持：excludedLanguages 高置信命中拦截', () => {
    // arrange（假名 → ja 高置信）
    const items = [track('a1', 'あいみょん', 'マリーゴールド')]
    // act
    const out = buildCandidatePool(items, {
      ...emptyOptions,
      constraints: { excludedLanguages: ['ja'] },
    })
    // assert
    expect(out).toHaveLength(0)
  })

  it('未命中排除语言的候选保留', () => {
    // arrange
    const items = [track('a1', 'Adele', 'Hello')]
    // act
    const out = buildCandidatePool(items, {
      ...emptyOptions,
      constraints: { excludedLanguages: ['ja'] },
    })
    // assert
    expect(out.map(t => t.encryptedId)).toEqual(['a1'])
  })
})

describe('filterExcludeTracks - 跨批次排除', () => {
  it('id 命中排除 + 同曲变体排除 + 无关候选保留', () => {
    // arrange
    const items = [
      track('a1', 'mpi, Laco, Benjamin, 薄野弘之', 'Möbius'), // id 命中
      track('a2', 'Benjamin, Laco, 薄野弘之', 'Möbius'), // 同曲变体（id 不同）
      track('a3', '周杰伦', '晴天'), // 无关
    ]
    // act
    const out = filterExcludeTracks(items, ['a1'], [{ artist: 'Benjamin、Laco、薄野弘之', title: 'Möbius' }])
    // assert
    expect(out.map(t => t.encryptedId)).toEqual(['a3'])
  })

  it('空排除列表时原样返回', () => {
    // arrange
    const items = [track('a1', 'Adele', 'Hello')]
    // act
    const out = filterExcludeTracks(items, [], [])
    // assert
    expect(out).toHaveLength(1)
  })
})
