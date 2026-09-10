/**
 * 探索会话状态机（纯逻辑，T-B2）。
 *
 * “从此歌出发”会话的领域状态与转移：创建、半径/指令更新、反馈（far/good）、
 * 路径追加、推荐 id 集合、续补判断与续补指令拼接。
 * 本模块不依赖任何 lx 运行时模块（无 @common/@renderer/electron 与 IPC 依赖），由 vitest 直接测试；
 * 播放器/事件/引擎的编排见 session.ts（薄层）。
 */

import { sameSong } from './sameSong'

/** 探索距离下限（feedback far 的边界）。 */
export const RADIUS_MIN = 10
/** 探索距离上限。 */
export const RADIUS_MAX = 90
/** 默认探索距离（与引擎 updateSession 的 35 一致）。 */
export const RADIUS_DEFAULT = 35
/** far 反馈每次减少的距离。 */
export const FEEDBACK_RADIUS_STEP = 8
/** 队列剩余小于等于该值时自动续补。 */
export const REFILL_THRESHOLD = 3
/** 路径最多保留的条目数（防无限增长）。 */
export const MAX_PATH = 60

/** 反馈类型：far=太远了（收紧距离），good=就这个方向。 */
export type FeedbackKind = 'far' | 'good'

/** 会话起点（从当前播放歌曲提取）。 */
export interface SessionAnchor {
  id?: string | null
  artist: string
  title: string
  album?: string
  /** 封面（用于会话卡片展示）。 */
  pic?: string | null
}

/** 路径条目状态：planned=已计划未播，played=已听过。 */
export type PathState = 'played' | 'planned'

/** 路径条目的批次标注：该条目来自哪次计划及其筛选条件快照（供路径分层展示）。 */
export interface PathBatch {
  /** 计划发起时的探索距离。 */
  radius: number
  /** 计划发起时的一句话约束（用户原样输入，不含反馈拼接）。 */
  instruction: string
  /** 该次计划实际使用的引擎（AI 或本地回退）。 */
  engine: 'ai' | 'local'
}

/** 路径条目（含来源原因与弧线角色）。 */
export interface SessionPathItem {
  id: string | null
  artist: string
  title: string
  album?: string
  reason: string
  journeyRole: string
  state: PathState
  /** 批次快照（计划入队时写入；切歌回写 played 时继承，不丢失）。 */
  batch?: PathBatch
  /** 可播放的完整音乐信息（引擎透传；路径点击跳播用，无则不可跳播）。 */
  musicInfo?: LX.Music.MusicInfoOnline
}

/** 会话状态（纯数据，转移函数返回新对象）。 */
export interface SessionState {
  active: boolean
  anchor: SessionAnchor
  radius: number
  instruction: string
  positiveArtists: string[]
  negativeArtists: string[]
  recommendedIds: string[]
  path: SessionPathItem[]
}

/** 页面视图（toView 输出）。 */
export interface SessionView extends SessionState {
  remaining: number
  path: Array<SessionPathItem & { isCurrent: boolean }>
}

/** 半径收敛：夹取到 [10, 90]，非数值回退默认 35。 */
export const clampRadius = (radius: number): number => {
  if (!Number.isFinite(Number(radius))) return RADIUS_DEFAULT
  return Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(Number(radius))))
}

/** 创建会话：active=true，半径/指令可选（半径按边界收敛）。 */
export const createSession = (anchor: SessionAnchor, options: { radius?: number, instruction?: string } = {}): SessionState => {
  return {
    active: true,
    anchor,
    radius: clampRadius(options.radius ?? RADIUS_DEFAULT),
    instruction: String(options.instruction ?? ''),
    positiveArtists: [],
    negativeArtists: [],
    recommendedIds: [],
    path: [],
  }
}

/** 独立追加（不重复）一个艺人到列表。 */
const pushArtist = (list: string[], artist: string): string[] => {
  const name = String(artist ?? '').trim()
  if (!name) return list
  return list.includes(name) ? list : [...list, name]
}

/** 更新探索距离（滑杆；按边界收敛）。 */
export const updateRadius = (state: SessionState, radius: number): SessionState => {
  return { ...state, radius: clampRadius(radius) }
}

/** 更新一句话约束（原样保存，续补时拼接）。 */
export const updateInstruction = (state: SessionState, instruction: string): SessionState => {
  return { ...state, instruction: String(instruction ?? '') }
}

/**
 * 反馈转移：far → 半径减 8（下限 10）+ 当前艺人入 negativeArtists；
 * good → 半径不变 + 当前艺人入 positiveArtists。
 * 反馈只影响策略（后续续补），不跳过当前歌（path/recommendedIds 不动）。
 */
export const applyFeedback = (state: SessionState, kind: FeedbackKind, artist: string): SessionState => {
  if (kind === 'far') {
    return {
      ...state,
      radius: clampRadius(state.radius - FEEDBACK_RADIUS_STEP),
      negativeArtists: pushArtist(state.negativeArtists, artist),
    }
  }
  return {
    ...state,
    positiveArtists: pushArtist(state.positiveArtists, artist),
  }
}

