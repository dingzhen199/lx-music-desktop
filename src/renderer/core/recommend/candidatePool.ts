/**
 * 候选池纯函数（T-B3）。
 *
 * 统一承载召回末端与引擎跨批次排除的同一套去重语义：
 * - buildCandidatePool：id 去重 → 锚点排除（sameSong）→ 红心排除（sameSong）→
 *   语言门控（复用 gates.recallSourceLanguageBlocked）→ 同曲去重（保留先出现者）；
 * - filterExcludeTracks：跨批次按 id 与 sameSong 排除已推荐曲目（防同曲不同 id 变体重复入队）。
 * 本模块无任何 lx 运行时依赖，由 vitest 直接测试。
 */

import { recallSourceLanguageBlocked } from './gates'
import type { LanguageConstraints, TrackLike } from './judgment'
import { normalizeTitle, sameSong } from './sameSong'
import type { SongRef } from './sameSong'

/** 候选池构建选项。 */
export interface CandidatePoolOptions {
  /** 起点（会话锚点）：sameSong 命中或同 id 命中的候选剔除（id 兜底防跨语言/元数据不一致漏排）。 */
  anchor: SongRef & { id?: string | null }
  /** 已红心歌曲（artist/title，同曲变体也命中；按 titleKey 分桶，全量读取无截断）。 */
  lovedTracks: SongRef[]
  /** 语言硬约束。 */
  constraints: LanguageConstraints
}

/** 红心歌按 titleKey 分桶：候选判定先查桶再 sameSong，只对 title 相同的少量项做 token 交集。 */
const indexLovedTracks = (lovedTracks: SongRef[]): Map<string, SongRef[]> => {
  const map = new Map<string, SongRef[]>()
  for (const loved of lovedTracks) {
    const key = normalizeTitle(loved.title)
    if (!key) continue
    const bucket = map.get(key)
    if (bucket) bucket.push(loved)
    else map.set(key, [loved])
  }
  return map
}

/** 候选是否命中红心（titleKey 桶内 sameSong 判定；title 不同直接 false，不误伤同名异曲）。 */
const isLoved = (candidate: TrackLike, lovedIndex: Map<string, SongRef[]>): boolean => {
  const key = normalizeTitle(candidate.title)
  if (!key) return false
  const bucket = lovedIndex.get(key)
  if (!bucket) return false
  return bucket.some(loved => sameSong(loved, candidate))
}

/**
 * 构建候选池：按顺序 id 去重 → 锚点排除（同 id + sameSong）→ 红心排除 → 语言门控 → 同曲去重。
 * 同曲去重保留先出现者（跨源搜索结果在前、本地池在后）。
 * 返回新数组，不改动入参。
 */
export function buildCandidatePool<T extends TrackLike>(items: T[], options: CandidatePoolOptions): T[] {
  const out: T[] = []
  const seenIds = new Set<string>()
  const lovedIndex = indexLovedTracks(options.lovedTracks ?? [])
  for (const c of items) {
    const id = String(c.encryptedId ?? '')
    if (id && seenIds.has(id)) continue
    if (options.anchor.id && c.encryptedId === options.anchor.id) continue
    if (sameSong(c, options.anchor)) continue
    if (isLoved(c, lovedIndex)) continue
    if (recallSourceLanguageBlocked(c, options.constraints)) continue
    if (out.some(it => sameSong(it, c))) continue
    if (id) seenIds.add(id)
    out.push(c)
  }
  return out
}

/**
 * 按 id 与同曲语义排除已推荐曲目（engine 跨批次去重用）；
 * 与 buildCandidatePool 一样只排除、不改动其余候选的相对顺序。
 */
export function filterExcludeTracks<T extends TrackLike>(items: T[], excludeIds: string[], excludeTracks: SongRef[]): T[] {
  const ids = new Set((excludeIds ?? []).map(id => String(id)))
  return items.filter(c => {
    const id = String(c.encryptedId ?? '')
    if (id && ids.has(id)) return false
    if ((excludeTracks ?? []).some(t => sameSong(t, c))) return false
    return true
  })
}
