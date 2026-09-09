/**
 * LLM 协议实现（主进程，仅供推荐引擎 IPC 使用）：OpenAI-compatible /chat/completions 与 Anthropic /messages。
 *
 * 语义参考 from-here（MIT）bridge/providers/{openai-compatible,anthropic,common}.js：
 * - OpenAI-compatible：Bearer 认证，messages 透传，取 choices[0].message.content；
 * - Anthropic：x-api-key + anthropic-version 头，system 拆到顶层字段，content 取 type=text 拼接；
 * - 非 2xx 抛出 `${status} ${响应片段}` 错误。
 * API Key 仅随 IPC 参数运行时传入，不落盘、不打日志。
 */
import type { RecommendLlmMessage, RecommendLlmParams, RecommendLlmProtocol, RecommendLlmResult } from '@common/recommendation'
import { httpFetch } from './request'

/** 单次 LLM 调用超时（毫秒）。LLM 首字延迟高（长上下文 + 部分模型推理慢），60s 频繁报 Headers Timeout；放宽到 3 分钟。 */
const LLM_TIMEOUT = 180_000

/** 输出 token 上限：现役模型普遍支持 1M 上下文 / 384K 输出，直接按上限配置（之前 8192 太小，推理模型易被截断）。 */
const MAX_TOKENS = 384_000
/** 模型/网关不支持大 max_tokens（4xx 报超限）时降档重试的保守值。 */
const MIN_TOKENS = 8192

/** 协议默认服务地址。 */
const DEFAULT_BASE_URLS: Record<RecommendLlmProtocol, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
}

type LlmProtocol = RecommendLlmProtocol

const normalizeBaseUrl = (baseUrl?: string): string => {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '')
}

/** 协议判定：显式 protocol 优先，否则按 baseUrl 域名隐式判定，默认 OpenAI-compatible。 */
const resolveProtocol = (protocol: RecommendLlmProtocol | undefined, baseUrl: string): LlmProtocol => {
  if (protocol === 'anthropic') return 'anthropic'
  if (protocol === 'openai-compatible') return 'openai-compatible'
  return /anthropic\.com/i.test(baseUrl) ? 'anthropic' : 'openai-compatible'
}

/** 非 2xx 抛错（与 from-here fetchJson 的错误语义一致）。 */
const assertOk = (statusCode: number | undefined, body: unknown): void => {
  const code = statusCode ?? 0
  if (code >= 200 && code < 400) return
  const snippet = typeof body === 'string'
    ? body
    : JSON.stringify(body ?? '')
  throw new Error(`${code} ${snippet.slice(0, 260)}`)
}

/** 提取消息正文：兼容 string / null / 数组（部分网关透传 Responses 风格 content 数组）。 */
const extractContentText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item?.type === 'text')
      .map((item: any) => String(item?.text ?? ''))
      .join('\n')
      .trim()
  }
  return ''
}

/** OpenAI-compatible 单个 choice 的响应结构（含推理模型常见的 reasoning 字段）。 */
interface OpenAIChatChoice {
  finish_reason?: string
  message?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
  }
}

/** 错误响应是否抱怨 max_tokens 超限/非法（需降档重试）。 */
const isMaxTokensError = (err: Error): boolean => {
  const msg = (err?.message ?? '').toLowerCase()
  return /max_tokens/.test(msg) && /exceed|greater|larger|invalid|maximum|limit|less than|过大|超出|无效|超限/.test(msg)
}

const completeOpenAI = async(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: RecommendLlmMessage[],
  maxTokens: number = MAX_TOKENS,
): Promise<string> => {
  let res: { statusCode?: number, body?: { choices?: OpenAIChatChoice[] } }
  try {
    res = await httpFetch<{ choices?: OpenAIChatChoice[] }>(`${baseUrl}/chat/completions`, {
      method: 'POST',
      timeout: LLM_TIMEOUT,
      retryNum: 0,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      json: {
        model,
        temperature: 0.25,
        max_tokens: maxTokens,
        messages,
      },
    })
    assertOk(res.statusCode, res.body)
  } catch (err) {
    // 部分模型/网关不支持大 max_tokens（返回 4xx 报超限），降档到保守值再试一次
    if (maxTokens > MIN_TOKENS && isMaxTokensError(err as Error)) {
      return completeOpenAI(baseUrl, apiKey, model, messages, MIN_TOKENS)
    }
    throw err
  }
  const choice = res.body?.choices?.[0]
  const content = extractContentText(choice?.message?.content)
  if (content) return content
  const reason = choice?.finish_reason
  const hasReasoning = extractContentText(choice?.message?.reasoning_content ?? choice?.message?.reasoning) !== ''
  throw new Error(
    reason === 'length'
      ? `LLM 输出被截断（finish_reason=length，max_tokens=${maxTokens} 被思考/推理耗尽），返回内容为空`
      : hasReasoning
        ? 'LLM 仅返回思考内容（reasoning_content），未返回结果 JSON'
        : `LLM 返回空内容（finish_reason=${reason ?? '无'}）`,
  )
}

const completeAnthropic = async(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: RecommendLlmMessage[],
  maxTokens: number = MAX_TOKENS,
): Promise<string> => {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const rest = messages.filter(m => m.role !== 'system')
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature: 0.25,
    messages: rest,
  }
  if (system) body.system = system
  let res: { statusCode?: number, body?: { content?: Array<{ type?: string, text?: string }> } }
  try {
    res = await httpFetch<{ content?: Array<{ type?: string, text?: string }> }>(`${baseUrl}/messages`, {
      method: 'POST',
      timeout: LLM_TIMEOUT,
      retryNum: 0,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      json: body,
    })
    assertOk(res.statusCode, res.body)
  } catch (err) {
    if (maxTokens > MIN_TOKENS && isMaxTokensError(err as Error)) {
      return completeAnthropic(baseUrl, apiKey, model, messages, MIN_TOKENS)
    }
    throw err
  }
  const blocks = Array.isArray(res.body?.content) ? res.body.content : []
  const text = blocks
    .filter(item => item?.type === 'text')
    .map(item => item?.text ?? '')
    .join('\n')
    .trim()
  if (text) return text
  const hasThinking = blocks.some(item => item?.type === 'thinking')
  throw new Error(hasThinking
    ? 'LLM 返回内容为空（仅思考块 thinking、无结果文本）'
    : 'LLM 返回空内容（响应 content 无 text 块）')
}

/** 完成一次 LLM 补全，返回 { content }；未配置 API Key 直接抛明确错误。 */
export const llmComplete = async(params: RecommendLlmParams): Promise<RecommendLlmResult> => {
  if (!params?.apiKey) throw new Error('AI API Key 未配置（调试入口请通过 explore 的 options.ai 运行时传入）')
  if (!params.model) throw new Error('LLM model 未配置')
  if (!Array.isArray(params.messages) || !params.messages.length) throw new Error('LLM messages 不能为空')

  const baseUrl = normalizeBaseUrl(params.baseUrl) || DEFAULT_BASE_URLS[resolveProtocol(params.protocol, '')]
  const protocol = resolveProtocol(params.protocol, baseUrl)
  const content = protocol === 'anthropic'
    ? await completeAnthropic(baseUrl, params.apiKey, params.model, params.messages)
    : await completeOpenAI(baseUrl, params.apiKey, params.model, params.messages)
  return { content }
}
