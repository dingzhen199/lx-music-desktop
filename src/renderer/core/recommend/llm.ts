/** 推荐 LLM 通道：共享并发上限，按单次请求重试（含输出校验），不重跑已成功的批次。 */
import { RECOMMENDATION_EVENT_NAME } from '@common/ipcNames'
import { appSetting } from '@renderer/store/setting'
import { watch } from '@common/utils/vueTools'
import { normalizeLlmConcurrency } from '@common/recommendationConfig'
import { rendererInvoke } from '@common/rendererIpc'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'

/** n 次重试 = 初始请求 + n 次；HTTP 层不再叠加重试。 */
export const LLM_MAX_RETRIES = 2
const RETRY_DELAY_MS = 800
// 模型不支持高输出预算时记住降档结果，后续批次不再重复发送必失败的请求。
const tokenLimits = new Map<string, number>()
const isTokenLimitError = (err: unknown): boolean => {
  const message = String((err as Error)?.message ?? err).toLowerCase()
  return /\b4\d\d\b/.test(message) && /max_(?:completion_)?tokens/.test(message) &&
    ['exceed', 'greater', 'larger', 'invalid', 'maximum', 'limit', 'less than', 'unsupported', '过大', '超出', '无效', '超限'].some(hint => message.includes(hint))
}
let active = 0
const waiting: Array<() => void> = []
const drain = (): void => {
  const limit = normalizeLlmConcurrency(appSetting['ai.maxConcurrentRequests'])
  while (active < limit && waiting.length) {
    active++
    waiting.shift()!()
  }
}
// 调大立即放行等待请求；调小不打断在途请求，等它们完成后再按新上限放行。
watch(() => appSetting['ai.maxConcurrentRequests'], drain)

export interface LlmCallOptions {
  isCancelled?: () => boolean
}

const checkCancelled = (options: LlmCallOptions): void => {
  if (options.isCancelled?.()) throw new Error('推荐计划已取消')
}

const invoke = async(params: RecommendLlmParams, options: LlmCallOptions): Promise<RecommendLlmResult> => {
  checkCancelled(options)
  await new Promise<void>(resolve => {
    waiting.push(resolve)
    drain()
  })
  try {
    checkCancelled(options)
    return await rendererInvoke<RecommendLlmParams, RecommendLlmResult>(RECOMMENDATION_EVENT_NAME.llm_complete, params)
  } finally {
    active--
    drain()
  }
}

/** IPC 会把主进程异常包装为文本，因此从状态码文本识别不可重试的配置/认证错误。 */
const isPermanentError = (err: unknown): boolean => {
  const status = String((err as Error)?.message ?? err).match(/\b(4\d\d)\b/)?.[1]
  return status != null && !['408', '409', '425', '429'].includes(status)
}

export const llmCompleteWithValidation = async<T>(
  params: RecommendLlmParams,
  validate: (result: RecommendLlmResult) => T,
  options: LlmCallOptions = {},
): Promise<T> => {
  const modelKey = JSON.stringify([params.protocol, params.baseUrl, params.model])
  const request = { ...params, maxTokens: params.maxTokens ?? tokenLimits.get(modelKey) ?? 384_000 }
  for (let attempt = 0; ; attempt++) {
    checkCancelled(options)
    try {
      const result = await invoke(request, options)
      checkCancelled(options)
      if (!result?.content?.trim()) throw new Error('LLM 返回空内容')
      return validate(result)
    } catch (err) {
      checkCancelled(options)
      if (attempt >= LLM_MAX_RETRIES) throw err
      if (request.maxTokens > 8192 && isTokenLimitError(err)) {
        request.maxTokens = 8192
        tokenLimits.set(modelKey, 8192)
      } else if (isPermanentError(err)) throw err
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * 2 ** attempt))
    }
  }
}

export const llmComplete = async(params: RecommendLlmParams): Promise<RecommendLlmResult> => {
  return llmCompleteWithValidation(params, result => result)
}
