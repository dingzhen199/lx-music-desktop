import { describe, expect, it } from 'vitest'
import { applyArtistDiversity, applyProfileAdjustment, fuseSimilarCandidates, PROVIDER_ORDER } from './similarFusion'
import type { ProviderBatch } from './similarFusion'

const info = (id: string, name: string, singer: string) => ({
  id, name, singer, source: id.split('_')[0], interval: '04:00', meta: { albumName: '' },
} as unknown as LX.Music.MusicInfo)

const batch = (provider: 'wy' | 'tx', entries: Array<[string, string, string]>): ProviderBatch => ({
  provider,
  candidates: entries.map(([id, name, singer], i) => ({ musicInfo: info(id, name, singer), rank: i + 1 })),
})

describe('跨源相似候选融合', () => {
  it('保留各来源排名与备用音源条目，不提前丢证据', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Song A', 'Artist X'], ['wy_2', 'Song B', 'Artist Y']]),
      batch('tx', [['tx_9', 'Song A', 'Artist X'], ['tx_8', 'Song C', 'Artist Z']]),
    ])
    const songA = fused.find(f => f.title === 'Song A')!
    expect(songA.sources).toHaveLength(2)
    expect(songA.sources.map(s => s.provider)).toEqual(['wy', 'tx'])
    expect(songA.sources.map(s => s.rank)).toEqual([1, 1])
    // 备用音源条目保留（wy 条目 + tx 条目都在）
    expect(songA.sources.map(s => s.musicInfo.id)).toEqual(['wy_1', 'tx_9'])
  })

  it('多源共同推荐累加融合分，排在单源高排名之前', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Both', 'A'], ['wy_2', 'OnlyWy', 'B']]),
      batch('tx', [['tx_1', 'Both', 'A']]),
    ])
    expect(fused[0].title).toBe('Both')
    // Both = 1/(k+1) + 1/(k+1) > OnlyWy = 1/(k+1)
    expect(fused[0].fusionScore).toBeGreaterThan(fused[1].fusionScore)
  })

  it('同源重复行/重试返回只计一次投票', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Song A', 'A'], ['wy_1b', 'Song A', 'A'], ['wy_2', 'Song B', 'B']]),
    ])
    const songA = fused.find(f => f.title === 'Song A')!
    expect(songA.sources).toHaveLength(1)
    expect(songA.sources[0].rank).toBe(1)
    expect(fused).toHaveLength(2)
  })

  it('确定性：输入批次顺序/异步完成顺序变化不改变结果', () => {
    const b1 = batch('wy', [['wy_1', 'Song A', 'A'], ['wy_2', 'Song B', 'B']])
    const b2 = batch('tx', [['tx_2', 'Song C', 'C'], ['tx_1', 'Song A', 'A']])
    const order1 = fuseSimilarCandidates([b1, b2]).map(f => `${f.title}:${f.sources.map(s => `${s.provider}#${s.rank}`).join(',')}`)
    const order2 = fuseSimilarCandidates([b2, b1]).map(f => `${f.title}:${f.sources.map(s => `${s.provider}#${s.rank}`).join(',')}`)
    expect(order1).toEqual(order2)
  })

  it('完全平手时按固定来源序与标题字典序稳定排序', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Same Rank', 'A']]),
      batch('tx', [['tx_1', 'Same Rank', 'A']]),
    ])
    // 同曲同排名：wy 来源序在前，首选播放条目取 wy
    expect(fused[0].musicInfo.id).toBe('wy_1')
    expect(PROVIDER_ORDER).toEqual(['wy', 'tx'])
  })

  it('单源高排名候选仍保留展示机会（不被多源垄断）', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Multi', 'A'], ['wy_5', 'SoloHigh', 'B']]),
      batch('tx', [['tx_3', 'Multi', 'A'], ['tx_1', 'SoloTx', 'C']]),
    ])
    // SoloHigh 单源 rank5：1/(k+5)；Multi 两源：1/(k+1)+1/(k+3) —— Multi 更高，但 SoloHigh 仍在列表中
    expect(fused.map(f => f.title)).toContain('SoloHigh')
    expect(fused[0].title).toBe('Multi')
  })
})

describe('画像有界调整与艺人多样性', () => {
  it('画像加成有界（±15%），来源排名仍主导', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'Top', 'Favorite'], ['wy_2', 'Second', 'Other']]),
    ])
    // Favorite +10 → +15%；Other -10 → -15%：分数差距被压缩但不翻转量级主导
    const adjusted = applyProfileAdjustment(fused, artist => (artist === 'Favorite' ? 10 : -10))
    expect(adjusted[0].title).toBe('Top')
    expect(adjusted[0].fusionScore).toBeCloseTo(fused[0].fusionScore * 1.15, 8)
    expect(adjusted[1].fusionScore).toBeCloseTo(fused[1].fusionScore * 0.85, 8)
  })

  it('画像加成可小幅重排相邻候选，但不会无界放大', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [['wy_1', 'A', 'X'], ['wy_2', 'B', 'Y']]),
    ])
    // 相邻排名分数接近时，+15% 与 -15% 可以翻转
    const adjusted = applyProfileAdjustment(fused, artist => (artist === 'Y' ? 10 : -10))
    expect(adjusted[0].title).toBe('B')
  })

  it('艺人多样性：同主艺人每批最多 2 首，超出不展示且不补足数量', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [
        ['wy_1', 'S1', 'Same Artist'],
        ['wy_2', 'S2', 'Same Artist'],
        ['wy_3', 'S3', 'Same Artist'],
        ['wy_4', 'Other', 'Different Artist'],
      ]),
    ])
    const diversified = applyArtistDiversity(fused, 2)
    expect(diversified.map(f => f.title)).toEqual(['S1', 'S2', 'Other'])
  })

  it('艺人主 token 归一（合作艺人按首个 token 计数）', () => {
    const fused = fuseSimilarCandidates([
      batch('wy', [
        ['wy_1', 'S1', 'A、B'],
        ['wy_2', 'S2', 'A'],
        ['wy_3', 'S3', 'A、C'],
        ['wy_4', 'S4', 'D'],
      ]),
    ])
    const diversified = applyArtistDiversity(fused, 2)
    expect(diversified.map(f => f.title)).toEqual(['S1', 'S2', 'S4'])
  })
})
