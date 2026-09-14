/**
 * “从此歌出发”探索会话编排（T-B2 薄层）/ 探索电台编排（TT-1）。
 *
 * 职责：创建会话（锚点取当前播放歌曲、AI 配置取设置、初始计划）、
 * 切歌订阅（路径追加 + 队列剩余 <=3 自动续补，含防抖/单飞/失败退避）、反馈、结束；
 * TT-1 电台化：切歌走向统一由 session-core.decideOnSongChange 判定（on-path/start/reanchor/ignore），
 * 首计划与续补一律队尾入队（D6），同一 run 连续计划最终失败达到上限即收台（D13），
 * initRecommendRadio 负责电台开关的启动恢复与开关变化响应（D15/D10）；
 * TT-2：约束变更作废锚点分析（D3）——applyResult 记录分析所用约束快照，续补经 analysisStale 判废后
 * 不传 reuseAnalysis，引擎自动重新分析、召回方向随新约束换道（快照与 analysisCache 同生命周期）。
 * TP-3：订阅画像信号广播——推荐曲正向信号背书即时入 run（等价 good 转移 + 续补，不发指标）；
 * 切歌结算推荐曲 <30s 经 recordRecommendedSkip 回注画像 skips（D11）。
 * TP-4：buildExploreOptions 注入画像 profileBoost（本地档艺人加成）与 profileSummary（AI 档独立通道，D6）。
 * 状态转移的纯逻辑在 session-core.ts（由 vitest 覆盖）；
 * 本文件依赖播放器状态/事件/引擎，属于集成层，验证方式为 tsc/lint/构建 + 手动冒烟（见 T-B2 报告）。
 */

import { computed, ref, watch } from '@common/utils/vueTools'
import { appSetting } from '@renderer/store/setting'
import { isPlay, playMusicInfo, tempPlayList } from '@renderer/store/player/state'
import { removeTempPlayList } from '@renderer/store/player/action'
import { playMusicInfoNow } from '@renderer/core/player'
import { getRecommendMetrics, saveRecommendMetrics } from '@renderer/utils/data'
import { exploreOnce } from './engine'
import type { AiConfig, ExploreAnchor, ExploreOptions, ExploreResult } from './engine'
import { startFeatureCollection, stopFeatureCollection } from './feature'
import { sameSong } from './sameSong'
import type { RankPathInput, TrackAnalysis } from './prompts'
import { getProfileState, onProfileSignal, recordRecommendedSkip } from './profile'
import { decideEndorsement, localBonus } from './profile-core'
import type { ProfileSignal, RecommendedTrackRef } from './profile-core'
import {
  RADIUS_DEFAULT,
  SKIP_JUDGE_SECONDS,
  START_RADIO_DEBOUNCE_MS,
  accumulatePlayTime,
  addRecommendedIds,
  analysisStale,
  appendToPath,
  applyFeedback as applyFeedbackCore,
  batchKey,
  buildReplanInstruction,
  computeRefillNeed,
  createPlayTimeState,
  createSession,
  decideOnSongChange,
  hydrateMetrics,
  readPlayedMs,
  reanchorSession,
  recordPlanFailure,
  recordPlanSuccess,
  reduceMetrics,
  shouldEndRun,
  toView,
  updateInstruction as updateInstructionCore,
  updateRadius as updateRadiusCore,
} from './session-core'
import type { FeedbackKind, MetricsEvent, MetricsState, PathBatch, PlayTimeState, SessionAnchor, SessionPathItem, SessionState, SessionView } from './session-core'

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
/** 缓存分析产出时所用的一句话约束快照（st.instruction 原样值，D3 作废判定用；与 analysisCache 同生命周期）。 */
let analysisInstruction: string | null = null
let unsubMusicToggled: (() => void) | null = null
let refillTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
// 开台/重锚首计划的防抖计时器（与续补防抖分开：两次切歌各自取消对方的待执行计划）
let reanchorTimer: ReturnType<typeof setTimeout> | null = null
// 单飞标记放在对象属性上（eslint require-atomic-updates 配置 allowProperties: true）
const refillFlight = { inFlight: false }
let refillRetry = 0
// 会话代际号：end/start 时自增，在途计划完成后据此识别“已不属于当前会话”并回滚
let epoch = 0

