/**
 * 推荐引擎编排：exploreOnce 一条龙（实时特征 → 可选 LLM 分析 → 跨源召回 → 排序 → 守门 → 弧线 → 稍后播放）。
 *
 * 语义移植自 from-here（MIT）bridge/server.js 的 buildSession/planBatch/aiRank/localRank 流程，
 * 复用 T-B0 的守门/编排纯函数；T-B0 文件（judgment.ts/prompts.ts）保持只读复用。
 * 依赖 electron/IPC/音乐 SDK/播放器插件的部分无法在 vitest 中单测（见测试报告）。
 */

import { LIST_IDS } from '@common/constants'
import { addTempPlayList } from '@renderer/store/player/action'
import { playProgress } from '@renderer/store/player/playProgress'
import { playMusicInfo } from '@renderer/store/player/state'
import { getFeatureCollector, startFeatureCollection, stopFeatureCollection } from './feature'
import type { FeatureSheet } from './feature'
import { parseLooseJson } from './json'
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
import type { LanguageConstraints, TrackLike } from './judgment'
import { llmComplete } from './llm'
import {
  ANALYSIS_SYSTEM,
  RANK_SYSTEM,
  buildAnchorAnalysisPrompt,
  buildRankingPrompt,
  normalizeAnalysis,
} from './prompts'
import type { AnchorLike, RankCandidateInput, TrackAnalysis } from './prompts'
import { recallCandidates } from './recall'
import type { RecallAnchor, RecallCandidate } from './recall'

/** AI 配置（仅运行时传入，不落盘）。 */
export interface AiConfig {
  protocol?: string
  baseUrl?: string
  apiKey: string
  model: string
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
}

/** 对外返回的单条候选视图。 */
export interface ExploreItemView {
  artist: string
  title: string
  album: string
  source: string
  reason: string
  journeyRole: string
  distance: number | null
}

/** exploreOnce 结果视图。 */
export interface ExploreResult {
  engine: 'ai' | 'local'
  anchor: { artist: string, title: string, album: string }
  /** 当前位置（你在这里：mm:ss）。 */
  position: string
  featureSheet: FeatureSheet
  analysis: { summary: string, aiUsed: boolean, error: string | null }
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
): Promise<RecallCandidate[]> => {
  const eligible = pool.filter(t => eligibleByFormat(t, analysis, stateWords, excludes) && !exclusionHit(t, excludes))
  const candidates = eligible.slice(0, 48)
  if (!candidates.length) return []

  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints)].filter(Boolean).join('；')
  const prompt = buildRankingPrompt({
    anchor,
    radius,
    instruction,
    analysis,
    candidates: candidates as RankCandidateInput[],
  })
  const content = await callAi(ai, RANK_SYSTEM, prompt)
  const parsed = parseLooseJson(content)
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray((parsed as { ranking?: unknown[] })?.ranking) ? (parsed as { ranking: unknown[] }).ranking : [])
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

  const picked: RecallCandidate[] = []
  const pickedIds = new Set<string>()
  for (const x of rows) {
    const row = (x ?? {}) as Record<string, any>
    const idx = Number(row.candidate_id ?? row.i)
    const track = candidates[idx]
    if (!track || pickedIds.has(String(track.encryptedId))) continue
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
  if (!picked.length) return []
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
  const items = pool
    .filter(t => {
      if (exclusionHit(t, excludes)) return false
      if (localLanguageBlocked(t, constraints)) return false
      if (!eligibleByFormat(t, analysis, stateWords, excludes)) return false
      if (coarseWorldBreak(t, analysis, radius)) return false
      if (Number(t.distance) > Number(radius)) return false
      return true
    })
    .map((t, i) => {
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
  if (!playMusic) throw new Error('请先播放歌曲')

  const anchorInfo = 'progress' in playMusic ? playMusic.metadata.musicInfo : playMusic
  const anchor: AnchorLike = {
    artist: anchorInfo.singer || '(未知艺人)',
    title: anchorInfo.name || '(未知曲目)',
    album: anchorInfo.meta?.albumName ?? '',
  }
  const recallAnchor: RecallAnchor = {
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

  // 2. 可选 LLM 分析（失败回退本地分析，不抛错）
  let analysis: TrackAnalysis
  let aiUsed = false
  let aiAnalysisError: string | null = null
  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints)].filter(Boolean).join('；')
  if (options.ai?.apiKey) {
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

  // 3. 跨源召回（语义关键词 + 同艺人 + 本地我喜欢/收藏歌单）
  const recall = await recallCandidates(recallAnchor, analysis, radius, {
    stateWords,
    excludes: activeExcludes,
    excludedLanguages: constraints.excludedLanguages,
  })
  const pool = recall.items
  if (!pool.length) {
    throw new Error(constraints.excludedLanguages?.length
      ? '当前硬约束下没有找到可用候选。不会退回被你排除的音乐来凑数，请稍后重试。'
      : '这次没有找到能加入播放队列的后续歌曲，请稍后重试，或把探索距离稍微打开一点。')
  }

  // 4. 排序：LLM 优先（失败回退本地），AI 未配置直接本地
  let ranked: RecallCandidate[] = []
  let engine: 'ai' | 'local' = 'local'
  let aiRankError: string | null = null
  if (options.ai?.apiKey) {
    try {
      const aiRanked = await aiRank(options.ai, pool, anchor, radius, stateWords, activeExcludes, analysis, constraints)
      if (aiRanked.length) {
        ranked = aiRanked
        engine = 'ai'
      }
    } catch (err) {
      aiRankError = (err as Error).message
      console.warn('[AI rank fallback]', aiRankError)
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

  // 5. 插入“稍后播放”队列（首批置顶）
  addTempPlayList(ranked.map(t => ({
    listId: LIST_IDS.PLAY_LATER,
    musicInfo: t.musicInfo,
    isTop: true,
  })))

  // 6. 返回视图
  return {
    engine,
    anchor: { artist: anchor.artist, title: anchor.title, album: anchor.album ?? '' },
    position: playProgress.nowPlayTimeStr,
    featureSheet,
    analysis: { summary: analysis.summary, aiUsed, error: aiAnalysisError },
    candidates: ranked.map((t: TrackLike) => ({
      artist: t.artist ?? '',
      title: t.title ?? '',
      album: t.album ?? '',
      source: t.source ?? '',
      reason: publicReason(String(t.reason ?? ''), '和起点仍有清楚的听感连续性'),
      journeyRole: normalizeRole(t.journeyRole),
      distance: Number.isFinite(Number(t.distance)) ? Number(t.distance) : null,
    })),
    meta: {
      sourceCounts: recall.meta.sourceCounts,
      recallError: recall.meta.error,
      aiRankError,
    },
  }
}

// ============================ dev 调试入口 ============================

/** 暴露 console 调试入口（无正式 UI；API Key 只接受运行时通过 explore 的 options.ai 传入）。 */
export const registerDevHook = (): void => {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__lxRecommend = {
    explore: exploreOnce,
    startCollect: startFeatureCollection,
    stopCollect: stopFeatureCollection,
    clearSession,
  }
}

registerDevHook()
