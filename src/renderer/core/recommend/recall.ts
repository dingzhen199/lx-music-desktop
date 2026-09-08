/**
 * 推荐引擎召回模块：跨源候选召回。
 *
 * 召回方向（from-here bridge/server.js recallPool 语义的 lx 适配）：
 * - 同艺人搜索（anchor.singer/name，硬约束冲突时跳过）；
 * - 语义关键词跨源搜索（复用 T-B0 recallQueries，每关键词每源限 10 首）；
 * - 本地“我喜欢”列表（弱偏好源 taste=liked）与用户收藏歌单（source=playlist）作候选池补充；
 * - 过滤 anchor 自身与无 id（不可播放类）的条目，归一化为 TrackLike。
 */

import { getListMusics } from '@renderer/store/list/listManage/rendererListManage'
import { loveList, userLists } from '@renderer/store/list/listManage/state'
import { playedList } from '@renderer/store/player/state'
import { toNewMusicInfo } from '@renderer/utils'
import musicSdk from '@renderer/utils/musicSdk'
import { recallSourceLanguageBlocked, SEMANTIC_DISTANCE_BASE, SEMANTIC_DISTANCE_STEP, trimSemanticQueries } from './gates'
import { sameArtistConflictsWithConstraints } from './judgment'
import type { AnalysisShape, LanguageConstraints, TrackLike } from './judgment'
import { recallQueries } from './prompts'
import type { TrackAnalysis } from './prompts'

/** 召回候选：T-B0 TrackLike + 可插入队列的完整音乐信息。 */
export type RecallCandidate = TrackLike & {
  musicInfo: LX.Music.MusicInfo
  /** 感知距离（0-100，仅排序阶段参与语义判定）。 */
  distance: number
}

/** 一条召回查询。 */
export interface RecallQuery {
  keyword: string
  reason: string
  kind: 'same-artist' | 'semantic'
}

/** 召回最小锚点结构。 */
export interface RecallAnchor {
  artist: string
  title: string
  singer?: string
  name?: string
  id?: string
}

/** 召回选项。 */
export interface RecallOptions {
  /** 语言硬约束（“不要华语”等，已解析）。 */
  excludedLanguages?: string[]
}

/** 召回结果。 */
export interface RecallResult {
  items: RecallCandidate[]
  meta: {
    sourceCounts: Record<string, number>
    error: string | null
  }
}

/** 搜索原始条目是否具备可用 id（无 songmid/hash/copyrightId/strMediaMid 的不可播放条目直接丢弃）。 */
const rawHasId = (raw: Record<string, any>): boolean => {
  return Boolean(raw && (raw.songmid || raw.hash || raw.copyrightId || raw.strMediaMid))
}

/** 同艺人查询关键词：优先歌手名，缺失时退回歌名。 */
const sameArtistKeyword = (anchor: RecallAnchor): string => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 保留 from-here 的 || 回退链：空串继续向后续字段回退
  return String(anchor.singer || anchor.artist || anchor.name || '').trim()
}

/**
 * 构建召回查询：同艺人搜索优先，其后接 T-B0 recallQueries 的语义关键词。
 * 语义移植自 from-here recallPool：同一搜索词去重、按半径限量（由 recallQueries 决定）。
 */
export function buildRecallQueries(
  anchor: RecallAnchor,
  analysis: Pick<TrackAnalysis, 'recallDirections'> | null | undefined,
  radius: number,
  options: { sameArtistAllowed?: boolean } = {},
): RecallQuery[] {
  const queries: RecallQuery[] = []
  if (options.sameArtistAllowed !== false) {
    const keyword = sameArtistKeyword(anchor)
    if (keyword) queries.push({ keyword, reason: '围绕当前艺人保持较近的听感边界', kind: 'same-artist' })
  }
  for (const q of recallQueries(analysis, radius)) {
    queries.push({ keyword: q.keyword, reason: q.reason, kind: 'semantic' })
  }
  return queries
}

