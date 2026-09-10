/**
 * 空结果提示文案选择（S3，纯函数）。
 *
 * 背景：engine.exploreOnce 有两个“空结果”抛出点——召回池过滤后为空（pool）、
 * 排序与守门后为空（ranked）。原先两处各自内联三元表达式，器乐硬门在第二个
 * 抛出点之后才执行，导致“用户要求器乐 + 排序后为空”永远不会命中器乐专属文案。
 * 本模块把文案选择收敛为单一优先级：
 *   要求器乐 → 器乐文案；否则有语言硬约束 → 硬约束文案；否则通用文案。
 * 两个阶段各自的既有措辞原样保留（不做文案/i18n 改动）。
 * 无任何 lx 运行时依赖，由 vitest 直接测试。
 */

/** 空结果发生的阶段：pool=召回池过滤后为空；ranked=排序/守门后为空（缺省）。 */
export type EmptyResultStage = 'pool' | 'ranked'

/** 空结果文案选项。 */
export interface EmptyResultOptions {
  /** 用户是否显式要求器乐/纯音乐（wantsInstrumental(stateWords)）。 */
  wantsInstrumental: boolean
  /** 语言硬约束（“不要华语”等已解析；空/null 视为无约束）。 */
  excludedLanguages?: string[] | null
  /** 空结果阶段（决定同优先级下的措辞；缺省 ranked）。 */
  stage?: EmptyResultStage
}

const INSTRUMENTAL_MESSAGE = '当前约束下没有找到器乐/纯音乐类的后续歌曲，可以尝试松开距离或换一种描述。'
const EXCLUDED_MESSAGES: Record<EmptyResultStage, string> = {
  pool: '当前硬约束下没有找到可用候选。不会退回被你排除的音乐来凑数，请稍后重试。',
  ranked: '当前硬约束下没有足够可靠的后续歌曲，不会用不符合要求的歌凑数；可以换一种描述或稍后重试。',
}
const GENERIC_MESSAGES: Record<EmptyResultStage, string> = {
  pool: '这次没有找到能加入播放队列的后续歌曲，请稍后重试，或把探索距离稍微打开一点。',
  ranked: '候选全部被当前边界过滤掉了，可以把距离稍微打开一点。',
}

/**
 * 空结果文案：器乐诉求最优先（修复“器乐文案不可达”），
 * 其次语言硬约束，最后通用文案；措辞按阶段区分。
 */
export const emptyResultMessage = (options: EmptyResultOptions): string => {
  if (options.wantsInstrumental) return INSTRUMENTAL_MESSAGE
  const stage: EmptyResultStage = options.stage ?? 'ranked'
  if (options.excludedLanguages?.length) return EXCLUDED_MESSAGES[stage]
  return GENERIC_MESSAGES[stage]
}
