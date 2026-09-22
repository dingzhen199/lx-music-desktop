/**
 * 推荐引擎编排：exploreOnce 一条龙（实时特征 → 可选 LLM 分析 → 跨源召回 → 排序 → 守门 → 弧线 → 稍后播放）。
 *
 * 语义移植自 from-here（MIT）bridge/server.js 的 buildSession/planBatch/aiRank/localRank 流程，
 * 复用守门/编排纯函数，提示词按固定规则与动态上下文分层。
 * engine.test.ts 对 IPC/SDK 边界做 mock，覆盖分批并行、重试、取消与入队。
 */

import { LIST_IDS } from '@common/constants'
import type { RecommendLlmProtocol } from '@common/recommendation'
import { addTempPlayList } from '@renderer/store/player/action'
import { hasDislike } from '@renderer/store/dislikeList/action'
import { playProgress } from '@renderer/store/player/playProgress'
import { playMusicInfo } from '@renderer/store/player/state'
import { getFeatureCollector, startFeatureCollection, stopFeatureCollection, summarizeBuckets } from './feature'
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
import { llmCompleteWithValidation } from './llm'
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
import { normalizeConfidence, shouldBlockLowConfidence } from './confidenceGate'
import { emptyResultMessage } from './hints'
import { includesSameSong, pushUniqueSameSong, sameSong } from './sameSong'
import type { SongRef } from './sameSong'
import { passesInstrumentalGate, wantsInstrumental } from './vocalGate'
import { filterForSubmission } from './submission'

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
  /** 会话先校验代际再提交队列，防过期计划污染播放。调试入口默认仍直接入队。 */
  enqueue?: boolean
  isCancelled?: () => boolean
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
  /** 复用起点分析（跳过分析步骤；T-B2 续补沿会话语义，也省一次 LLM 分析）。
   * 作废语义（D3）：一句话约束变更后调用方不再传本选项，引擎本次自动重新分析（召回方向随新约束换道）。 */
  reuseAnalysis?: TrackAnalysis
  /** 队列追加模式：bottom=追加队尾（会话路径一律传此值，D6 队尾统一）；
   * top=置顶仅为默认缺省，保留给 dev 钩子直调 exploreOnce 的无会话手动探索（插队试听旧行为，不参与会话流程）。 */
  appendMode?: 'top' | 'bottom'
  /** 已推荐过的候选 id（续补时避免重复入队）。 */
  excludeIds?: string[]
  /** 跨批次排除已推荐/已播曲目（artist/title，按 sameSong 防同曲不同 id 变体重复入队）。 */
  excludeTracks?: SongRef[]
  /** 最近路径（已播/已计划，供 AI 排序提示词延续弧线）。 */
  recentPath?: RankPathInput[]
  /** 本地用户画像的艺人排序加成（TP-4/D3）：localRank 打分叠加后照常 clamp 到 [0,100]；缺省不加。 */
  profileBoost?: (artist: string) => number
  /** 用户长期画像摘要（TP-4/D6 独立通道）：仅在 aiRank 内拼入排序提示词文本；
   * 绝不进入 stateWords/instruction（它们会被 effectiveExcludes/parseSessionConstraints/wantsInstrumental 等
   * 机器解析面消费，摘要散文里的体裁词会翻转器乐硬门等守门行为，B7-R3）；无摘要不传。 */
  profileSummary?: string
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
  alternativeMusicInfos?: LX.Music.MusicInfoOnline[]
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

const callAi = async<T>(ai: AiConfig, system: string, user: string, validate: (content: string) => T, isCancelled?: () => boolean): Promise<T> => {
  // 固定规则放入 system，动态上下文在后；分析与排序共用同一审美前缀。
  const marker = '\n\n本轮上下文：\n'
  const split = user.indexOf(marker)
  return llmCompleteWithValidation({
    protocol: ai.protocol,
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    messages: [
      { role: 'system', content: split < 0 ? system : `${system}\n\n${user.slice(0, split)}` },
      { role: 'user', content: split < 0 ? user : user.slice(split + marker.length) },
    ],
  }, result => validate(result.content), { isCancelled })
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
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/** 仅接受真实的批内整数编号；null/空串/布尔值不能隐式映射成第 0 首。 */
const candidateIndex = (value: unknown, length: number): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < length ? index : null
}

/**
 * 行级世界断裂守门（from-here rankingWorldBreak 语义）：
 * 近距（<=45）世界断裂或核心连续性过低直接拦；中距（<=65）两处以上才拦。
 */
