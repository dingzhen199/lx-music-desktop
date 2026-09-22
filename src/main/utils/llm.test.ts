import { beforeEach, describe, expect, it, vi } from 'vitest'
import { httpFetch } from './request'
import { llmComplete } from './llm'
import type { RecommendLlmParams } from '@common/recommendation'

vi.mock('./request', () => ({ httpFetch: vi.fn() }))
const fetchMock = vi.mocked(httpFetch)
const params: RecommendLlmParams = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://example.test/v1/',
  messages: [{ role: 'system', content: '固定规则' }, { role: 'user', content: '歌曲' }],
}
beforeEach(() => vi.clearAllMocks())

describe('LLM 协议请求', () => {
  it('OpenAI 保留消息顺序，输出预算有界且 HTTP 不叠加重试', async() => {
    fetchMock.mockResolvedValue({ statusCode: 200, body: { choices: [{ message: { content: ' {} ' } }] } } as any)
    await expect(llmComplete(params)).resolves.toEqual({ content: '{}' })
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({
      retryNum: 0, json: expect.objectContaining({ max_tokens: 384_000, messages: params.messages }),
    }))
  })

  it('Anthropic 在固定 system 前缀设置缓存断点', async() => {
    fetchMock.mockResolvedValue({ statusCode: 200, body: { content: [{ type: 'text', text: '{}' }] } } as any)
    await expect(llmComplete({ ...params, protocol: 'anthropic' })).resolves.toEqual({ content: '{}' })
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/messages', expect.objectContaining({
      json: expect.objectContaining({
        system: [{ type: 'text', text: '固定规则', cache_control: { type: 'ephemeral' } }],
        messages: [params.messages[1]],
      }),
    }))
  })

  it.each([302, 400, 401, 429, 500])('HTTP %s 只请求一次并抛给统一重试层', async(statusCode) => {
    fetchMock.mockResolvedValue({ statusCode, body: { error: 'failed' } } as any)
    await expect(llmComplete(params)).rejects.toThrow(String(statusCode))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('OpenAI 即使有正文也拒绝被截断的结果', async() => {
    fetchMock.mockResolvedValue({ statusCode: 200, body: { choices: [{ message: { content: '{"partial":true}' }, finish_reason: 'length' }] } } as any)
    await expect(llmComplete(params)).rejects.toThrow('截断')
  })

  it('Anthropic 拒绝 max_tokens 截断', async() => {
    fetchMock.mockResolvedValue({ statusCode: 200, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] } } as any)
    await expect(llmComplete({ ...params, protocol: 'anthropic' })).rejects.toThrow('截断')
  })
})
