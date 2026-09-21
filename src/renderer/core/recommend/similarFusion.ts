/**
 * 跨源相似候选合并与排名融合纯函数（平台相似推荐 4.3）。
 *
 * - 候选保留作品身份 + 各来源条目（含排名与备用音源），不提前「保留第一条」丢证据；
 * - 等权倒数排名融合 Σ 1/(k + rank)（k 集中配置于 recommendationConfig）：
 *   仅用来源内排名，避免不同平台原始分数不可比；同源重复行/重试返回只计一次；
 * - 确定性：固定来源顺序（PROVIDER_ORDER）+ 稳定全序比较，异步返回先后不改变最终排名；
 * - 本地画像加成是有界次级调整（默认 ±15%），保留来源排名的主要作用；
 * - 艺人多样性：同主艺人每批最多 maxPerArtist 首，不足一批允许少量结果，不补足数量。
 * 本模块无 lx 运行时依赖，由 vitest 直接测试。
 */

import { SIMILAR_FUSION_K } from '@common/recommendationConfig'
import { sameSong } from './sameSong'

/** 平台提供方固定顺序（确定性合并的来源序，与异步完成顺序无关）。 */
export const PROVIDER_ORDER = ['wy', 'tx'] as const
export type SimilarProviderId = typeof PROVIDER_ORDER[number]

/** 单来源候选（平台返回的归一化条目，rank 为来源内排名，从 1 开始）。 */
export interface ProviderCandidate {
  musicInfo: LX.Music.MusicInfo
  rank: number
}

/** 单来源输入批次。 */
export interface ProviderBatch {
  provider: SimilarProviderId
  candidates: ProviderCandidate[]
}

/** 来源证据：提供方 + 来源内排名 + 该来源的可播放条目（备用音源）。 */
export interface CandidateSource {
  provider: SimilarProviderId
  rank: number
  musicInfo: LX.Music.MusicInfo
}

/** 融合后的候选：保留全部来源证据；musicInfo 为首选播放条目（按 PROVIDER_ORDER 取最早来源）。 */
export interface FusedCandidate {
  artist: string
  title: string
  album: string
  /** 各来源证据（按 PROVIDER_ORDER 排序；同一候选跨源合并后仍保留各自排名与条目）。 */
  sources: CandidateSource[]
  /** 首选播放条目（PROVIDER_ORDER 中最早的来源；推荐方不一定是最终播放源）。 */
  musicInfo: LX.Music.MusicInfo
  /** 融合分 Σ 1/(k + rank)（画像调整前）。 */
  fusionScore: number
}

/** 画像加成的有界调整幅度（localBonus ∈ [-10,+10] 映射为分数乘数最多 ±15%）。 */
const PROFILE_ADJUST_LIMIT = 0.15

/** 同来源内去重：同 id 或同曲（sameSong）只计一次，保留排名最靠前（rank 最小）的一次。 */
const dedupeWithinProvider = (candidates: ProviderCandidate[]): ProviderCandidate[] => {
  const out: ProviderCandidate[] = []
  for (const c of candidates) {
    if (out.some(o => o.musicInfo.id === c.musicInfo.id || sameSong(
      { artist: o.musicInfo.singer, title: o.musicInfo.name },
      { artist: c.musicInfo.singer, title: c.musicInfo.name },
    ))) continue
    out.push(c)
  }
  return out
}

/** 候选的最佳来源证据（排名最靠前；并列时取来源固定序靠前者）——全序比较的次级键。 */
const bestSource = (c: FusedCandidate): CandidateSource => {
  return c.sources.reduce((best, s) => {
    if (s.rank < best.rank) return s
    if (s.rank === best.rank && PROVIDER_ORDER.indexOf(s.provider) < PROVIDER_ORDER.indexOf(best.provider)) return s
    return best
  })
}