const rankingWorldBreak = (row: unknown, radius: number, stateWords: string): boolean => {
  const r = (row ?? {}) as Record<string, any>
  const breaks = Array.isArray(r.world_breaks) ? r.world_breaks.filter(Boolean) : []
  const c = r.continuity && typeof r.continuity === 'object' ? r.continuity as Record<string, unknown> : {}
  const core = ['vocal', 'timbre', 'instrumentation_texture', 'rhythm_motion']
    .filter(k => k !== 'vocal' || !wantsInstrumental(stateWords))
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

/**
 * LLM 行级距离标签 → 感知距离分（0-100）映射；标签未知/缺失时按中线 50。
 * 与召回侧 gates.SEMANTIC_DISTANCE_*（按查询序号分配距程）语义不同，数值相近纯属巧合，勿共用常量。
 */
const DISTANCE_LABEL_SCORE: Record<string, number> = { near: 24, medium: 50, far: 76 }

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
  profileSummary?: string,
  isCancelled?: () => boolean,
): Promise<{ items: RecallCandidate[], fallbackPool: RecallCandidate[], error: string | null }> => {
  const eligible = pool.filter(t => eligibleByFormat(t, analysis, stateWords, excludes) && !exclusionHit(t, excludes))
  const candidates = eligible.slice(0, 48)
  if (!candidates.length) return { items: [], fallbackPool: [], error: null }

  // 画像摘要独立通道（TP-4/D6/B7-R3）：摘要仅作提示词文本拼进本 instruction（只喂 LLM 语义消费的
  // buildRankingPrompt），绝不并入 stateWords/excludes——后者会进入 effectiveExcludes/parseSessionConstraints/
  // wantsInstrumental/transformationAllowed 等机器解析面，摘要散文里的体裁词（如“器乐/轻音乐”）会翻转器乐硬门
  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints), profileSummary ? `用户长期画像：${profileSummary}` : ''].filter(Boolean).join('；')
  const recentPathInput = recentPath.length ? recentPath : undefined

  const picked: RecallCandidate[] = []
  const pickedIds = new Set<string>()
  // 独立批次并行；重试只作用于失败批次，成功结果按原始批次顺序合并。
  const batches: RecallCandidate[][] = []
  for (let start = 0; start < candidates.length; start += RANK_BATCH_SIZE) {
    batches.push(candidates.slice(start, start + RANK_BATCH_SIZE))
  }
  const results = await Promise.allSettled(batches.map(async(batch) => {
    return callAi(ai, RANK_SYSTEM, buildRankingPrompt({
      anchor,
      radius,
      instruction,
      analysis,
      candidates: batch as RankCandidateInput[],
      recentPath: recentPathInput,
    }), content => {
      const parsed = parseLooseJson(content)
      const rows = extractRankingRows(parsed)
      // 空 ranking 是有效的“全部不合格”，不能当作请求失败后再用本地结果绕过守门。
      const ranking = (parsed as { ranking?: unknown } | null)?.ranking
      const emptyRanking = Array.isArray(ranking) && ranking.length === 0
      const arr = rows.filter(x => {
        const row = x as Record<string, unknown>
        return candidateIndex(row.candidate_id ?? row.i, batch.length) != null
      })
      if (!arr.length && !emptyRanking) throw new Error('AI Provider 未返回含有效 candidate_id 的 ranking JSON 数组')
      return { parsed, arr }
    }, isCancelled)
  }))
  const errors: string[] = []
  const fallbackPool: RecallCandidate[] = []
  for (const [batchIndex, result] of results.entries()) {
    if (result.status === 'rejected') {
      errors.push(String((result.reason as Error)?.message ?? result.reason))
      fallbackPool.push(...batches[batchIndex])
      continue
    }
    const batch = batches[batchIndex]
    const { parsed, arr } = result.value
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
      if (includesSameSong(picked, track)) continue
      if (rowLanguageBlocked(row, track, constraints)) continue
      if (!eligibleByFormat(track, analysis, stateWords, excludes) || exclusionHit(track, excludes)) continue
      if (rankingWorldBreak(row, radius, stateWords)) continue
      // 归一口径已收口 confidenceGate：本变量同时供守门判定与下方候选透传，二者共用同一归一值
      const confidence = normalizeConfidence(row.confidence)
      if (shouldBlockLowConfidence(confidence)) continue

      const label = String(row.distance_from_anchor || '').toLowerCase()
      const rawDistance = row.perceptual_distance
      const explicit = typeof rawDistance === 'number' || (typeof rawDistance === 'string' && rawDistance.trim()) ? Number(rawDistance) : NaN
      let mapped: number | null = Number.isFinite(explicit) ? Math.max(0, Math.min(100, explicit)) : null
      if (mapped == null) mapped = DISTANCE_LABEL_SCORE[label] ?? 50
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
        vocalType: row.vocal_type === 'instrumental' || row.vocal_type === 'vocal' ? row.vocal_type : 'unknown',
      }
      if (aestheticReject(enriched, radius)) continue
      if (!passesInstrumentalGate(enriched, stateWords, enriched.continuity)) continue
      picked.push(enriched)
      pickedIds.add(String(track.encryptedId))
    }
  }
  if (!picked.length) return { items: [], fallbackPool, error: errors.join('; ') || null }
  // 跨批合并为全局序列：score 同标尺，按降序排；相同 score 保持批内顺序（稳定排序）
  picked.sort((a, b) => (Number(b.aiScore) || 0) - (Number(a.aiScore) || 0))
  const arc = composeListeningArc(picked, anchor, radius, 8)
  return { items: diversify(arc, anchor, 8, radius) as RecallCandidate[], fallbackPool, error: errors.join('; ') || null }
}

