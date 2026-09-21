import { describe, expect, it } from 'vitest'
import {
  AESTHETIC_CONSTITUTION,
  ANALYSIS_SYSTEM,
  RANK_SYSTEM,
  buildAnchorAnalysisPrompt,
  buildRankingPrompt,
  normalizeAnalysis,
  recallQueries,
} from './prompts'
import type { TrackAnalysis } from './prompts'

const anchor = { artist: 'Of Monsters and Men', title: 'Dirty Paws', album: 'My Head Is an Animal' }

describe('AESTHETIC_CONSTITUTION - 审美宪法', () => {
  it('包含核心审美原则且不含平台名称', () => {
    // act & assert
    expect(AESTHETIC_CONSTITUTION).toContain('审美宪法')
    expect(AESTHETIC_CONSTITUTION).toContain('同艺人是安全网')
    expect(AESTHETIC_CONSTITUTION).toContain('listening arc')
    expect(AESTHETIC_CONSTITUTION).not.toContain('网易云')
    expect(AESTHETIC_CONSTITUTION).not.toContain('QQ音乐')
  })
})

describe('ANALYSIS_SYSTEM - 分析系统提示词', () => {
  it('包含硬约束语义（不要华语不等于不要 CJK 字符）与严格 JSON 要求', () => {
    // act & assert
    expect(ANALYSIS_SYSTEM).toContain('HARD CONSTRAINT')
    expect(ANALYSIS_SYSTEM).toContain('recall_directions')
    expect(ANALYSIS_SYSTEM).toContain('CJK')
    expect(ANALYSIS_SYSTEM).toContain('不要华语')
    expect(ANALYSIS_SYSTEM).toContain('只输出严格 JSON')
    expect(ANALYSIS_SYSTEM).not.toContain('网易云')
  })
})

describe('RANK_SYSTEM - 排序系统提示词', () => {
  it('包含“有没有资格成为下一首”与弧线视角，不含平台名称', () => {
    // act & assert
    expect(RANK_SYSTEM).toContain('Listening Judgment')
    expect(RANK_SYSTEM).toContain('有没有资格成为下一首')
    expect(RANK_SYSTEM).toContain('listening arc')
    expect(RANK_SYSTEM).toContain('绝对禁止创造不存在于候选池中的歌曲')
    expect(RANK_SYSTEM).not.toContain('网易云')
  })
})

describe('buildAnchorAnalysisPrompt - 锚点分析提示词', () => {
  const prompt = buildAnchorAnalysisPrompt({ anchor, radius: 35, instruction: '更冷一点，不要纯音乐，保持人声' })

  it('包含上下文与全部结构块（fingerprint/recall_directions/avoid_transforms 等）', () => {
    // act & assert
    expect(prompt).toContain('Anchor: Of Monsters and Men — Dirty Paws · My Head Is an Animal')
    expect(prompt).toContain('Exploration distance: 35/100')
    expect(prompt).toContain('Session instruction: 更冷一点，不要纯音乐，保持人声')
    for (const token of [
      'Vocal Identity',
      '真假音',
      'Emotional Core',
      'Imagery & Atmosphere',
      'Rhythm & Motion',
      'Dynamics',
      'Instrumentation & Texture',
      'Melody & Harmony',
      'Narrative Feeling',
      'must_preserve',
      'recall_directions',
    ]) {
      expect(prompt).toContain(token)
    }
  })
  it('包含四个关键问题与审美画像字段', () => {
    // act & assert
    for (const token of ['为什么会让人停下来', 'tension', 'unspoken', 'avoid_reductions', 'surprise_axes', 'avoid_transforms', 'aesthetic_bridge', 'anchor_language', 'target_language']) {
      expect(prompt).toContain(token)
    }
  })
  it('硬约束从召回源头生效的说明存在', () => {
    // act & assert
    expect(prompt).toContain('recall_directions 必须从源头满足它')
    expect(prompt).toContain('不要华语')
  })
  it('不含平台名称', () => {
    // act & assert
    expect(prompt).not.toContain('网易云')
  })
})

