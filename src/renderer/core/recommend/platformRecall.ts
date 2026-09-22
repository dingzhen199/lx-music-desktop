/**
 * 平台相似召回编排（平台相似推荐 4.1–4.6 的运行时适配层）。
 *
 * 职责：
 * - 统一适配器边界：每个平台独立「种子定位 → 相似调用 → 归一化」，可区分
 *   成功/空结果/无匹配/限流或失败/已取消；单源失败不影响其他源（Promise.allSettled 语义）；
 * - 种子定位：优先使用起点已有的原生平台标识；其他来源按歌手+歌名搜索后经 seedMatch 严格匹配，
 *   找不到可靠匹配跳过该平台，不取搜索第一条充数；
 * - 有限超时 + 单层重试（仅相似调用重试一次；种子搜索复用 SDK 既有内部重试，本层不叠加）；
 * - 缓存：按平台+种子 id 读取/写入归一化结果；失败/限流/取消不写缓存；
 * - 融合与过滤：similarFusion 确定性合并排名 → 排除（起点/会话已消费/当前队列/红心/不再推荐）
 *   → 艺人多样性 → 画像有界调整；输出可区分的整体状态
 *   （ok / all-failed / no-match / empty / empty-after-filter / exhausted）。
 * 纯逻辑（种子匹配/融合/缓存）在 seedMatch/similarFusion/similarCache（vitest 覆盖）；
 * 本模块依赖 musicSdk 边界，由 platformRecall.test.ts mock 验证。
 */

import { SIMILAR_REQUEST_TIMEOUT_MS, SIMILAR_SEED_SEARCH_TIMEOUT_MS } from '@common/recommendationConfig'
import { toNewMusicInfo } from '@renderer/utils'
import musicSdk from '@renderer/utils/musicSdk'
import { sameSong } from './sameSong'
import type { SongRef } from './sameSong'
import { parseIntervalSec, matchSeed } from './seedMatch'
import { applyArtistDiversity, applyProfileAdjustment, fuseSimilarCandidates, PROVIDER_ORDER } from './similarFusion'
import type { FusedCandidate, ProviderBatch, SimilarProviderId } from './similarFusion'
import { SimilarCandidateCache } from './similarCache'
import type { CachedSimilarItem } from './similarCache'

/** 平台相似召回的起点（携带原生平台标识，避免解析全局 id 字符串猜测平台字段）。 */
export interface PlatformRecallAnchor {
  artist: string
  title: string
  album?: string | null
  /** 起点时长（秒；未知为 null）。 */
  intervalSec?: number | null
  /** 起点歌曲 id（排除起点自身用）。 */
  id?: string | null
  /** 起点音乐来源（'wy' | 'tx' | 其他）。 */
  source?: string | null
  /** 起点在各平台的原生歌曲 id（当前歌曲来自该平台时可直接使用，免搜索定位）。 */
  seedIds?: { wy?: string, tx?: string } | null
}

/** 单平台调用状态（4.2 可区分状态；当前 SDK 信号不区分限流/需登录，统一落 error 并带原始信息）。 */
export type ProviderCallStatus = 'success' | 'empty' | 'no-match' | 'error' | 'cancelled'

/** 单平台调用结果。 */
export interface ProviderCallResult {
  provider: SimilarProviderId
  status: ProviderCallStatus
  /** 定位到的种子原生 id（未定位为 null）。 */
  seedId: string | null
  /** 是否命中缓存（未发网络请求）。 */
  fromCache: boolean
  items: CachedSimilarItem[]
  error?: string
}

/** 整体召回状态（全部失败/无匹配/空结果/过滤完/用尽 可区分）。 */
export type PlatformRecallState = 'ok' | 'all-failed' | 'no-match' | 'empty' | 'empty-after-filter' | 'exhausted' | 'cancelled'

