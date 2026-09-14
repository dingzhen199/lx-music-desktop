/**
 * 本地用户画像状态机（纯逻辑，TP-1）。
 *
 * 用户画像的领域状态与转移：行为信号（收藏 love / 听完 complete / 推荐曲快速切走 skip）归并为
 * 艺人维度计数底座（按证据量 Top200 截断）+ 滚动事件缓冲（≤500 FIFO）+ 单调总计数器 + LLM 摘要快照；
 * 谓词与构建器：听完判定（isCompleteListen，≥90% 时长）、背书判定（decideEndorsement，仅正向信号且命中
 * 会话推荐集）、本地档排序加成（localBonus，[-10, +10]）、摘要重写条件（summaryDue）与提示词构建
 *（buildSummaryPrompt）、宽松水合（hydrateProfile）。
 * 权重系数、截断与缓冲口径均藏在本模块内（深模块：接口即测试面）。
 * 本模块不依赖任何 lx 运行时模块（仅引入纯函数 ./sameSong 与类型级 @common/recommendation），由 vitest 直接测试；
 * 播放事件/收藏桥/落盘/LLM 摘要的编排见 profile.ts（TP-2，集成层）。
 */
import type { RecommendLlmMessage } from '@common/recommendation'
import { sameSong } from './sameSong'

/** 行为信号类别：收藏（重正向）/ 听完（轻正向）/ 推荐曲快速切走（负向）（D1）。 */
export type ProfileSignalKind = 'love' | 'complete' | 'skip'

/** 艺人表上限（按证据量截断，D2）。 */
export const MAX_ARTISTS = 200
/** 滚动事件缓冲上限（FIFO，D2）。 */
export const MAX_EVENTS = 500
/** 摘要输入的 Top 艺人口径（D7）。 */
export const SUMMARY_TOP_ARTISTS = 50
/** 摘要输入的最近事件条数口径（D7）。 */
export const SUMMARY_RECENT_EVENTS = 100
/** 触发一次摘要重写所需的新正向事件数（loves + completes 增量，D7）。 */
export const SUMMARY_DUE_DELTA = 20
/** 摘要落盘前的最大字数（D12；截断动作在编排层落盘前施加，本模块只持有口径常量）。 */
export const SUMMARY_MAX_CHARS = 200
/** 画像排序加成的幅值上限（D3：正向封顶 +10、负向至多 -10）。 */
export const PROFILE_BONUS_LIMIT = 10
/** 听完判定的播放占比门槛（D1：自然播放 ≥90% 曲目时长）。 */
export const COMPLETE_LISTEN_RATIO = 0.9

// ---- 排序加成的权重系数（D3：loves 重、completes 轻、skips 负；具体系数为实现细节，藏模块内） ----
const LOVE_BONUS = 4
const COMPLETE_BONUS = 1
const SKIP_PENALTY = 3

/** 单艺人的分信号计数（分列原始计数；权重系数的施用发生在读取与截断时，表内不预加权）。 */
export interface ArtistCounts {
  love: number
  complete: number
  skip: number
}

/** 滚动事件缓冲条目（摘要的“最近事件”输入）。 */
export interface ProfileEvent {
  kind: ProfileSignalKind
  artist: string
  title: string
}

/** LLM 摘要快照（basedOnCount = 生成摘要时的 loves + completes 总量，是 summaryDue 的增量判定基准）。 */
export interface ProfileSummary {
  text: string
  basedOnCount: number
}

/**
 * 用户画像状态（纯 JSON 数据，即 data.json recommendProfile 键的落盘形状；转移函数返回新对象）。
 * 三类总计数器单调递增且独立于艺人表截断——summaryDue 依赖总计数，截断不影响摘要阈值口径。
 */
export interface ProfileState {
  /** 收藏信号总数。 */
  loves: number
  /** 听完信号总数。 */
  completes: number
  /** 推荐曲快速切走信号总数。 */
  skips: number
  /** 艺人计数表（信号增量累计底座；证据量 Top200 截断）。 */
  artistCounts: Record<string, ArtistCounts>
  /** 滚动事件缓冲（≤500 FIFO）。 */
  events: ProfileEvent[]
  /** 最近一次 LLM 摘要；从未生成为 null。 */
  summary: ProfileSummary | null
}

