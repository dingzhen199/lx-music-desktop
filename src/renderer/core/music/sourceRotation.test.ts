import { describe, expect, it } from 'vitest'
import { buildBackupApiIds, isProviderServable, type SourceRotationEnv } from './sourceRotation'

const buildEnv = (overrides: Partial<SourceRotationEnv> = {}): SourceRotationEnv => ({
  primaryApiId: 'user_api_a',
  primaryServedProviders: ['tx', 'wy'],
  backupApiIds: ['user_api_b', 'user_api_c'],
  readyApiIds: ['user_api_b', 'user_api_c'],
  servedProviders: {
    user_api_b: ['tx', 'kw'],
    user_api_c: ['wy', 'mg'],
  },
  ...overrides,
})

describe('音源轮换编排', () => {
  it('备源按用户排序输出，主源不在其列', () => {
    const env = buildEnv()
    expect(buildBackupApiIds(env, 'tx')).toStrictEqual(['user_api_b'])
    expect(buildBackupApiIds(env, 'wy')).toStrictEqual(['user_api_c'])
  })

  it('备源列表去重，重复配置的源只轮换一次', () => {
    const env = buildEnv({ backupApiIds: ['user_api_b', 'user_api_b', 'user_api_c'] })
    expect(buildBackupApiIds(env, 'tx')).toStrictEqual(['user_api_b'])
  })

  it('未就绪（初始化失败/未完成）的源被跳过', () => {
    const env = buildEnv({ readyApiIds: ['user_api_c'] })
    expect(buildBackupApiIds(env, 'tx')).toStrictEqual([])
    expect(buildBackupApiIds(env, 'wy')).toStrictEqual(['user_api_c'])
  })

  it('不服务该提供方的源被跳过', () => {
    const env = buildEnv()
    expect(buildBackupApiIds(env, 'kg')).toStrictEqual([])
  })

  it('主源出现在备源配置中时不重复轮换（主源由调用方先行尝试）', () => {
    const env = buildEnv({ backupApiIds: ['user_api_a', 'user_api_b'] })
    expect(buildBackupApiIds(env, 'tx')).toStrictEqual(['user_api_b'])
  })

  it('提供方可服务判定：主源或任一备源支持即可，不误杀仅备源支持的平台', () => {
    const env = buildEnv()
    expect(isProviderServable(env, 'tx')).toBe(true) // 主源支持
    expect(isProviderServable(env, 'kw')).toBe(true) // 仅备源 b 支持
    expect(isProviderServable(env, 'kg')).toBe(false) // 无任何源支持
  })

  it('备源为空时回退到仅主源判定', () => {
    const env = buildEnv({ backupApiIds: [], readyApiIds: [] })
    expect(isProviderServable(env, 'tx')).toBe(true)
    expect(isProviderServable(env, 'kw')).toBe(false)
  })
})
