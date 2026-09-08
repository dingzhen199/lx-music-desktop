/**
 * 推荐引擎 LLM 通道（renderer 侧）。
 *
 * 通过 IPC 调用主进程的 recommendation_llm_complete（参数校验/超时/HTTP 转调均在主进程），
 * 返回 { content }；失败时向调用方抛错（engine 侧统一回退本地排序，不向外冒泡）。
 */
import { RECOMMENDATION_EVENT_NAME } from '@common/ipcNames'
import { rendererInvoke } from '@common/rendererIpc'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'

export const llmComplete = async(params: RecommendLlmParams): Promise<RecommendLlmResult> => {
  return rendererInvoke<RecommendLlmParams, RecommendLlmResult>(RECOMMENDATION_EVENT_NAME.llm_complete, params)
}