// ============================ 本地回退排序（from-here localRank 语义简化） ============================

/**
 * 确定性本地排序：taste 弱偏好（同艺人+8/semantic+10/playlist+2、最近播放+1）、
 * 超半径过滤、T-B0 守门（eligibleByFormat/coarseWorldBreak/exclusionHit/localLanguageBlocked），
 * 最后经 composeListeningArc + diversify 收敛。
 * 无红心加分：红心歌已在候选池（candidatePool 红心排除）硬排除，候选侧 liked 恒 false。
 */
const localRank = (
  pool: RecallCandidate[],
  anchor: AnchorLike,
  radius: number,
  stateWords: string,
  excludes: string,
  analysis: TrackAnalysis,
  constraints: LanguageConstraints,
  profileBoost?: (artist: string) => number,
): RecallCandidate[] => {
  const seenTracks: RecallCandidate[] = []
  const items = pool
    .filter(t => {
      if (exclusionHit(t, excludes)) return false
      if (localLanguageBlocked(t, constraints)) return false
      if (!eligibleByFormat(t, analysis, stateWords, excludes)) return false
      if (coarseWorldBreak(t, analysis, radius, stateWords)) return false
      if (Number(t.distance) > Number(radius)) return false
      if (!passesInstrumentalGate(t, stateWords, t.continuity)) return false
      return true
    })
    // 同曲不同 id 变体保险：候选池已按 sameSong 去重，此处兜底防不同批次混入的同曲变体。
    .filter(t => pushUniqueSameSong(seenTracks, t))
    .map((t, i) => {
      // 基础分 + 来源弱偏好 + 最近播放微调；红心歌已在候选池硬排除，此排序无红心加分。
      let score = 100 - Number(t.distance) * 0.7
      if (t.source === 'same-artist') score += 8
      else if (t.source === 'semantic-search') score += 10
      else if (t.source === 'playlist') score += 2
      if (t.recent) score += 1
      score += (i % 5) * 0.17
      // 用户画像艺人加成（TP-4/D3）：在既有 clamp 之前叠加，clamp [0,100] 不变式由下行 Math.min/max 保持
      if (profileBoost) score += profileBoost(t.artist ?? '')
      return { ...t, aiScore: Math.max(0, Math.min(100, score)) }
    })
    .sort((a, b) => Number(b.aiScore) - Number(a.aiScore))
  if (!items.length) return []
  const arc = composeListeningArc(items, anchor, radius, 8)
  return diversify(arc, anchor, 8, radius) as RecallCandidate[]
}

// ============================ exploreOnce ============================

