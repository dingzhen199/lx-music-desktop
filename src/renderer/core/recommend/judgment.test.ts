import { describe, expect, it } from 'vitest'
import {
  aestheticReject,
  analysisSuggestsVocal,
  candidateScore,
  coarseWorldBreak,
  composeListeningArc,
  constraintPrompt,
  containsCjk,
  continuityAverage,
  diversify,
  effectiveExcludes,
  eligibleByFormat,
  exclusionHit,
  hasHangul,
  hasKana,
  languageBlocked,
  likelyDerivative,
  localLanguageBlocked,
  metadataLanguageHint,
  negativeFromInstruction,
  normalizeRole,
  parseSessionConstraints,
  publicReason,
  roleBonus,
  rowLanguageBlocked,
  sameArtistConflictsWithConstraints,
  tokenize,
  transformationAllowed,
  unit,
  vocalMismatch,
} from './judgment'
import type { TrackLike } from './judgment'

const anchor = { artist: '回春丹', title: '鲜花' }

const baseARC: TrackLike = {
  artist: 'The Killers',
  title: 'Read My Mind',
  continuity: {
    vocal: 0.8,
    timbre: 0.75,
    instrumentation_texture: 0.76,
    rhythm_motion: 0.72,
    dynamics: 0.7,
    emotional_core: 0.82,
    imagery_narrative: 0.78,
  },
  source: 'semantic-search',
  nextSongWorthiness: 0.94,
  meaningfulDifference: 0.62,
  surpriseValue: 0.48,
  obviousness: 0.18,
  clicheRisk: 0.08,
  journeyRole: 'deepen',
  sequenceIndex: 1,
}

// 原生实现 oracle：score=56.3（非艺人、position 0）
const baseCandidate: TrackLike = {
  artist: 'X',
  title: 'T',
  continuity: {
    vocal: 0.6,
    timbre: 0.6,
    instrumentation_texture: 0.6,
    rhythm_motion: 0.6,
    dynamics: 0.6,
    emotional_core: 0.6,
    imagery_narrative: 0.6,
  },
  nextSongWorthiness: 0.7,
  meaningfulDifference: 0.5,
  surpriseValue: 0.5,
  obviousness: 0.35,
  clicheRisk: 0.2,
  aiScore: 55,
  journeyRole: 'hold',
}

describe('unit - 数值归一化', () => {
  it('百分比入参按 /100 换算、小数原样保留，越界夹在 0-1', () => {
    // arrange
    const cases: Array<[unknown, number | null]> = [
      ['55', 0.55],
      [0.5, 0.5],
      [1.5, 0.015],
      [101, 1],
      [-5, 0],
      [0, 0],
      ['abc', null],
    ]
    // act & assert
    for (const [input, expected] of cases) {
      expect(unit(input)).toBe(expected)
    }
  })
})

describe('continuityAverage - 连续性均值', () => {
  it('七维齐全时返回算术平均（与 from-here 一致 0.7614...）', () => {
    // arrange
    const track: TrackLike = baseARC
    // act & assert
    expect(continuityAverage(track)).toBeCloseTo(5.33 / 7, 3)
  })
  it('非法值被过滤、缺失维度不计入分母', () => {
    // arrange
    const track: TrackLike = { artist: 'A', title: 'B', continuity: { vocal: 0.5, timbre: 'x' as unknown as number } }
    // act & assert
    expect(continuityAverage(track)).toBe(0.5)
  })
  it('无 continuity 信息时返回 null 而非 0', () => {
    // act & assert
    expect(continuityAverage({})).toBeNull()
    expect(continuityAverage(null)).toBeNull()
  })
})

describe('normalizeRole - 角色归一化', () => {
  it('大小写与空白归一，未知角色回退 open', () => {
    // act & assert
    expect(normalizeRole('Hold ')).toBe('hold')
    expect(normalizeRole('TURN')).toBe('turn')
    expect(normalizeRole('weird')).toBe('open')
    expect(normalizeRole('')).toBe('open')
    expect(normalizeRole('land')).toBe('land')
  })
})

