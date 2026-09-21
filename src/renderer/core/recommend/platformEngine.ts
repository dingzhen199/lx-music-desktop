/**
 * 平台相似推荐引擎（默认路径，零 LLM）。
 *
 * 当前歌曲 → 各平台准确定位同曲 → 平台单曲相似推荐 → 跨源合并与排名融合
 * → 本地过滤和偏好调整 → 稍后播放队列（平台相似推荐需求 1）。
 *
 * 与旧 AI 引擎（engine.ts exploreOnce）的关系：
 * - 本路径为默认推荐路径，不要求 AI Key，全程 0 次 LLM 请求（分析/排序/画像摘要均不发起）；
 * - 平台全部失败时抛错走会话层有限重试；无匹配/空结果/过滤完/候选用尽为可区分的
 *   非失败状态（不重试、不静默回退关键词搜索/同艺人/旧 AI 排序）；
 * - 旧 AI 路径仅经显式设置（recommend.engine='ai'）进入，不因本路径失败被自动触发。
 */

import { LIST_IDS } from '@common/constants'
import { addTempPlayList } from '@renderer/store/player/action'
import { tempPlayList } from '@renderer/store/player/state'
import { getListMusics } from '@renderer/store/list/listManage/rendererListManage'
import { loveList } from '@renderer/store/list/listManage/state'
import { recallPlatformSimilar } from './platformRecall'
import type { PlatformRecallAnchor, PlatformRecallState } from './platformRecall'
import type { FusedCandidate, SimilarProviderId } from './similarFusion'
import type { SongRef } from './sameSong'

/** 平台推荐引擎选项。 */
export interface PlatformExploreOptions {
  anchor: PlatformRecallAnchor
  /** 会话先校验代际再提交队列（与 exploreOnce.enqueue 同语义）。 */
  enqueue?: boolean
  isCancelled?: () => boolean
  /** 队列追加模式：bottom=追加队尾（会话路径一律传此值）。 */
  appendMode?: 'top' | 'bottom'
  /** 会话已推荐过的候选 id（续补避免重复入队）。 */
  excludeIds?: string[]
  /** 会话已推荐/已播曲目（同曲通道）。 */
  excludeTracks?: SongRef[]
  /** 明确「不再推荐」的曲目。 */
  dislikedTracks?: SongRef[]
  /** 本地画像艺人加成（有界次级调整）。 */
  profileBoost?: (artist: string) => number
  /** 单批最多入队数。 */
  maxItems?: number
}

/** 对外返回的单条候选视图（与 ExploreItemView 对齐的子集 + 来源证据）。 */
export interface PlatformItemView {
  id: string | null
  artist: string
  title: string
  album: string
  /** 展示来源：'wy' | 'tx' | 'aggregated'（跨源共同推荐）。 */
  source: string
  /** 可验证事实理由（不生成未经测量的听感描述）。 */
  reason: string
  journeyRole: string
  musicInfo?: LX.Music.MusicInfoOnline
  /** 各来源证据（含排名与备用音源条目）。 */
  sources: Array<{ provider: SimilarProviderId, rank: number, musicInfo: LX.Music.MusicInfoOnline }>
}

/** 平台推荐结果视图。 */
export interface PlatformExploreResult {
  engine: 'platform'
  anchor: { artist: string, title: string, album: string }
  candidates: PlatformItemView[]
  meta: {
    state: PlatformRecallState
    /** 各平台调用状态（部分来源不可用时供非阻断提示）。 */
    providers: Array<{ provider: SimilarProviderId, status: string, seedId: string | null, fromCache: boolean }>
    error: string | null
  }
}

/** 平台展示名（理由/来源文案用）。 */
const PROVIDER_LABEL: Record<SimilarProviderId, string> = {
  wy: '网易相似歌曲推荐',
  tx: 'QQ 音乐相关歌曲推荐',
}

/** 读取红心歌（排除用；失败时按空处理，不阻塞推荐）。 */
const gatherLovedTracks = async(): Promise<SongRef[]> => {
  try {
    const items = await getListMusics(loveList.id)
    return items.map(m => ({ artist: m.singer, title: m.name }))
  } catch {
    return []
  }
}

/** 候选 → 视图（理由只陈述可验证事实：来源与共同推荐，不编造听感描述）。 */
const toView = (item: FusedCandidate): PlatformItemView => {
  const aggregated = item.sources.length > 1
  return {
    id: item.musicInfo.id ?? null,
    artist: item.artist ?? '',
    title: item.title ?? '',
    album: item.album ?? '',
    source: aggregated ? 'aggregated' : item.sources[0].provider,
    reason: aggregated ? '两个平台共同推荐' : (PROVIDER_LABEL[item.sources[0].provider] ?? '平台相似推荐'),
    // 平台模式无弧线角色语义，占位 open（视图在平台模式隐藏角色徽章）
    journeyRole: 'open',
    musicInfo: item.musicInfo as LX.Music.MusicInfoOnline,
    sources: item.sources.map(s => ({ provider: s.provider, rank: s.rank, musicInfo: s.musicInfo as LX.Music.MusicInfoOnline })),
  }
}

/**
 * 平台相似推荐一次计划：召回（种子定位 + 相似 + 融合 + 过滤）→ 入队。
 * 全部平台失败时抛错（会话层有限重试）；其余零候选状态以 meta.state 返回，不抛错。
 */
export const explorePlatformOnce = async(options: PlatformExploreOptions): Promise<PlatformExploreResult> => {
  const anchor = options.anchor
  if (options.isCancelled?.()) throw new Error('推荐计划已取消')

  const lovedTracks = await gatherLovedTracks()
  if (options.isCancelled?.()) throw new Error('推荐计划已取消')

  // 当前稍后播放队列（含用户手动排队；同曲不重复插入）
  const queueTracks: SongRef[] = []
  for (const item of tempPlayList) {
    const info: any = item?.musicInfo
    if (info?.id) queueTracks.push({ artist: info.singer, title: info.name })
  }

  const recall = await recallPlatformSimilar(anchor, {
    isCancelled: options.isCancelled,
    excludeIds: options.excludeIds,
    excludeTracks: options.excludeTracks,
    queueTracks,
    lovedTracks,
    dislikedTracks: options.dislikedTracks,
    profileBoost: options.profileBoost,
    maxItems: options.maxItems,
  })
  if (options.isCancelled?.()) throw new Error('推荐计划已取消')

  // 全部平台失败按请求失败处理（走会话层有限重试；不静默回退其他召回）
  if (recall.state === 'all-failed') {
    throw new Error(recall.error ?? '全部平台请求失败')
  }

  if (options.enqueue !== false && recall.items.length) {
    addTempPlayList(recall.items.map(item => ({
      listId: LIST_IDS.PLAY_LATER,
      musicInfo: item.musicInfo,
      isTop: options.appendMode !== 'bottom',
    })))
  }

  return {
    engine: 'platform',
    anchor: { artist: anchor.artist, title: anchor.title, album: anchor.album ?? '' },
    candidates: recall.items.map(toView),
    meta: {
      state: recall.state,
      providers: recall.providers,
      error: recall.error,
    },
  }
}