/** 当前播放歌曲 → 特征事实单 →（可选 LLM 分析）→ 跨源召回 →（LLM 或本地）排序 → 守门 → 弧线 → 稍后播放。 */
export const exploreOnce = async(options: ExploreOptions = {}): Promise<ExploreResult> => {
  const checkCancelled = (): void => {
    if (options.isCancelled?.()) throw new Error('推荐计划已取消')
  }
  checkCancelled()
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

  // 1. 特征只能归属当前播放的起点；续补可能已在播放路径上的另一首歌。
  const anchorIsPlaying = (): boolean => {
    const play = playMusicInfo.musicInfo
    const info = play && ('progress' in play ? play.metadata.musicInfo : play)
    if (!info) return false
    return recallAnchor.id != null
      ? info.id === recallAnchor.id
      : sameSong(anchor, { artist: info.singer, title: info.name })
  }
  let featureSheet = summarizeBuckets([])
  let position = ''
  if (anchorIsPlaying()) {
    const collector = getFeatureCollector()
    featureSheet = collector.summary()
    if (!featureSheet.valid || !collector.isStarted()) featureSheet = await collector.sampleOnce()
    // sampleOnce 中有动态 import，等待期间可能切歌，不能把新歌数据标成旧起点的事实。
    if (anchorIsPlaying()) position = playProgress.nowPlayTimeStr
    else featureSheet = summarizeBuckets([])
  }

  checkCancelled()

  // 2. 可选 LLM 分析（失败回退本地分析，不抛错；T-B2 续补时复用会话起步时的分析）
  let analysis: TrackAnalysis
  let aiUsed = false
  let aiAnalysisError: string | null = null
  const instruction = [stateWords, excludes ? `不要：${excludes}` : '', constraintPrompt(constraints)].filter(Boolean).join('；')
  if (options.reuseAnalysis) {
    analysis = options.reuseAnalysis
  } else if (options.ai?.apiKey) {
    try {
      // 特征事实单放在动态上下文末尾，固定规则前缀不受采样变化影响。
      const prompt = `${buildAnchorAnalysisPrompt({ anchor, radius, instruction })}\n\n音频特征事实单：\n${featureSheet.text}\n起点采样位置：${position || 'unknown（起点当前未播放）'}`
      analysis = await callAi(options.ai, ANALYSIS_SYSTEM, prompt, content => {
        const parsed = parseLooseJson(content)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !['fingerprint', 'traits', 'recall_directions', 'searches', 'summary'].some(key => key in parsed)) {
          throw new Error('AI Provider 未返回有效分析 JSON')
        }
        return normalizeAnalysis(parsed, anchor)
      }, options.isCancelled)
      aiUsed = true
    } catch (err) {
      aiAnalysisError = (err as Error).message
      console.warn('[AI analysis fallback]', aiAnalysisError)
      analysis = fallbackAnalysis(anchor)
    }
  } else {
    analysis = fallbackAnalysis(anchor)
  }

  checkCancelled()

  // 3. 跨源召回（语义关键词 + 同艺人 + 本地收藏歌单；「我喜欢」仅用于红心排除）
  const recall = await recallCandidates(recallAnchor, analysis, radius, {
    excludedLanguages: constraints.excludedLanguages,
  })
  // T-B2：续补时排除本会话已推荐过的候选，避免重复入队（按 id 与 sameSong 双通道，
  // 防同曲不同 id 变体跨批次重复）。
  const pool = filterExcludeTracks(recall.items, options.excludeIds ?? [], options.excludeTracks ?? [])
    .filter(item => !hasDislike(item.musicInfo))
  if (!pool.length) {
    throw new Error(emptyResultMessage({
      wantsInstrumental: wantsInstrumental(stateWords),
      excludedLanguages: constraints.excludedLanguages,
      stage: 'pool',
    }))
  }

  // 4. 排序：LLM 优先；无合格 AI 结果时只对请求失败的批次本地回退，成功淘汰的候选不复活。
  let ranked: RecallCandidate[] = []
  let engine: 'ai' | 'local' = 'local'
  let aiRankError: string | null = null
  let fallbackPool = pool
  checkCancelled()
  if (options.ai?.apiKey) {
    const result = await aiRank(options.ai, pool, anchor, radius, stateWords, activeExcludes, analysis, constraints, options.recentPath, options.profileSummary, options.isCancelled)
    ranked = result.items
    aiRankError = result.error
    fallbackPool = result.fallbackPool
    if (ranked.length) engine = 'ai'
  }
  checkCancelled()
  if (!ranked.length) {
    ranked = localRank(fallbackPool, anchor, radius, stateWords, activeExcludes, analysis, constraints, options.profileBoost)
  }
  if (!ranked.length) {
    // 文案优先级：器乐诉求 → 语言硬约束 → 通用（hints.emptyResultMessage，两级空结果共用）
    throw new Error(emptyResultMessage({
      wantsInstrumental: wantsInstrumental(stateWords),
      excludedLanguages: constraints.excludedLanguages,
      stage: 'ranked',
    }))
  }

  let result: ExploreResult = {
    engine,
    anchor: { artist: anchor.artist, title: anchor.title, album: anchor.album ?? '' },
    position,
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
  checkCancelled()
  if (options.enqueue !== false) {
    result = await filterForSubmission(result, { isCancelled: options.isCancelled })
    const items = result.candidates.flatMap(item => item.musicInfo ? [{
      listId: LIST_IDS.PLAY_LATER,
      musicInfo: item.musicInfo,
      isTop: options.appendMode !== 'bottom',
    }] : [])
    if (items.length) addTempPlayList(items)
  }
  return result
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
    // TT-4（D9/AC7）：只读本地指标快照。透传 data.ts 读档通道，本函数不做归并/计数逻辑；
    // 动态 import 避免 engine→data 的顶层加载边，快照形状见 session-core.MetricsState
    metrics: async() => (await import('@renderer/utils/data')).getRecommendMetrics(),
  }
}

// 与仓库既有判定一致（globalData.ts：isProd = process.env.NODE_ENV == 'production'）；
// T-B2 的 UI 将直接 import 本模块的 exploreOnce 等导出，不受该门控影响。
if (typeof window !== 'undefined' && !window.lx?.isProd) registerDevHook()
