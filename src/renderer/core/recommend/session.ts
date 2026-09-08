/**
 * “从此歌出发”探索会话编排（T-B2 薄层）。
 *
 * 职责：创建会话（锚点取当前播放歌曲、AI 配置取设置、初始计划）、
 * 切歌订阅（路径追加 + 队列剩余 <=3 自动续补，含防抖/单飞/失败退避）、反馈、结束。
 * 状态转移的纯逻辑在 session-core.ts（由 vitest 覆盖）；
 * 本文件依赖播放器状态/事件/引擎，属于集成层，验证方式为 tsc/lint/构建 + 手动冒烟（见 T-B2 报告）。
 */

import { computed, ref } from '@common/utils/vueTools'
import { appSetting } from '@renderer/store/setting'
import { playMusicInfo, tempPlayList } from '@renderer/store/player/state'
import { removeTempPlayList } from '@renderer/store/player/action'
import { exploreOnce } from './engine'
import type { AiConfig, ExploreAnchor, ExploreOptions, ExploreResult } from './engine'
import type { RankPathInput, TrackAnalysis } from './prompts'
import {
  RADIUS_DEFAULT,
  addRecommendedIds,
  appendToPath,
  applyFeedback as applyFeedbackCore,
  buildReplanInstruction,
  computeRefillNeed,
  createSession,
  toView,
  updateInstruction as updateInstructionCore,
  updateRadius as updateRadiusCore,
} from './session-core'
import type { FeedbackKind, SessionAnchor, SessionPathItem, SessionState, SessionView } from './session-core'

/** 切歌后自动续补的防抖间隔（毫秒）。 */
const REFILL_DEBOUNCE_MS = 1200
/** 续补失败后的首次重试延迟（毫秒），之后按倍数递增。 */
const REFILL_RETRY_BASE_MS = 15000
/** 最大连续重试次数（之后静默等待下一次切歌/操作再触发）。 */
const REFILL_MAX_RETRY = 3

// 模块级单例状态：播放栏与探索页共享同一会话实例。
const state = ref<SessionState | null>(null)
const lastResult = ref<ExploreResult | null>(null)
const lastError = ref<string | null>(null)
/** 最近一次失败的类型（初始计划 / 续补），供页面区分文案。 */
const lastErrorKind = ref<'initial' | 'refill' | null>(null)
/** 续补状态：idle / refilling / retrying。 */
const refillState = ref<'idle' | 'refilling' | 'retrying'>('idle')

let analysisCache: TrackAnalysis | null = null
let unsubMusicToggled: (() => void) | null = null
let refillTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
// 单飞标记放在对象属性上（eslint require-atomic-updates 配置 allowProperties: true）
const refillFlight = { inFlight: false }
let refillRetry = 0
// 会话代际号：end/start 时自增，在途计划完成后据此识别“已不属于当前会话”并回滚
let epoch = 0

/** 当前播放歌曲（含下载列表项兼容），用于锚点/切歌判定。 */
const currentMusic = (): { id: string, singer: string, name: string, album: string, pic?: string | null } | null => {
  const play = playMusicInfo.musicInfo
  if (!play) return null
  const info: any = 'progress' in play ? play.metadata.musicInfo : play
  if (!info?.id) return null
  return {
    id: info.id,
    singer: info.singer ?? '',
    name: info.name ?? '',
    album: info.meta?.albumName ?? '',
    pic: info.meta?.picUrl ?? null,
  }
}

/** 队列中仍属于本会话推荐的 id（会话推荐 ∩ 稍后播放列表）。 */
const outstandingRecommendedIds = (st: SessionState): string[] => {
  const recommended = new Set(st.recommendedIds)
  const out: string[] = []
  for (const item of tempPlayList) {
    const id = item?.musicInfo?.id
    if (id && recommended.has(id)) out.push(id)
  }
  return out
}

/** 页面视图（非会话时为 inactive 空视图，避免模板侧 null 判断）。 */
export const sessionView = computed<SessionView>(() => {
  const st = state.value
  if (!st) {
    return {
      active: false,
      anchor: { artist: '', title: '' },
      radius: RADIUS_DEFAULT,
      instruction: '',
      positiveArtists: [],
      negativeArtists: [],
      recommendedIds: [],
      path: [],
      remaining: 0,
    }
  }
  return toView(st, { currentId: currentMusic()?.id ?? null, remaining: outstandingRecommendedIds(st).length })
})

/** 最近一次错误文案（无错误为空串；供页面展示）。 */
export const lastErrorText = computed<string>(() => lastError.value ?? '')

