/**
 * LLM 输出 JSON 的健壮解析纯逻辑模块。
 *
 * 语义移植自 from-here（MIT）bridge/server.js 的 looseParse / extractJsonChunks / parseCliOutput：
 * - looseParse：直接解析失败时取首尾括号切片再试，仍失败回退 {raw}；
 * - extractJsonChunks：逐字符扫描平衡的 {} / [] 块（跳过引号内字符）逐个解析；
 * - parseLooseJson：先整体，失败后多块提取，单块取块、多块包 {chunks}，全败回退 {raw}。
 * 本模块不依赖任何 lx 运行时模块，由 vitest 直接测试。
 */

/** 直接解析，失败时尝试首尾括号切片，仍失败回退 {raw}。 */
export const looseParse = (text: unknown): unknown => {
  const s = String(text ?? '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {}
  for (const [a, b] of [['{', '}'], ['[', ']']] as const) {
    const i = s.indexOf(a)
    const j = s.lastIndexOf(b)
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1))
      } catch {}
    }
  }
  return { raw: s }
}

/** 剥离 ANSI 转义序列（LLM 输出可能带颜色码）。 */
export const stripAnsi = (text: string): string => {
  // eslint-disable-next-line no-control-regex -- 必须匹配 ESC(\x1B) 控制序列，这是 from-here stripAnsi 的语义
  return String(text ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

/** 提取文本内所有可解析的平衡 JSON 块。 */
export const extractJsonChunks = (text: unknown): unknown[] => {
  const s = stripAnsi(String(text ?? ''))
  const out: unknown[] = []
  let start = -1
  let depth = 0
  let quote = ''
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (start < 0) {
      if (ch === '{' || ch === '[') {
        start = i
        depth = 1
        quote = ''
        esc = false
      }
      continue
    }
    if (quote) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (depth === 0) {
      const chunk = s.slice(start, i + 1)
      try {
        out.push(JSON.parse(chunk))
      } catch {}
      start = -1
    }
  }
  return out
}

/**
 * 组合解析：整体 → 单块 → 多块 → {raw} 回退。
 * 与 from-here parseCliOutput 的 stdout 路径语义一致（不含 stderr 分支）。
 */
export const parseLooseJson = (text: unknown): unknown => {
  const direct = looseParse(text)
  if (direct && !(typeof direct === 'object' && 'raw' in direct && typeof (direct as { raw: unknown }).raw === 'string')) return direct
  const chunks = extractJsonChunks(text)
  if (chunks.length === 1) return chunks[0]
  if (chunks.length > 1) return { chunks }
  return direct
}

/** 候选行可能的键名（按优先级依次尝试）。 */
const RANKING_KEYS = ['ranking', 'rows', 'results', 'candidates', 'sequence', 'key'] as const

/** 递归提取候选行：数组直接用；对象按键名优先级取；字符串先 parseLooseJson 再重复本步。 */
const pickRankingRows = (value: unknown, depth: number): unknown[] | null => {
  if (depth > 6) return null
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = parseLooseJson(value)
    if (parsed === value) return null
    return pickRankingRows(parsed, depth + 1)
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of RANKING_KEYS) {
      if (!(key in obj)) continue
      const rows = pickRankingRows(obj[key], depth + 1)
      if (rows) return rows
    }
    // 多块输出（parseLooseJson 的 {chunks} 包）：逐块递归、拼接
    if (Array.isArray(obj.chunks)) {
      const merged: unknown[] = []
      for (const chunk of obj.chunks) {
        const rows = pickRankingRows(chunk, depth + 1)
        if (rows) merged.push(...rows)
      }
      if (merged.length) return merged
    }
  }
  return null
}

/**
 * 提取 ranking 候选行（LLM 输出健壮化）：
 * 1) 字符串输入先 parseLooseJson（结构体输入直接使用）；
 * 2) 数组直接用；
 * 3) 对象按 ranking/rows/results/candidates/sequence/key 依次取第一个数组
 *    （字符串值先 parseLooseJson 再重复本步，无法解析则跳过）；
 * 4) {chunks:[…]} 多块递归拼接并去重；
 * 5) 仅保留非空对象行；找不到返回 []。
 */
export const extractRankingRows = (content: unknown): unknown[] => {
  const parsed = typeof content === 'string' ? parseLooseJson(content) : content
  const rows = pickRankingRows(parsed, 0)
  if (!rows) return []
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const row of rows) {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) continue
    if (Object.keys(row).length === 0) continue
    const key = JSON.stringify(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}