/** 感知距离：与 from-here tracksFrom 一致（语义按语义查询序号递增，同艺人最近）。 */
const distanceFor = (kind: RecallQuery['kind'], semanticIndex: number): number => {
  return kind === 'same-artist' ? 8 : SEMANTIC_DISTANCE_BASE + semanticIndex * SEMANTIC_DISTANCE_STEP
}

/** 与 anchor 是同一首歌（id 相同，或艺人+歌名一致）。 */
const sameTrack = (candidate: RecallCandidate, anchor: RecallAnchor): boolean => {
  if (anchor.id && candidate.encryptedId === anchor.id) return true
  const cArtist = String(candidate.artist ?? '').toLowerCase()
  const cTitle = String(candidate.title ?? '').toLowerCase()
  const aArtist = String(anchor.artist ?? '').toLowerCase()
  const aTitle = String(anchor.title ?? '').toLowerCase()
  return Boolean(cArtist && cTitle && cArtist === aArtist && cTitle === aTitle)
}

/** 归一化候选为 TrackLike（source 为召回来源标记）。 */
const toCandidate = (info: LX.Music.MusicInfo, source: string, extra: {
  distance: number
  reason: string
  semanticReason?: string
  loveIds: Set<string>
  recentIds: Set<string>
}): RecallCandidate => {
  return {
    artist: info.singer,
    title: info.name,
    album: info.meta.albumName ?? '',
    tags: [],
    source,
    encryptedId: info.id,
    distance: extra.distance,
    liked: extra.loveIds.has(info.id),
    recent: extra.recentIds.has(info.id),
    semanticReason: extra.semanticReason,
    reason: extra.reason,
    musicInfo: info,
  }
}

/** 单条关键词的跨源搜索（每关键词每源限 10 首）。 */
const searchByQuery = async(
  q: RecallQuery,
  semanticIndex: number,
  loveIds: Set<string>,
  recentIds: Set<string>,
): Promise<RecallCandidate[]> => {
  const out: RecallCandidate[] = []
  let results: Array<{ list: any[], source: string }> | null = null
  try {
    results = (await musicSdk.searchMusic({ name: q.keyword, singer: '', source: '', limit: 10 })) as Array<{ list: any[], source: string }> | null
  } catch (err) {
    console.error('[recall] 搜索失败', q.keyword, err)
    return out
  }
  const distance = distanceFor(q.kind, semanticIndex)
  const source = q.kind === 'same-artist' ? 'same-artist' : 'semantic-search'
  const reason = q.kind === 'same-artist' ? '保留起点熟悉的声音与表达方式' : '沿着起点的声音气质继续展开'
  for (const result of results ?? []) {
    if (!result?.list) continue
    for (const raw of result.list.slice(0, 10)) {
      if (!rawHasId(raw)) continue
      try {
        const info = toNewMusicInfo(raw)
        out.push(toCandidate(info, source, {
          distance,
          reason,
          semanticReason: q.kind === 'semantic' ? q.reason : undefined,
          loveIds,
          recentIds,
        }))
      } catch (err) {
        console.warn('[recall] 归一化失败', err)
      }
    }
  }
  return out
}

/**
 * 召回候选（并行）：
 * - 同艺人搜索（若与语言硬约束冲突则跳过）；
 * - 语义关键词跨源搜索；
 * - 本地“我喜欢”列表（liked）与用户收藏歌单（playlist）候选池补充；
 * 过滤 anchor 自身与无 id 条目，按 id 去重（保留先出现来源的版本）。
 */