// ===== TT-4 本地指标（D9/D14）：编排层只在事件点构造事件，计数口径全部在 session-core =====
/** 播放时长累计器：生命周期 = 单曲目，切歌结算上一首后换新零态（即“清零”动作）。 */
let playTime: PlayTimeState = createPlayTimeState()
/** 上一首的 id 与推荐归属（trackEnded 的推荐归属取上一首切换时的 on-path 结论，与 trackStarted 同源）；
 * 艺人/曲名供推荐曲 <30s 跳过的画像 skips 回注（TP-3/D11，判定材料本层现成，profile 无感知）。 */
let lastSongId: string | null = null
let lastSongRecommended = false
let lastSongArtist = ''
let lastSongTitle = ''
/** 指标状态（水合后常驻内存、每次事件后直写落盘；null = 尚未水合）。 */
let metricsState: MetricsState | null = null
/**
 * 指标批次登记的单调序号（稳态撞 key 修复）：批次 key 由（半径/约束/引擎）三元组派生，
 * 稳态连续续补时三元组不变，裸 batchKey 会让新批登记覆盖旧批、旧批曲目失归属（消费比失真）；
 * 故登记侧统一追加本序号（`${batchKey}#${seq}`）使每次计划登记唯一。
 * 随新 run 归零（在 openSession 重置）：重锚属同一 run、不走 openSession，序号跨重锚延续，
 * run 内登记 key 恒不撞；batchKey 本身不携带序号（它兼作路径分组判定，分组语义不变）。
 */
let metricsBatchSeq = 0
/** 水合完成前到达的事件缓冲（D15 启动恢复的首个 musicToggled 可能早于 IPC 读档返回，不能丢）。 */
let pendingMetricsEvents: MetricsEvent[] | null = []

/** 指标事件入口：归并入状态后直写落盘（不节流——事件只发生在切歌/反馈/开收台/计划完成点，量级极小）。 */
const emitMetrics = (event: MetricsEvent): void => {
  if (metricsState == null) {
    pendingMetricsEvents?.push(event)
    return
  }
  metricsState = reduceMetrics(metricsState, event)
  saveRecommendMetrics(metricsState)
}

/** 启动水合一次：快照宽松归一后，水合前缓冲的事件在旧值上续归并（AC7：重启后可读且随事件增长）。 */
const hydrateRecommendMetrics = async(): Promise<void> => {
  const raw = await getRecommendMetrics().catch(() => null)
  const buffered = pendingMetricsEvents ?? []
  let next = hydrateMetrics(raw)
  for (const event of buffered) next = reduceMetrics(next, event)
  metricsState = next
  pendingMetricsEvents = null
  if (buffered.length) saveRecommendMetrics(next)
}

/** play/pause 只喂时长累计器，不直接产生指标事件（30 秒跳过率取实际播放秒数，不取切歌墙钟间隙）。 */
const handlePlayForMetrics = (): void => {
  playTime = accumulatePlayTime(playTime, 'play', Date.now())
}
const handlePauseForMetrics = (): void => {
  playTime = accumulatePlayTime(playTime, 'pause', Date.now())
}

/**
 * 切歌指标：先结算上一首的实际播放秒数（trackEnd 收尾含在途分段，暂停区间已被 pause 事件扣除），
 * 再登记新一首（trackStarted 触发批次消费判定）。本函数只做读取与事件构造，不改动会话状态，
 * 调用点放在 decideOnSongChange 判定之后、执行分支之前——on-path 归属取自转移前会话，不受影响。
 */