describe('aestheticReject - 候选守门', () => {
  it('低价值候选（worth<0.48）直接拒收', () => {
    // act & assert
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.4 }, 35)).toBe(true)
  })
  it('正常距离下高显然+高俗套（cliche>=.84 且 obvious>=.64）拒收', () => {
    // act & assert
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.6, obviousness: 0.64, clicheRisk: 0.84 }, 35)).toBe(true)
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.6, obviousness: 0.63, clicheRisk: 0.83 }, 35)).toBe(false)
  })
  it('高显然+低差异（obvious>=.9 且 difference<.26）拒收，radius<=18 不触发', () => {
    // act & assert
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.6, obviousness: 0.9, meaningfulDifference: 0.25 }, 19)).toBe(true)
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.6, obviousness: 0.9, meaningfulDifference: 0.25 }, 18)).toBe(false)
    expect(aestheticReject({ artist: 'A', title: 'B', nextSongWorthiness: 0.6, obviousness: 0.89, meaningfulDifference: 0.25 }, 19)).toBe(false)
  })
  it('无任何信号时不误杀', () => {
    // act & assert
    expect(aestheticReject({ artist: 'A', title: 'B' }, 35)).toBe(false)
  })
})

describe('likelyDerivative / transformationAllowed - tribute 压制', () => {
  it('tribute/karaoke/翻奏类候选被识别为衍生版本', () => {
    // act & assert
    expect(likelyDerivative({ artist: 'Guitar Tribute', title: 'Song' })).toBe(true)
    expect(likelyDerivative({ artist: 'A', title: 'Karaoke Version' })).toBe(true)
    expect(likelyDerivative({ artist: 'A', title: '翻奏版', tags: [] })).toBe(true)
    expect(likelyDerivative({ artist: 'The Killers', title: 'Read My Mind' })).toBe(false)
  })
  it('用户显式要求纯音乐/翻唱时 transformationAllowed=true', () => {
    // act & assert
    expect(transformationAllowed('想听纯音乐')).toBe(true)
    expect(transformationAllowed('来点instrumental')).toBe(true)
    expect(transformationAllowed('纯音乐')).toBe(true)
  })
  it('“不要/别/避免”纯音乐或翻唱时 transformationAllowed=false', () => {
    // act & assert
    expect(transformationAllowed('不要纯音乐')).toBe(false)
    expect(transformationAllowed('别来翻唱')).toBe(false)
    expect(transformationAllowed('')).toBe(false)
  })
})

describe('vocalMismatch / analysisSuggestsVocal - 人声一致性', () => {
  it('anchor 判定为人声关键而候选是纯器乐时判定失配', () => {
    // act & assert
    const vocalAnalysis = { fingerprint: { vocal_identity: ['男声', '真声'] } }
    expect(vocalMismatch({ artist: 'X', title: 'An Instrumental Piece', tags: [] }, vocalAnalysis)).toBe(true)
  })
  it('用户要求纯音乐时不再判失配', () => {
    // act & assert
    const vocalAnalysis = { fingerprint: { vocal_identity: ['男声', '真声'] } }
    expect(vocalMismatch({ artist: 'X', title: 'An Instrumental Piece', tags: [] }, vocalAnalysis, '想听纯音乐')).toBe(false)
  })
  it('anchor 本身是纯器乐时候选器乐不算失配', () => {
    // act & assert
    const instrAnalysis = { fingerprint: { vocal_identity: ['纯器乐'] } }
    expect(vocalMismatch({ artist: 'X', title: 'An Instrumental Piece', tags: [] }, instrAnalysis)).toBe(false)
  })
  it('analysisSuggestsVocal 识别“纯器乐/无信息”为非人声', () => {
    // act & assert
    expect(analysisSuggestsVocal({ fingerprint: { vocal_identity: ['男声', '真声'] } })).toBe(true)
    expect(analysisSuggestsVocal({ fingerprint: { vocal_identity: ['纯器乐'] } })).toBe(false)
    expect(analysisSuggestsVocal({ fingerprint: { vocal_identity: [] } })).toBe(false)
  })
})

