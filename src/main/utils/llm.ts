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

/** 单次 LLM 调用超时（毫秒）。 */
const LLM_TIMEOUT = 60_000

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

const completeOpenAI = async(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: RecommendLlmMessage[],
): Promise<string> => {
  const res = await httpFetch<{ choices?: Array<{ message?: { content?: string } }> }>(`${baseUrl}/chat/completions`, {
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
      messages,
    },
  })
  assertOk(res.statusCode, res.body)
  return String(res.body?.choices?.[0]?.message?.content ?? '')
}

const completeAnthropic = async(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: RecommendLlmMessage[],
): Promise<string> => {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const rest = messages.filter(m => m.role !== 'system')
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1800,
    temperature: 0.25,
    messages: rest,
  }
  if (system) body.system = system
  const res = await httpFetch<{ content?: Array<{ type?: string, text?: string }> }>(`${baseUrl}/messages`, {
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
  return Array.isArray(res.body?.content)
    ? res.body.content.filter(item => item?.type === 'text').map(item => item?.text ?? '').join('\n')
    : ''
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