const emitSongChangeMetrics = (play: ReturnType<typeof currentMusic>, nextOnPath: boolean): void => {
  const now = Date.now()
  if (lastSongId != null) {
    playTime = accumulatePlayTime(playTime, 'trackEnd', now)
    const playedSeconds = readPlayedMs(playTime, now) / 1000
    emitMetrics({
      type: 'trackEnded',
      recommendedId: lastSongRecommended ? lastSongId : null,
      playedSeconds,
    })
    // TP-3（D11/AC3）：推荐曲 30 秒内被切走 → 回注画像 skips 信号；非推荐曲跳过不入画像；
    // 判定时长口径与 metrics 的 skippedUnder30s 同源（实际播放秒数，非切歌墙钟间隙）
    if (lastSongRecommended && playedSeconds < SKIP_JUDGE_SECONDS) {
      recordRecommendedSkip({ id: lastSongId, artist: lastSongArtist, title: lastSongTitle })
    }
  }
  // 清零换曲：新一首从 0 起计
  playTime = createPlayTimeState()
  lastSongId = play?.id != null ? String(play.id) : null
  lastSongRecommended = nextOnPath
  lastSongArtist = play?.singer ?? ''
  lastSongTitle = play?.name ?? ''
  if (lastSongId != null) emitMetrics({ type: 'trackStarted', id: lastSongId, recommended: nextOnPath })
  // 自然接续切歌常无独立 pause/play 事件对，播放中切歌先开口子；随后播放器的 play 事件会被累计器
  // 按“重复 play 重新锚定”吸收，不会重复计时
  if (isPlay.value) playTime = accumulatePlayTime(playTime, 'play', now)
}

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

