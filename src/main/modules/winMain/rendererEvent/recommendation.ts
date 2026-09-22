/**
 * 推荐引擎主进程事件：LLM 补全通道。
 * 校验参数（validateLlmParams，纯函数）→ llm.ts 协议实现（OpenAI-compatible / Anthropic，180s 超时，非 2xx 报错）。
 * API Key 仅随本次 IPC 参数传入，不持久化。
 */
import { RECOMMENDATION_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'
import { llmComplete } from '@main/utils/llm'
import { validateLlmParams } from './llmValidate'

export default () => {
  mainHandle<RecommendLlmParams, RecommendLlmResult>(RECOMMENDATION_EVENT_NAME.llm_complete, async({ params }) => {
    validateLlmParams(params)
    return llmComplete(params)
  })
}
