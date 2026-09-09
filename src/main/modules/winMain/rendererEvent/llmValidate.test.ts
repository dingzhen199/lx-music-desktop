import { describe, expect, it } from 'vitest'
import { validateLlmParams } from './llmValidate'

const validParams = () => ({
  apiKey: 'sk-test-123456',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: '你是一名排序助手' },
    { role: 'user', content: '请对候选排序' },
  ],
})

describe('validateLlmParams - LLM 参数校验', () => {
  it('合法小参数通过（含显式 protocol/baseUrl/全部三种 role）', () => {
    // act & assert
    expect(() => {
      validateLlmParams({
        ...validParams(),
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'user' },
          { role: 'assistant', content: 'assistant' },
        ],
      })
    }).not.toThrow()
  })
  it('protocol/baseUrl 缺省时通过（按域名隐式判定，默认 OpenAI-compatible）', () => {
    // act & assert
    expect(() => {
      validateLlmParams({
        ...validParams(),
        baseUrl: '',
      })
    }).not.toThrow()
  })
  it('content 长度 10000（超过旧 4096 上限）的排序消息通过 · 本次回归核心用例', () => {
    // arrange
    const params = {
      ...validParams(),
      messages: [
        { role: 'system', content: '排序系统提示词' },
        { role: 'user', content: 'x'.repeat(10_000) },
      ],
    }
    // act & assert
    expect(() => { validateLlmParams(params) }).not.toThrow()
  })
  it('content 长度恰好为新上限 1000000 时通过', () => {
    // arrange
    const params = {
      ...validParams(),
      messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }],
    }
    // act & assert
    expect(() => { validateLlmParams(params) }).not.toThrow()
  })
  it('content 长度超过新上限 1000000 时拒绝', () => {
    // arrange
    const params = {
      ...validParams(),
      messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }],
    }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM message 格式非法')
  })
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'not-an-object'],
    ['数字', 42],
  ])('非对象参数（%s）拒绝', (_label, value) => {
    // act & assert
    expect(() => { validateLlmParams(value) }).toThrow('LLM 参数缺失')
  })
  it('缺 apiKey 拒绝', () => {
    // arrange
    const params = { ...validParams(), apiKey: '' }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('AI API Key 未配置或格式非法')
  })
  it('apiKey 超长（>4096）拒绝', () => {
    // arrange
    const params = { ...validParams(), apiKey: 'k'.repeat(4097) }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('AI API Key 未配置或格式非法')
  })
  it('缺 model 拒绝', () => {
    // arrange
    const params = { ...validParams(), model: '' }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM model 未配置或格式非法')
  })
  it('baseUrl 超长（>4096）拒绝', () => {
    // arrange
    const params = { ...validParams(), baseUrl: `https://example.com/${'a'.repeat(4097)}` }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM baseUrl 格式非法')
  })
  it('非法 protocol 拒绝', () => {
    // arrange
    const params = { ...validParams(), protocol: 'google' }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM protocol 不支持')
  })
  it('空 messages 数组拒绝', () => {
    // arrange
    const params = { ...validParams(), messages: [] }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM messages 不能为空')
  })
  it('messages 非数组拒绝', () => {
    // arrange
    const params = { ...validParams(), messages: 'not-an-array' }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM messages 不能为空')
  })
  it('messages 内嵌套非对象条目拒绝', () => {
    // arrange
    const withMessage = (message: unknown) => ({ ...validParams(), messages: [message] })
    // act & assert
    for (const bad of [null, 42, 'text', true, ['nested']]) {
      expect(() => { validateLlmParams(withMessage(bad)) }).toThrow('LLM message 格式非法')
    }
  })
  it('非法 role 拒绝', () => {
    // arrange
    const params = { ...validParams(), messages: [{ role: 'developer', content: 'x' }] }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM message 格式非法')
  })
  it.each([
    ['content 非字符串', { role: 'user', content: 123 }],
    ['content 为空串', { role: 'user', content: '' }],
  ])('%s 拒绝', (_label, message) => {
    // arrange
    const params = { ...validParams(), messages: [message] }
    // act & assert
    expect(() => { validateLlmParams(params) }).toThrow('LLM message 格式非法')
  })
})