/** 最近一次计划的引擎（无结果为 null；供页面展示 AI/本地标识）。 */
export const lastResultEngine = computed<'ai' | 'local' | null>(() => lastResult.value?.engine ?? null)

/** AI 配置：未启用或未填 Key 时返回 undefined（引擎走本地排序回退，不报错）。 */
const buildAiConfig = (): AiConfig | undefined => {
  if (!appSetting['ai.enable']) return undefined
  return {
    protocol: appSetting['ai.provider'],
    baseUrl: appSetting['ai.baseUrl'],
    apiKey: appSetting['ai.apiKey'],
    model: appSetting['ai.model'],
  }
}

/** 路径 → 引擎 recentPath 输入（已播/已计划，供 AI 排序延续弧线）。 */
const toRecentPath = (st: SessionState): RankPathInput[] => {
  return st.path.slice(-6).map((p: SessionPathItem) => ({
    artist: p.artist,
    title: p.title,
    journeyRole: p.journeyRole,
    reason: p.reason,
    pathState: p.state,
  }))
}

/** 拼 exploreOnce 选项：锚点始终沿会话起点，反馈拼进 instruction。 */
const buildExploreOptions = (mode: 'initial' | 'refill'): ExploreOptions | null => {
  const st = state.value
  if (!st) return null
  const anchor: ExploreAnchor = {
    artist: st.anchor.artist,
    title: st.anchor.title,
    singer: st.anchor.artist,
    name: st.anchor.title,
    id: st.anchor.id ?? undefined,
    album: st.anchor.album,
  }
  return {
    anchor,
    ai: buildAiConfig(),
    radius: st.radius,
    instruction: [st.instruction, buildReplanInstruction(st)].filter(Boolean).join('；'),
    excludes: '',
    appendMode: mode === 'refill' ? 'bottom' : 'top',
    ...(mode === 'refill'
      ? {
          reuseAnalysis: analysisCache ?? undefined,
          excludeIds: [...st.recommendedIds],
          recentPath: toRecentPath(st),
        }
      : {}),
  }
}

/** 应用一次计划结果：记录推荐 id、追加 planned 路径、缓存分析供续补复用。 */
const applyResult = (result: ExploreResult): void => {
  const st = state.value
  if (!st) return
  let next = addRecommendedIds(st, result.candidates.map(c => c.id).filter((id): id is string => id != null))
  for (const c of result.candidates) {
    next = appendToPath(next, {
      id: c.id,
      artist: c.artist,
      title: c.title,
      album: c.album,
      reason: c.reason,
      journeyRole: c.journeyRole,
      state: 'planned',
    })
  }
  state.value = next
  lastResult.value = result
  lastError.value = null
  lastErrorKind.value = null
  // 起点分析只为当前会话跑一次（LLM 分析贵且非确定），续补通过 reuseAnalysis 沿用，
  // 保证续补与首计划解读同一首歌；状态更新后再缓存，失败路径不会留下半成品分析。
  analysisCache = result.rawAnalysis
}

/** 回滚已入队的候选：按返回 id 从队列末尾向前删除（索引随删除变化，从后往前安全）。 */
const rollbackQueued = (result: ExploreResult): void => {
  const ids = new Set(result.candidates.map(c => c.id).filter((id): id is string => id != null))
  for (let i = tempPlayList.length - 1; i >= 0; i--) {
    const id = tempPlayList[i]?.musicInfo?.id
    if (id && ids.has(id)) removeTempPlayList(i)
  }
}

/** 执行一次计划（单飞：in-flight 时直接返回；失败按退避重试，最多 REFILL_MAX_RETRY 次）。 */
const plan = async(mode: 'initial' | 'refill'): Promise<void> => {
  if (refillFlight.inFlight || !state.value) return
  refillFlight.inFlight = true
  refillState.value = 'refilling'
  // 捕获发起时的代际：await 期间会话可能被结束/重启，结果只属于发起时的会话
  const e = epoch
  try {
    const options = buildExploreOptions(mode)
    if (!options) return
    const result = await exploreOnce(options)
    if (e !== epoch) {
      // 会话已结束或已重启：回滚本次入队结果，不写任何会话状态
      rollbackQueued(result)
      return
    }
    applyResult(result)
    refillRetry = 0
    refillState.value = 'idle'
  } catch (err) {
    if (e !== epoch) return
    const message = (err as Error).message
    console.warn('[session] 计划失败', message)
    lastError.value = message
    lastErrorKind.value = mode
    if (mode === 'refill' && refillRetry < REFILL_MAX_RETRY) {
      refillRetry++
      refillState.value = 'retrying'
      const delay = REFILL_RETRY_BASE_MS * refillRetry
      retryTimer = setTimeout(() => {
        void plan('refill')
      }, delay)
    } else {
      refillState.value = 'idle'
    }
  } finally {
    // 只有本代际的计划才有权释放单飞标记（旧代际的 finally 不得影响新会话）
    if (e === epoch) refillFlight.inFlight = false
  }
}