/** 召回选项。 */
export interface PlatformRecallOptions {
  isCancelled?: () => boolean
  /** 会话已推荐/已消费的候选 id（同 id 通道）。 */
  excludeIds?: string[]
  /** 会话已推荐/已消费的曲目（同曲通道，防同曲不同 id 变体）。 */
  excludeTracks?: SongRef[]
  /** 当前稍后播放队列中的曲目（避免重复插入用户手动排队的内容）。 */
  queueTracks?: SongRef[]
  /** 红心歌（保持现有发现新歌语义，硬排除）。 */
  lovedTracks?: SongRef[]
  /** 明确「不再推荐」的曲目。 */
  dislikedTracks?: SongRef[]
  /** 应用级屏蔽规则；在多样性与批次裁剪前执行，屏蔽项不占配额。 */
  isExcluded?: (musicInfo: LX.Music.MusicInfo) => boolean
  /** 本地画像艺人加成（有界次级调整）。 */
  profileBoost?: (artist: string) => number
  /** 单批最多入队数（默认 8）。 */
  maxItems?: number
  /** 缓存实例（默认模块级单例；测试可注入）。 */
  cache?: SimilarCandidateCache
}

/** 召回结果。 */
export interface PlatformRecallResult {
  state: PlatformRecallState
  items: FusedCandidate[]
  providers: Array<Pick<ProviderCallResult, 'provider' | 'status' | 'seedId' | 'fromCache'>>
  error: string | null
}

/** 模块级缓存单例（TTL/容量由 recommendationConfig 集中配置）。 */
const similarCache = new SimilarCandidateCache()

/** 可取消 Promise：平台 SDK 适配器将底层 httpFetch.cancelHttp 暴露到此边界。 */
type CancellablePromise<T> = Promise<T> & {
  cancel?: () => void
  cancelHttp?: () => void
}

const cancelRequest = <T>(request: CancellablePromise<T>): void => {
  try {
    if (request.cancel) request.cancel()
    else request.cancelHttp?.()
  } catch {}
}

/** 有限超时包装：超时和会话取消都终止底层请求，不留下后台重试。 */
const withTimeout = async <T>(
  request: CancellablePromise<T>,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let cancelTimer: ReturnType<typeof setInterval> | null = null
    const timer = setTimeout(() => {
      finishReject(new Error(`请求超时(${timeoutMs}ms)`), true)
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (cancelTimer != null) clearInterval(cancelTimer)
    }
    const finishResolve = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (err: unknown, abort = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (abort) cancelRequest(request)
      reject(err)
    }
    if (isCancelled) {
      cancelTimer = setInterval(() => {
        if (isCancelled()) finishReject(new Error('推荐计划已取消'), true)
      }, 50)
      if (isCancelled()) finishReject(new Error('推荐计划已取消'), true)
    }
    request.then(finishResolve, finishReject)
  })
}

/** 原始条目是否具备可交给播放器的音乐标识（与 recall.rawHasId 同口径）。 */
const rawHasId = (raw: Record<string, any>): boolean => {
  return Boolean(raw && (raw.songmid || raw.hash || raw.copyrightId || raw.strMediaMid))
}

/** musicSdk 的最小类型投影（JS 模块推断类型不稳定，统一经此收窄为 any 边界）。 */
type SimilarSdk = Record<string, {
  simiSong?: { getSimiSong: (songId: string) => CancellablePromise<any> }
  musicSearch?: { search: (str: string, page: number, limit: number) => CancellablePromise<any> }
}>
const similarSdk = musicSdk as unknown as SimilarSdk

/** 主艺人（首个艺人 token）。 */
export const primaryArtist = (artist?: string | null): string => {
  return String(artist ?? '').split(/[,、，/&;；|]+/)[0]?.trim() ?? ''
}

