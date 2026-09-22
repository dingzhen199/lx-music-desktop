/**
 * 平台相似结果缓存（平台相似推荐 4.6）。
 *
 * - 按「平台 + 种子原生 id」缓存归一化结果；TTL 与容量上限集中配置；
 * - LRU 淘汰：读取命中刷新热度，超容量淘汰最久未用条目；
 * - 只缓存真实成功结果（含平台真实返回的空列表）；
 *   失败/限流/取消不写入（不得伪装成长期有效的“成功空列表”，取消不算失败）；
 * - 缓存不包含认证信息或短期播放 URL（只存归一化候选条目）；
 * - 会话的排除/偏好/队列过滤在读取后由调用方重新执行（缓存不感知会话状态）。
 * 本模块无 lx 运行时依赖，由 vitest 直接测试。
 */

import { SIMILAR_CACHE_MAX_ENTRIES, SIMILAR_CACHE_TTL_MS } from '@common/recommendationConfig'
import type { SimilarProviderId } from './similarFusion'

/** 缓存的归一化候选条目（platformRecall 归一化后的形状）。 */
export interface CachedSimilarItem {
  musicInfo: LX.Music.MusicInfo
  rank: number
}

/** 缓存条目：归一化候选列表 + 写入时间戳。 */
export interface SimilarCacheEntry {
  items: CachedSimilarItem[]
  fetchedAt: number
}

/** 相似候选缓存（LRU + TTL；Map 迭代序即热度序：尾端最新）。 */
export class SimilarCandidateCache {
  private readonly store = new Map<string, SimilarCacheEntry>()
  private readonly seeds = new Map<string, { seedId: string, fetchedAt: number }>()
  constructor(
    private readonly maxEntries: number = SIMILAR_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = SIMILAR_CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 缓存键：平台 + 种子原生 id（不含认证信息；账号上下文由调用方拼入 key）。 */
  static key(provider: SimilarProviderId, seedId: string, accountContext = ''): string {
    return `${provider}:${String(seedId)}:${accountContext}`
  }

  /** 已确认的跨平台种子；独立按同一 TTL/容量限制，不缓存失败或无匹配。 */
  getSeed(provider: SimilarProviderId, anchorKey: string, accountContext = ''): string | null {
    const key = SimilarCandidateCache.key(provider, anchorKey, accountContext)
    const entry = this.seeds.get(key)
    if (!entry) return null
    this.seeds.delete(key)
    if (this.now() - entry.fetchedAt > this.ttlMs) return null
    this.seeds.set(key, entry)
    return entry.seedId
  }

  setSeed(provider: SimilarProviderId, anchorKey: string, seedId: string, accountContext = ''): void {
    const key = SimilarCandidateCache.key(provider, anchorKey, accountContext)
    this.seeds.delete(key)
    this.seeds.set(key, { seedId, fetchedAt: this.now() })
    while (this.seeds.size > this.maxEntries) {
      const oldest = this.seeds.keys().next().value
      if (oldest == null) break
      this.seeds.delete(oldest)
    }
  }

  /** 读取：未命中/已过期返回 null（过期条目顺手淘汰）；命中刷新 LRU 热度。 */
  get(provider: SimilarProviderId, seedId: string, accountContext = ''): SimilarCacheEntry | null {
    const key = SimilarCandidateCache.key(provider, seedId, accountContext)
    const entry = this.store.get(key)
    if (!entry) return null
    if (this.now() - entry.fetchedAt > this.ttlMs) {
      this.store.delete(key)
      return null
    }
    // LRU 刷新：删除后重插（Map 迭代序尾端为最新）
    this.store.delete(key)
    this.store.set(key, entry)
    return entry
  }

  /** 写入（仅真实成功结果；超容量淘汰最旧条目）。 */
  set(provider: SimilarProviderId, seedId: string, items: CachedSimilarItem[], accountContext = ''): void {
    const key = SimilarCandidateCache.key(provider, seedId, accountContext)
    this.store.delete(key)
    this.store.set(key, { items, fetchedAt: this.now() })
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest == null) break
      this.store.delete(oldest)
    }
  }

  /** 删除单条（测试/失效用）。 */
  delete(provider: SimilarProviderId, seedId: string, accountContext = ''): void {
    this.store.delete(SimilarCandidateCache.key(provider, seedId, accountContext))
  }

  clear(): void {
    this.store.clear()
    this.seeds.clear()
  }

  get size(): number {
    return this.store.size
  }
}