describe('roleBonus - 弧线角色加成', () => {
  it('第一步 hold/deepen +9、open +3、turn 近距 -11/远距 -5、land -5', () => {
    // act & assert
    expect(roleBonus('hold', 0, 35, [])).toBe(9)
    expect(roleBonus('deepen', 0, 35, [])).toBe(9)
    expect(roleBonus('open', 0, 35, [])).toBe(3)
    expect(roleBonus('turn', 0, 35, [])).toBe(-11)
    expect(roleBonus('turn', 0, 60, [])).toBe(-5)
    expect(roleBonus('land', 0, 35, [])).toBe(-5)
  })
  it('第二步 deepen/open +7、turn 在 radius<=30 时 -6', () => {
    // act & assert
    expect(roleBonus('deepen', 1, 35, [])).toBe(7)
    expect(roleBonus('open', 1, 35, [])).toBe(7)
    expect(roleBonus('turn', 1, 30, [])).toBe(-6)
    expect(roleBonus('turn', 1, 35, [])).toBe(0)
    expect(roleBonus('hold', 1, 35, [])).toBe(0)
  })
  it('第三步 open/turn +8', () => {
    // act & assert
    expect(roleBonus('open', 2, 35, [])).toBe(8)
    expect(roleBonus('turn', 2, 35, [])).toBe(8)
    expect(roleBonus('hold', 2, 35, [])).toBe(0)
  })
  it('中后段 land 承接已出现的 open/turn +7、turn 未出现且半径>28 +4、已出现则 -7', () => {
    // act & assert
    expect(roleBonus('land', 3, 35, [{ journeyRole: 'open' }])).toBe(7)
    expect(roleBonus('turn', 3, 35, [{ journeyRole: 'hold' }])).toBe(4)
    expect(roleBonus('turn', 3, 35, [{ journeyRole: 'turn' }])).toBe(-7)
  })
  it('与上一首同角色连续惩罚 -7', () => {
    // act & assert
    expect(roleBonus('hold', 1, 35, [{ journeyRole: 'hold' }])).toBe(-7)
    expect(roleBonus('open', 2, 35, [{ journeyRole: 'open' }])).toBe(1)
  })
})

describe('candidateScore - 候选打分', () => {
  it('正常距离前三名出现 anchor 艺人时 -100（安全网不占前排）', () => {
    // arrange
    const sameArtist: TrackLike = { ...baseCandidate, artist: '回春丹' }
    const other: TrackLike = baseCandidate
    // act
    const same = candidateScore(sameArtist, 0, 35, [], anchor)
    const diff = candidateScore(other, 0, 35, [], anchor)
    // assert
    expect(diff - same).toBeCloseTo(100, 5)
    expect(diff).toBeCloseTo(56.3, 4)
  })
  it('位置 >=3 后 anchor 艺人不再罚分', () => {
    // arrange
    const sameArtist: TrackLike = { ...baseCandidate, artist: '回春丹' }
    const other: TrackLike = baseCandidate
    const selected = [{ journeyRole: 'open' as string }]
    // act
    const same = candidateScore(sameArtist, 3, 35, selected, anchor)
    const diff = candidateScore(other, 3, 35, selected, anchor)
    // assert
    expect(diff - same).toBeCloseTo(0, 5)
    expect(diff).toBeCloseTo(43.8, 4)
  })
  it('提供给模型的 sequence 加成（14 - seq*2.2，下限 0）但不覆盖守门', () => {
    // arrange
    const a: TrackLike = { ...baseCandidate, sequenceIndex: undefined }
    const b: TrackLike = { ...baseCandidate, sequenceIndex: 2 }
    // act
    const scoreA = candidateScore(a, 0, 35, [], anchor)
    const scoreB = candidateScore(b, 0, 35, [], anchor)
    // assert
    expect(scoreB - scoreA).toBeCloseTo(9.6, 5)
    expect(candidateScore({ ...baseCandidate, sequenceIndex: 9 }, 0, 35, [], anchor)).toBeCloseTo(scoreA, 5)
  })
  it('首步高惊喜但连续性低时 -9（先让人相信起点）', () => {
    // arrange
    const highSurprise: TrackLike = { ...baseCandidate, surpriseValue: 0.9 }
    const midSurprise: TrackLike = { ...baseCandidate, surpriseValue: 0.5 }
    // act & assert
    expect(candidateScore(highSurprise, 0, 35, [], anchor)).toBeCloseTo(49.3, 4)
    expect(candidateScore(midSurprise, 0, 35, [], anchor) - candidateScore(highSurprise, 0, 35, [], anchor)).toBeCloseTo(7, 5)
  })
  it('与上一首同召回来源 -3.5', () => {
    // arrange
    const sameSource: TrackLike = { ...baseCandidate, source: 'heartbeat' }
    const sameSourceSel = [{ journeyRole: 'open', source: 'heartbeat' }]
    const diffSourceSel = [{ journeyRole: 'open', source: 'semantic-search' }]
    // act
    const a = candidateScore(sameSource, 2, 35, sameSourceSel, anchor)
    const b = candidateScore(sameSource, 2, 35, diffSourceSel, anchor)
    // assert
    expect(b - a).toBeCloseTo(3.5, 5)
  })
})

