/**
 * 推荐引擎召回源头的纯逻辑守门（供 recall.ts 集成，由 vitest 直接测试）。
 *
 * - 语言门控（S1）：复用 T-B0 judgment.localLanguageBlocked 语义——排除语言时仅拦截
 *   “元数据高置信”标明该语言的候选；纯汉字日文/韩文因 hint=unknown/low 不拦截，避免误杀
 *   （如标题含“桜”的作品）。不做“纯 CJK 保守拦截”，这是已批准规格的硬性边界。
 * - 语义查询距程裁剪（S3）：语义召回按感知距离 24+7*i（i 为语义查询序号）发起，
 *   超过半径的查询不再发起；同艺人查询（距离 8）始终保留。
 *   不修改 T-B0 recallQueries，在其返回值之外裁剪。
 */

import { localLanguageBlocked } from './judgment'
import type { LanguageConstraints, TrackLike } from './judgment'

/** 语义查询的感知距离起点与步长（与 from-here tracksFrom 一致）。 */
export const SEMANTIC_DISTANCE_BASE = 24
export const SEMANTIC_DISTANCE_STEP = 7

/** 召回源头语言门控：硬约束在召回源头生效，但只拦高置信元数据提示（低置信/unknown 不误杀）。 */
export const recallSourceLanguageBlocked = (candidate: TrackLike, constraints: LanguageConstraints): boolean => {
  return localLanguageBlocked(candidate, constraints)
}

/** 语义查询距程裁剪：距离 = 24 + 7*i 大于 radius 的语义查询丢弃（同艺人查询始终保留）。 */
export const trimSemanticQueries = <T extends { kind: string }>(queries: T[], radius: number): T[] => {
  const out: T[] = []
  const maxDistance = Number(radius) || 0
  let semanticIndex = 0
  for (const query of queries) {
    if (query.kind !== 'same-artist') {
      // 距离随序号单调递增，超限后直接终止（T-B0 recallQueries 返回顺序为语义序号 0..n）。
      if (SEMANTIC_DISTANCE_BASE + semanticIndex * SEMANTIC_DISTANCE_STEP > maxDistance) break
      semanticIndex++
    }
    out.push(query)
  }
  return out
}