/** 种子定位：原生标识优先；否则平台搜索 + 严格匹配（找不到可靠匹配返回 null）。 */
const locateSeed = async(
  provider: SimilarProviderId,
  anchor: PlatformRecallAnchor,
  isCancelled?: () => boolean,
): Promise<{ seedId: string | null, error?: string }> => {
  const native = anchor.seedIds?.[provider]
  if (native) return { seedId: String(native) }
  if (!String(anchor.title ?? '').trim() || !primaryArtist(anchor.artist)) return { seedId: null }

  const keyword = `${String(anchor.title).trim()} ${primaryArtist(anchor.artist)}`
  let result: any
  try {
    // SDK musicSearch.search 自带有限内部重试（wy≤3/tx≤5）；本层不叠加搜索重试
    result = await withTimeout(
      similarSdk[provider].musicSearch!.search(keyword, 1, 30),
      SIMILAR_SEED_SEARCH_TIMEOUT_MS,
      isCancelled,
    )
  } catch (err) {
    return { seedId: null, error: `seed-search: ${(err as Error).message}` }
  }
  if (isCancelled?.()) return { seedId: null }
  const rows: any[] = Array.isArray(result?.list) ? result.list : []
  const matched = matchSeed(
    {
      artist: anchor.artist,
      title: anchor.title,
      album: anchor.album,
      intervalSec: anchor.intervalSec,
    },
    rows.map(r => ({
      artist: r.singer,
      title: r.name,
      album: r.albumName,
      intervalSec: parseIntervalSec(r.interval),
      raw: r,
    })),
  )
  if (!matched) return { seedId: null }
  const raw = (matched as unknown as { raw: Record<string, any> }).raw
  const seedId = provider === 'tx' ? raw.songId : raw.songmid
  return seedId ? { seedId: String(seedId) } : { seedId: null }
}

/** 相似调用：有限超时 + 单层重试（仅本层重试一次；失败/限流/取消不写缓存）。 */
const callSimilar = async(
  provider: SimilarProviderId,
  seedId: string,
  isCancelled?: () => boolean,
): Promise<{ status: ProviderCallStatus, items: CachedSimilarItem[], error?: string }> => {
  let attempt = 0
  // 单层重试：最多 2 次尝试（首次 + 1 次重试）
  for (;;) {
    try {
      const result = await withTimeout(
        similarSdk[provider].simiSong!.getSimiSong(seedId),
        SIMILAR_REQUEST_TIMEOUT_MS,
        isCancelled,
      )
      if (isCancelled?.()) return { status: 'cancelled', items: [] }
      const list: any[] = Array.isArray(result?.list) ? result.list : []
      const items = list.filter(rawHasId).map((raw, index) => ({
        musicInfo: toNewMusicInfo(raw),
        rank: index + 1,
      }))
      return { status: items.length ? 'success' : 'empty', items }
    } catch (err) {
      if (isCancelled?.()) return { status: 'cancelled', items: [] }
      if (++attempt > 1) return { status: 'error', items: [], error: (err as Error).message }
    }
  }
}

/** 过滤规则标识（用于整体状态分类：会话消费 vs 其他过滤）。 */
type FilterRule = 'anchor' | 'session' | 'queue' | 'loved' | 'disliked' | 'diversity'

const sameSongIn = (list: SongRef[] | undefined, ref: SongRef): boolean => {
  return (list ?? []).some(item => sameSong(item, ref))
}