describe('composeListeningArc - 整段弧线编排', () => {
  const items: TrackLike[] = [
    {
      ...baseARC,
      artist: '回春丹',
      title: '艾蜜莉',
      source: 'same-artist',
      aiScore: 99,
      nextSongWorthiness: 0.82,
      meaningfulDifference: 0.12,
      surpriseValue: 0.08,
      obviousness: 0.96,
      clicheRisk: 0.86,
      journeyRole: 'hold',
      sequenceIndex: 0,
    },
    baseARC,
    {
      ...baseARC,
      artist: 'RADWIMPS',
      title: 'スパークル',
      aiScore: 89,
      nextSongWorthiness: 0.9,
      meaningfulDifference: 0.68,
      surpriseValue: 0.58,
      obviousness: 0.24,
      clicheRisk: 0.1,
      journeyRole: 'open',
      sequenceIndex: 2,
    },
    {
      ...baseARC,
      artist: 'Phoenix',
      title: 'Lisztomania',
      aiScore: 86,
      nextSongWorthiness: 0.84,
      meaningfulDifference: 0.71,
      surpriseValue: 0.66,
      obviousness: 0.2,
      clicheRisk: 0.11,
      journeyRole: 'turn',
      sequenceIndex: 3,
    },
    {
      ...baseARC,
      artist: 'Mew',
      title: 'Comforting Sounds',
      aiScore: 84,
      nextSongWorthiness: 0.87,
      meaningfulDifference: 0.55,
      surpriseValue: 0.42,
      obviousness: 0.16,
      clicheRisk: 0.07,
      journeyRole: 'land',
      sequenceIndex: 4,
    },
    {
      ...baseARC,
      artist: 'Generic Rock Band',
      title: 'Sad Indie Rock',
      aiScore: 95,
      nextSongWorthiness: 0.4,
      meaningfulDifference: 0.08,
      surpriseValue: 0.05,
      obviousness: 0.94,
      clicheRisk: 0.93,
      journeyRole: 'hold',
      sequenceIndex: 5,
    },
  ]

  it('明显同艺人俗套与技术兼容但低价值的候选都被守门拒收', () => {
    // act & assert
    expect(aestheticReject(items[0], 35)).toBe(true)
    expect(aestheticReject(items[5], 35)).toBe(true)
  })
  it('弧线保留高质量候选且顺序符合“先深化再打开/转向/落下”的 oracle', () => {
    // act
    const arc = composeListeningArc(items, anchor, 35, 5)
    // assert
    expect(arc.length).toBe(4)
    expect(arc.map(t => t.artist)).toEqual(['The Killers', 'RADWIMPS', 'Phoenix', 'Mew'])
    expect(arc.map(t => t.journeyRole)).toEqual(['deepen', 'open', 'turn', 'land'])
  })
  it('首位不是 anchor 艺人，角色不是靠大转弯博眼球', () => {
    // act
    const arc = composeListeningArc(items, anchor, 35, 5)
    // assert
    expect(arc[0].artist).not.toBe('回春丹')
    expect(['hold', 'deepen', 'open']).toContain(arc[0].journeyRole)
  })
  it('低价值俗套候选不会漏进弧线，角色有变化而不是五个独立冠军', () => {
    // act
    const arc = composeListeningArc(items, anchor, 35, 5)
    // assert
    expect(arc.some(t => t.artist === 'Generic Rock Band')).toBe(false)
    expect(new Set(arc.map(t => t.journeyRole)).size).toBeGreaterThanOrEqual(3)
  })
})

