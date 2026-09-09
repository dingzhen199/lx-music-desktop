/**
 * 同曲判定纯函数（T-B3）。
 *
 * 背景：音乐平台对同一首歌返回的 artist 串顺序/分隔符/合作者数量可能不同
 * （如 Möbius 一条 artist="Benjamin, Laco, 薄野弘之"，另一条 "mpi, Laco, Benjamin, 薄野弘之"；
 * Inferno 两条 artist 相同但 id 不同），导致同曲以多个 id/artist 变体穿过全链路去重。
 * 本模块无任何 lx 运行时依赖（纯函数），供 recall/candidatePool/engine/session-core 复用，
 * 由 vitest 直接测试。
 */

/** 参与同曲判定的最小歌曲引用（artist/title 均可空）。 */
export interface SongRef {
  artist?: string | null
  title?: string | null
}

/** 标题归一化：trim、lower、空白折叠（保留 (Live) 等版本差异）。 */
export const normalizeTitle = (title?: string | null): string => {
  return String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 艺人归一化：按常见分隔符切词、trim、lower。 */
const normalizeArtistTokens = (artist?: string | null): string[] => {
  return String(artist ?? '')
    .split(/[,、，/&;；|]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 是否同一首歌：
 * - title 归一化后不同 → false（保留 "(Live)" 等版本差异）；
 * - title 相同后：双方 artist 都为空 → true；任一方为空另一方非空 → false
 *   （同名但艺人归属不明/不同的不算同曲）；双方非空 → 艺人 token 集合有交集即 true，
 *   完全无交集 → false（同名不同艺人算不同曲）。
 */
export const sameSong = (a: SongRef, b: SongRef): boolean => {
  const ta = normalizeTitle(a.title)
  const tb = normalizeTitle(b.title)
  if (!ta || !tb || ta !== tb) return false
  const aTokens = normalizeArtistTokens(a.artist)
  const bTokens = normalizeArtistTokens(b.artist)
  if (!aTokens.length && !bTokens.length) return true
  if (!aTokens.length || !bTokens.length) return false
  return aTokens.some(t => bTokens.includes(t))
}