/** 行为信号（编排层在事件点构造，字段宽松、reducer 内归一）。 */
export interface ProfileSignal {
  kind: ProfileSignalKind | string
  artist?: string | null
  title?: string | null
  /** 曲目 id（decideEndorsement 的 id 命中判定用；事件缓冲不保留）。 */
  id?: string | null
}

/** 会话推荐集中的曲目引用（decideEndorsement 命中判定输入：id 或 artist/title 满足其一即可命中）。 */
export interface RecommendedTrackRef {
  id?: string | null
  artist?: string | null
  title?: string | null
}

/** 归一为非负整数计数：非有限数/负数按 0 计、浮点向下取整（垃圾快照不污染，与 session-core.toCount 同口径）。 */
const toCount = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 归一艺人名：字符串化去空白；空串按垃圾值处理（画像底座仅艺人维度，空艺人不产生任何可归因计数，D2）。 */
const toArtist = (value: unknown): string => String(value ?? '').trim()

/** 归一曲目名：字符串化去空白（可空）。 */
const toTitle = (value: unknown): string => String(value ?? '').trim()

/** 归一信号类别：三类之外为 null（垃圾 kind 不进入画像）。 */
const toKind = (value: unknown): ProfileSignalKind | null =>
  value === 'love' || value === 'complete' || value === 'skip' ? value : null

/** 证据量：分信号计数之和（艺人表截断与摘要 Top 排行的共用权重——不分极性，被触达最多的艺人优先保留）。 */
const evidenceWeight = (entry: ArtistCounts): number => entry.love + entry.complete + entry.skip

/** 艺人表按证据量截断到 MAX_ARTISTS（超出上限时丢弃最轻者；未超限时原样返回，避免无谓的新引用）。 */
const truncateArtistCounts = (table: Record<string, ArtistCounts>): Record<string, ArtistCounts> => {
  const keys = Object.keys(table)
  if (keys.length <= MAX_ARTISTS) return table
  const keptKeys = keys
    .sort((a, b) => evidenceWeight(table[b]) - evidenceWeight(table[a]))
    .slice(0, MAX_ARTISTS)
  const kept: Record<string, ArtistCounts> = {}
  for (const key of keptKeys) kept[key] = table[key]
  return kept
}

/** 零态画像（首装/快照缺失的水合兜底）。 */
export const createProfileState = (): ProfileState => ({
  loves: 0,
  completes: 0,
  skips: 0,
  artistCounts: {},
  events: [],
  summary: null,
})

/**
 * 行为信号归并 reducer（不可变转移：返回新对象；垃圾信号原样返回原引用）：
 * - kind 必须是 love/complete/skip 之一；
 * - 空艺人信号整体丢弃（画像底座仅艺人维度，无法归因的信号不产生任何计数/事件，垃圾值不污染）；
 * - 三类总计数器单调 +1（独立于艺人表截断）；
 * - 艺人表对应艺人的分信号计数 +1 后按证据量 Top200 截断；
 * - 事件缓冲追加 {kind, artist, title} 后按 ≤500 FIFO 丢弃最旧。
 */
export const reduceProfileSignal = (state: ProfileState | null | undefined, signal: ProfileSignal | null | undefined): ProfileState => {
  const st = state ?? createProfileState()
  if (signal == null) return st
  const kind = toKind(signal.kind)
  if (!kind) return st
  const artist = toArtist(signal.artist)
  if (!artist) return st
  const title = toTitle(signal.title)

  const prevEntry = st.artistCounts[artist]
  const entry: ArtistCounts = {
    love: (prevEntry?.love ?? 0) + (kind === 'love' ? 1 : 0),
    complete: (prevEntry?.complete ?? 0) + (kind === 'complete' ? 1 : 0),
    skip: (prevEntry?.skip ?? 0) + (kind === 'skip' ? 1 : 0),
  }
  const events = [...st.events, { kind, artist, title }]

  return {
    loves: st.loves + (kind === 'love' ? 1 : 0),
    completes: st.completes + (kind === 'complete' ? 1 : 0),
    skips: st.skips + (kind === 'skip' ? 1 : 0),
    artistCounts: truncateArtistCounts({ ...st.artistCounts, [artist]: entry }),
    events: events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events,
    summary: st.summary,
  }
}

