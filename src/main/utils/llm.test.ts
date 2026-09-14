import { describe, expect, it } from 'vitest'
import { isMaxTokensError } from './llm'

describe('isMaxTokensError - max_tokens 降档重试的错误识别', () => {
  it('max_tokens 超限措辞命中', () => {
    // act & assert
    expect(isMaxTokensError(new Error('400 max_tokens is too large: 384000. Maximum is 8192'))).toBe(true)
    expect(isMaxTokensError(new Error('max_tokens 超出模型上限'))).toBe(true)
  })

  it('新模型 max_completion_tokens 参数报错也命中', () => {
    // 新模型报错只提 max_completion_tokens，不出现 max_tokens 字样
    // act & assert
    expect(isMaxTokensError(new Error("400 Unsupported parameter: 'max_completion_tokens' is not supported with this model"))).toBe(true)
  })

  it('unsupported 措辞的 max_tokens 报错命中', () => {
    // act & assert
    expect(isMaxTokensError(new Error("400 Unsupported parameter: 'max_tokens'"))).toBe(true)
  })

  it('与 token 参数无关的错误不命中', () => {
    // act & assert
    expect(isMaxTokensError(new Error('401 invalid api key'))).toBe(false)
    expect(isMaxTokensError(new Error('rate limit exceeded'))).toBe(false)
  })
})