/** 全序比较（确定性）：融合分降序 → 最佳来源排名升序 → 来源固定顺序 → 标题/艺人归一化字典序。 */
const compareFused = (a: FusedCandidate, b: FusedCandidate): number => {
  if (a.fusionScore !== b.fusionScore) return b.fusionScore - a.fusionScore
  const aBest = bestSource(a)
  const bBest = bestSource(b)
  if (aBest.rank !== bBest.rank) return aBest.rank - bBest.rank
  const aOrder = PROVIDER_ORDER.indexOf(aBest.provider)
  const bOrder = PROVIDER_ORDER.indexOf(bBest.provider)
  if (aOrder !== bOrder) return aOrder - bOrder
  const aKey = `${String(a.title).toLowerCase()}||${String(a.artist).toLowerCase()}`
  const bKey = `${String(b.title).toLowerCase()}||${String(b.artist).toLowerCase()}`
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

/**
 * 跨源合并与融合：
 * - 每来源先做同源去重（重复行/重试只计一次），再按 sameSong 跨源归并（保留各来源条目与排名）；
 * - 融合分 Σ 1/(k + rank)，多源共同推荐自然累加，但单源高排名候选仍有展示机会；
 * - 输出顺序与来源输入顺序/异步完成顺序无关（固定来源序 + 全序比较）。
 */
export const fuseSimilarCandidates = (batches: ProviderBatch[]): FusedCandidate[] => {
  // 固定来源顺序消费输入（调用方传入顺序不影响结果）
  const ordered = PROVIDER_ORDER
    .map(provider => batches.find(b => b.provider === provider))
    .filter((b): b is ProviderBatch => b != null)

  const groups: FusedCandidate[] = []
  for (const batch of ordered) {
    for (const c of dedupeWithinProvider(batch.candidates)) {
      const ref = { artist: c.musicInfo.singer, title: c.musicInfo.name }
      const existing = groups.find(g => sameSong(g, ref))
      const source: CandidateSource = { provider: batch.provider, rank: c.rank, musicInfo: c.musicInfo }
      if (existing) {
        // 同一平台对同一候选最多贡献一次：同源同曲重复已在上方去重，此处只会跨源合并
        if (!existing.sources.some(s => s.provider === batch.provider)) existing.sources.push(source)
        continue
      }
      groups.push({
        artist: c.musicInfo.singer,
        title: c.musicInfo.name,
        album: c.musicInfo.meta.albumName ?? '',
        sources: [source],
        musicInfo: c.musicInfo,
        fusionScore: 1 / (SIMILAR_FUSION_K + c.rank),
      })
    }
  }
  // 重算融合分（跨源合并后累加）并按来源固定序整理证据
  for (const g of groups) {
    g.sources.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || a.rank - b.rank)
    g.fusionScore = g.sources.reduce((sum, s) => sum + 1 / (SIMILAR_FUSION_K + s.rank), 0)
    g.musicInfo = g.sources[0].musicInfo
  }
  return groups.sort(compareFused)
}

/**
 * 有界画像调整：localBonus（[-10,+10]）映射为最多 ±15% 的分数乘数，来源排名仍主导顺序；
 * 调整后重排仍用 compareFused 的全序（分数变化才可能换位）。
 */
export const applyProfileAdjustment = (items: FusedCandidate[], profileBoost?: (artist: string) => number): FusedCandidate[] => {
  if (!profileBoost) return items
  const adjusted = items.map(item => {
    const bonus = Math.max(-10, Math.min(10, Number(profileBoost(item.artist ?? '')) || 0))
    const multiplier = 1 + (bonus / 10) * PROFILE_ADJUST_LIMIT
    return { ...item, fusionScore: item.fusionScore * multiplier }
  })
  return adjusted.sort(compareFused)
}

/**
 * 艺人多样性限制：按顺序保留同主艺人（首个艺人 token，小写）最多 maxPerArtist 首，
 * 超出的本批不展示（不重排、不从无关来源补足数量）；不足一批允许少量结果。
 */
export const applyArtistDiversity = (items: FusedCandidate[], maxPerArtist = 2): FusedCandidate[] => {
  const counts = new Map<string, number>()
  const out: FusedCandidate[] = []
  for (const item of items) {
    const primary = String(item.artist ?? '').split(/[,、，/&;；|]+/)[0]?.trim().toLowerCase() ?? ''
    const count = counts.get(primary) ?? 0
    if (count >= maxPerArtist) continue
    counts.set(primary, count + 1)
    out.push(item)
  }
  return out
}
