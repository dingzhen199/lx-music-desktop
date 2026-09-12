import { describe, expect, it } from 'vitest'
import { stripSensitiveSetting } from './sensitiveSetting'

const buildSetting = () => ({
  'ai.enable': true,
  'ai.provider': 'openai-compatible',
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': 'sk-secret-key',
  'ai.model': 'gpt-4o-mini',
  'common.lang': 'zh-cn',
} as unknown as LX.AppSetting)

describe('stripSensitiveSetting - 备份导出剔除 API Key', () => {
  it('apiKey 被清空，其余 ai 配置保留', () => {
    // arrange
    const setting = buildSetting()

    // act
    const result = stripSensitiveSetting(setting)

    // assert
    expect(result['ai.apiKey']).toBe('')
    expect(result['ai.model']).toBe('gpt-4o-mini')
    expect(result['ai.baseUrl']).toBe('https://api.openai.com/v1')
  })

  it('不改动入参对象', () => {
    // arrange
    const setting = buildSetting()

    // act
    stripSensitiveSetting(setting)

    // assert
    expect(setting['ai.apiKey']).toBe('sk-secret-key')
  })

  it('apiKey 本就为空时原样返回副本', () => {
    // arrange
    const setting = buildSetting()
    setting['ai.apiKey'] = ''

    // act
    const result = stripSensitiveSetting(setting)

    // assert
    expect(result['ai.apiKey']).toBe('')
    expect(result['ai.model']).toBe('gpt-4o-mini')
  })
})