/**
 * 听完判定（D1/D9）：实际播放秒数 ÷ 曲目时长 ≥ 90% 为 true；
 * 时长未知（0/负数/非有限数）恒 false（元数据加载前被切走的曲目保守不判定，宁缺毋滥）；
 * 播放秒数垃圾值按 0 计。占比经除法比较：played === duration*0.9 的恰 90% 边界在乘法写法下
 * 会引入浮点尾差（0.9*100 为 90.00000000000001）而误判 false，除法写法则两侧为同一双精度值。
 */
export const isCompleteListen = (playedSec: number, durationSec: number): boolean => {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return false
  const played = Number(playedSec)
  const settled = Number.isFinite(played) && played > 0 ? played : 0
  return settled / duration >= COMPLETE_LISTEN_RATIO
}

/**
 * 背书判定（D5/D11）：信号对象为本会话推荐曲目时返回艺人名，否则 null。
 * - 仅正向信号（love/complete）可构成背书；skip 信号恒 null（跳过只进画像降权，D1/Q8）；
 * - 命中口径：id 相等，或 sameSong 同曲变体（id 不同但 title 相同且艺人 token 有交集）；
 * - 返回艺人口径：优先推荐集侧艺人名（与会话候选命名同源），条目无艺人名时回退信号侧；
 * - 空艺人信号恒否（背书须可归因到艺人）。
 */
export const decideEndorsement = (
  recommended: Array<RecommendedTrackRef | null | undefined> | null | undefined,
  signal: ProfileSignal | null | undefined,
): string | null => {
  if (signal == null || recommended == null) return null
  if (signal.kind !== 'love' && signal.kind !== 'complete') return null
  const signalArtist = toArtist(signal.artist)
  if (!signalArtist) return null
  const signalId = signal.id != null ? String(signal.id) : ''
  const signalRef = { artist: signalArtist, title: signal.title }
  for (const track of recommended) {
    if (track == null) continue
    const trackId = track.id != null ? String(track.id) : ''
    const hit = (!!signalId && !!trackId && signalId === trackId) || sameSong(track, signalRef)
    if (!hit) continue
    return toArtist(track.artist) || signalArtist
  }
  return null
}

/**
 * 本地档排序加成（D3/Q8）：loves 重、completes 轻、skips 负，加权净额收敛到 [-10, +10]；
 * 无记录/空艺人/垃圾状态为 0。权重系数藏在本模块内，调用方只消费最终分值。
 */
export const localBonus = (state: ProfileState | null | undefined, artist: string | null | undefined): number => {
  const entry = state?.artistCounts?.[toArtist(artist)]
  if (!entry) return 0
  const raw = toCount(entry.love) * LOVE_BONUS + toCount(entry.complete) * COMPLETE_BONUS - toCount(entry.skip) * SKIP_PENALTY
  return Math.max(-PROFILE_BONUS_LIMIT, Math.min(PROFILE_BONUS_LIMIT, raw))
}

/**
 * 摘要重写条件（D7）：(loves + completes) 相对摘要 basedOnCount 的增量 ≥ 20 时触发一次重写；
 * 从未生成摘要时 basedOnCount 按 0 计（首轮等价于累计满 20 个正向事件）；skips 不计入正向增量。
 */
export const summaryDue = (state: ProfileState | null | undefined): boolean => {
  const st = state ?? createProfileState()
  return st.loves + st.completes - toCount(st.summary?.basedOnCount) >= SUMMARY_DUE_DELTA
}

/**
 * 摘要生成的 system 提示词（D12：只正向描述偏好、不含指令式措辞，不超过 200 字；
 * 输出为散文而非清单——它会被拼入排序指令面，祈使句会污染 LLM 排序）。
 */
const SUMMARY_SYSTEM_PROMPT = '你在为一位音乐用户撰写本地收听画像摘要。依据给出的艺人计数与最近行为事件，用不超过 200 字的中文散文概括这位用户长期偏爱什么样的音乐（偏爱的艺人、作品的气质与收听习惯）。只正向描述偏好；不得包含任何指令式措辞（“不要”“排除”“多来点”这类命令或请求句式一律不用），不逐条罗列，不使用列表或 Markdown 格式。'

/** 信号类别的事件行文案。 */
const KIND_LABEL: Record<ProfileSignalKind, string> = { love: '收藏', complete: '听完', skip: '跳过' }

