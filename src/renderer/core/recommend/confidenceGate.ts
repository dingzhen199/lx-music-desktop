/**
 * 低置信全半径拦截守门（探索电台 TT-3 新增，D5 附随项）。
 *
 * AI 排序对候选的连续性判定依赖模型先验知识：confidence=low 意味着模型
 * 不认识该曲目，行内 distance/continuity 等字段均不可信（spec 剩余风险：
 * AC6 只缓解冷歌幻觉而非根治）。旧口径“近距离（radius<=45）才拦低置信”
 * 会让远距探索电台放进模型不认识的曲目，违背探索弧线的可信排序前提，
 * 故改为全半径拦截（谓词不再携带半径参数，近/中/远三档是同一调用）。
 * 判定本身是字符串口径（仅 'low' 小写化后相等才拦），与其塞进 engine.ts
 * （依赖 electron/IPC，无法被 vitest 加载），不如参照 vocalGate.ts 先例
 * 独立成守门纯函数，由 vitest 直接钉死语义。
 * judgment.ts / prompts.ts / gates.ts 保持只读。
 */

/**
 * 该候选行是否因低置信应被拦截：
 * 仅 confidence 小写化后严格等于 'low' 才拦；
 * high/medium/缺失（空串/null/undefined）/非字符串一律放行。
 */
export const shouldBlockLowConfidence = (confidence: unknown): boolean => {
  // null/undefined 先归空串再 String，与 vocalGate 的 String(x ?? '') 口径一致；
  // 'null'/'undefined' 字面量本就不等于 'low'，归一只是避免依赖 String 转换的隐式字面量
  return String(confidence ?? '').toLowerCase() === 'low'
}
