/**
 * 本地用户画像编排适配器（TP-2，薄层）。
 *
 * 职责：常驻 window.app_event 播放事件订阅（musicToggled/play/pause/playerLoadeddata，自有
 * PlayTimeState 时长累计器；不开电台也累计画像，与 session.ts 指标订阅并存互不依赖）、
 * 收藏事件桥订阅（loveListMusicsAdded，来源是 listMusicAdd 去重后实际新增或列表未加载时的原始入参发射；重复收藏的幂等由 reducer 同曲归一兜底，D10/D13）、
 * 切歌结算听完信号（isCompleteListen，时长快照锚定 playerLoadeddata——切歌点 maxPlayTime
 * 恒已被清零，不可作快照点，D9）、onProfileSignal 信号广播注册表（session 侧背书订阅，D11）、
 * recordRecommendedSkip 主动入口（推荐曲 <30s 跳过由 session 结算后回注，入口经 isCompleteListen 与 completes 互斥否决短曲双计，TP-3 接线）、
 * 画像落盘（data.ts recommendProfile 读写对，启动水合一次、事件直写不节流，量级小，D8）、
 * LLM 增量摘要（TP-5/D7：summaryDue 命中且启用 AI 且有 Key 时 fire-and-forget 重写，在途单飞、失败保旧）。
 * 判定与计数口径全部在 profile-core（纯函数，vitest 覆盖）；本文件不 import session（D11 单向依赖），
 * 全部事件处理器经 safeHandle 兜底不外抛（e2e“无脚本错误”断言直接暴露此面，B7-m6）。
 * 属于集成层：验证方式为 tsc/lint/全量构建 + dev hook 冒烟（spec Test Seams）。
 */
import { isPlay, playMusicInfo } from '@renderer/store/player/state'
import { playProgress } from '@renderer/store/player/playProgress'
import { appSetting } from '@renderer/store/setting'
import { getRecommendProfile, saveRecommendProfile } from '@renderer/utils/data'
import type { RecommendLlmProtocol } from '@common/recommendation'
import { llmComplete } from './llm'
import { accumulatePlayTime, createPlayTimeState, readPlayedMs } from './session-core'
import type { PlayTimeState } from './session-core'
import { SUMMARY_MAX_CHARS, buildSummaryPrompt, hydrateProfile, isCompleteListen, isDuplicateLoveSignal, reduceProfileSignal, summaryDue } from './profile-core'
import type { ProfileSignal, ProfileState } from './profile-core'

/** 画像状态（水合后常驻内存、每次有效信号后直写落盘；null = 尚未水合）。 */
let profileState: ProfileState | null = null
/** 水合完成前到达的信号缓冲（启动恢复的首个 musicToggled/收藏可能早于 IPC 读档返回，不能丢；口径同 session.ts 指标水合）。 */
let pendingSignals: ProfileSignal[] | null = []

/** 画像信号广播监听器（session 侧背书判定订阅，D11；本模块只负责广播，不含背书判定逻辑）。 */
export type ProfileSignalListener = (signal: ProfileSignal) => void
const signalListeners = new Set<ProfileSignalListener>()

/**
 * 订阅画像信号广播（有效归并后的 love/complete/skip 信号逐一到达；冗余调用安全，返回退订函数）。
 * 监听器异常 console.warn 落证并被吞掉，不影响其余监听器与画像自身归并。
 */
export const onProfileSignal = (listener: ProfileSignalListener): (() => void) => {
  signalListeners.add(listener)
  return () => {
    signalListeners.delete(listener)
  }
}

/** 信号广播：逐监听器隔离异常，不向外抛。 */
const broadcastSignal = (signal: ProfileSignal): void => {
  for (const listener of signalListeners) {
    try {
      listener(signal)
    } catch (err) {
      console.warn('[profile] 信号广播监听器异常', (err as Error).message)
    }
  }
}

/**
 * 单条信号归并（emitSignal 单发与收藏批处理共用）：
 * - 水合未完成时入缓冲（待水合后续归并、不广播——启动竞态窗口内尚无可成型的背书订阅方，口径同 session.ts 指标水合缓冲）；
 * - 垃圾信号（reducer 原样返回）不动作；
 * - 被幂等吸收的合法 love（isDuplicateLoveSignal 命中）：计数/事件不增，但仍广播——session 背书链依赖
 *   信号到达（取消后再收藏本台推荐曲须进 positiveArtists 并续补，AC1）；幂等吸收与背书广播解耦无副作用
 *   （applyFeedbackCore 的 pushArtist 去重、scheduleRefill 防抖）；
 * - 广播在此完成；落盘与摘要检查交回调用方按频次收敛（单发直写 / 批量单次）。
 * 返回是否有真实状态变化（调用方据此决定落盘与摘要检查）。
 */