/** 追加本次计划推荐的候选 id（去重）。 */
export const addRecommendedIds = (state: SessionState, ids: string[]): SessionState => {
  const seen = new Set(state.recommendedIds)
  const added: string[] = []
  for (const id of ids) {
    const key = String(id ?? '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    added.push(key)
  }
  return added.length ? { ...state, recommendedIds: [...state.recommendedIds, ...added] } : state
}

/**
 * 追加/更新路径条目：同 id 或同曲（sameSong，同曲不同 id 变体）只保留一条
 * （planned 更新为 played 时位置不变，字段取后来传入的 item）；
 * 超出 MAX_PATH 裁掉最旧条目。无 id 且非同曲条目按追加处理。
 * 批次继承：新 item 带 batch 用新值，否则继承既有条目的 batch
 * （保证切歌回写 played 时批次快照不丢失）。
 */
export const appendToPath = (state: SessionState, item: SessionPathItem): SessionState => {
  // 此处是 id 或同曲命中的“查找既有条目下标”语义（命中要原位更新），与 includesSameSong 的纯存在性判断不同，不复用。
  const index = state.path.findIndex(p =>
    (item.id != null && p.id === item.id) || sameSong(p, item),
  )
  let path: SessionPathItem[]
  if (index >= 0) {
    const existing = state.path[index]
    path = state.path.slice()
    path[index] = { ...item, batch: item.batch ?? existing.batch }
  } else {
    path = [...state.path, item]
  }
  if (path.length > MAX_PATH) path = path.slice(path.length - MAX_PATH)
  return { ...state, path }
}

/**
 * 批次身份 key：由批次快照三元组（radius/instruction/engine）派生，
 * 兼作路径分组的连续判定与视图 v-for 的稳定 key；无批次为 null。
 */
export const batchKey = (batch?: PathBatch | null): string | null => {
  if (!batch) return null
  return `${batch.radius}|||${batch.instruction}|||${batch.engine}`
}

/** 路径批次分组结果：batch 为该组的批次快照（全列表无批次时为 null）。 */
export interface PathBatchGroup<T> {
  /** v-for 稳定 key（含组序号，非连续的同批次值也不会撞 key）。 */
  key: string
  batch: PathBatch | null
  items: T[]
}

/**
 * 路径按批次分组（视图只负责 i18n 组头文案）：
 * - 连续相同 batchKey 的条目并为一组，批次变化开新组；
 * - 无 batch 条目并入上一组（组内保持原相对顺序）；
 * - 整条列表都无 batch 时输出单个 batch:null 组（视图组头回落「—」）；
 * - 头部无 batch 孤儿（其后存在批次）并入第一个批次组，仍在最前。
 * 空列表返回空数组。
 */
export const groupPathByBatch = <T extends { batch?: PathBatch }>(items: T[]): Array<PathBatchGroup<T>> => {
  const groups: Array<PathBatchGroup<T>> = []
  const leadingOrphans: T[] = []
  const anyBatch = items.some(item => item.batch != null)
  let lastKey: string | null = null
  for (const item of items) {
    const key = batchKey(item.batch)
    if (key == null) {
      if (groups.length) groups[groups.length - 1].items.push(item)
      else if (anyBatch) leadingOrphans.push(item)
      else groups.push({ key: '', batch: null, items: [item] })
      continue
    }
    if (key !== lastKey) {
      groups.push({ key: '', batch: item.batch ?? null, items: [] })
      lastKey = key
    }
    groups[groups.length - 1].items.push(item)
  }
  if (leadingOrphans.length && groups.length) {
    groups[0].items = [...leadingOrphans, ...groups[0].items]
  }
  return groups.map((group, gi) => ({ ...group, key: `${gi}-${batchKey(group.batch) ?? ''}` }))
}

/**
 * 续补判断：队列中剩余的“会话推荐”不超过 minQueueSize 时返回 true。
 * outstandingRecommendedIds 为「会话推荐 id ∩ 当前稍后播放列表」的统计结果。
 */
export const computeRefillNeed = (outstandingRecommendedIds: string[], minQueueSize: number = REFILL_THRESHOLD): boolean => {
  const counted = (Array.isArray(outstandingRecommendedIds) ? outstandingRecommendedIds : []).filter(id => String(id ?? '') !== '').length
  return counted <= Math.max(0, Number(minQueueSize) || REFILL_THRESHOLD)
}

/**
 * 反馈拼接成一句续补指令（positive 在前、negative 在后）；
 * 无反馈返回空串。由调用方与用户约束拼接后传给 exploreOnce 的 instruction。
 * negative 用「不要 + 空格」而非全角冒号：judgment.negativeFromInstruction 的
 * 捕获组不排除全角冒号，冒号会粘进第一个艺人的词元导致排除失效。
 */
export const buildReplanInstruction = (state: SessionState): string => {
  const parts = [
    state.positiveArtists.length ? `近一点的方向：${state.positiveArtists.join('、')}` : '',
    state.negativeArtists.length ? `不要 ${state.negativeArtists.join('、')}` : '',
  ].filter(Boolean)
  return parts.join('；')
}

/** 页面视图：路径条目标记当前播放，附队列剩余计数。 */
export const toView = (state: SessionState, options: { currentId: string | null, remaining: number }): SessionView => {
  return {
    ...state,
    remaining: Math.max(0, Number(options.remaining) || 0),
    path: state.path.map(item => ({
      ...item,
      isCurrent: item.id != null && String(item.id) === String(options.currentId ?? ''),
    })),
  }
}
