/**
 * 器乐/纯音乐反向硬门（诉求 1 新增）。
 *
 * T-B0（judgment.ts）的 transformationAllowed/vocalMismatch 只处理
 * “允许器乐候选不压制”（anchor 人声 → 压制器乐方向），没有
 * “用户要求纯音乐 → 过滤人声候选”的反向硬门；AI 排序对“有无歌词”的
 * 语义判定不可靠，故在此补充确定性反向过滤。
 * 本模块不依赖 judgment/prompts 的运行时逻辑（判定自实现），由 vitest 直接测试；
 * judgment.ts / gates.ts / prompts.ts 保持只读。
 */

/** 器乐信号在候选元数据中的匹配（title/artist/album/tags 联合文本小写）。 */
const INSTRUMENTAL_META_RE = /(instrumental|纯音乐|伴奏|无人声|无歌词|纯乐器|轻音乐|pure music|纯音乐版|inst\.)/i

/** 器乐目标词（语义判定用，“器乐”覆盖“纯器乐”）。 */
const INSTRUMENTAL_TERMS = '(?:纯音乐|器乐|instrumental|无人声|无歌词|纯乐器)'

/** 否定前缀：不要/别/不想/避免 + 目标词 → 不是要求器乐。 */
const NEGATIVE_INSTRUMENTAL_RE = new RegExp(`(?:不要|别|不想|避免)[^，,。；;]{0,12}${INSTRUMENTAL_TERMS}`, 'i')

/** 肯定命中：目标词前跟段首或非句内标点（“想听纯音乐”“来点器乐”等）。 */
const POSITIVE_INSTRUMENTAL_RE = new RegExp(`(?:^|[^，,。；;])${INSTRUMENTAL_TERMS}`, 'i')

/** 连续性最小结构（只需 vocal 维度；与 judgment.ContinuityRating 兼容）。 */
export interface VocalContinuity {
  vocal?: unknown
}

/** 候选最小结构（宽松建模，便于外部数据直接传入）。 */
export interface InstrumentalCandidate {
  title?: string | null
  artist?: string | null
  album?: string | null
  tags?: string[] | null
  continuity?: VocalContinuity | null
}

/**
 * 用户是否要求纯音乐/器乐：
 * 否定前缀（“不要纯音乐”“别来纯音乐”）→ false；
 * 否则命中目标词（“纯音乐”“想听纯音乐”“来点器乐”等）→ true。
 * “讲纯音乐史”这类误判可接受（非否定即视为要求）。
 */
export const wantsInstrumental = (stateWords: string): boolean => {
  const s = String(stateWords ?? '')
  if (NEGATIVE_INSTRUMENTAL_RE.test(s)) return false
  return POSITIVE_INSTRUMENTAL_RE.test(s)
}

/**
 * 候选是否器乐：元数据信号（title/artist/album/tags 命中器乐词）
 * 或 AI 行 vocal 连续性明确低（有限数字且 < 0.4 → 器乐推断）。
 */
export const candidateIsInstrumental = (
  track: InstrumentalCandidate | null | undefined,
  continuity: VocalContinuity | null | undefined = track?.continuity,
): boolean => {
  const t = track ?? {}
  const hay = `${t.title ?? ''} ${t.artist ?? ''} ${t.album ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase()
  if (INSTRUMENTAL_META_RE.test(hay)) return true
  const vocal = Number((continuity ?? {})?.vocal)
  return Number.isFinite(vocal) && vocal < 0.4
}

/**
 * 器乐硬门：无“要求纯音乐”时不拦；有要求时只放行器乐信号明确的候选。
 */
export const passesInstrumentalGate = (
  track: InstrumentalCandidate | null | undefined,
  stateWords: string,
  continuity?: VocalContinuity | null,
): boolean => {
  if (!wantsInstrumental(stateWords)) return true
  return candidateIsInstrumental(track, continuity)
}