const mergeSignal = (signal: ProfileSignal): boolean => {
  if (profileState == null) {
    pendingSignals?.push(signal)
    return false
  }
  const next = reduceProfileSignal(profileState, signal)
  if (next === profileState) {
    if (isDuplicateLoveSignal(profileState, signal)) broadcastSignal(signal)
    return false
  }
  profileState = next
  broadcastSignal(signal)
  return true
}

/** 信号入口：归并广播（口径见 mergeSignal）后直写落盘（不节流——事件只发生在切歌结算/收藏/跳过回注点，量级极小）。 */
const emitSignal = (signal: ProfileSignal): void => {
  if (!mergeSignal(signal)) return
  const st = profileState
  if (st == null) return
  saveRecommendProfile(st)
  // TP-5（D7）：每次正向信号归并落盘后检查一次摘要重写；skip 不构成正向增量，不查
  if (signal.kind === 'love' || signal.kind === 'complete') maybeRewriteSummary()
}

/** 当前画像状态只读出口（TP-4 供 session 侧 profileBoost 闭包实时读取/透传摘要；活引用，只读消费勿原地改）。 */
export const getProfileState = (): ProfileState | null => profileState

// ===== TP-5 LLM 增量摘要（D7）=====
/** AI 配置（与 session.ts buildAiConfig 同口径的独立副本——本模块不 import session，D11；未启用返回 undefined）。 */
const buildAiConfig = (): { protocol?: RecommendLlmProtocol, baseUrl?: string, apiKey: string, model: string } | undefined => {
  if (!appSetting['ai.enable']) return undefined
  return {
    protocol: appSetting['ai.provider'],
    baseUrl: appSetting['ai.baseUrl'],
    apiKey: appSetting['ai.apiKey'],
    model: appSetting['ai.model'],
  }
}

// 在途单飞标记放在对象属性上（eslint require-atomic-updates 配置 allowProperties: true，先例 session.ts refillFlight）
const summaryFlight = { inFlight: false }

/**
 * LLM 增量摘要重写（D7）：summaryDue 命中（loves+completes 相对 basedOnCount 增量 ≥20）且启用 AI 且有 Key 时
 * fire-and-forget 重写一次；在途单飞（B7-m2，参照 session.ts refillFlight 先例）；输入 = profile-core
 * buildSummaryPrompt（Top50 艺人计数 + 近 100 条事件）；失败 console.warn 落证并保留旧摘要（basedOnCount 不前移，
 * 下轮正向信号仍会触发重写）；成功落盘摘要文本（D12：落盘前 ≤200 字截断）+ basedOnCount = 成功点的 loves+completes。
 */
const maybeRewriteSummary = (): void => {
  const st = profileState
  if (st == null || summaryFlight.inFlight || !summaryDue(st)) return
  const ai = buildAiConfig()
  // 无 Key 不发起调用（D7：零成本路径）
  if (!ai?.apiKey) return
  summaryFlight.inFlight = true
  void llmComplete({
    protocol: ai.protocol,
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    messages: buildSummaryPrompt(st),
  }).then(result => {
    const text = String(result?.content ?? '').trim()
    const cur = profileState
    if (text && cur != null) {
      // 成功后落盘（D7）：basedOnCount 取成功点的当前计数——在途期间新到的正向信号自然包含进增量口径
      profileState = { ...cur, summary: { text: text.slice(0, SUMMARY_MAX_CHARS), basedOnCount: cur.loves + cur.completes } }
      saveRecommendProfile(profileState)
    }
  }).catch((err: unknown) => {
    console.warn('[profile] 摘要重写失败，保留旧摘要', (err as Error).message)
  }).finally(() => {
    summaryFlight.inFlight = false
  })
}

/** 启动水合一次：快照宽松归一后，水合前缓冲的信号在旧值上续归并（AC6：重启后计数在旧值上续增）。 */
const hydrateRecommendProfile = async(): Promise<void> => {
  const raw = await getRecommendProfile().catch(() => null)
  const buffered = pendingSignals ?? []
  let next = hydrateProfile(raw)
  for (const signal of buffered) next = reduceProfileSignal(next, signal)
  profileState = next
  pendingSignals = null
  if (buffered.length) saveRecommendProfile(next)
}