describe('buildRankingPrompt - 排序提示词', () => {
  const candidates = [
    { artist: 'Fleet Foxes', title: 'Mykonos', album: '', tags: ['indie', 'folk'], source: 'semantic-search', distance: 28, liked: true },
    { artist: 'Klaas', title: 'First Girl On The Moon', album: '', tags: ['dance', 'edm'], source: 'heartbeat', distance: 50, semanticReason: '接住原始情绪' },
  ]
  const analysis = {
    fingerprint: {
      vocal_identity: ['男女声', '真声'],
      must_preserve: ['有人声'],
      can_drift: ['更暗'],
      emotional_core: ['青春感'],
      imagery: [],
      rhythm_motion: [],
      dynamics: [],
      instrumentation_texture: [],
      melody_harmony: [],
      narrative: [],
    },
  }
  const prompt = buildRankingPrompt({
    anchor,
    radius: 35,
    instruction: '保持人声',
    analysis,
    candidates,
    recentPath: [{ artist: 'Mew', title: 'Comforting Sounds', journeyRole: 'land', distance: 32, reason: '落下', pathState: 'played' }],
  })

  it('包含候选表结构（candidate_id/familiarity）与听感知连续要求', () => {
    // act & assert
    expect(prompt).toContain('candidate_id')
    expect(prompt).toContain('"candidate_id":0')
    expect(prompt).toContain('familiarity')
    for (const token of ['Continuity', 'Vocal Compatibility', 'instrumental cover', 'world_breaks', 'perceptual_distance']) {
      expect(prompt).toContain(token)
    }
  })
  it('包含听感距离而非召回来源距离（不泄露 rough_distance）', () => {
    // act & assert
    expect(prompt).toContain('不要因为 source=heartbeat')
    expect(prompt).not.toContain('rough_distance')
  })
  it('包含双层判断与弧线原则', () => {
    // act & assert
    for (const token of ['有没有资格成为下一首', 'Meaningful Difference', 'Obviousness', 'Cliché Risk', 'journey_role', 'sequence', 'Listening Arc']) {
      expect(prompt).toContain(token)
    }
  })
  it('包含硬约束与近距断裂规则文案', () => {
    // act & assert
    expect(prompt).toContain('User constraint：明确“不要/避免/别”的内容必须满足。')
    expect(prompt).toContain('world_breaks 是致命断裂')
    expect(prompt).toContain('距离 <=45 时，有明显 world_break 的候选不应该进入 sequence。')
    expect(prompt).toContain('非 Anchor Artist 默认最多 1 首')
  })
  it('包含最近路径', () => {
    // act & assert
    expect(prompt).toContain('state=planned')
    expect(prompt).toContain('Comforting Sounds')
  })
  it('不含平台名称', () => {
    // act & assert
    expect(prompt).not.toContain('网易云')
  })
})

describe('normalizeAnalysis - 分析结果归一化', () => {
  it('兼容 v0.4.1 的 legacy searches/traits 结构', () => {
    // act
    const a = normalizeAnalysis({
      summary: '总结',
      traits: { vocal: '男声', mood: ['青春感'], invariants: ['保持人声'] },
      searches: ['The Killers', { keyword: 'RADWIMPS', reason: '跨语言' }],
    }, anchor)
    // assert
    expect(a.summary).toBe('总结')
    expect(a.anchorLanguage).toEqual({ code: 'unknown', confidence: 'low', reason: '' })
    expect(a.fingerprint.vocal_identity).toEqual(['男声'])
    expect(a.fingerprint.emotional_core).toEqual(['青春感'])
    expect(a.fingerprint.must_preserve).toEqual(['保持人声'])
    expect(a.recallDirections).toHaveLength(2)
    expect(a.recallDirections[0].searchArtists).toEqual(['The Killers'])
    expect(a.recallDirections[1]).toMatchObject({ reason: '跨语言', searchArtists: ['RADWIMPS'], targetLanguage: 'unknown' })
    expect(a.avoidTransforms).toEqual(['tribute', 'karaoke', 'instrumental reinterpretation'])
  })
  it('完整 snake_case 结构完整保留', () => {
    // act
    const a = normalizeAnalysis({
      summary: '总结',
      anchor_language: { code: 'zh', confidence: 'high', reason: '中文' },
      aesthetic: { why_it_stops_you: 'w', human_state: ['a'], tension: ['b'], world: 'c', unspoken: 'd', avoid_reductions: ['e'], surprise_axes: ['f'] },
      fingerprint: { vocal_identity: ['男声'], emotional_core: ['青春'], must_preserve: ['保持'], can_drift: ['语言'] },
      recall_directions: [{ name: 'D1', reason: 'r', aesthetic_bridge: 'b', search_artists: ['A1', 'A2'], search_keywords: ['k'], target_language: 'ja' }],
      avoid_transforms: ['tribute'],
    }, anchor)
    // assert
    expect(a.anchorLanguage).toEqual({ code: 'zh', confidence: 'high', reason: '中文' })
    expect(a.fingerprint.must_preserve).toEqual(['保持'])
    expect(a.recallDirections[0]).toEqual({
      name: 'D1',
      reason: 'r',
      aestheticBridge: 'b',
      preserve: [],
      drift: [],
      searchArtists: ['A1', 'A2'],
      searchKeywords: ['k'],
      targetLanguage: 'ja',
    })
    expect(a.avoidTransforms).toEqual(['tribute'])
  })
  it('camelCase 字段可用；无召回向量的方向被丢弃', () => {
    // act
    const a = normalizeAnalysis({
      recallDirections: [
        { name: 'D', reason: 'r', aestheticBridge: 'b', preserve: ['p'], drift: [], searchArtists: [], searchKeywords: ['kw'], targetLanguage: 'en' },
        { name: 'empty' },
      ],
    }, anchor)
    // assert
    expect(a.recallDirections).toHaveLength(1)
    expect(a.recallDirections[0]).toMatchObject({ name: 'D', searchKeywords: ['kw'], targetLanguage: 'en' })
  })
  it('未知值/非对象安全回退默认', () => {
    // act
    const empty = normalizeAnalysis({}, anchor)
    const nullRaw = normalizeAnalysis(null, anchor)
    const garbage = normalizeAnalysis({ fingerprint: { vocal_identity: '男声' } }, anchor)
    // assert
    expect(empty.summary).toBe('Of Monsters and Men — Dirty Paws')
    expect(empty.anchorLanguage).toEqual({ code: 'unknown', confidence: 'low', reason: '' })
    expect(empty.avoidTransforms).toEqual(['tribute', 'karaoke', 'instrumental reinterpretation'])
    expect(nullRaw).toEqual(empty)
    expect(garbage.fingerprint.vocal_identity).toEqual([])
  })
})

