/**
 * 推荐引擎编排：exploreOnce 一条龙（实时特征 → 可选 LLM 分析 → 跨源召回 → 排序 → 守门 → 弧线 → 稍后播放）。
 *
 * 语义移植自 from-here（MIT）bridge/server.js 的 buildSession/planBatch/aiRank/localRank 流程，
 * 复用 T-B0 的守门/编排纯函数；T-B0 文件（judgment.ts/prompts.ts）保持只读复用。
 * 依赖 electron/IPC/音乐 SDK/播放器插件的部分无法在 vitest 中单测（见测试报告）。
 */

import { LIST_IDS } from '@common/constants'
import type { RecommendLlmProtocol } from '@common/recommendation'
import { addTempPlayList } from '@renderer/store/player/action'
import { playProgress } from '@renderer/store/player/playProgress'
import { playMusicInfo } from '@renderer/store/player/state'
import { getFeatureCollector, startFeatureCollection, stopFeatureCollection } from './feature'
import type { FeatureSheet } from './feature'
import { extractRankingRows, parseLooseJson } from './json'
import {
  aestheticReject,
  coarseWorldBreak,
  composeListeningArc,
  constraintPrompt,
  diversify,
  effectiveExcludes,
  eligibleByFormat,
  exclusionHit,
  localLanguageBlocked,
  normalizeRole,
  parseSessionConstraints,
  publicReason,
  rowLanguageBlocked,
} from './judgment'
import type { LanguageConstraints } from './judgment'
import { llmComplete } from './llm'
import {
  ANALYSIS_SYSTEM,
  RANK_SYSTEM,
  buildAnchorAnalysisPrompt,
  buildRankingPrompt,
  normalizeAnalysis,
} from './prompts'
import type { AnchorLike, RankCandidateInput, RankPathInput, TrackAnalysis } from './prompts'
import { recallCandidates } from './recall'
import type { RecallAnchor, RecallCandidate } from './recall'
import { filterExcludeTracks } from './candidatePool'
import { sameSong } from './sameSong'

/** AI 配置（仅运行时传入，不落盘）。 */
export interface AiConfig {
  protocol?: RecommendLlmProtocol
  baseUrl?: string
  apiKey: string
  model: string
}

/**
 * 会话锚点（T-B2）：会话中途切歌后 replan 仍沿起点，不受当前播放曲目影响。
 * singer/name/id 供召回使用；缺省时 exploreOnce 取当前播放歌曲。
 */
export interface ExploreAnchor extends RecallAnchor {
  album?: string
}

/** exploreOnce 选项。 */
export interface ExploreOptions {
  /** 探索距离（0-100，越远越允许跑偏）。 */
  radius?: number
  /** 会话指令（“更冷一点”“不要华语”等）。 */
  instruction?: string
  /** 显式排除词。 */
  excludes?: string
  /** AI 配置；缺省或未提供 apiKey 时不做 LLM（分析/排序走本地回退）。 */
  ai?: AiConfig
  /** 会话锚点覆盖（T-B2 replan 用；缺省取当前播放歌曲）。 */
  anchor?: ExploreAnchor
  /** 复用起点分析（跳过分析步骤；T-B2 续补沿会话语义，也省一次 LLM 分析）。 */
  reuseAnalysis?: TrackAnalysis
  /** 队列追加模式：top=置顶（默认/首计划），bottom=追加队尾（续补）。 */
  appendMode?: 'top' | 'bottom'
  /** 已推荐过的候选 id（续补时避免重复入队）。 */
  excludeIds?: string[]
  /** 跨批次排除已推荐/已播曲目（artist/title，按 sameSong 防同曲不同 id 变体重复入队）。 */
  excludeTracks?: Array<{ artist?: string, title?: string }>
  /** 最近路径（已播/已计划，供 AI 排序提示词延续弧线）。 */
  recentPath?: RankPathInput[]
}

