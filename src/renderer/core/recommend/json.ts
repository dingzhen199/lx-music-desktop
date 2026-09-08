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