describe('diversify - 多样性限制', () => {
  it('正常距离下 anchor 艺人延迟到前三位之后', () => {
    // arrange
    const items: TrackLike[] = [
      { artist: '回春丹', title: '艾蜜莉' },
      { artist: 'B', title: 'B1' },
      { artist: 'C', title: 'C1' },
      { artist: 'D', title: 'D1' },
      { artist: 'E', title: 'E1' },
      { artist: 'F', title: 'F1' },
    ]
    // act
    const out = diversify(items, anchor, 6, 35)
    // assert
    expect(out.map(t => t.artist)).toEqual(['B', 'C', 'D', 'E', 'F', '回春丹'])
  })
  it('极近距离（<=18）anchor 艺人最多 2 首', () => {
    // arrange
    const items: TrackLike[] = [
      { artist: '回春丹', title: '艾蜜莉' },
      { artist: 'B', title: 'B1' },
      { artist: 'C', title: 'C1' },
    ]
    // act
    const out = diversify(items, anchor, 6, 18)
    // assert
    expect(out.map(t => t.artist)).toEqual(['回春丹', 'B', 'C'])
  })
  it('同一 (artist, album) 默认最多 1 首', () => {
    // arrange
    const items: TrackLike[] = [
      { artist: '回春丹', title: 'A1', album: 'same' },
      { artist: '回春丹', title: 'A2', album: 'same' },
      { artist: '回春丹', title: 'A3', album: 'other' },
    ]
    // act
    const out = diversify(items, anchor, 6, 18)
    // assert
    expect(out.map(t => t.title)).toEqual(['A1', 'A3'])
  })
  it('非 anchor 艺人每艺人默认 1 首；重复音轨按 id 去重', () => {
    // arrange
    const items: TrackLike[] = [
      { artist: 'X', title: 'T1', encryptedId: 'id1' },
      { artist: 'X', title: 'T1', encryptedId: 'id1' },
      { artist: 'X', title: 'T2', encryptedId: 'id2' },
      { artist: 'Y', title: 'T1' },
    ]
    // act
    const out = diversify(items, { artist: 'Z', title: 'A' }, 6, 35)
    // assert
    expect(out.map(t => t.artist)).toEqual(['X', 'Y'])
    expect(out.map(t => t.title)).toEqual(['T1', 'T1'])
  })
})