/** 对外返回的单条候选视图。 */
export interface ExploreItemView {
  /** 候选 id（用于会话路径/剩余统计）。 */
  id: string | null
  artist: string
  title: string
  album: string
  source: string
  reason: string
  journeyRole: string
  distance: number | null
  /** 可插入队列播放的完整音乐信息（与 addTempPlayList 同源；探索路径点击跳播用）。 */
  musicInfo?: LX.Music.MusicInfoOnline
}

/** exploreOnce 结果视图。 */
export interface ExploreResult {
  engine: 'ai' | 'local'
  anchor: { artist: string, title: string, album: string }
  /** 当前位置（你在这里：mm:ss）。 */
  position: string
  featureSheet: FeatureSheet
  analysis: { summary: string, aiUsed: boolean, error: string | null }
  /** 起点分析的完整结构（T-B2 会话续补时作为 reuseAnalysis 复用）。 */
  rawAnalysis: TrackAnalysis
  candidates: ExploreItemView[]
  meta: {
    sourceCounts: Record<string, number>
    recallError: string | null
    aiRankError: string | null
  }
}

// ============================ 会话与默认值 ============================

interface SessionState {
  stateWords: string
  excludes: string
  radius: number
}

const session: SessionState = {
  stateWords: '',
  excludes: '',
  radius: 35,
}

/** 更新会话上下文（多条命令共用同一轮探索边界）。 */
export const updateSession = (options: Partial<SessionState> = {}): void => {
  if (options.stateWords != null) session.stateWords = options.stateWords
  if (options.excludes != null) session.excludes = options.excludes
  if (options.radius != null) session.radius = options.radius
}

/** 清空会话与已采集的音频特征（调试入口 clearSession）。 */
export const clearSession = (): void => {
  session.stateWords = ''
  session.excludes = ''
  session.radius = 35
  getFeatureCollector().clear()
}

// ============================ LLM 调用与回退 ============================

