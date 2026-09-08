/**
 * 推荐引擎与主进程 IPC 的共享类型（LLM 通道）。
 * 仅类型定义，无运行时代码，main / renderer 两侧共用。
 */

/** LLM 消息（OpenAI-compatible 协议直接透传；Anthropic 协议由主进程把 system 拆分出来）。 */
export interface RecommendLlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 推荐引擎 LLM 调用参数（renderer → main）。 */
export interface RecommendLlmParams {
  /** 协议：openai-compatible | anthropic；缺省按 baseUrl/默认顺序探测。 */
  protocol?: string
  /** 服务地址（如 https://api.openai.com/v1 或 https://api.anthropic.com/v1），缺省用协议默认值。 */
  baseUrl?: string
  /** API Key，仅运行时传入，禁止写入仓库与日志。 */
  apiKey: string
  model: string
  messages: RecommendLlmMessage[]
}

/** 推荐引擎 LLM 调用结果（main → renderer）。 */
export interface RecommendLlmResult {
  content: string
}
