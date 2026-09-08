/**
 * 推荐引擎主进程事件：LLM 补全通道。
 * 校验参数 → llm.ts 协议实现（OpenAI-compatible / Anthropic，60s 超时，非 2xx 报错）。
 * API Key 仅随本次 IPC 参数传入，不持久化。
 */
import { RECOMMENDATION_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'
import { llmComplete } from '@main/utils/llm'


export default () => {
  mainHandle<RecommendLlmParams, RecommendLlmResult>(RECOMMENDATION_EVENT_NAME.llm_complete, async({ params }) => {
    if (!params || typeof params !== 'object') throw new Error('LLM 参数缺失')
    if (!params.apiKey) throw new Error('AI API Key 未配置')
    if (!params.model) throw new Error('LLM model 未配置')
    if (!Array.isArray(params.messages) || !params.messages.length) throw new Error('LLM messages 不能为空')
    return llmComplete(params)
  })
}