describe('语言约束 - 不要华语从源头生效且不误杀日语/韩语', () => {
  it('parseSessionConstraints 识别“不要/别/避免+华语类”为 zh 排除', () => {
    // act & assert
    expect(parseSessionConstraints('不要华语').excludedLanguages).toEqual(['zh'])
    expect(parseSessionConstraints('别来粤语').excludedLanguages).toEqual(['zh'])
    expect(parseSessionConstraints('华语不要').excludedLanguages).toEqual(['zh'])
    expect(parseSessionConstraints('想听日语').excludedLanguages).toEqual([])
    expect(parseSessionConstraints()).toEqual({ raw: '', excludedLanguages: [] })
  })
  it('metadataLanguageHint：含假名的日文识别为 ja，纯汉字日文不误判为 zh', () => {
    // act & assert
    expect(metadataLanguageHint({ artist: 'Vaundy', title: '怪獣の花唄' })).toEqual({ code: 'ja', confidence: 'high' })
    expect(metadataLanguageHint({ artist: '周杰伦', title: '晴天' })).toEqual({ code: 'unknown', confidence: 'low' })
    expect(metadataLanguageHint({ artist: 'A', title: '桜' })).toEqual({ code: 'unknown', confidence: 'low' })
    expect(metadataLanguageHint({ artist: 'A', title: 'B', tags: ['华语'] })).toEqual({ code: 'zh', confidence: 'high' })
  })
  it('metadataLanguageHint：韩文识别为 ko', () => {
    // act & assert
    expect(metadataLanguageHint({ artist: 'BTS', title: '봄날' })).toEqual({ code: 'ko', confidence: 'high' })
  })
  it('rowLanguageBlocked：明确 zh 行高置信才拦；含汉字日文标题不被拦', () => {
    // arrange
    const zh = { excludedLanguages: ['zh'] }
    // act & assert
    expect(rowLanguageBlocked({ language: 'ja', language_confidence: 'high' }, { artist: 'Vaundy', title: '怪獣の花唄' }, zh)).toBe(false)
    expect(rowLanguageBlocked({ language: 'zh', language_confidence: 'low' }, { artist: 'A', title: '晴天' }, zh)).toBe(false)
    expect(rowLanguageBlocked({ language: 'zh', language_confidence: 'high' }, { artist: 'A', title: '晴天' }, zh)).toBe(true)
    expect(rowLanguageBlocked({ language: 'unknown' }, { artist: 'Vaundy', title: '怪獣の花唄' }, zh)).toBe(false)
    expect(rowLanguageBlocked({ language: 'unknown' }, { title: 'x', tags: ['中文歌'] }, zh)).toBe(true)
  })
  it('localLanguageBlocked：仅元数据强提示被禁语言时拦截', () => {
    // act & assert
    expect(localLanguageBlocked({ artist: 'Vaundy', title: '怪獣の花唄' }, { excludedLanguages: ['zh'] })).toBe(false)
    expect(localLanguageBlocked({ artist: 'Vaundy', title: '怪獣の花唄' }, { excludedLanguages: ['ja'] })).toBe(true)
  })
  it('languageBlocked 精确匹配排除语言', () => {
    // act & assert
    expect(languageBlocked('zh', { excludedLanguages: ['zh'] })).toBe(true)
    expect(languageBlocked('en', { excludedLanguages: ['zh'] })).toBe(false)
  })
  it('sameArtistConflictsWithConstraints：纯汉字 anchor 保守换召回空间，带假名/韩文不算', () => {
    // arrange
    const zh = { excludedLanguages: ['zh'] }
    // act & assert
    expect(sameArtistConflictsWithConstraints({ artist: '周杰伦', title: '晴天' }, { anchorLanguage: { code: 'zh', confidence: 'high' } }, zh)).toBe(true)
    expect(sameArtistConflictsWithConstraints({ artist: 'RADWIMPS', title: 'スパークル' }, { anchorLanguage: { code: 'ja', confidence: 'high' } }, zh)).toBe(false)
    expect(sameArtistConflictsWithConstraints({ artist: '周杰伦', title: '晴天' }, { anchorLanguage: { code: 'unknown', confidence: 'low' } }, zh)).toBe(true)
    expect(sameArtistConflictsWithConstraints({ artist: '周杰伦', title: '晴天' }, { anchorLanguage: { code: 'zh', confidence: 'high' } }, { excludedLanguages: [] })).toBe(false)
  })
  it('constraintPrompt 把硬约束写进召回要求（不能只靠最后过滤）', () => {
    // act & assert
    expect(constraintPrompt({ excludedLanguages: ['zh'] })).toBe('硬约束：不要 中文演唱/华语。召回方向必须从源头跨到允许的语言空间，不能只靠最后过滤。')
    expect(constraintPrompt({ excludedLanguages: [] })).toBe('')
  })
  it('CJK/假名/韩文判定基础函数', () => {
    // act & assert
    expect(containsCjk('桜')).toBe(true)
    expect(containsCjk('abc')).toBe(false)
    expect(hasKana('スパークル')).toBe(true)
    expect(hasKana('桜')).toBe(false)
    expect(hasHangul('봄날')).toBe(true)
    expect(tokenize('edm, 电子 / house')).toEqual(['edm', '电子', 'house'])
  })
})

