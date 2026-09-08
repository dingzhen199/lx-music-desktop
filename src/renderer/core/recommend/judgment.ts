/**
 * 确定性守门与轨道编排纯逻辑模块。
 *
 * 语义移植自 from-here（MIT）：
 * - bridge/listening-judgment.js（unit/continuityAverage/normalizeRole/aestheticReject/roleBonus/candidateScore/composeListeningArc）
 * - bridge/server.js 的纯函数子集（transformationAllowed/likelyDerivative/vocalMismatch/analysisSuggestsVocal/
 *   coarseWorldBreak/eligibleByFormat/diversify/publicReason/语言约束与排除函数）
 * 按 T-B0 规格做类型化重写与平台文案参数化（去掉“网易云”等平台字样），并保留 from-here 的
 * 既有边界行为（如 negativeFromInstruction 的原样捕获、distance 语义只在排序阶段生效）。
 * 本模块不依赖任何 lx 运行时模块（无 @common/@renderer/electron 与 IPC 依赖），由 vitest 直接测试。
 */

/** 连续性的七个感知维度（与 from-here continuity 结构一致）。 */
export type ContinuityKey =
  | 'vocal'
  | 'timbre'
  | 'instrumentation_texture'
  | 'rhythm_motion'
  | 'dynamics'
  | 'emotional_core'
  | 'imagery_narrative'

/** 单曲的连续性评分（0-1，缺项不计入均值）。 */
export type ContinuityRating = Partial<Record<ContinuityKey, number>>

/** 候选/路径元素的最小结构（宽松建模：字段均为可选，便于外部数据直接传入）。 */
export interface TrackLike {
  artist?: string
  title?: string
  album?: string
  tags?: string[]
  /** 召回来源：same-artist / semantic-search / heartbeat / fm / daily。 */
  source?: string
  encryptedId?: string
  liked?: boolean
  recent?: boolean
  journeyRole?: string
  continuity?: ContinuityRating
  nextSongWorthiness?: number
  meaningfulDifference?: number
  surpriseValue?: number
  obviousness?: number
  clicheRisk?: number
  aiScore?: number
  sequenceIndex?: number
  distance?: number
  reason?: string
  semanticReason?: string
  worldBreaks?: string[]
  pathState?: string
  confidence?: string
  language?: string
  language_code?: string
  language_confidence?: string
  languageConfidence?: string
}

/** Listening Arc 的角色（未知一律回退 open）。 */
export type ArcRole = 'hold' | 'deepen' | 'open' | 'turn' | 'land'

/** 会话语言约束（“不要华语”等明确否定）。 */
export interface SessionConstraints {
  raw: string
  excludedLanguages: string[]
}

/** 语言硬约束容器。 */
export interface LanguageConstraints {
  excludedLanguages?: string[]
}

/** 元数据语言推断结果。 */
export interface LanguageHint {
  code: string
  confidence: 'high' | 'low'
}

/**
 * 供守门函数消费的最小分析结构（与 prompts.ts 的 TrackAnalysis 结构兼容，
 * 此处独立声明以避免模块间耦合）。
 */
export interface AnalysisShape {
  fingerprint?: {
    vocal_identity?: string[]
    [key: string]: unknown
  }
  anchorLanguage?: {
    code?: string
    confidence?: string
    reason?: string
  }
}

/** 将任意数值归一化到 0-1：1<n<=100 视为百分比，其余原样夹取。 */
export function unit(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100))
  return Math.max(0, Math.min(1, n))
}