/** 艺人榜目行：`- 陈奕迅：收藏 3 / 听完 12 / 跳过 1`。 */
const artistLine = (artist: string, entry: ArtistCounts): string =>
  `- ${artist}：收藏 ${toCount(entry.love)} / 听完 ${toCount(entry.complete)} / 跳过 ${toCount(entry.skip)}`

/**
 * 摘要提示词构建（D7 输入口径 + D12 措辞约束）：
 * 输入 = 按证据量 Top50 的艺人计数 + 最近 100 条行为事件；输出为 llmComplete 可消费的消息序列
 *（system 携带措辞约束，user 携带画像原料；摘要文本由编排层在落盘前按 ≤200 字截断）。
 */
export const buildSummaryPrompt = (state: ProfileState | null | undefined): RecommendLlmMessage[] => {
  const st = state ?? createProfileState()
  const artistLines = Object.entries(st.artistCounts)
    .sort((a, b) => evidenceWeight(b[1]) - evidenceWeight(a[1]))
    .slice(0, SUMMARY_TOP_ARTISTS)
    .map(([artist, entry]) => artistLine(artist, entry))
  const eventLines = st.events
    .slice(-SUMMARY_RECENT_EVENTS)
    .map(event => `- ${KIND_LABEL[event.kind]} ${event.artist}${event.title ? `《${event.title}》` : ''}`)
  const user = [
    `艺人计数（按证据量排序，最多 ${SUMMARY_TOP_ARTISTS} 位）：`,
    ...(artistLines.length ? artistLines : ['（暂无）']),
    '',
    `最近行为事件（最多 ${SUMMARY_RECENT_EVENTS} 条，按时间先后）：`,
    ...(eventLines.length ? eventLines : ['（暂无）']),
  ].join('\n')
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

/** 水合艺人表：键名归一（空白同名归并为合计计数）、垃圾/全零条目不保留，最终结果按证据量截断。 */
const hydrateArtistCounts = (raw: unknown): Record<string, ArtistCounts> => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const merged: Record<string, ArtistCounts> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const artist = toArtist(key)
    if (!artist || value == null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const love = toCount(entry.love)
    const complete = toCount(entry.complete)
    const skip = toCount(entry.skip)
    if (!love && !complete && !skip) continue
    const prev = merged[artist]
    merged[artist] = prev
      ? { love: prev.love + love, complete: prev.complete + complete, skip: prev.skip + skip }
      : { love, complete, skip }
  }
  return truncateArtistCounts(merged)
}

/** 水合事件缓冲：非法 kind、空艺人与非对象条目剔除，超出上限仅保留最近部分（FIFO 语义）。 */
const hydrateEvents = (raw: unknown): ProfileEvent[] => {
  if (!Array.isArray(raw)) return []
  const events: ProfileEvent[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const kind = toKind(entry.kind)
    const artist = toArtist(entry.artist)
    if (!kind || !artist) continue
    events.push({ kind, artist, title: toTitle(entry.title) })
  }
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
}

/** 水合摘要：文本须为非空字符串（否则整体丢弃）；basedOnCount 垃圾按 0（摘要文本保留，增量口径下一轮自然前移）。 */
const hydrateSummary = (raw: unknown): ProfileSummary | null => {
  if (raw == null || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const text = typeof entry.text === 'string' ? entry.text : null
  if (!text?.trim()) return null
  return { text, basedOnCount: toCount(entry.basedOnCount) }
}

/**
 * 快照水合（宽松归一，沿用 session-core.hydrateMetrics 口径）：
 * 落盘 JSON 可能是旧版本或损坏数据——有效字段保留、垃圾字段缺省补齐；
 * 艺人表归并/截断与事件缓冲截断在此恒成立（AC6：重启后计数在旧值上续增）。
 */
export const hydrateProfile = (raw: unknown): ProfileState => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return createProfileState()
  const obj = raw as Record<string, unknown>
  return {
    loves: toCount(obj.loves),
    completes: toCount(obj.completes),
    skips: toCount(obj.skips),
    artistCounts: hydrateArtistCounts(obj.artistCounts),
    events: hydrateEvents(obj.events),
    summary: hydrateSummary(obj.summary),
  }
}