/** 防抖安排自动续补（切歌/参数变化共用；重复触发只保留最后一次）。 */
const scheduleRefill = (): void => {
  if (!state.value) return
  if (refillTimer) clearTimeout(refillTimer)
  refillTimer = setTimeout(() => {
    refillTimer = null
    void plan('refill')
  }, REFILL_DEBOUNCE_MS)
}

/**
 * 切歌处理：
 * 1. 新歌属于本会话推荐 → 记入路径（已听）；
 * 2. 队列剩余 <= 阈值 且用户仍在推荐路径上 → 自动续补。
 * 用户手动切到非推荐歌曲（会清空稍后播放队列）时不自动续补，避免抢占播放权。
 */
const handleMusicToggled = (): void => {
  const st = state.value
  const play = currentMusic()
  if (!st || !play) return
  const onPath = st.recommendedIds.includes(play.id)
  if (onPath) {
    const existing = st.path.find(p => p.id === play.id)
    state.value = appendToPath(st, {
      id: play.id,
      artist: play.singer,
      title: play.name,
      album: play.album,
      reason: existing?.reason ?? '',
      journeyRole: existing?.journeyRole ?? 'open',
      state: 'played',
    })
  }
  if (!appSetting['recommend.autoRefill']) return
  if (onPath && computeRefillNeed(outstandingRecommendedIds(st))) scheduleRefill()
}

const subscribeMusicToggled = (): void => {
  if (unsubMusicToggled) return
  window.app_event.on('musicToggled', handleMusicToggled)
  unsubMusicToggled = () => {
    window.app_event.off('musicToggled', handleMusicToggled)
  }
}

/**
 * 开始会话：锚点取当前播放歌曲，按默认设置做初始计划（置顶入队）。
 * 会话进行中调用本函数不重启（幂等，供播放栏按钮直接跳转页面）。
 */
export const startSession = async(): Promise<void> => {
  const play = currentMusic()
  if (!play) throw new Error('请先播放歌曲')
  if (state.value) return
  lastError.value = null
  lastResult.value = null
  lastErrorKind.value = null
  analysisCache = null
  refillRetry = 0
  epoch++
  const anchor: SessionAnchor = {
    id: play.id,
    artist: play.singer || '(未知艺人)',
    title: play.name || '(未知曲目)',
    album: play.album,
    pic: play.pic ?? null,
  }
  state.value = createSession(anchor, { radius: appSetting['recommend.radius'] })
  subscribeMusicToggled()
  // 初始计划失败时保留会话与错误信息：用户可调整距离/约束（会触发续补重试）或直接结束
  await plan('initial')
}

/** 反馈：far=太远了（收紧距离 + 当前艺人进 negativeArtists），good=就这个方向。只影响后续批次，不切歌。 */
export const applyFeedback = (kind: FeedbackKind): void => {
  const st = state.value
  if (!st) return
  const play = currentMusic()
  state.value = applyFeedbackCore(st, kind, play?.singer ?? '')
  // 反馈是显式用户动作：始终触发一次续补让改动可感知（不受 autoRefill 开关限制）
  scheduleRefill()
}

/** 更新探索距离（滑杆；下次续补生效，并防抖触发一次续补让改动可感知）。 */
export const setRadius = (radius: number): void => {
  const st = state.value
  if (!st) return
  state.value = updateRadiusCore(st, radius)
  scheduleRefill()
}

/** 更新一句话约束（同理：下次续补生效，并防抖触发一次续补）。 */
export const setInstruction = (instruction: string): void => {
  const st = state.value
  if (!st) return
  state.value = updateInstructionCore(st, instruction)
  scheduleRefill()
}

/** 结束会话：清空状态与订阅（停止路径追加与自动续补）。 */
export const endSession = (): void => {
  if (refillTimer) {
    clearTimeout(refillTimer)
    refillTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  unsubMusicToggled?.()
  unsubMusicToggled = null
  // 代际自增：使在途计划完成时识别为旧会话并回滚，不污染新会话
  epoch++
  state.value = null
  lastResult.value = null
  refillState.value = 'idle'
  refillFlight.inFlight = false
  refillRetry = 0
  analysisCache = null
}

export { lastErrorKind, refillState }
