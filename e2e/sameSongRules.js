/**
 * e2e 同曲规则独立副本（CommonJS）。
 *
 * 本模块**刻意**不 import src/renderer/core/recommend/sameSong.ts：
 * 作为 e2e 探针（pathProbe/deep 的 D3c 路径去重检查）的独立 oracle，
 * 若直接复用被测实现，实现本身出错时 oracle 会跟着一起错、无法发现。
 * 因此三个函数与 src 版本语义一致但物理独立。
 *
 * 漂移防护：e2e/sameSongRules.test.js 的一致性测试用共享语料逐例比对
 * 本副本与 src/renderer/core/recommend/sameSong.ts 的 sameSong 判定；
 * 修改任何一侧都必须让该测试保持通过（不一致会直接红）。
 */

/**
 * 标题归一化：trim + lower + 空白折叠（与 src/renderer/core/recommend/sameSong.ts 同规则）。
 */
function normalizeTitleText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * artist 归一化：常见分隔符 split + trim + lower + 去空
 * （与 sameSong.ts 同规则，分隔符 /[,、，/&;；|]+/）。
 */
function artistTokens(artist) {
  return String(artist ?? '')
    .toLowerCase()
    .split(/[,、，/&;；|]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 与 sameSong.ts 语义一致：title 归一化相同 +（双方都空 artist，或 artist token 有交集）→ 同曲。
 * 单方 artist 空、另一方非空 → false（同名不同艺人归属不判同曲）。
 */
function sameSongText(a, b) {
  const ta = normalizeTitleText(a?.title)
  const tb = normalizeTitleText(b?.title)
  if (!ta || !tb || ta !== tb) return false
  const at = artistTokens(a?.artist)
  const bt = artistTokens(b?.artist)
  if (!at.length && !bt.length) return true
  if (!at.length || !bt.length) return false
  return at.some(t => bt.includes(t))
}

module.exports = { normalizeTitleText, artistTokens, sameSongText }