describe('exclusionHit / effectiveExcludes / negativeFromInstruction - 指令排除', () => {
  it('negativeFromInstruction 提取“不要/别/避免”后的词（保留 from-here 原行为）', () => {
    // act & assert
    expect(negativeFromInstruction('不要电子')).toBe('电子')
    expect(negativeFromInstruction('别来纯音乐')).toBe('来纯音乐')
    expect(negativeFromInstruction('不要华语 保持人声')).toBe('华语 保持人声')
    expect(negativeFromInstruction('')).toBe('')
  })
  it('effectiveExcludes 合并显式排除与指令排除', () => {
    // act & assert
    expect(effectiveExcludes('不要电子', '翻唱')).toBe('翻唱 电子')
    expect(effectiveExcludes()).toBe('')
  })
  it('exclusionHit：edm 同义词命中、普通词按包含命中、单字词不命中', () => {
    // act & assert
    expect(exclusionHit({ title: 'The Dancefloor', tags: ['electronic'] }, 'edm')).toBe(true)
    expect(exclusionHit({ title: 'Solo Guitar', tags: [] }, 'edm')).toBe(false)
    expect(exclusionHit({ title: '夜曲', artist: '某人' }, '电子')).toBe(false)
    expect(exclusionHit({ title: '翻唱版', artist: '某人' }, '翻唱')).toBe(true)
    expect(exclusionHit({ title: '夜曲', artist: '某人' }, '夜')).toBe(false)
  })
})

describe('coarseWorldBreak / eligibleByFormat - 近距断裂与格式守门', () => {
  const vocalAnalysis = { fingerprint: { vocal_identity: ['男声', '真声'] } }
  const folkAnalysis = { fingerprint: { instrumentation_texture: ['acoustic', '木吉他'], rhythm_motion: ['folk'] } }

  it('acoustic folk -> four-on-the-floor EDM 在 radius<=45 判断裂，>45 放行', () => {
    // act & assert
    expect(coarseWorldBreak({ artist: 'A', title: 'B', tags: ['four-on-the-floor', 'edm'] }, folkAnalysis, 35)).toBe(true)
    expect(coarseWorldBreak({ artist: 'A', title: 'B', tags: ['four-on-the-floor', 'edm'] }, folkAnalysis, 46)).toBe(false)
  })
  it('核心人声 -> 纯器乐判断裂（候选文本带上艺人名后不享受“纯音乐”独立豁免）', () => {
    // act & assert
    expect(coarseWorldBreak({ artist: 'A', title: '纯音乐伴奏', tags: [] }, vocalAnalysis, 35)).toBe(true)
    expect(coarseWorldBreak({ artist: 'A', title: '纯音乐', tags: [] }, vocalAnalysis, 35)).toBe(true)
    expect(coarseWorldBreak({ artist: 'A', title: 'B', tags: ['jazz'] }, vocalAnalysis, 35)).toBe(false)
  })
  it('eligibleByFormat：未要求时压制 tribute/翻唱；用户要求翻唱时放行', () => {
    // act & assert
    expect(eligibleByFormat({ artist: 'Guitar Tribute', title: 'X' }, vocalAnalysis)).toBe(false)
    expect(eligibleByFormat({ artist: 'Guitar Tribute', title: 'X' }, vocalAnalysis, '想听翻唱')).toBe(true)
    expect(eligibleByFormat({ artist: 'A', title: 'Instrumental Cover' }, vocalAnalysis)).toBe(false)
    expect(eligibleByFormat({ artist: 'The Killers', title: 'Read My Mind' }, vocalAnalysis)).toBe(true)
  })
})

describe('publicReason - 对外文案过滤', () => {
  it('工程内部词（召回/重排/候选池/AI）替换为听者语言，真实听感理由保留', () => {
    // arrange
    const fallback = '和起点仍有清楚的听感连续性'
    // act & assert
    expect(publicReason('候选池重排结果')).toBe(fallback)
    expect(publicReason('AI 推荐了这首歌')).toBe(fallback)
    expect(publicReason('')).toBe(fallback)
    expect(publicReason('换语言但保留青年感')).toBe('换语言但保留青年感')
  })
})
