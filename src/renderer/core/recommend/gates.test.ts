import { describe, expect, it } from 'vitest'
import { SEMANTIC_DISTANCE_BASE, SEMANTIC_DISTANCE_STEP, recallSourceLanguageBlocked, trimSemanticQueries } from './gates'
import type { TrackLike } from './judgment'

const candidate = (artist: string, title: string, album = '', tags: string[] = []): TrackLike => ({ artist, title, album, tags })

describe('recallSourceLanguageBlocked - 召回源头语言门控（S1）', () => {
  it('排除 zh 且元数据含高置信华语标记（mandopop 标签）时拦截', () => {
    // arrange
    const track = candidate('某乐队', '某歌', '', ['mandopop'])
    // act & assert
    expect(recallSourceLanguageBlocked(track, { excludedLanguages: ['zh'] })).toBe(true)
  })

  it('排除 zh 时含假名标题（高置信日语）不误杀', () => {
    // arrange
    const track = candidate('ある歌手', '桜の歌', 'アルバム')
    // act & assert
    expect(recallSourceLanguageBlocked(track, { excludedLanguages: ['zh'] })).toBe(false)
  })

  it('排除 zh 时无明确语言标记（纯汉字标题）不拦截', () => {
    // arrange
    const track = candidate('某乐队', '夜曲')
    // act & assert
    expect(recallSourceLanguageBlocked(track, { excludedLanguages: ['zh'] })).toBe(false)
  })

  it('排除 ja 时假名标题（高置信日语）被拦——门控为通用语义而非仅 zh', () => {
    // arrange
    const track = candidate('ある歌手', '桜の歌')
    // act & assert
    expect(recallSourceLanguageBlocked(track, { excludedLanguages: ['ja'] })).toBe(true)
  })

  it('无排除语言时一律不拦', () => {
    // act & assert
    expect(recallSourceLanguageBlocked(candidate('某乐队', '某歌', '', ['mandopop']), { excludedLanguages: [] })).toBe(false)
  })
})

describe('trimSemanticQueries - 语义查询距程裁剪（S3）', () => {
  const seed = (semanticCount: number): Array<{ kind: string, keyword: string }> => {
    const out: Array<{ kind: string, keyword: string }> = [{ kind: 'same-artist', keyword: '艺人' }]
    for (let i = 0; i < semanticCount; i++) out.push({ kind: 'semantic', keyword: `语义${i}` })
    return out
  }

  it('radius=35 时仅发起语义 idx0/idx1（距离 24/31），同艺人保留', () => {
    // act
    const trimmed = trimSemanticQueries(seed(4), 35)
    // assert
    expect(trimmed.map(q => q.keyword)).toEqual(['艺人', '语义0', '语义1'])
  })

  it('radius=24 时仅发起语义 idx0（24<=24），后续（31/38）丢弃', () => {
    // act
    const trimmed = trimSemanticQueries(seed(3), 24)
    // assert
    expect(trimmed.map(q => q.keyword)).toEqual(['艺人', '语义0'])
  })

  it('radius=10 时不发起任何语义查询，同艺人仍保留', () => {
    // act
    const trimmed = trimSemanticQueries(seed(3), 10)
    // assert
    expect(trimmed.map(q => q.keyword)).toEqual(['艺人'])
  })

  it('距离公式与常量一致：i=2 时距离为 24+7*2=38', () => {
    // act & assert
    expect(SEMANTIC_DISTANCE_BASE + SEMANTIC_DISTANCE_STEP * 2).toBe(38)
  })
})