const callAi = async(ai: AiConfig, system: string, user: string): Promise<string> => {
  const result = await llmComplete({
    protocol: ai.protocol,
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  if (!result?.content) throw new Error('LLM 返回空内容')
  return result.content
}

/** 无 AI 或 AI 分析失败时的兜底分析（保留起点形态，召回方向留空 → 走同艺人 + 本地池）。 */
const fallbackAnalysis = (anchor: AnchorLike): TrackAnalysis => {
  return normalizeAnalysis({
    summary: `${anchor.artist} — ${anchor.title}`,
    fingerprint: {
      vocal_identity: [],
      emotional_core: [],
      must_preserve: ['保持原曲主要演唱/器乐形态', '避免明显 tribute / karaoke 版本'],
      can_drift: [],
    },
    recall_directions: [],
  }, anchor)
}

// ============================ AI 排序重试 ============================

/**
 * AI 排序失败重试策略：真实 LLM 输出非确定性（偶发截断/格式漂移/网络抖动），
 * 失败一次即回退本地常导致可用但更好的 AI 排序被放弃；
 * 最多初始 1 次 + 重试 2 次（共 3 次调用），间隔 800/1600ms 指数退避。
 */
const AI_RANK_MAX_RETRY = 2
const AI_RANK_RETRY_DELAY_MS = 800

/** 延时（重试退避用；仓库无通用 sleep/delay 工具，本地实现）。 */
const sleep = async(ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ============================ AI 排序（from-here aiRank 语义） ============================

const clamp01 = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/**
 * 行级世界断裂守门（from-here rankingWorldBreak 语义）：
 * 近距（<=45）世界断裂或核心连续性过低直接拦；中距（<=65）两处以上才拦。
 */
const rankingWorldBreak = (row: unknown, radius: number): boolean => {
  const r = (row ?? {}) as Record<string, any>
  const breaks = Array.isArray(r.world_breaks) ? r.world_breaks.filter(Boolean) : []
  const c = r.continuity && typeof r.continuity === 'object' ? r.continuity as Record<string, unknown> : {}
  const core = ['vocal', 'timbre', 'instrumentation_texture', 'rhythm_motion']
    .map(k => clamp01(c[k]))
    .filter((v): v is number => v != null)
  const veryLow = core.filter(v => v < 0.34).length
  if (radius <= 45 && breaks.length > 0) return true
  if (radius <= 45 && veryLow > 0) return true
  if (radius <= 65 && breaks.length >= 2) return true
  if (radius <= 65 && veryLow >= 2) return true
  return false
}

/** AI 排序分批大小：候选最多 48 条，单次提示过长既拖慢生成也容易触发超时；分批让模型每次只判断最多 16 首。 */
const RANK_BATCH_SIZE = 16

/** LLM 排序：字段映射参照 from-here aiRank 的 enriched / aestheticReject 语义。 */
const aiRank = async(
  ai: AiConfig,
  pool: RecallCandidate[],
  anchor: AnchorLike,
  radius: number,
  stateWords: string,
  excludes: string,
  analysis: TrackAnalysis,
  constraints: LanguageConstraints,
  recentPath: RankPathInput[] = [],
): Promise<RecallCandidate[]> => {
  const eligible = pool.filter(t => eligibleByFormat(t, analysis, stateWords, excludes) && !exclusionHit(t, excludes))
  const candidates = eligible.slice(0, 48)
  if (!candidates.length) return []

  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints)].filter(Boolean).join('；')
  const recentPathInput = recentPath.length ? recentPath : undefined

  const picked: RecallCandidate[] = []
  const pickedIds = new Set<string>()
  // 分批排序：每批独立调用 LLM（批次内 candidate_id 仍从 0 编号、行级守门不变）；
  // score 是同一标尺（0-1），合并后按 score 全局排序再走弧线（批内 LLM 的 sequence 只做批内排序）。
  for (let start = 0; start < candidates.length; start += RANK_BATCH_SIZE) {
    const batch = candidates.slice(start, start + RANK_BATCH_SIZE)
    const content = await callAi(ai, RANK_SYSTEM, buildRankingPrompt({
      anchor,
      radius,
      instruction,
      analysis,
      candidates: batch as RankCandidateInput[],
      recentPath: recentPathInput,
    }))
    const parsed = parseLooseJson(content)
    const arr = extractRankingRows(parsed)
    if (!arr.length) throw new Error('AI Provider 未返回 ranking JSON 数组')
    const parsedObj = (parsed ?? {}) as { sequence?: unknown[] }
    const sequence = Array.isArray(parsedObj.sequence) ? parsedObj.sequence.map(Number).filter(Number.isFinite) : []
    const sequenceOrder = new Map(sequence.map((id, i) => [Number(id), i]))

    const rows = [...arr].sort((a, b) => {
      const aObj = (a ?? {}) as Record<string, unknown>
      const bObj = (b ?? {}) as Record<string, unknown>
      const ai = sequenceOrder.has(Number(aObj.candidate_id ?? aObj.i)) ? sequenceOrder.get(Number(aObj.candidate_id ?? aObj.i))! : 999
      const bi = sequenceOrder.has(Number(bObj.candidate_id ?? bObj.i)) ? sequenceOrder.get(Number(bObj.candidate_id ?? bObj.i))! : 999
      if (ai !== bi) return ai - bi
      return (Number(bObj.score) || 0) - (Number(aObj.score) || 0)
    })

    for (const x of rows) {
      const row = (x ?? {}) as Record<string, any>
      const idx = Number(row.candidate_id ?? row.i)
      const track = batch[idx]
      if (!track || pickedIds.has(String(track.encryptedId))) continue
      // 同曲不同 id 变体批内保险：多批次 merge 后仍可能残留同曲（候选池已按 sameSong 去重，
      // 此处兜底防 LLM 分批产物里不同 id 的同曲变体）。
      if (picked.some(it => sameSong(it, track))) continue
      if (rowLanguageBlocked(row, track, constraints)) continue
      if (!eligibleByFormat(track, analysis, stateWords, excludes) || exclusionHit(track, excludes)) continue
      if (rankingWorldBreak(row, radius)) continue
      const confidence = String(row.confidence || 'medium').toLowerCase()
      if (radius <= 45 && confidence === 'low') continue

      const label = String(row.distance_from_anchor || '').toLowerCase()
      const explicit = Number(row.perceptual_distance)
      let mapped: number | null = Number.isFinite(explicit) ? Math.max(0, Math.min(100, explicit)) : null
      if (mapped == null) mapped = label === 'near' ? 24 : label === 'medium' ? 50 : label === 'far' ? 76 : 50
      if (mapped > radius + 10 && radius <= 65) continue

      const enriched: RecallCandidate = {
        ...track,
        distance: mapped,
        reason: publicReason(String(row.reason ?? ''), '它接住了起点没有说完的那一部分'),
        journeyRole: String(row.journey_role || row.journeyRole || 'open').toLowerCase(),
        nextSongWorthiness: row.next_song_worthiness ?? row.nextSongWorthiness,
        meaningfulDifference: row.meaningful_difference ?? row.meaningfulDifference,
        surpriseValue: row.surprise_value ?? row.surpriseValue,
        obviousness: row.obviousness,
        clicheRisk: row.cliche_risk ?? row.clicheRisk,
        sequenceIndex: sequenceOrder.get(idx),
        aiScore: Number(row.score) || 0,
        continuity: row.continuity || {},
        worldBreaks: Array.isArray(row.world_breaks) ? row.world_breaks : [],
        confidence,
      }
      if (aestheticReject(enriched, radius)) continue
      picked.push(enriched)
      pickedIds.add(String(track.encryptedId))
    }
  }
  if (!picked.length) return []
  // 跨批合并为全局序列：score 同标尺，按降序排；相同 score 保持批内顺序（稳定排序）
  picked.sort((a, b) => (Number(b.aiScore) || 0) - (Number(a.aiScore) || 0))
  const arc = composeListeningArc(picked, anchor, radius, 8)
  return diversify(arc, anchor, 8) as RecallCandidate[]
}

// ============================ 本地回退排序（from-here localRank 语义简化） ============================

/**
 * 确定性本地排序：taste 弱偏好（liked+6/同艺人近距+8/semantic+10/playlist+2）、
 * 超半径过滤、T-B0 守门（eligibleByFormat/coarseWorldBreak/exclusionHit/localLanguageBlocked），
 * 最后经 composeListeningArc + diversify 收敛。
 */
const localRank = (
  pool: RecallCandidate[],
  anchor: AnchorLike,
  radius: number,
  stateWords: string,
  excludes: string,
  analysis: TrackAnalysis,
  constraints: LanguageConstraints,
): RecallCandidate[] => {
  const seenTracks: RecallCandidate[] = []
  const items = pool
    .filter(t => {
      if (exclusionHit(t, excludes)) return false
      if (localLanguageBlocked(t, constraints)) return false
      if (!eligibleByFormat(t, analysis, stateWords, excludes)) return false
      if (coarseWorldBreak(t, analysis, radius)) return false
      if (Number(t.distance) > Number(radius)) return false
      return true
    })
    .filter(t => {
      // 同曲不同 id 变体保险：候选池已按 sameSong 去重，此处兜底防不同批次混入的同曲变体。
      if (seenTracks.some(it => sameSong(it, t))) return false
      seenTracks.push(t)
      return true
    })
    .map((t, i) => {
      // liked/source==='liked' 加分：红心候选已在召回层（candidatePool 红心排除）硬排除，
      // 幸存候选仅剩 title 变体等边缘情形（如 (Live) 版本），分支保留供未来弱偏好排序复用。
      let score = 100 - Number(t.distance) * 0.7
      if (t.source === 'liked') score += 6
      else if (t.source === 'same-artist') score += 8
      else if (t.source === 'semantic-search') score += 10
      else if (t.source === 'playlist') score += 2
      if (t.liked) score += 3
      else if (t.recent) score += 1
      score += (i % 5) * 0.17
      return { ...t, aiScore: Math.max(0, Math.min(100, score)) }
    })
    .sort((a, b) => Number(b.aiScore) - Number(a.aiScore))
  if (!items.length) return []
  const arc = composeListeningArc(items, anchor, radius, 8)
  return diversify(arc, anchor, 8) as RecallCandidate[]
}

// ============================ exploreOnce ============================

/** 当前播放歌曲 → 特征事实单 →（可选 LLM 分析）→ 跨源召回 →（LLM 或本地）排序 → 守门 → 弧线 → 稍后播放。 */
export const exploreOnce = async(options: ExploreOptions = {}): Promise<ExploreResult> => {
  const playMusic = playMusicInfo.musicInfo
  const playAnchor = playMusic ? ('progress' in playMusic ? playMusic.metadata.musicInfo : playMusic) : null
  // T-B2：会话锚点覆盖优先（replan 沿起点继续）；缺省取当前播放歌曲（T-B1 行为不变）。
  const anchorInfo: any = options.anchor ?? playAnchor
  if (!anchorInfo) throw new Error('请先播放歌曲')

  const anchor: AnchorLike = {
    artist: anchorInfo.singer || anchorInfo.artist || '(未知艺人)',
    title: anchorInfo.name || anchorInfo.title || '(未知曲目)',
    album: anchorInfo.album ?? anchorInfo.meta?.albumName ?? '',
  }
  const recallAnchor: RecallAnchor = options.anchor
    ? { ...options.anchor }
    : {
        artist: anchor.artist,
        title: anchor.title,
        singer: anchorInfo.singer,
        name: anchorInfo.name,
        id: anchorInfo.id,
      }
  const radius = Math.max(1, Math.min(100, Number(options.radius ?? session.radius) || 35))
  const stateWords = options.instruction ?? session.stateWords
  const excludes = options.excludes ?? session.excludes

  const activeExcludes = effectiveExcludes(stateWords, excludes)
  const parsed = parseSessionConstraints(stateWords, activeExcludes)
  const constraints: LanguageConstraints = { excludedLanguages: parsed.excludedLanguages }

  // 1. 音频特征事实单（collector 已有桶摘要；空时即时采样一次）
  const collector = getFeatureCollector()
  let featureSheet = collector.summary()
  if (!featureSheet.valid || !collector.isStarted()) {
    featureSheet = await collector.sampleOnce()
  }

  // 2. 可选 LLM 分析（失败回退本地分析，不抛错；T-B2 续补时复用会话起步时的分析）
  let analysis: TrackAnalysis
  let aiUsed = false
  let aiAnalysisError: string | null = null
  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints)].filter(Boolean).join('；')
  if (options.reuseAnalysis) {
    analysis = options.reuseAnalysis
  } else if (options.ai?.apiKey) {
    try {
      // 特征事实单以“追加段”方式拼接在 T-B0 提示词之外，不改动 prompts.ts。
      const prompt = `${buildAnchorAnalysisPrompt({ anchor, radius, instruction })}\n\n音频特征事实单：\n${featureSheet.text}\n你在这里：${playProgress.nowPlayTimeStr}`
      const content = await callAi(options.ai, ANALYSIS_SYSTEM, prompt)
      analysis = normalizeAnalysis(parseLooseJson(content), anchor)
      aiUsed = true
    } catch (err) {
      aiAnalysisError = (err as Error).message
      console.warn('[AI analysis fallback]', aiAnalysisError)
      analysis = fallbackAnalysis(anchor)
    }
  } else {
    analysis = fallbackAnalysis(anchor)
  }

  // 3. 跨源召回（语义关键词 + 同艺人 + 本地收藏歌单；「我喜欢」仅用于红心排除与计数展示）
  const recall = await recallCandidates(recallAnchor, analysis, radius, {
    excludedLanguages: constraints.excludedLanguages,
  })
  // T-B2：续补时排除本会话已推荐过的候选，避免重复入队（按 id 与 sameSong 双通道，
  // 防同曲不同 id 变体跨批次重复）。
  const pool = filterExcludeTracks(recall.items, options.excludeIds ?? [], options.excludeTracks ?? [])
  if (!pool.length) {
    throw new Error(constraints.excludedLanguages?.length
      ? '当前硬约束下没有找到可用候选。不会退回被你排除的音乐来凑数，请稍后重试。'
      : '这次没有找到能加入播放队列的后续歌曲，请稍后重试，或把探索距离稍微打开一点。')
  }

  // 4. 排序：LLM 优先（抛错时自动重试，全部失败才回退本地），AI 未配置直接本地
  let ranked: RecallCandidate[] = []
  let engine: 'ai' | 'local' = 'local'
  let aiRankError: string | null = null
  if (options.ai?.apiKey) {
    for (let attempt = 0; ; attempt++) {
      try {
        const aiRanked = await aiRank(options.ai, pool, anchor, radius, stateWords, activeExcludes, analysis, constraints, options.recentPath)
        if (aiRanked.length) {
          ranked = aiRanked
          engine = 'ai'
          break
        }
        // 返回空数组而未抛错（多半是守门全部过滤），重试无意义，直接回退本地
        break
      } catch (err) {
        aiRankError = (err as Error).message
        const retry = attempt < AI_RANK_MAX_RETRY
        console.warn('[AI rank fallback]', aiRankError, retry ? `，重试中(${attempt + 1}/${AI_RANK_MAX_RETRY})` : '')
        if (!retry) break
        await sleep(AI_RANK_RETRY_DELAY_MS * (attempt + 1))
      }
    }
  }
  if (!ranked.length) {
    ranked = localRank(pool, anchor, radius, stateWords, activeExcludes, analysis, constraints)
  }
  if (!ranked.length) {
    throw new Error(constraints.excludedLanguages?.length
      ? '当前硬约束下没有足够可靠的后续歌曲，不会用不符合要求的歌凑数；可以换一种描述或稍后重试。'
      : '候选全部被当前边界过滤掉了，可以把距离稍微打开一点。')
  }

  // 5. 插入“稍后播放”队列（T-B2：续补模式追加队尾，不重排已计划的路径）
  addTempPlayList(ranked.map(t => ({
    listId: LIST_IDS.PLAY_LATER,
    musicInfo: t.musicInfo,
    isTop: options.appendMode !== 'bottom',
  })))

  // 6. 返回视图
  return {
    engine,
    anchor: { artist: anchor.artist, title: anchor.title, album: anchor.album ?? '' },
    position: playProgress.nowPlayTimeStr,
    featureSheet,
    analysis: { summary: analysis.summary, aiUsed, error: aiAnalysisError },
    rawAnalysis: analysis,
    candidates: ranked.map((t: RecallCandidate) => ({
      id: t.encryptedId ?? null,
      artist: t.artist ?? '',
      title: t.title ?? '',
      album: t.album ?? '',
      source: t.source ?? '',
      reason: publicReason(String(t.reason ?? ''), '和起点仍有清楚的听感连续性'),
      journeyRole: normalizeRole(t.journeyRole),
      distance: Number.isFinite(Number(t.distance)) ? Number(t.distance) : null,
      // 探索召回均为在线候选（SearchResult/列表条目），此处只透传给视图；类型收窄为在线条目
      musicInfo: t.musicInfo as LX.Music.MusicInfoOnline,
    })),
    meta: {
      sourceCounts: recall.meta.sourceCounts,
      recallError: recall.meta.error,
      aiRankError,
    },
  }
}

// ============================ dev 调试入口 ============================

/** 暴露 console 调试入口（仅非生产环境；无正式 UI；API Key 只接受运行时通过 explore 的 options.ai 传入）。 */
export const registerDevHook = (): void => {
  if (typeof window === 'undefined' || window.lx?.isProd) return
  ;(window as unknown as Record<string, unknown>).__lxRecommend = {
    explore: exploreOnce,
    startCollect: startFeatureCollection,
    stopCollect: stopFeatureCollection,
    clearSession,
  }
}

// 与仓库既有判定一致（globalData.ts：isProd = process.env.NODE_ENV == 'production'）；
// T-B2 的 UI 将直接 import 本模块的 exploreOnce 等导出，不受该门控影响。
if (typeof window !== 'undefined' && !window.lx?.isProd) registerDevHook()