/** 处理器兜底包装：画像事件处理器内部异常 console.warn 落证、不向外抛（B7-m6）。 */
const safeHandle = <T extends unknown[]>(handler: (...args: T) => void): (...args: T) => void => {
  return (...args: T) => {
    try {
      handler(...args)
    } catch (err) {
      console.warn('[profile] 事件处理器异常', (err as Error).message)
    }
  }
}

/** 播放时长累计器（自有，与 session 指标累计器并存互不依赖，spec 剩余风险“双订阅并存”）：生命周期 = 单曲目。 */
let playTime: PlayTimeState = createPlayTimeState()
/** 当前曲目时长快照（秒；playerLoadeddata 锚定，未知为 0——isCompleteListen 对未知时长恒不判定，D9）。 */
let durationSnapshotSec = 0
/**
 * 最近成功加载元数据曲目的时长（秒；与 durationSnapshotSec 同源锚定 playerLoadeddata，但不随切歌清零）。
 * 只服务 recordRecommendedSkip 的短曲双计互斥否决（不影响 completes 判定——completes 仍用 durationSnapshotSec）：
 * 本层自存“上一首时长”，session 的 skip 回注无论在 profile 的切歌结算之前还是之后到达，读到的都是
 * 上一首的时长——与两个模块 musicToggled 订阅的执行顺序无关（注册顺序只影响 durationSnapshotSec 的读取时点，
 * 故不复用它）。启动后首曲之前/从未成功加载元数据时为 0 → 恒不否决、保守放行 skip（spec D9“未知不判定听完”的同源口径）。
 */
let lastSettledDurationSec = 0

/** 上一首曲目信息（切歌时结算上一首用；推荐曲跳过判定不在本层——由 session 经 recordRecommendedSkip 回注）。 */
interface LastTrack {
  id: string
  artist: string
  title: string
}
let lastTrack: LastTrack | null = null

/** 当前播放歌曲（含下载列表项兼容；与 session.ts 同口径的最小副本——本层不 import session，D11）。 */
const currentMusic = (): LastTrack | null => {
  const play = playMusicInfo.musicInfo
  if (!play) return null
  const info: any = 'progress' in play ? play.metadata.musicInfo : play
  if (!info?.id) return null
  return {
    id: info.id,
    artist: info.singer ?? '',
    title: info.name ?? '',
  }
}

/** play/pause 只喂时长累计器（听完判定取实际播放秒数，不取切歌墙钟间隙；口径同 session.ts 指标累计）。 */
const handlePlay = safeHandle(() => {
  playTime = accumulatePlayTime(playTime, 'play', Date.now())
})
const handlePause = safeHandle(() => {
  playTime = accumulatePlayTime(playTime, 'pause', Date.now())
})

/** 曲首时长快照（D9/B7-C1）：playerLoadeddata 时点 maxPlayTime 为当前曲目真实时长；非正垃圾值按未知处理。
 *  顺序前提：emit 为订阅序同步派发，本读取依赖 usePlayProgress 先于本模块注册（useApp/index.ts 中 usePlayer 在 initRecommendProfile 之前）。 */
const handlePlayerLoadeddata = safeHandle(() => {
  const duration = Number(playProgress.maxPlayTime)
  const snapped = Number.isFinite(duration) && duration > 0 ? duration : 0
  durationSnapshotSec = snapped
  // 自存“上一首时长”供 skip 互斥否决（见 lastSettledDurationSec 注记）：元数据到达必早于下一次切歌派发，
  // 两种订阅顺序下回注时点读到的都是本首（即将被结算为“上一首”）的时长；垃圾值写 0，恒不否决
  lastSettledDurationSec = snapped
})

/**
 * 切歌结算：先结算上一首（trackEnd 收尾含在途分段，暂停区间已被 pause 扣除；达 90% 发 complete 信号），
 * 再换新曲目零态重开累计（时长快照同步清零，等下一首 loadeddata 重新锚定）；
 * 播放中自然接续切歌常无独立 pause/play 事件对，先开口子（随后播放器 play 事件被累计器“重复 play”吸收）。
 * 队列播尽不派发 musicToggled 的末曲缺口为已知接受项（spec 剩余风险，与指标同口径）。
 */