/** 七维连续性均值，无有效维度时返回 null。 */
export function continuityAverage(track: TrackLike | null | undefined): number | null {
  const c = track?.continuity && typeof track.continuity === 'object' ? track.continuity : {}
  const keys: ContinuityKey[] = [
    'vocal', 'timbre', 'instrumentation_texture', 'rhythm_motion', 'dynamics', 'emotional_core', 'imagery_narrative',
  ]
  const values = keys.map(k => unit(c[k])).filter((v): v is number => v != null)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

/** 角色归一化：大小写/空白不敏感，未知值回退 open。 */
export function normalizeRole(role = ''): ArcRole {
  const r = String(role || '').toLowerCase().trim()
  if (['hold', 'deepen', 'open', 'turn', 'land'].includes(r)) return r as ArcRole
  return 'open'
}

/**
 * 审美守门：技术上匹配不代表有资格成为下一首。
 * 阈值与 from-here 一致（worth<0.48；正常距离下高显然+高俗套；高显然+低差异）。
 */
export function aestheticReject(track: TrackLike, radius: number | string = 35): boolean {
  const worth = unit(track?.nextSongWorthiness)
  const obvious = unit(track?.obviousness)
  const cliche = unit(track?.clicheRisk)
  const difference = unit(track?.meaningfulDifference)

  if (worth != null && worth < 0.48) return true
  if (Number(radius) > 18 && cliche != null && obvious != null && cliche >= 0.84 && obvious >= 0.64) return true
  if (Number(radius) > 18 && obvious != null && difference != null && obvious >= 0.9 && difference < 0.26) return true
  return false
}

/** 按位置与已选角色给出角色加成（首步 hold/deepen 偏好、近距 turn 惩罚、同角色连续 -7 等）。 */
export function roleBonus(
  role: string,
  position: number,
  radius: number | string,
  selected: Array<{ journeyRole?: string }>,
): number {
  const r = normalizeRole(role)
  const seen = new Set(selected.map(x => normalizeRole(x.journeyRole)))
  let bonus = 0

  if (position === 0) {
    if (r === 'hold' || r === 'deepen') bonus += 9
    if (r === 'open') bonus += 3
    if (r === 'turn') bonus -= Number(radius) <= 45 ? 11 : 5
    if (r === 'land') bonus -= 5
  } else if (position === 1) {
    if (r === 'deepen' || r === 'open') bonus += 7
    if (r === 'turn' && Number(radius) <= 30) bonus -= 6
  } else if (position === 2) {
    if (r === 'open' || r === 'turn') bonus += 8
  } else {
    if (r === 'land' && (seen.has('open') || seen.has('turn'))) bonus += 7
    if (r === 'turn' && !seen.has('turn') && Number(radius) > 28) bonus += 4
  }

  const prev = selected[selected.length - 1]
  if (prev && normalizeRole(prev.journeyRole) === r) bonus -= 7
  return bonus
}

/** 单候选打分：worth/continuity/difference/ai/surprise 加权，扣 obvious/cliche，再加角色与序列加成。 */
export function candidateScore(
  track: TrackLike,
  position: number,
  radius: number | string,
  selected: Array<{ journeyRole?: string, source?: string }>,
  anchor: Pick<TrackLike, 'artist' | 'title'>,
): number {
  const worth = unit(track?.nextSongWorthiness) ?? 0.62
  const continuity = continuityAverage(track) ?? 0.58
  const difference = unit(track?.meaningfulDifference) ?? 0.45
  const surprise = unit(track?.surpriseValue) ?? 0.35
  const obvious = unit(track?.obviousness) ?? 0.35
  const cliche = unit(track?.clicheRisk) ?? 0.2
  const ai = Number.isFinite(Number(track?.aiScore)) ? Math.max(0, Math.min(100, Number(track.aiScore))) / 100 : 0.55
  const seq = Number.isFinite(Number(track?.sequenceIndex)) ? Number(track.sequenceIndex) : null

  let score = worth * 34 + continuity * 22 + difference * 12 + ai * 12
  score += Math.min(surprise, Number(radius) <= 25 ? 0.45 : 0.75) * 8
  score -= obvious * 10 + cliche * 14
  score += roleBonus(track?.journeyRole ?? '', position, radius, selected)

  // 参考模型给出的整体顺序，但不得覆盖确定性的反偷懒/弧线守门。
  if (seq != null) score += Math.max(0, 14 - seq * 2.2)

  const prev = selected[selected.length - 1]
  if (prev && String(prev.source ?? '') === String(track.source ?? '')) score -= 3.5

  // 正常距离下前三名不出 anchor 艺人：同类唱片只是安全网，不是探索价值。
  const anchorArtist = String(anchor?.artist ?? '').toLowerCase()
  const artist = String(track?.artist ?? '').toLowerCase()
  if (Number(radius) > 18 && anchorArtist && artist === anchorArtist && position < 3) score -= 100

  // 第一步通常先让人觉得“你懂”，再谈惊喜。
  if (position === 0 && surprise > 0.78 && continuity < 0.68) score -= 9

  return score
}

/** 组合一条 listening arc：先过守门，再按 candidateScore 逐位贪心挑选（顺序敏感）。 */
export function composeListeningArc(
  items: TrackLike[],
  anchor: Pick<TrackLike, 'artist' | 'title'>,
  radius: number | string = 35,
  limit = 8,
): TrackLike[] {
  const max = Math.max(1, Number(limit) || 8)
  const pool = (Array.isArray(items) ? items : []).filter(t => !aestheticReject(t, radius))
  const selected: TrackLike[] = []
  const used = new Set<number>()

  while (selected.length < max) {
    let best: number | null = null
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue
      const score = candidateScore(pool[i], selected.length, radius, selected, anchor)
      if (score > bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best == null) break
    used.add(best)
    selected.push(pool[best])
  }
  return selected
}

/** 是否包含 CJK 统一表意文字（含汉字，不含假名/谚文）。 */
export function containsCjk(s: string): boolean {
  return /[\u3400-\u9fff]/.test(String(s || ''))
}

/** 是否包含日文假名（平/片假名）。 */
export function hasKana(s: string): boolean {
  return /[\u3040-\u30ff]/.test(String(s || ''))
}

/** 是否包含韩文谚文。 */
export function hasHangul(s: string): boolean {
  return /[\uac00-\ud7af]/.test(String(s || ''))
}

/** 按空白/标点切词并转小写。 */
export function tokenize(s: string): string[] {
  return String(s || '').toLowerCase().split(/[\s,，、/|;；]+/).filter(Boolean)
}

/**
 * 解析会话约束（“不要/别/避免 + 华语类”判定为排除 zh）。
 * 注意：日文/韩文可能含汉字，这里不做 CJK 字符猜测，候选语言在 row/localLanguageBlocked 判定。
 */
export function parseSessionConstraints(stateWords = '', excludes = ''): SessionConstraints {
  const raw = `${stateWords} ${excludes}`.trim()
  const excludedLanguages: string[] = []
  const zhNegative = /(?:不要|别|不想(?:听)?|避免|排除)[^，,。；;\n]{0,10}(?:华语|中文(?:歌|歌曲|音乐)?|国语|普通话|粤语|mandopop|cantopop|c-pop)/i.test(raw) ||
    /(?:华语|中文(?:歌|歌曲|音乐)?|国语|普通话|粤语|mandopop|cantopop|c-pop)[^，,。；;\n]{0,8}(?:不要|排除|避免)/i.test(raw)
  if (zhNegative) excludedLanguages.push('zh')
  return { raw, excludedLanguages }
}

/**
 * 由元数据推断歌曲语言：显式华语标记 > 假名 > 谚文 > unknown。
 * 纯汉字标题（含日文汉字）不会被判为 zh——只有明确的中文/华语标记才算。
 */
export function metadataLanguageHint(track: TrackLike): LanguageHint {
  const hay = `${track?.artist ?? ''} ${track?.title ?? ''} ${track?.album ?? ''} ${(track?.tags ?? []).join(' ')}`
  if (/mandopop|cantopop|c-pop|华语|国语|普通话|粤语|中文歌/i.test(hay)) return { code: 'zh', confidence: 'high' }
  if (hasKana(hay)) return { code: 'ja', confidence: 'high' }
  if (hasHangul(hay)) return { code: 'ko', confidence: 'high' }
  return { code: 'unknown', confidence: 'low' }
}

/** 语言编码是否命中排除列表（精确小写匹配）。 */
export function languageBlocked(code: string, constraints: LanguageConstraints): boolean {
  return Boolean(code && constraints?.excludedLanguages?.includes(String(code).toLowerCase()))
}

/** 候选行语言判定：行内明确语言高置信被禁 → 拦；否则按元数据强提示拦。 */
export function rowLanguageBlocked(
  row: { language?: string, language_code?: string, language_confidence?: string, languageConfidence?: string },
  track: TrackLike,
  constraints: LanguageConstraints,
): boolean {
  if (!constraints?.excludedLanguages?.length) return false
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退：空串语言继续落到 language_code
  const code = String(row?.language || row?.language_code || 'unknown').toLowerCase()
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退：空串置信度按 low 处理更保守
  const confidence = String(row?.language_confidence || row?.languageConfidence || 'low').toLowerCase()
  if (languageBlocked(code, constraints) && confidence !== 'low') return true
  const hint = metadataLanguageHint(track)
  return languageBlocked(hint.code, constraints) && hint.confidence === 'high'
}

/** 仅按元数据强提示做语言拦截（无行内语言信息时的本地兜底）。 */
export function localLanguageBlocked(track: TrackLike, constraints: LanguageConstraints): boolean {
  if (!constraints?.excludedLanguages?.length) return false
  const hint = metadataLanguageHint(track)
  return languageBlocked(hint.code, constraints) && hint.confidence === 'high'
}

/**
 * 保守判断 anchor 是否与语言约束冲突（只影响召回方向选择）：
 * 有明确 anchorLanguage 高置信被禁，或纯汉字且无假名/谚文的 anchor。
 * 该判断不用于候选语言分类——候选语言由 row/localLanguageBlocked 判定。
 */
export function sameArtistConflictsWithConstraints(
  anchor: Pick<TrackLike, 'artist' | 'title'>,
  analysis: AnalysisShape,
  constraints: LanguageConstraints,
): boolean {
  if (!constraints?.excludedLanguages?.length) return false
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退：空串编码/置信度回退 unknown/low 后参与保守判定
  const code = String(analysis?.anchorLanguage?.code || 'unknown').toLowerCase()
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退：空串置信度按 low 处理，避免误拦
  const confidence = String(analysis?.anchorLanguage?.confidence || 'low').toLowerCase()
  if (languageBlocked(code, constraints) && confidence !== 'low') return true
  const text = `${anchor?.artist ?? ''} ${anchor?.title ?? ''}`
  // 仅保守用于召回换道：纯汉字且无假名/谚文的 anchor 很可能是中文作品。
  // 这不把日语/韩语候选当华语；候选语言在后续按行判定。
  if (constraints.excludedLanguages.includes('zh') && containsCjk(text) && !hasKana(text) && !hasHangul(text)) return true
  return false
}

/** 把语言硬约束写成一句提示词（要求召回源头跨到允许语言空间）。 */
export function constraintPrompt(constraints: LanguageConstraints): string {
  if (!constraints?.excludedLanguages?.length) return ''
  const labels = constraints.excludedLanguages.map(x => x === 'zh' ? '中文演唱/华语' : x).join('、')
  return `硬约束：不要 ${labels}。召回方向必须从源头跨到允许的语言空间，不能只靠最后过滤。`
}

/**
 * 从指令文本提取“不要/别/避免”后的词。
 * 与 from-here 保持一致：捕获组原样保留（如“别来纯音乐”→“来纯音乐”），不再做二次修剪。
 */
export function negativeFromInstruction(text = ''): string {
  const s = String(text || '')
  const out: string[] = []
  const re = /(?:不要|别|不想听?|避免)\s*([^，,。；;\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(...String(m[1] || '').split(/[、/\s]+/).filter(Boolean))
  return out.join(' ')
}

/** 合并显式排除词与指令中提取的排除词。 */
export function effectiveExcludes(stateWords = '', excludes = ''): string {
  return [excludes, negativeFromInstruction(stateWords)].filter(Boolean).join(' ').trim()
}

/** 命中排除词：edm 同义词按正则命中，普通词按包含命中（单字词不生效）。 */
export function exclusionHit(track: TrackLike, excludes: string): boolean {
  const words = tokenize(excludes)
  if (!words.length) return false
  const hay = `${track.title ?? ''} ${track.artist ?? ''} ${track.album ?? ''} ${(track.tags ?? []).join(' ')}`.toLowerCase()
  for (const w of words) {
    if (['edm', '电子'].includes(w) && /(edm|electronic|house|techno|电子)/i.test(hay)) return true
    if (['太欢快', '欢快', '快乐'].includes(w) && /(happy|upbeat|欢快|快乐|活力)/i.test(hay)) return true
    if (w.length > 1 && hay.includes(w)) return true
  }
  return false
}

/** 衍生版本识别（tribute/karaoke/翻奏/伴奏等），用于压制“用同一个旋律换皮”。 */
export function likelyDerivative(track: TrackLike): boolean {
  const hay = `${track.artist ?? ''} ${track.title ?? ''} ${track.album ?? ''} ${(track.tags ?? []).join(' ')}`.toLowerCase()
  return /(guitar tribute|tribute players|tribute to|\btribute\b|karaoke|instrumental version|instrumental cover|cover version|piano tribute|string quartet tribute|8-bit tribute|lullaby rendition|翻奏|伴奏|卡拉ok)/i.test(hay)
}

/**
 * 用户是否允许纯音乐/器乐/翻奏/翻唱类转换形态。
 * 保留 from-here 的边界行为：显式“不要/别/避免”前缀优先返回 false；
 * “想听/来点…”等肯定表达或独立“纯音乐/器乐/instrumental”返回 true。
 */
export function transformationAllowed(text = ''): boolean {
  const s = String(text || '')
  if (/(?:不要|别|不想|避免)[^，,。；;]{0,12}(?:纯音乐|器乐|instrumental|翻奏|翻唱|cover|tribute|karaoke)/i.test(s)) return false
  return /(?:想听|想要|来点|可以|允许|多一点|更)[^，,。；;]{0,12}(?:纯音乐|器乐|instrumental|翻奏|翻唱|cover|tribute|karaoke)|^(?:纯音乐|器乐|instrumental)$/i.test(s.trim())
}

/** anchor 分析是否提示“人声是关键体验”（纯器乐/无人声且无正面人声词 → false）。 */
export function analysisSuggestsVocal(analysis: AnalysisShape | null | undefined): boolean {
  const text = (analysis?.fingerprint?.vocal_identity ?? []).join(' ').toLowerCase()
  if (/instrumental|纯器乐|无人声/.test(text) && !/vocal|人声|主唱|合唱|男女/.test(text)) return false
  return /vocal|人声|男声|女声|主唱|合唱|男女|真声|假声|混声|气声|和声/.test(text)
}

/** anchor 人声关键而候选纯器乐 → 失配（用户明确要求纯音乐/器乐时豁免）。 */
export function vocalMismatch(track: TrackLike, analysis: AnalysisShape | null | undefined, stateWords = ''): boolean {
  if (!analysis || transformationAllowed(stateWords) || !analysisSuggestsVocal(analysis)) return false
  const hay = `${track.artist ?? ''} ${track.title ?? ''} ${track.album ?? ''} ${(track.tags ?? []).join(' ')}`.toLowerCase()
  return /(instrumental|纯音乐|伴奏)/i.test(hay)
}

/**
 * 粗粒度世界断裂：近距离（<=45）内 acoustic/folk → 四踩 EDM、核心人声 → 纯器乐。
 * 保留 from-here 的边界行为：候选文本带上艺人/标题后几乎不会命中“纯音乐”独立豁免。
 */
export function coarseWorldBreak(track: TrackLike, analysis: AnalysisShape | null | undefined, radius: number | string): boolean {
  if (Number(radius) > 45) return false
  const anchorText = JSON.stringify(analysis?.fingerprint ?? {}).toLowerCase()
  const candidateText = `${track.artist ?? ''} ${track.title ?? ''} ${track.album ?? ''} ${(track.tags ?? []).join(' ')}`.toLowerCase()
  const anchorOrganic = /(acoustic|原声|folk|民谣|木吉他|organic)/i.test(anchorText)
  const candidateDance = /(dance|edm|four-on-the-floor|house|techno|trance|festival|电子舞曲)/i.test(candidateText)
  const anchorVocal = analysisSuggestsVocal(analysis)
  const candidateInstrumental = /(instrumental|纯音乐|伴奏)/i.test(candidateText)
  if (anchorOrganic && candidateDance) return true
  if (anchorVocal && candidateInstrumental && !transformationAllowed(candidateText)) return true
  return false
}

/** 格式守门：未明确要求时压制衍生态，并拒绝人声失配。 */
export function eligibleByFormat(
  track: TrackLike,
  analysis: AnalysisShape | null | undefined,
  stateWords = '',
  excludes = '',
): boolean {
  const userText = `${stateWords} ${excludes}`
  if (!transformationAllowed(userText) && likelyDerivative(track)) return false
  if (vocalMismatch(track, analysis, userText)) return false
  return true
}

/**
 * 多样性收束：每艺人默认 1 首（anchor 艺人只在极近距离 <=18 允许 2 首）、
 * 同一 (artist, album) 最多 1 首、正常距离下 anchor 艺人延迟到前三位之后、按 id 去重。
 * limit 参数化（from-here 取 config.queueSize 与 6 的较大者），radius 默认 35。
 */
export function diversify(
  items: TrackLike[],
  anchor: Pick<TrackLike, 'artist' | 'title'>,
  limit = 6,
  radius: number | string = 35,
): TrackLike[] {
  const out: TrackLike[] = []
  const counts = new Map<string, number>()
  const albumCounts = new Map<string, number>()
  const seenTracks = new Set<string>()
  const anchorArtist = String(anchor?.artist ?? '').toLowerCase()
  const delayedAnchor: TrackLike[] = []

  function keyFor(t: TrackLike): string {
    return `${String(t.artist ?? '').toLowerCase()}::${String(t.title ?? '').toLowerCase()}`
  }
  function tryPush(t: TrackLike): boolean {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退：空串 id 按 artist::title 去重
    const trackKey = t.encryptedId || keyFor(t)
    if (seenTracks.has(trackKey)) return false
    const artist = String(t.artist ?? '').toLowerCase()
    const isAnchorArtist = artist === anchorArtist
    const cap = isAnchorArtist ? (Number(radius) <= 18 ? 2 : 1) : 1
    if ((counts.get(artist) ?? 0) >= cap) return false
    const album = String(t.album ?? '').trim().toLowerCase()
    const albumKey = album ? `${artist}::${album}` : ''
    if (albumKey && (albumCounts.get(albumKey) ?? 0) >= 1) return false
    out.push(t)
    seenTracks.add(trackKey)
    counts.set(artist, (counts.get(artist) ?? 0) + 1)
    if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1)
    return true
  }

  for (const t of items) {
    const isAnchorArtist = String(t.artist ?? '').toLowerCase() === anchorArtist
    // 正常距离下同艺人候选是安全网，不该占据前三位。
    if (Number(radius) > 18 && isAnchorArtist && out.length < 3) {
      delayedAnchor.push(t)
      continue
    }
    tryPush(t)
    if (out.length >= limit) break
  }
  if (out.length < limit) {
    for (const t of delayedAnchor) {
      if (out.length >= limit) break
      tryPush(t)
    }
  }
  return out
}

/**
 * 对外展示原因：过滤工程内部词（召回/重排/候选池/AI 等），回退听者语言。
 * 与 from-here 一致，仅去掉平台名（“网易云”）不再单独出现。
 */
export function publicReason(reason: string, fallback = '和起点仍有清楚的听感连续性'): string {
  const raw = String(reason || '').trim()
  if (!raw) return fallback
  if (/召回|重排|候选池|ranking|rank|provider|模型|AI/i.test(raw)) return fallback
  return raw
}