describe('recallQueries - 召回查询生成', () => {
  const analysis = (dirs: Array<{ searchArtists?: string[], searchKeywords?: string[], name?: string, reason?: string, aestheticBridge?: string }>): TrackAnalysis => ({
    summary: '',
    anchorLanguage: { code: 'unknown', confidence: 'low', reason: '' },
    aesthetic: {
      why_it_stops_you: '', human_state: [], tension: [], world: '', unspoken: '', avoid_reductions: [], surprise_axes: [],
    },
    fingerprint: {
      vocal_identity: [], emotional_core: [], imagery: [], rhythm_motion: [], dynamics: [], instrumentation_texture: [], melody_harmony: [], narrative: [], must_preserve: [], can_drift: [],
    },
    recallDirections: dirs.map(d => ({
      name: d.name ?? '', reason: d.reason ?? '', aestheticBridge: d.aestheticBridge ?? '', preserve: [], drift: [], searchArtists: d.searchArtists ?? [], searchKeywords: d.searchKeywords ?? [], targetLanguage: 'unknown',
    })),
    avoidTransforms: [],
  })

  it('按半径决定查询上限：<=25 -> 4，<=65 -> 6，更大 -> 8', () => {
    // arrange
    const a = analysis([{ searchArtists: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'] }])
    // act & assert
    expect(recallQueries(a, 25)).toHaveLength(4)
    expect(recallQueries(a, 65)).toHaveLength(6)
    expect(recallQueries(a, 80)).toHaveLength(8)
  })
  it('跨方向去重且 maxOverride 生效', () => {
    // arrange
    const a = analysis([
      { searchArtists: ['dup', 'x'], reason: 'r1' },
      { searchKeywords: ['dup'], reason: 'r2' },
    ])
    // act
    const q = recallQueries(a, 80, 3)
    // assert
    expect(q.map(item => item.keyword)).toEqual(['dup', 'x'])
    expect(q[0].reason).toBe('r1')
  })
  it('reason 按 “bridge；reason；name” 拼接', () => {
    // arrange
    const a = analysis([{ name: 'N', reason: 'R', aestheticBridge: 'B', searchArtists: ['A'] }])
    // act & assert
    expect(recallQueries(a, 80, 3)[0].reason).toBe('B；R；N')
  })
})

describe('缓存友好的固定前缀', () => {
  it('分析与排序共享完整审美前缀', () => {
    expect(ANALYSIS_SYSTEM.startsWith(AESTHETIC_CONSTITUTION)).toBe(true)
    expect(RANK_SYSTEM.startsWith(AESTHETIC_CONSTITUTION)).toBe(true)
  })
  it('规则不因锚点、约束、距离或候选变化而变化，候选在末尾', () => {
    const marker = '\n\n本轮上下文：\n'
    const first = { artist: 'a', title: 'b', source: 'semantic-search' }
    const second = { artist: 'x', title: 'y', source: 'playlist' }
    const a = buildRankingPrompt({ anchor, radius: 20, instruction: '安静', candidates: [first] })
    const b = buildRankingPrompt({ anchor: second, radius: 80, instruction: '热闹', candidates: [second] })
    expect(a.split(marker)[0]).toBe(b.split(marker)[0])
    expect(a.indexOf('Ranking 原则')).toBeLessThan(a.indexOf('Anchor:'))
    expect(a.indexOf('Anchor:')).toBeLessThan(a.indexOf('下面是音乐平台返回的真实候选'))
    expect(buildAnchorAnalysisPrompt({ anchor, radius: 20 }).split(marker)[0])
      .toBe(buildAnchorAnalysisPrompt({ anchor: second, radius: 80 }).split(marker)[0])
  })
})
