/**
 * 推荐引擎召回模块：跨源候选召回。
 *
 * 召回方向（from-here bridge/server.js recallPool 语义的 lx 适配）：
 * - 同艺人搜索（anchor.singer/name，硬约束冲突时跳过）；
 * - 语义关键词跨源搜索（复用 T-B0 recallQueries，每关键词每源限 10 首）；
 * - 本地用户收藏歌单（source=playlist）作候选池补充；
 * - 过滤 anchor 自身与无 id（不可播放类）的条目，归一化为 TrackLike；
 * - 「我喜欢」列表不再作为候选源（见 candidatePool 红心排除），仅用于红心排除。
 */

import { getListMusics } from '@renderer/store/list/listManage/rendererListManage'
import { loveList, userLists } from '@renderer/store/list/listManage/state'
import { playedList } from '@renderer/store/player/state'
import { toNewMusicInfo } from '@renderer/utils'
import musicSdk from '@renderer/utils/musicSdk'
import { buildCandidatePool } from './candidatePool'
import { SEMANTIC_DISTANCE_BASE, SEMANTIC_DISTANCE_STEP, trimSemanticQueries } from './gates'
import { sameArtistConflictsWithConstraints } from './judgment'
import type { AnalysisShape, LanguageConstraints, TrackLike } from './judgment'
import { recallQueries } from './prompts'
import type { TrackAnalysis } from './prompts'

/** 召回候选：T-B0 TrackLike + 可插入队列的完整音乐信息。 */
export type RecallCandidate = TrackLike & {
  musicInfo: LX.Music.MusicInfo
  /** 感知距离（0-100，仅排序阶段参与语义判定）。 */
  distance: number
  vocalType?: 'instrumental' | 'vocal' | 'unknown'
}

/** 一条召回查询。reason 仅语义方向携带（逐条理由，回写候选的 semanticReason；同艺人方向无）。 */
export interface RecallQuery {
  keyword: string
  reason?: string
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
    if (keyword) queries.push({ keyword, kind: 'same-artist' })
  }
  for (const q of recallQueries(analysis, radius)) {
    queries.push({ keyword: q.keyword, reason: q.reason, kind: 'semantic' })
  }
  return queries
}

/**
 * 召回方向档案：距离生成、来源标注、固定理由、逐条理由回写与语义序号消耗按 kind 收敛于此
 * （此前同一 kind 判定散在 distanceFor/searchByQuery/recallCandidates 五处三元，新增方向需逐处同步）。
 * 距离口径与 from-here tracksFrom 一致：同艺人恒最近（8），语义按查询序号 24+7*i 递增。
 */
const KIND_PROFILE = {
  'same-artist': {
    source: 'same-artist',
    reason: '保留起点熟悉的声音与表达方式',
    // 不消耗语义查询序号；参数位置只为与语义档对齐，恒弃用
    distance: (_semanticIndex: number): number => 8,
    semantic: false,
  },
  semantic: {
    source: 'semantic-search',
    reason: '沿着起点的声音气质继续展开',
    distance: (semanticIndex: number): number => SEMANTIC_DISTANCE_BASE + semanticIndex * SEMANTIC_DISTANCE_STEP,
    semantic: true,
  },
} as const

/**
 * 归一化候选为 TrackLike（source 为召回来源标记）。
 * loveIds：红心歌已在候选池（buildCandidatePool 红心排除）硬排除，
 * liked 标记实际恒为 false；保留该字段仅因 prompts.ts 的 Familiarity 字段读取它（prompts.ts 只读）。
 */
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
  const profile = KIND_PROFILE[q.kind]
  const distance = profile.distance(semanticIndex)
  const source = profile.source
  const reason = profile.reason
  for (const result of results ?? []) {
    if (!result?.list) continue
    for (const raw of result.list.slice(0, 10)) {
      if (!rawHasId(raw)) continue
      try {
        const info = toNewMusicInfo(raw)
        out.push(toCandidate(info, source, {
          distance,
          reason,
          semanticReason: profile.semantic ? q.reason : undefined,
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
 * - 本地用户收藏歌单（playlist）候选池补充；
 * 合并后经 candidatePool 统一去重（id → 锚点排除 → 红心排除 → 语言门控 → 同曲去重）。
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

  // 本地池：用户收藏歌单（playlist，LOCAL_POOL_CAP 截断）；
  // 「我喜欢」列表仅用于红心排除，不再作为候选源（全量读取，截断会让 >200 首的红心曲漏排）。
  const LOCAL_POOL_CAP = 200
  const loveIds = new Set<string>()
  const recentIds = new Set<string>()
  for (const item of playedList.slice(-10)) {
    if (item?.musicInfo?.id) recentIds.add(item.musicInfo.id)
  }
  let likedItems: LX.Music.MusicInfo[] = []
  const playlistItems: LX.Music.MusicInfo[] = []
  try {
    likedItems = await getListMusics(loveList.id)
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
    const index = KIND_PROFILE[q.kind].semantic ? semanticIndex++ : 0
    return searchByQuery(q, index, loveIds, recentIds).catch(err => {
      errors.push(`${q.kind}:${q.keyword}: ${(err as Error).message}`)
      return []
    })
  }))

  // 候选池统一去重（id → 锚点排除 → 红心排除 → 语言门控 → 同曲去重）：
  // 跨源搜索结果在前、本地收藏歌单池在后（同曲去重保留先出现者）。
  const lovedTracks = likedItems.map(m => ({ artist: m.singer, title: m.name }))
  const items: RecallCandidate[] = buildCandidatePool(
    [
      ...searchResults.flat(),
      ...playlistItems.map(m => toCandidate(m, 'playlist', {
        distance: 30,
        reason: '来自你的收藏歌单（弱偏好，仅作候选池补充）',
        loveIds,
        recentIds,
      })),
    ],
    { anchor: { artist: anchor.artist, title: anchor.title, id: anchor.id }, lovedTracks, constraints },
  )

  sourceCounts['semantic-search'] = items.filter(c => c.source === 'semantic-search').length
  sourceCounts['same-artist'] = items.filter(c => c.source === 'same-artist').length
  sourceCounts.playlist = items.filter(c => c.source === 'playlist').length

  return { items, meta: { sourceCounts, error: errors.length ? errors.join('；') : null } }
}
