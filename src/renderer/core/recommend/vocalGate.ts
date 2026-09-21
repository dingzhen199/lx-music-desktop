/**
 * 器乐/纯音乐反向硬门（诉求 1 新增）。
 *
 * T-B0（judgment.ts）的 transformationAllowed/vocalMismatch 只处理
 * “允许器乐候选不压制”（anchor 人声 → 压制器乐方向），没有
 * “用户要求纯音乐 → 过滤人声候选”的反向硬门；AI 排序对“有无歌词”的
 * 语义判定不可靠，故在此补充确定性反向过滤。
 * 本模块不依赖 judgment/prompts 的运行时逻辑（判定自实现），由 vitest 直接测试；
 * judgment.ts 共用诉求判定，prompts.ts 要求模型显式输出 vocal_type。
 *
 * 跨模块正则漂移说明：judgment.ts 中存在表面相似的器乐判定
 * （likelyDerivative ~370 / vocalMismatch ~394 / coarseWorldBreak ~404），
 * 但语义刻意不同——judgment 面向“衍生态/人声失配压制”，本门面向
 * “用户显式要求器乐 → 反向过滤人声候选”。元数据词表各有用途；
 * 用户诉求统一由 wantsInstrumental 判定。
 */

/**
 * 器乐信号在候选元数据中的匹配（title/artist/album/tags 联合文本小写）。
 * 注意：本表与 INSTRUMENTAL_TERMS 是**刻意不同的两套词表**——
 * 本表是“曲目元数据里标注了器乐形态”的标记词，INSTRUMENTAL_TERMS 是“用户诉求句式”的目标词；
 * 两者按各自场景独立演进（当前 `器乐` 两边都有，但不要假定会同步增删）。
 */
const INSTRUMENTAL_META_RE = /(instrumental|纯音乐|器乐|伴奏|无人声|无歌词|纯乐器|轻音乐|pure music|inst\.)/i

/**
 * 器乐/无人声目标词：正面与负面**共用**同一常量，杜绝单边漏词漂移
 * （历史教训：词表连踩三轮“正面加了负面没加”）。
 * NEGATIVE 用 `${INSTRUMENTAL_TERMS}` 插值构造、POSITIVE 用同一常量 + `不要人声`
 * （POSITIVE 独有的裸词：`不要人声` 是器乐诉求，但裸“人声”不能进 NEGATIVE 词表，
 * 否则“不要人声”会被误判为否定——此为两表**刻意保留**的唯一差异）。
 */
const INSTRUMENTAL_TERMS = '纯音乐|器乐|instrumental|纯乐器|轻音乐|无人声|无歌词|没有人声|没人声|去掉人声|没有歌词|无词'

/**
 * 否定前缀 + 目标词 → 不是要求器乐。
 * “无歌词/无人声/去掉人声”类目标词在带否定前缀时（“不要无歌词的”“不要去掉人声”）
 * 是“不要(无歌词)/不要(去掉人声)”= 要求人声/歌词，不是器乐诉求；裸诉求（“去掉人声”）
 * 无否定前缀，由 POSITIVE 命中为器乐诉求。
 *
 * 否定链的截断标点：句末/停顿类（，,。；;！？!?）与换行会截断——“不要华语！纯音乐”
 * 是两句诉求（不要华语 + 要纯音乐）。**刻意不截断**：顿号 `、` 与冒号 `：/:`
 * （“不要华语、纯音乐”“不要华语：纯音乐”是并列列举/补语，读作“不要华语和纯音乐”，
 * 若在此截断会把否定诉求反转为器乐诉求）。
 */
const NEGATIVE_INSTRUMENTAL_RE = new RegExp(`(?:不要|别|不想听|不想|不喜欢|不爱|讨厌|避免)[^，,。；;！？!?\\n\\r]{0,12}(?:${INSTRUMENTAL_TERMS})`, 'i')

/**
 * 肯定命中：只管目标词出现（否定前缀已由 NEGATIVE 先行排除，
 * 句末/停顿标点（，。；！？!? 与换行）会截断否定链，无需前导标点排除——
 * “不要华语，纯音乐”“不要华语！纯音乐”“；纯音乐”都算要求器乐）。
 * 额外包含 `不要人声`（见 INSTRUMENTAL_TERMS 注释：仅 POSITIVE 有意多出的词）。
 */
const POSITIVE_INSTRUMENTAL_RE = new RegExp(`(?:${INSTRUMENTAL_TERMS})|不要人声`, 'i')

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
  vocalType?: 'instrumental' | 'vocal' | 'unknown'
}

/**
 * 用户是否要求纯音乐/器乐：
 * 否定前缀（“不要纯音乐”“别来纯音乐”“我不喜欢纯音乐”）→ false；
 * 否则命中目标词（“纯音乐”“想听纯音乐”“来点器乐”“不要人声”等）→ true。
 * “讲纯音乐史”这类误判可接受（非否定即视为要求）。
 */
export const wantsInstrumental = (stateWords: string): boolean => {
  const s = String(stateWords ?? '')
  if (NEGATIVE_INSTRUMENTAL_RE.test(s)) return false
  return POSITIVE_INSTRUMENTAL_RE.test(s)
}

/**
 * 候选是否器乐：元数据信号（title/artist/album/tags 命中器乐词）
 * 或 AI 明确标注 vocalType=instrumental。
 * continuity.vocal 表示与起点的人声相似度，低分不能证明没有人声。
 */
export const candidateIsInstrumental = (
  track: InstrumentalCandidate | null | undefined,
  _continuity: VocalContinuity | null | undefined = track?.continuity,
): boolean => {
  const t = track ?? {}
  const hay = `${t.title ?? ''} ${t.artist ?? ''} ${t.album ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase()
  if (INSTRUMENTAL_META_RE.test(hay)) return true
  return t.vocalType === 'instrumental'
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