export const recallCandidates = async(
  anchor: RecallAnchor,
  analysis: TrackAnalysis | null | undefined,
  radius: number,
  options: RecallOptions = {},
): Promise<RecallResult> => {
  const sourceCounts: Record<string, number> = {}
  const errors: string[] = []
  const constraints: LanguageConstraints = { excludedLanguages: options.excludedLanguages ?? [] }

  // 本地池：我喜欢列表 + 用户收藏歌单（无 id 歌曲不会出现，均为可播放曲目）
  // 各来源截断上限：离线池仅作弱偏好 tie-break，超量只会带来排序噪音与带宽浪费。
  const LOCAL_POOL_CAP = 200
  const loveIds = new Set<string>()
  const recentIds = new Set<string>()
  for (const item of playedList.slice(-10)) {
    if (item?.musicInfo?.id) recentIds.add(item.musicInfo.id)
  }
  let likedItems: LX.Music.MusicInfo[] = []
  const playlistItems: LX.Music.MusicInfo[] = []
  try {
    likedItems = (await getListMusics(loveList.id)).slice(0, LOCAL_POOL_CAP)
    for (const m of likedItems) loveIds.add(m.id)
  } catch (err) {
    errors.push(`liked: ${(err as Error).message}`)
  }
  for (const list of userLists) {
    try {
      if (!list.id) continue
      for (const musicInfo of await getListMusics(list.id)) {
        if (playlistItems.length >= LOCAL_POOL_CAP) break
        playlistItems.push(musicInfo)
      }
    } catch (err) {
      errors.push(`playlist:${list.id}: ${(err as Error).message}`)
    }
  }
  sourceCounts.liked = likedItems.length
  sourceCounts.playlist = playlistItems.length

  // 语言硬约束：同艺人搜索与 anchor 冲突时换道（语义上不跨语言空间的召回方向）。
  const sameArtistAllowed = !sameArtistConflictsWithConstraints(
    { artist: anchor.artist, title: anchor.title },
    analysis as AnalysisShape,
    constraints,
  )
  // 语义查询距程裁剪（S3）：距离 24+7*i 超过半径的语义查询不再发起，同艺人查询保留。
  const queries = trimSemanticQueries(buildRecallQueries(anchor, analysis, radius, { sameArtistAllowed }), radius)

  // 并行执行所有查询（同艺人 + 语义），单条失败不影响整体。
  let semanticIndex = 0
  const searchResults = await Promise.all(queries.map(async(q) => {
    const index = q.kind === 'semantic' ? semanticIndex++ : 0
    return searchByQuery(q, index, loveIds, recentIds).catch(err => {
      errors.push(`${q.kind}:${q.keyword}: ${(err as Error).message}`)
      return []
    })
  }))

  const items: RecallCandidate[] = []
  const seen = new Set<string>()
  const pushCandidate = (c: RecallCandidate) => {
    const key = String(c.encryptedId ?? `${c.artist}::${c.title}`)
    if (seen.has(key)) return
    if (sameTrack(c, anchor)) return
    // 源头语言门控（S1）：排除语言时仅拦高置信元数据提示的候选（rank 阶段守门仍保留为兜底）。
    if (recallSourceLanguageBlocked(c, constraints)) return
    seen.add(key)
    items.push(c)
  }

  for (const list of searchResults) {
    for (const c of list) pushCandidate(c)
  }
  for (const m of likedItems) {
    pushCandidate(toCandidate(m, 'liked', {
      distance: 12,
      reason: '来自你喜欢的列表（弱偏好，仅作 tie-break）',
      loveIds,
      recentIds,
    }))
  }
  for (const m of playlistItems) {
    pushCandidate(toCandidate(m, 'playlist', {
      distance: 30,
      reason: '来自你的收藏歌单（弱偏好，仅作候选池补充）',
      loveIds,
      recentIds,
    }))
  }

  sourceCounts['semantic-search'] = items.filter(c => c.source === 'semantic-search').length
  sourceCounts['same-artist'] = items.filter(c => c.source === 'same-artist').length
  sourceCounts.liked = items.filter(c => c.source === 'liked').length
  sourceCounts.playlist = items.filter(c => c.source === 'playlist').length

  return { items, meta: { sourceCounts, error: errors.length ? errors.join('；') : null } }
}
