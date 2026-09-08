/**
 * 推荐引擎主进程事件：LLM 补全通道。
 * 校验参数 → llm.ts 协议实现（OpenAI-compatible / Anthropic，60s 超时，非 2xx 报错）。
 * API Key 仅随本次 IPC 参数传入，不持久化。
 */
import { RECOMMENDATION_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'
import { llmComplete } from '@main/utils/llm'

/** 字段长度上限（防止异常超长输入进入 HTTP 请求）。 */
const MAX_FIELD_LENGTH = 4096

const PROTOCOLS = ['openai-compatible', 'anthropic'] as const

const MESSAGE_ROLES = ['system', 'user', 'assistant'] as const

/** 非空且不超长的字符串校验。 */
const isValidText = (value: unknown, maxLength = MAX_FIELD_LENGTH): value is string => {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export default () => {
  mainHandle<RecommendLlmParams, RecommendLlmResult>(RECOMMENDATION_EVENT_NAME.llm_complete, async({ params }) => {
    if (!params || typeof params !== 'object') throw new Error('LLM 参数缺失')
    if (!isValidText(params.apiKey)) throw new Error('AI API Key 未配置或格式非法')
    if (!isValidText(params.model)) throw new Error('LLM model 未配置或格式非法')
    if (params.baseUrl != null && (typeof params.baseUrl !== 'string' || params.baseUrl.length > MAX_FIELD_LENGTH)) throw new Error('LLM baseUrl 格式非法')
    if (params.protocol != null && !PROTOCOLS.includes(params.protocol)) throw new Error('LLM protocol 不支持')
    if (!Array.isArray(params.messages) || !params.messages.length) throw new Error('LLM messages 不能为空')
    for (const message of params.messages) {
      if (!message || !MESSAGE_ROLES.includes(message.role) || !isValidText(message.content)) throw new Error('LLM message 格式非法')
    }
    return llmComplete(params)
  })
}
