/**
 * 跨平台种子定位纯函数（平台相似推荐 4.1）。
 *
 * 语义：在目标平台的搜索结果中为起点歌曲定位「确认是同一录音/版本」的条目。
 * 与 sameSong 的宽松同曲判定不同——本模块是种子匹配规则，要求更严：
 * - 标题（含版本标记）归一化后必须一致：清洗后同名但版本标记不同（Live/DJ/伴奏/翻唱标注等）不算匹配；
 * - 起点主艺人（首个艺人 token）必须出现在候选艺人 token 中（大小写不敏感；
 *   起点艺人缺失时无匹配证据，直接无匹配，不取搜索第一条充数）；
 * - 时长（有数据时）用于甄别版本差异：全部候选与起点时长差超过容差 → 视为版本不符，无匹配；
 *   多个通过主门禁的候选按（专辑一致 > 时长最接近 > 搜索序）择优。
 * 本模块无 lx 运行时依赖，由 vitest 直接测试。
 */

import { SEED_MATCH_DURATION_TOLERANCE_SEC } from '@common/recommendationConfig'

/** 种子匹配的目标（起点歌曲）。 */
export interface SeedMatchTarget {
  artist: string
  title: string
  album?: string | null
  /** 起点时长（秒；未知为 null/undefined）。 */
  intervalSec?: number | null
}

/** 参与匹配的候选行（平台搜索结果行的最小投影；泛型保留原始行）。 */
export interface SeedMatchRowLike {
  artist: string
  title: string
  album?: string | null
  /** 候选时长（秒；SDK 行的 interval 为 "mm:ss" 字符串，先用 parseIntervalSec 转换）。 */
  intervalSec?: number | null
}

/** 归一化：去零宽字符/BOM、全角括号转半角、trim、lower、空白折叠。 */
const normalizeText = (text?: string | null): string => {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** 标题归一化：在通用归一化之上去掉括号前后的空格（"晴天 (Live)" 与 "晴天(Live)" 视为同一写法）。 */
export const normalizeSeedTitle = (title?: string | null): string => {
  return normalizeText(title).replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')').trim()
}

/** 专辑名归一化（同 normalizeText，不做括号空格处理）。 */
const normalizeAlbum = (album?: string | null): string => {
  return normalizeText(album)
}

/** 艺人 token 切分（与 sameSong 同分隔符口径；括号别名标注拆出括号内外独立 token，
 * 如 "冯沁苑(买辣椒也用券)" → {冯沁苑(买辣椒也用券), 冯沁苑, 买辣椒也用券}）。 */
const artistTokens = (artist?: string | null): string[] => {
  const raw = String(artist ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '')
  const tokens = new Set<string>()
  for (const part of raw.split(/[,、，/&;；|]+/)) {
    for (const token of segmentVariants(part)) tokens.add(token)
  }
  return [...tokens]
}

/** 单段艺人名的变体集合（原文 + 括号内别名 + 去括号主名）。 */
const segmentVariants = (segment: string): string[] => {
  const variants = new Set<string>()
  const token = segment.trim().toLowerCase()
  if (!token) return []
  variants.add(token)
  for (const m of segment.matchAll(/[（(]([^（）()]*)[)）]/g)) {
    const inner = m[1].trim().toLowerCase()
    if (inner) variants.add(inner)
  }
  const stripped = segment.replace(/[（(][^（）()]*[)）]/g, ' ').trim().toLowerCase()
  if (stripped) variants.add(stripped)
  return [...variants]
}

/** 起点主艺人（首个艺人段）的全部变体（含括号别名；双向别名标注均可命中）。 */
const primaryArtistVariants = (artist?: string | null): string[] => {
  const raw = String(artist ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '')
  const first = raw.split(/[,、，/&;；|]+/)[0] ?? ''
  return segmentVariants(first)
}

/** "mm:ss"（或 "h:mm:ss"）/数字时长 → 秒；无效返回 null。 */
export const parseIntervalSec = (interval?: string | number | null): number | null => {
  if (interval == null) return null
  if (typeof interval === 'number') return Number.isFinite(interval) && interval > 0 ? interval : null
  const text = String(interval).trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n > 0 ? n : null
  }
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text)
  if (!m) return null
  const seg1 = Number(m[1] ?? 0)
  const seg2 = Number(m[2] ?? 0)
  const seg3 = m[3] != null ? Number(m[3]) : null
  const seconds = seg3 != null ? seg1 * 3600 + seg2 * 60 + seg3 : seg1 * 60 + seg2
  return seconds > 0 ? seconds : null
}

/** 主门禁：标题（含版本标记）一致 + 起点主艺人（含括号别名变体）命中候选艺人 token。 */
const passesPrimaryGate = (target: SeedMatchTarget, row: SeedMatchRowLike): boolean => {
  if (normalizeSeedTitle(target.title) !== normalizeSeedTitle(row.title)) return false
  const primaryVariants = primaryArtistVariants(target.artist)
  if (!primaryVariants.length) return false
  const rowTokens = artistTokens(row.artist)
  if (!rowTokens.length) return false
  return rowTokens.some(token => primaryVariants.includes(token))
}

/**
 * 严格种子匹配：在平台搜索结果行中定位与起点「确认是同一录音/版本」的条目。
 * 返回命中的原始行（泛型透传），无可靠匹配返回 null。
 * 择优顺序：时长容差过滤 → 专辑一致优先 → 时长最接近 → 搜索序（先出现者）。
 */
export const matchSeed = <T extends SeedMatchRowLike>(target: SeedMatchTarget, rows: T[]): T | null => {
  const gated = rows.filter(row => passesPrimaryGate(target, row))
  if (!gated.length) return null

  // 时长甄别（有起点时长数据时）：全部候选超容差 → 版本不符（如只剩 Live/DJ 版），无匹配
  const targetSec = parseIntervalSec(target.intervalSec)
  let candidates = gated
  if (targetSec != null) {
    const within = gated.filter(row => {
      const rowSec = parseIntervalSec(row.intervalSec)
      return rowSec != null && Math.abs(rowSec - targetSec) <= SEED_MATCH_DURATION_TOLERANCE_SEC
    })
    if (within.length) candidates = within
    else return null
  }

  const targetAlbum = normalizeAlbum(target.album)
  const score = (row: SeedMatchRowLike): number => {
    const albumMatch = targetAlbum && normalizeAlbum(row.album) === targetAlbum ? 0 : 1
    const rowSec = parseIntervalSec(row.intervalSec)
    const durationDelta = targetSec != null && rowSec != null ? Math.abs(rowSec - targetSec) : Number.MAX_SAFE_INTEGER
    return albumMatch * 1e9 + durationDelta
  }
  let best = candidates[0]
  let bestScore = Number.POSITIVE_INFINITY
  for (const row of candidates) {
    const s = score(row)
    if (s < bestScore) {
      best = row
      bestScore = s
    }
  }
  return best
}
