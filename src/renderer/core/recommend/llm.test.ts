import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appSetting } from '@renderer/store/setting'
import { rendererInvoke } from '@common/rendererIpc'
import { llmComplete, llmCompleteWithValidation } from './llm'
import type { RecommendLlmParams, RecommendLlmResult } from '@common/recommendation'
vi.mock('@renderer/store/setting', async() => ({ appSetting: (await import('vue')).reactive({ 'ai.maxConcurrentRequests': 3 }) }))
vi.mock('@common/rendererIpc', () => ({ rendererInvoke: vi.fn() }))
const invoke = vi.mocked(rendererInvoke)
const params: RecommendLlmParams = { apiKey: 'test', model: 'test', messages: [{ role: 'user', content: 'test' }] }
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); appSetting['ai.maxConcurrentRequests'] = 3 })
afterEach(() => vi.useRealTimers())

describe('共享 LLM 请求调度', () => {
  it('全局最多 3 个并发，完成一个才放行下一个', async() => {
    const resolvers: Array<(result: RecommendLlmResult) => void> = []
    invoke.mockImplementation(async() => new Promise(resolve => resolvers.push(resolve)))
    const pending = Array.from({ length: 5 }, async() => llmComplete(params))
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(3)
    resolvers[0]({ content: 'ok' })
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(4)
    resolvers[1]({ content: 'ok' })
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(5)
    resolvers.slice(2).forEach(resolve => { resolve({ content: 'ok' }) })
    await Promise.all(pending)
  })

  it('瞬时失败最多重试 2 次，800/1600ms 退避', async() => {
    invoke.mockRejectedValue(new Error('503 unavailable'))
    const result = expect(llmComplete(params)).rejects.toThrow('503')
    await vi.advanceTimersByTimeAsync(799)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(invoke).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1600)
    await result
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('认证错误直接失败', async() => {
    invoke.mockRejectedValue(new Error('Error invoking remote method: Error: 401 invalid key'))
    await expect(llmComplete(params)).rejects.toThrow('401')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('JSON 校验失败也在同一重试预算内', async() => {
    invoke.mockResolvedValueOnce({ content: 'bad json' }).mockResolvedValue({ content: '{"ok":true}' })
    const result = llmCompleteWithValidation(params, response => JSON.parse(response.content))
    await vi.advanceTimersByTimeAsync(800)
    await expect(result).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('会话取消后不继续重试', async() => {
    let cancelled = false
    invoke.mockRejectedValue(new Error('timeout'))
    const result = expect(llmCompleteWithValidation(params, x => x, { isCancelled: () => cancelled })).rejects.toThrow('取消')
    await vi.advanceTimersByTimeAsync(0)
    cancelled = true
    await vi.advanceTimersByTimeAsync(800)
    await result
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

it('输出预算降档计入同一重试上限，后续同模型复用降档预算', async() => {
  const config = { ...params, model: 'limited-model' }
  invoke.mockRejectedValueOnce(new Error('400 max_tokens exceeds maximum')).mockResolvedValue({ content: 'ok' })
  const result = llmComplete(config)
  await vi.advanceTimersByTimeAsync(800)
  await result
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(invoke.mock.calls[1][1]).toMatchObject({ maxTokens: 8192 })
  await llmComplete(config)
  expect(invoke.mock.calls[2][1]).toMatchObject({ maxTokens: 8192 })
})

it('并发设置实时生效：调大放行排队请求，调小等待在途完成', async() => {
  appSetting['ai.maxConcurrentRequests'] = 1
  const releases: Array<(result: RecommendLlmResult) => void> = []
  invoke.mockImplementation(async() => new Promise(resolve => releases.push(resolve)))
  const results = Array.from({ length: 5 }, async() => llmComplete(params))
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(1)
  appSetting['ai.maxConcurrentRequests'] = 3
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(3)
  appSetting['ai.maxConcurrentRequests'] = 1
  releases[0]({ content: 'ok' })
  releases[1]({ content: 'ok' })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(3)
  releases[2]({ content: 'ok' })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(4)
  releases[3]({ content: 'ok' })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledTimes(5)
  releases[4]({ content: 'ok' })
  await Promise.all(results)
})