/** 当前播放歌曲 → 会话锚点（开台/重锚/startSession 共用的锚点构造口径）。 */
const toAnchor = (play: NonNullable<ReturnType<typeof currentMusic>>): SessionAnchor => {
  return {
    id: play.id,
    artist: play.singer || '(未知艺人)',
    title: play.name || '(未知曲目)',
    album: play.album,
    pic: play.pic ?? null,
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

/** 按 id 从稍后播放队列移除条目（从后往前删避免索引漂移）。 */
const removeTempByIds = (ids: string[]): void => {
  const set = new Set(ids.map(id => String(id)))
  for (let i = tempPlayList.length - 1; i >= 0; i--) {
    const id = tempPlayList[i]?.musicInfo?.id
    if (id && set.has(String(id))) removeTempPlayList(i)
  }
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

/** 最近一次 AI 排序的失败文案（无错误为空串；供页面在本地计划时展示失败原因）。 */
export const lastAiRankError = computed<string>(() => lastResult.value?.meta.aiRankError ?? '')

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
  // D3/AC3：一句话约束变更即作废缓存的锚点分析——判废的续补不传 reuseAnalysis，引擎自动重新分析、
  // 召回方向随新约束换道；约束未变沿用首计划分析（续补与首计划解读同一首歌）。
  // console.warn 为 AC3 冒烟的控制台可观察点（变化后的批次组头 instruction 为页面可观察点）
  const analysisDiscarded = mode === 'refill' && analysisStale(st, analysisInstruction)
  if (analysisDiscarded) console.warn('[session] 一句话约束已变更，作废缓存的锚点分析，本次计划重新分析')
  const profileSummary = getProfileState()?.summary?.text
  return {
    anchor,
    ai: buildAiConfig(),
    radius: st.radius,
    instruction: [st.instruction, buildReplanInstruction(st)].filter(Boolean).join('；'),
    excludes: '',
    // 队尾统一（D6/AC2）：首计划与续补一律追加队尾，不再置顶插队到用户手动排队的歌之前
    appendMode: 'bottom',
    // TP-4（D3）：本地档画像加成——闭包实时读取画像状态（localBonus 对无记录/垃圾艺人恒 0）
    profileBoost: (artist: string) => localBonus(getProfileState(), artist),
    // TP-4（D6 独立通道）：AI 档画像摘要有才传，且绝不拼进上方 instruction——instruction 会经
    // exploreOnce 进入 stateWords 机器解析面（effectiveExcludes/parseSessionConstraints/wantsInstrumental），
    // 摘要散文里的体裁词会翻转器乐硬门（B7-R3）；prompts.ts 零改动
    ...(profileSummary ? { profileSummary } : {}),
    ...(mode === 'refill'
      ? {
          reuseAnalysis: analysisDiscarded ? undefined : (analysisCache ?? undefined),
          excludeIds: [...st.recommendedIds],
          // 已推荐/已播曲目跨批次排除（artist/title 按 sameSong，防同曲不同 id 变体重复入队）
          excludeTracks: st.path.map(p => ({ artist: p.artist, title: p.title })),
          recentPath: toRecentPath(st),
        }
      : {}),
  }
}

/**
 * 应用一次计划结果：记录推荐 id、追加 planned 路径、缓存分析供续补复用。
 * batch 为计划发起时的筛选条件快照（半径/原样约束），引擎由 result 决定。
 */
const applyResult = (result: ExploreResult, batch: Pick<PathBatch, 'radius' | 'instruction'>): void => {
  const st = state.value
  if (!st) return
  const pathBatch: PathBatch = { ...batch, engine: result.engine }
  // 任一计划成功即清零连续失败计数（D13：失败计数只在连续最终失败时累计）
  let next = recordPlanSuccess(addRecommendedIds(st, result.candidates.map(c => c.id).filter((id): id is string => id != null)))
  for (const c of result.candidates) {
    next = appendToPath(next, {
      id: c.id,
      artist: c.artist,
      title: c.title,
      album: c.album,
      reason: c.reason,
      journeyRole: c.journeyRole,
      state: 'planned',
      batch: pathBatch,
      musicInfo: c.musicInfo,
    })
  }
  state.value = next
  lastResult.value = result
  lastError.value = null
  lastErrorKind.value = null
  // 起点分析只为当前会话跑一次（LLM 分析贵且非确定），续补通过 reuseAnalysis 沿用，
  // 保证续补与首计划解读同一首歌；状态更新后再缓存，失败路径不会留下半成品分析。
  analysisCache = result.rawAnalysis
  // 快照记录本次计划实际使用的约束：batch.instruction 取自 plan() 发起时的会话快照（stateAtPlan）。
  // 误取计划完成时点的 st.instruction 会把“旧约束产出的分析”误标为新约束，下一轮续补将漏判作废（D3）
  analysisInstruction = batch.instruction
  // TT-4 续补消费比（D9）：登记本次计划批次与 batch→ids 映射，
  // 同批任一曲目后续进入已播（trackStarted）即记该批被消费一次（一批仅记一次的口径在 reducer 内）。
  // 登记 key = batchKey 追加每 run 单调序号（见 metricsBatchSeq 注记）：稳态连续续补不再覆盖旧批登记
  const registrationKey = batchKey(pathBatch)
  metricsBatchSeq++
  emitMetrics({
    type: 'refillPlanned',
    batchKey: registrationKey == null ? null : `${registrationKey}#${metricsBatchSeq}`,
    ids: result.candidates.map(c => c.id),
  })
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
    // 批次快照取计划发起时的半径与原样约束（await 期间用户改距离/约束不影响本批次标注）
    const stateAtPlan = state.value
    const options = buildExploreOptions(mode)
    if (!options) return
    const result = await exploreOnce(options)
    if (e !== epoch) {
      // 会话已结束或已重启：回滚本次入队结果，不写任何会话状态
      rollbackQueued(result)
      return
    }
    applyResult(result, { radius: stateAtPlan.radius, instruction: stateAtPlan.instruction })
    refillRetry = 0
    refillState.value = 'idle'
  } catch (err) {
    if (e !== epoch) return
    const message = (err as Error).message
    console.warn('[session] 计划失败', message)
    lastError.value = message
    lastErrorKind.value = mode
    if (mode === 'refill' && refillRetry < REFILL_MAX_RETRY) {
      // 重试中不算“最终失败”（D13）：重试耗尽或 initial 失败才计入连续失败
      refillRetry++
      refillState.value = 'retrying'
      const delay = REFILL_RETRY_BASE_MS * refillRetry
      retryTimer = setTimeout(() => {
        void plan('refill')
      }, delay)
    } else {
      refillState.value = 'idle'
      const st = state.value
      if (st) {
        state.value = recordPlanFailure(st)
        if (shouldEndRun(state.value)) {
          // 同一 run 连续计划最终失败达到上限 → 收台（D13/AC9）：清本 run 队列残留后结束会话；
          // 电台仍为开时 endSession 保留切歌订阅，下一首切歌会以新歌重新开台
          console.warn('[session] 同一 run 连续计划最终失败达到上限，收台')
          removeTempByIds(st.recommendedIds)
          endSession()
        }
      }
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

/** 开台/重锚首计划防抖（快速连切只保留最后一次切歌的计划，防切歌风暴连发 LLM 调用；量级与续补防抖一致）。 */
const scheduleRadioPlan = (): void => {
  if (!state.value) return
  if (reanchorTimer) clearTimeout(reanchorTimer)
  reanchorTimer = setTimeout(() => {
    reanchorTimer = null
    // 防抖窗口内会话可能已被收台（endSession 会清本计时器，此处再兜底一次）
    if (!state.value) return
    void plan('initial')
  }, START_RADIO_DEBOUNCE_MS)
}

/** 清空计划上下文（错误/结果/分析缓存及其约束快照）并推进代际：开台与重锚共用的“开新台”动作。 */
const resetPlanContext = (): void => {
  lastError.value = null
  lastResult.value = null
  lastErrorKind.value = null
  analysisCache = null
  analysisInstruction = null
  refillRetry = 0
  epoch++
}

/**
 * 开新台公共序列（startRadioSession / startSession 共用）：
 * 清计划上下文 → 按设置默认半径建全新 run → 建立切歌订阅 → 启动特征采集
 * （随会话生命周期让特征桶在会话播放中持续积累，此前仅 dev 钩子可达、生产路径从未启动）→ 记 run 开始指标；
 * 指标批次登记序号随新 run 归零（重锚属同一 run、复用 reanchorSession 路径，不经由本函数）。
 * 两入口各自的差异留在外层：startRadioSession 防抖发起首计划（切歌吸抖），startSession 幂等后直接 await 首计划。
 */
const openSession = (anchor: SessionAnchor): void => {
  resetPlanContext()
  metricsBatchSeq = 0
  state.value = createSession(anchor, { radius: appSetting['recommend.radius'] })
  subscribeMusicToggled()
  startFeatureCollection()
  emitMetrics({ type: 'runStarted', ts: Date.now() })
}

/** 电台开台（当前无会话）：以当前歌为锚点建会话并防抖发起首计划（decideOnSongChange 的 start 分支）。 */
const startRadioSession = (play: NonNullable<ReturnType<typeof currentMusic>>): void => {
  openSession(toAnchor(play))
  scheduleRadioPlan()
}

/**
 * 跟歌重锚（decideOnSongChange 的 reanchor 分支）：清本会话队列残留（不动用户手动排队的歌）→
 * 收旧台 → 以新歌开新台（run 级字段与连续失败计数沿用，见 session-core.reanchorSession）→ 防抖发起首计划。
 * 复用 startSession 的“清残留→endSession→开新会话→plan(initial)”结构。
 */
const reanchorRadioSession = (prev: SessionState, clearIds: string[], play: NonNullable<ReturnType<typeof currentMusic>>): void => {
  removeTempByIds(clearIds)
  // keepRunAlive：重锚是同一 run 内的“收旧台开新台”（D7 run 级字段沿用），run 指标不结算、不新计
  endSession({ keepRunAlive: true })
  resetPlanContext()
  state.value = reanchorSession(prev, toAnchor(play))
  subscribeMusicToggled()
  startFeatureCollection()
  scheduleRadioPlan()
}

/**
 * 切歌处理：走向由 session-core.decideOnSongChange 统一判定（本层只执行，不含判定逻辑）：
 * - on-path：新歌属于本会话推荐 → 记入路径（已听）；队列剩余 <= 阈值时自动续补；
 * - start：电台开且无会话 → 以当前歌开台（含重启恢复经 playList 派发的首个 musicToggled，D15）；
 * - reanchor：跟歌重锚（D2），该分支永远独立于任何队列清空语义（D13/B7-C1：重锚优先）；
 * - ignore：不动作（电台关且不在路径上时，用户切到非推荐歌曲不会自动续补，避免抢占播放权）。
 */
const handleMusicToggled = (): void => {
  const st = state.value
  const play = currentMusic()
  // SongChangeSong 已裁剪为判定实际消费的 id；宽对象经变量透传（结构类型兼容），不再逐字段复制
  const decision = decideOnSongChange(st, {
    radioEnabled: appSetting['recommend.radio'],
    song: play,
  })
  // TT-4 指标：先结算上一首再走执行分支——结算只读转移前的会话/播放状态，
  // on-path 归属判定（本函数内不做状态转移）不受后续分支影响
  emitSongChangeMetrics(play, decision.kind === 'on-path')
  switch (decision.kind) {
    case 'start':
      if (play) startRadioSession(play)
      return
    case 'reanchor':
      if (st && play) reanchorRadioSession(st, decision.clearIds, play)
      return
    case 'on-path': {
      if (!st || !play) return
      // 与 appendToPath 的合并语义一致：同 id 或同曲（sameSong）都视为当前路径条目
      const existing = st.path.find(p => p.id === play.id || sameSong(p, { artist: play.singer, title: play.name }))
      state.value = appendToPath(st, {
        id: play.id,
        artist: play.singer,
        title: play.name,
        album: play.album,
        reason: existing?.reason ?? '',
        journeyRole: existing?.journeyRole ?? 'open',
        state: 'played',
        // 切歌回写时带回既有批次快照（appendToPath 也会兜底继承，双保险不丢分组）
        batch: existing?.batch,
        // 已播条目可能已离开稍后播放队列，保留 musicInfo 供路径点击重新入队播放
        musicInfo: existing?.musicInfo,
      })
      if (!appSetting['recommend.autoRefill']) return
      if (computeRefillNeed(outstandingRecommendedIds(st))) scheduleRefill()
      break
    }
    default:
      // ignore
  }
}

const subscribeMusicToggled = (): void => {
  if (unsubMusicToggled) return
  window.app_event.on('musicToggled', handleMusicToggled)
  // TT-4 时长累计的 play/pause 订阅与切歌订阅同生命周期（所有权一致归“电台开关或活跃会话”，
  // 见 endSession）：指标事件全部由切歌/反馈/开收台触发，切歌退订后保留时长订阅只会积累
  // 永不被结算的状态；订阅保留期间的空转成本仅每次事件两次函数调用，可忽略
  window.app_event.on('play', handlePlayForMetrics)
  window.app_event.on('pause', handlePauseForMetrics)
  unsubMusicToggled = () => {
    window.app_event.off('musicToggled', handleMusicToggled)
    window.app_event.off('play', handlePlayForMetrics)
    window.app_event.off('pause', handlePauseForMetrics)
  }
}

/**
 * 开始会话：锚点取当前播放歌曲，按默认设置做初始计划（D6 队尾统一：与续补一样追加队尾入队）。
 * 幂等判定：会话存在且锚点仍是当前播放歌曲 → 不重启（供播放栏按钮直接跳转页面）；
 * 锚点已不是当前歌（用户切歌后主动再点“从此歌出发”）→ 旧推荐不清掉的话仍留在队列
 * 和新会话混在一起，故先移除旧会话入队的歌曲，再结束旧会话、按新歌重新开始（手动起点会话幂等语义保留，D13）。
 * 只有用户显式点击本函数才会重开；切歌/自动续补等内部流程不经过它，不会误判重开。
 */
export const startSession = async(): Promise<void> => {
  const play = currentMusic()
  if (!play) throw new Error('请先播放歌曲')
  const st = state.value
  if (st) {
    // 锚点一致 → 幂等返回（用户点了播放栏按钮只是跳转页面，不打断当前会话）
    if (st.anchor.id != null && String(play.id) === String(st.anchor.id)) return
    // 锚点变化 → 重开会话：清掉旧会话的推荐残留（保留用户手动入队的歌曲）
    removeTempByIds(st.recommendedIds)
    endSession()
  }
  openSession(toAnchor(play))
  // 初始计划失败时保留会话与错误信息：用户可调整距离/约束（会触发续补重试）或直接结束
  await plan('initial')
}

/** 反馈：far=太远了（收紧距离 + 当前艺人进 negativeArtists），good=就这个方向。只影响后续批次，不切歌。 */
export const applyFeedback = (kind: FeedbackKind): void => {
  const st = state.value
  if (!st) return
  const play = currentMusic()
  state.value = applyFeedbackCore(st, kind, play?.singer ?? '')
  // TT-4 far/good 计数（D9）：只统计有会话时的有效反馈（上方守卫已保证）
  emitMetrics({ type: 'feedback', kind })
  // 反馈是显式用户动作：始终触发一次续补让改动可感知（不受 autoRefill 开关限制）
  scheduleRefill()
}

/**
 * 背书判定的会话推荐集构造（TP-3）：path 条目（含 artist/title，sameSong 同曲变体判定用）
 * + recommendedIds 中不在路径上的 id（仅 id 命中通道）。
 */
const buildRecommendedRefs = (st: SessionState): RecommendedTrackRef[] => {
  const refs: RecommendedTrackRef[] = st.path.map(p => ({ id: p.id, artist: p.artist, title: p.title }))
  const onPath = new Set(refs.map(r => (r.id != null ? String(r.id) : '')))
  for (const id of st.recommendedIds) {
    const key = String(id)
    if (!onPath.has(key)) refs.push({ id: key })
  }
  return refs
}

/**
 * 画像信号背书（TP-3/D5/D11）：正向信号（love/complete）命中本会话推荐集 → 该艺人进 positiveArtists
 * （等价 applyFeedbackCore 的 good 转移）并触发一次续补；不 emit feedback 指标事件（D5：显式 far/good 口径不变）。
 * 非命中信号与无会话时不动作；重锚/收台后旧推荐集自然失效（decideEndorsement 查的是当前会话推荐集），无需额外处理。
 */
const handleProfileSignal = (signal: ProfileSignal): void => {
  const st = state.value
  if (!st) return
  const artist = decideEndorsement(buildRecommendedRefs(st), signal)
  if (!artist) return
  state.value = applyFeedbackCore(st, 'good', artist)
  // 与既有显式反馈续补共用 scheduleRefill 的防抖/单飞
  scheduleRefill()
}

// 订阅画像信号广播（模块加载即注册一次；无会话时 handler 恒不动作，无需随会话生命周期增删）
onProfileSignal(handleProfileSignal)

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

/**
 * 播放路径条目（探索路径点击跳播）：
 * - 稍后播放队列中仍有该 id → 先从队列移除再播放
 *   （稍后播放为 FIFO（playNext 弹队首），不移除的话该歌播完会被弹队首再播一次；
 *   严禁用 playList/playListById：它们会在切换列表时无条件调用 clearTempPlayeList()
 *   清空稍后播放队列，故此处用 playMusicInfoNow）；
 * - 队列中没有但路径条目带音乐信息 → 已被消费/已播，直接播放、不再入队；
 * - 都没有 → 仅 console.warn。
 */
export const playPathItem = (id: string | null): void => {
  const st = state.value
  if (!st || id == null) return
  const queued = tempPlayList.find(item => item?.musicInfo?.id === id)
  if (queued?.musicInfo) {
    const queueIndex = tempPlayList.indexOf(queued)
    removeTempPlayList(queueIndex)
    playMusicInfoNow(queued.musicInfo)
    return
  }
  const pathItem = st.path.find(p => p.id === id)
  if (pathItem?.musicInfo) {
    playMusicInfoNow(pathItem.musicInfo)
    return
  }
  console.warn('[session] 路径条目缺少可播放的音乐信息', id)
}

/**
 * 结束会话（收台）：清空状态；订阅所有权归“电台开关或活跃会话”——
 * 电台仍为开时保留切歌订阅（收台后下一首切歌会以新歌重新开台，D15），电台关时退订。
 * 收台 = run 边界终点（D7/AC4）：会话、分析缓存及其约束快照全部清空，之后重开
 * （startSession / 开关恢复 / 下一首切歌开台）一律经 createSession 建全新 run、
 * 半径回落设置默认，不沿用上一 run 的任何策略字段（run 级沿用只发生在重锚 reanchorSession）。
 * options.keepRunAlive：重锚内部的“收旧台”专用——重锚属同一 run（D7），run 指标不结算；
 * 其余收台路径（显式关闭/连续失败收台/锚点变更重开前的清场）一律结算 runEnded。
 */
export const endSession = (options?: { keepRunAlive?: boolean }): void => {
  if (!options?.keepRunAlive) emitMetrics({ type: 'runEnded', ts: Date.now() })
  if (refillTimer) {
    clearTimeout(refillTimer)
    refillTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (reanchorTimer) {
    clearTimeout(reanchorTimer)
    reanchorTimer = null
  }
  if (!appSetting['recommend.radio']) {
    unsubMusicToggled?.()
    unsubMusicToggled = null
  }
  stopFeatureCollection()
  // 代际自增：使在途计划完成时识别为旧会话并回滚，不污染新会话
  epoch++
  state.value = null
  lastResult.value = null
  refillState.value = 'idle'
  refillFlight.inFlight = false
  refillRetry = 0
  analysisCache = null
  analysisInstruction = null
}

/**
 * 电台开关初始化（渲染进程启动链调用一次；调用点必须先于 useDataInit 完成，D15）：
 * - recommend.radio 持久为开 → 立即建立切歌订阅（不重复订阅，subscribeMusicToggled 幂等）：
 *   不立即开台，开台时机是订阅建立后的首个 musicToggled
 *   （含启动恢复阶段 useDataInit 经 playList 派发的那一个）；
 * - 开关变化同源响应：开 → 建立订阅，有播放中的歌时立即以当前歌开台（无则等首切歌）；
 *   关 → 收台并退订（无会话时只摘掉启动恢复建立的订阅）。
 */
export const initRecommendRadio = (): void => {
  // TT-4 指标水合（D14/AC7）：启动时读档归一入内存；水合返回前到达的事件经缓冲在旧值上续归并
  void hydrateRecommendMetrics()
  watch(() => appSetting['recommend.radio'], (enabled) => {
    if (enabled) {
      subscribeMusicToggled()
      if (currentMusic()) {
        void startSession().catch(err => {
          console.warn('[session] 电台开台失败', (err as Error).message)
        })
      }
    } else if (state.value) {
      // 收台含清场（TT-1：播放栏开关「关 = 清场收台」）：本 run 的队列残留须随会话一并撤除，口径与连续失败收台一致
      removeTempByIds(state.value.recommendedIds)
      endSession()
    } else {
      unsubMusicToggled?.()
      unsubMusicToggled = null
    }
  })
  if (appSetting['recommend.radio']) subscribeMusicToggled()
}

export { lastErrorKind, refillState }

/** dev hook（非生产门控，先例 profile.ts registerDevHook）：向引擎先行注册的 __lxRecommend 增量挂载，
 * 对象缺失时自建兜底（不沉默依赖模块加载序；engine.ts 侧是整体赋值的旧模式，本层照 profile.ts 增量模式）。 */
const registerDevHook = (): void => {
  if (typeof window === 'undefined' || window.lx?.isProd) return
  const hook = ((window as unknown as Record<string, unknown>).__lxRecommend ??= {}) as Record<string, unknown>
  // 只读快照：返回拷贝，console 调试侧的任何篡改不影响模块内状态（TP-3/B7-M4，冒烟与调试依赖）；
  // sessionView 嵌套属性仍是 reactive Proxy（state 为深响应化 ref，toView 仅浅展开），structuredClone 会抛
  // DataCloneError，故用 JSON 往返（本会话视图为纯 JSON 可序列化数据；profile() 用 structuredClone 是因为其数据源未经 reactive）
  hook.session = () => JSON.parse(JSON.stringify(sessionView.value)) as SessionView
}
if (typeof window !== 'undefined' && !window.lx?.isProd) registerDevHook()