/** 标题去掉括号版本标记（(Live)/(DJ版)/(伴奏) 等）后的作品名。 */
const stripVersionMarkers = (title?: string | null): string => {
  return String(title ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[（(][^（）()]*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const artistTokenList = (artist?: string | null): string[] => {
  return String(artist ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/[,、，/&;；|]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 同一作品判定（起点排除专用，比 sameSong 宽一档）：
 * 去版本标记后的标题一致 + 艺人 token 有交集 → 视为起点同作品变体，不入候选
 * （推荐当前歌曲的 Live/DJ 版没有意义）；不同艺人的翻唱不算同一作品。
 */
const sameWork = (a: SongRef, b: SongRef): boolean => {
  const ta = stripVersionMarkers(a.title)
  const tb = stripVersionMarkers(b.title)
  if (!ta || !tb || ta !== tb) return false
  const aTokens = artistTokenList(a.artist)
  const bTokens = artistTokenList(b.artist)
  if (!aTokens.length || !bTokens.length) return false
  return aTokens.some(t => bTokens.includes(t))
}

/**
 * 过滤融合候选（4.4 排除规则）：
 * 会话已消费（id + 同曲）→ 当前队列（同曲）→ 红心 → 不再推荐 → 艺人多样性。
 * 返回保留项与各规则淘汰计数（供 exhausted / empty-after-filter 分类）。
 * 起点自身排除（同曲变体 + 同 id）在融合后、本函数前统一执行，由调用方计数。
 */
const filterFused = (
  items: FusedCandidate[],
  options: PlatformRecallOptions,
): { kept: FusedCandidate[], killed: Partial<Record<FilterRule, number>> } => {
  const excludeIds = new Set((options.excludeIds ?? []).map(id => String(id)))
  const killed: Partial<Record<FilterRule, number>> = {}
  const count = (rule: FilterRule) => { killed[rule] = (killed[rule] ?? 0) + 1 }

  const kept: FusedCandidate[] = []
  for (const item of items) {
    const ref: SongRef = { artist: item.artist, title: item.title }
    const id = String(item.musicInfo.id ?? '')
    if (id && excludeIds.has(id)) { count('session'); continue }
    if (sameSongIn(options.excludeTracks, ref)) { count('session'); continue }
    if (sameSongIn(options.queueTracks, ref)) { count('queue'); continue }
    if (sameSongIn(options.lovedTracks, ref)) { count('loved'); continue }
    if (sameSongIn(options.dislikedTracks, ref)) { count('disliked'); continue }
    if (options.isExcluded?.(item.musicInfo)) { count('disliked'); continue }
    kept.push(item)
  }
  // 已消费/收藏等条目不能占用本批配额；续补才能继续消费缓存中的后续候选。
  const diversified = applyArtistDiversity(kept)
  const diversitySkipped = kept.length - diversified.length
  if (diversitySkipped > 0) killed.diversity = diversitySkipped
  return { kept: diversified, killed }
}

/**
 * 平台相似召回主入口：各平台并行独立调用（单源失败不影响其他源）→ 确定性融合 → 过滤 → 状态分类。
 */
export const recallPlatformSimilar = async(
  anchor: PlatformRecallAnchor,
  options: PlatformRecallOptions = {},
): Promise<PlatformRecallResult> => {
  const cache = options.cache ?? similarCache
  const isCancelled = options.isCancelled
  const cancelCheck = (): boolean => Boolean(isCancelled?.())
  // 包含全部匹配证据，避免同 id 的元数据/版本变更误用旧匹配。
  const anchorKey = JSON.stringify([anchor.source, anchor.id, anchor.artist, anchor.title, anchor.album, anchor.intervalSec])

  const providerResults = await Promise.all(PROVIDER_ORDER.map(async(provider): Promise<ProviderCallResult> => {
    const base = { provider, seedId: null as string | null, fromCache: false }
    if (cancelCheck()) return { ...base, status: 'cancelled', items: [] }

    const knownSeed = anchor.seedIds?.[provider] ?? cache.getSeed(provider, anchorKey)
    const located = knownSeed ? { seedId: knownSeed } : await locateSeed(provider, anchor, isCancelled)
    if (cancelCheck()) return { ...base, status: 'cancelled', items: [] }
    if (!located.seedId) {
      return {
        ...base,
        status: located.error ? 'error' : 'no-match',
        items: [],
        ...(located.error ? { error: located.error } : {}),
      }
    }
    const seedId = located.seedId
    if (!knownSeed) cache.setSeed(provider, anchorKey, seedId)

    // 续补先消费缓存（会话排除/偏好/队列过滤在缓存读取后由 filterFused 重新执行）
    const cached = cache.get(provider, seedId)
    if (cached) {
      return {
        provider,
        seedId,
        fromCache: true,
        status: cached.items.length ? 'success' : 'empty',
        items: cached.items,
      }
    }

    const called = await callSimilar(provider, seedId, isCancelled)
    if (called.status === 'success' || called.status === 'empty') {
      // 只缓存真实成功结果（含平台真实返回的空列表）；失败/限流/取消不写缓存
      cache.set(provider, seedId, called.items)
    }
    return { provider, seedId, fromCache: false, ...called }
  }))

  if (cancelCheck()) {
    return { state: 'cancelled', items: [], providers: providerResults.map(p => ({ provider: p.provider, status: 'cancelled', seedId: p.seedId, fromCache: p.fromCache })), error: null }
  }

  // 融合（确定性，与完成顺序无关）→ 画像有界调整
  const batches: ProviderBatch[] = providerResults
    .filter(p => p.status === 'success')
    .map(p => ({ provider: p.provider, candidates: p.items.map(item => ({ musicInfo: item.musicInfo, rank: item.rank })) }))
  let fused = applyProfileAdjustment(fuseSimilarCandidates(batches), options.profileBoost)

  // 起点自身及同作品变体排除（同曲变体 + 同 id；在融合后统一执行；排除后无剩余按「平台空结果」归类）
  const anchorRef: SongRef = { artist: anchor.artist, title: anchor.title }
  fused = fused.filter(item => {
    if (anchor.id && String(item.musicInfo.id) === String(anchor.id)) return false
    return !sameWork(item, anchorRef)
  })

  const { kept, killed } = filterFused(fused, options)
  const maxItems = options.maxItems ?? 8
  const items = kept.slice(0, maxItems)

  // 状态分类（全部失败/无匹配/空结果/过滤完/用尽 可区分）
  const errors = providerResults.filter(p => p.status === 'error')
  const noMatch = providerResults.filter(p => p.status === 'no-match')
  const definitive = providerResults.filter(p => p.status === 'success' || p.status === 'empty')

  if (items.length) {
    return { state: 'ok', items, providers: projectProviders(providerResults), error: errors.length ? errors.map(e => `${e.provider}: ${e.error}`).join('；') : null }
  }

  // 有平台成功取数但没有候选可入队：
  // - 起点排除后无剩余（平台只返回了起点自身/同曲变体）→ 平台空结果（empty）；
  // - 被红心/队列/不再推荐/多样性过滤完 → empty-after-filter；
  // - 全部为本会话已消费 → exhausted（候选用尽，不是网络失败，不重试）。
  if (definitive.some(p => p.status === 'success')) {
    if (fused.length === 0) {
      return { state: 'empty', items: [], providers: projectProviders(providerResults), error: null }
    }
    const nonSessionKilled = (killed.queue ?? 0) + (killed.loved ?? 0) + (killed.disliked ?? 0) + (killed.diversity ?? 0)
    if (nonSessionKilled > 0) {
      return { state: 'empty-after-filter', items: [], providers: projectProviders(providerResults), error: null }
    }
    if ((killed.session ?? 0) > 0) {
      return { state: 'exhausted', items: [], providers: projectProviders(providerResults), error: null }
    }
    return { state: 'empty', items: [], providers: projectProviders(providerResults), error: null }
  }

  // 无任何平台成功取数：全部失败（可重试）/ 全部无匹配 / 种子已定位但平台空结果
  if (definitive.length) {
    return { state: 'empty', items: [], providers: projectProviders(providerResults), error: null }
  }
  if (errors.length && !definitive.length) {
    return {
      state: 'all-failed',
      items: [],
      providers: projectProviders(providerResults),
      error: errors.map(e => `${e.provider}: ${e.error ?? '请求失败'}`).join('；') || '全部平台请求失败',
    }
  }
  if (noMatch.length) {
    return { state: 'no-match', items: [], providers: projectProviders(providerResults), error: null }
  }
  return { state: 'empty', items: [], providers: projectProviders(providerResults), error: null }
}

/** 视图投影：不透传候选条目（调用方只需要状态与失败原因）。 */
const projectProviders = (results: ProviderCallResult[]): Array<Pick<ProviderCallResult, 'provider' | 'status' | 'seedId' | 'fromCache' | 'error'>> => {
  return results.map(p => ({ provider: p.provider, status: p.status, seedId: p.seedId, fromCache: p.fromCache, ...(p.error ? { error: p.error } : {}) }))
}