const handleMusicToggled = safeHandle(() => {
  const now = Date.now()
  if (lastTrack != null) {
    playTime = accumulatePlayTime(playTime, 'trackEnd', now)
    if (isCompleteListen(readPlayedMs(playTime, now) / 1000, durationSnapshotSec)) {
      emitSignal({ kind: 'complete', id: lastTrack.id, artist: lastTrack.artist, title: lastTrack.title })
    }
  }
  playTime = createPlayTimeState()
  durationSnapshotSec = 0
  lastTrack = currentMusic()
  if (lastTrack != null && isPlay.value) playTime = accumulatePlayTime(playTime, 'play', now)
})

/**
 * 收藏桥订阅：「我喜欢」实际新增（或列表未加载时的原始入参发射）的每首曲目各记一次 love 信号
 * （去重与触发范围由发送侧 listMusicAdd 保证）。
 * 批处理动机（sync/整单合入的写放大）：循环只做归并+逐条广播（被幂等吸收的 love 同口径广播，与 emitSignal 一致），
 * 循环结束后有真实变化才单次落盘 + 单次摘要检查——N 首合入从 N 次 save_data IPC 同步写收敛为一次。
 */
const handleLoveListMusicsAdded = safeHandle((musicInfos: LX.Music.MusicInfo[]) => {
  let changed = false
  for (const info of musicInfos ?? []) {
    if (mergeSignal({ kind: 'love', id: info?.id, artist: info?.singer, title: info?.name })) changed = true
  }
  if (!changed) return
  const st = profileState
  if (st == null) return
  saveRecommendProfile(st)
  maybeRewriteSummary()
})

/**
 * 推荐曲跳过主动入口（TP-2 搭好注册通道，TP-3 由 session 切歌结算判定 <30s 后经此回注，D11）。
 * 本层不做“是否推荐曲”判定（判定材料归 session 所有）；参数宽松构造、垃圾信号由 reducer 归一丢弃。
 * 短曲双计互斥：<~33s 短曲自然播尽时 session 结算点 playedSeconds < 30 仍会回注 skip，而本层同曲
 * 已因 ≥90% 记了 complete（同一完整收听 skip+1 且 complete+1，localBonus 净额为负）——归并前先以
 * isCompleteListen(playedSeconds, lastSettledDurationSec) 否决：时长取自本层自存的“上一首时长”
 * （playerLoadeddata 锚定、不随切歌清零），与 session/profile 两个 musicToggled 订阅的执行顺序无关；
 * 曲目时长未知（值为 0——启动后首曲前/元数据从未成功加载）时恒不否决、保守放行 skip（D9 快照口径不变）。
 */
export const recordRecommendedSkip = (track: { artist?: string | null, title?: string | null, id?: string | null, playedSeconds: number }): void => {
  try {
    if (isCompleteListen(track.playedSeconds, lastSettledDurationSec)) return
    emitSignal({ kind: 'skip', id: track?.id, artist: track?.artist, title: track?.title })
  } catch (err) {
    console.warn('[profile] recordRecommendedSkip 异常', (err as Error).message)
  }
}

let subscribed = false
/** 常驻订阅建立（幂等）：播放事件源 + 收藏事件桥；常驻语义 = 不开电台也累计画像（D10）。 */
const subscribe = (): void => {
  if (subscribed) return
  subscribed = true
  window.app_event.on('musicToggled', handleMusicToggled)
  window.app_event.on('play', handlePlay)
  window.app_event.on('pause', handlePause)
  window.app_event.on('playerLoadeddata', handlePlayerLoadeddata)
  window.app_event.on('loveListMusicsAdded', handleLoveListMusicsAdded)
}

/**
 * 画像常驻初始化（渲染进程启动链调用一次）：水合 + 建立常驻订阅。
 * 调用点必须先于 useDataInit 完成注册（沿用 initRecommendRadio 先例：useDataInit 恢复上次播放
 * 会经 playList 派发首个 musicToggled，错过注册点首事件就会被吞掉）。
 */
export const initRecommendProfile = (): void => {
  void hydrateRecommendProfile()
  subscribe()
}

/** dev hook（非生产门控，先例 engine.ts registerDevHook）：挂到引擎先行注册的 __lxRecommend 上；对象缺失时自建兜底（不沉默依赖模块加载序）。 */
const registerDevHook = (): void => {
  if (typeof window === 'undefined' || window.lx?.isProd) return
  const hook = ((window as unknown as Record<string, unknown>).__lxRecommend ??= {}) as Record<string, unknown>
  // 只读快照：返回拷贝，console 调试侧的任何篡改不影响模块内状态
  hook.profile = () => profileState == null ? null : structuredClone(profileState)
}
if (typeof window !== 'undefined' && !window.lx?.isProd) registerDevHook()
