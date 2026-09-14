import { describe, expect, it } from 'vitest'
import { buildRequestDispatcher } from './request'

describe('buildRequestDispatcher - 请求级 dispatcher 构建条件', () => {
  it('不传任何选项时不构建（走全局 dispatcher）', () => {
    // act & assert
    expect(buildRequestDispatcher({})).toBeUndefined()
  })

  it('自定义 maxRedirect 时构建', () => {
    // act & assert
    expect(buildRequestDispatcher({ maxRedirect: 3 })).toBeDefined()
  })

  it('仅传 retryNum 时也构建独立 dispatcher（否则全局重试拦截器会绕过 retryNum 生效）', () => {
    // act & assert
    expect(buildRequestDispatcher({ retryNum: 0 })).toBeDefined()
    expect(buildRequestDispatcher({ retryNum: 5 })).toBeDefined()
  })
})
