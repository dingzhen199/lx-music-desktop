export const LLM_DEFAULT_CONCURRENCY = 3
export const LLM_MAX_CONCURRENCY = 8

/** 导入旧配置或异常值时仍保证请求上限有效。 */
export const normalizeLlmConcurrency = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1
    ? Math.min(LLM_MAX_CONCURRENCY, Math.floor(n))
    : LLM_DEFAULT_CONCURRENCY
}

// ===== 平台相似推荐（docs/platform-similar-recommendation-spec.md）=====

/** 推荐引擎取值：platform=平台相似（默认，零 LLM）；ai/local=旧引擎（显式选择）。 */
export type RecommendEngine = 'platform' | 'ai' | 'local'

/** 读取持久化设置中的引擎值：兼容旧 ai/local 值；缺省/垃圾值回落 platform（平台推荐为默认路径）。 */
export const normalizeRecommendEngine = (value: unknown): RecommendEngine => {
  return value === 'ai' || value === 'local' ? value : 'platform'
}

/** 排名融合常数 k：等权倒数排名融合 Σ 1/(k + rank)，rank 从 1 开始。
 * 仅是初始排序方案，不代表声学距离或偏好概率；集中配置便于统一调整。 */
export const SIMILAR_FUSION_K = 10

/** 平台相似请求超时（毫秒）：适配层对每个平台调用设置有限超时，不无限等待。 */
export const SIMILAR_REQUEST_TIMEOUT_MS = 10_000

/** 种子定位搜索超时（毫秒）。 */
export const SIMILAR_SEED_SEARCH_TIMEOUT_MS = 10_000

/** 相似结果缓存 TTL（毫秒）：按平台 + 种子原生 id 缓存归一化结果。 */
export const SIMILAR_CACHE_TTL_MS = 30 * 60 * 1000

/** 相似结果缓存容量上限（种子条数，LRU 淘汰）。 */
export const SIMILAR_CACHE_MAX_ENTRIES = 64

/** 跨平台种子匹配的时长容差（秒）：用于版本/现场版甄别与多候选择优，不作硬性证据。 */
export const SEED_MATCH_DURATION_TOLERANCE_SEC = 15
