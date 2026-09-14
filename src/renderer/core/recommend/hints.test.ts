/**
 * 空结果文案优先级纯函数测试（S3）。
 *
 * 语义契约：用户要求器乐 → 器乐文案最优先（不再被通用文案抢先）；
 * 否则有语言硬约束 → 硬约束文案；否则通用文案。
 * 两个抛出阶段（召回池为空 pool / 排序守门后为空 ranked）各自保留既有措辞。
 */
import { describe, expect, it } from 'vitest'
import { emptyResultMessage } from './hints'

const INSTRUMENTAL = '当前约束下没有找到器乐/纯音乐类的后续歌曲，可以尝试松开距离或换一种描述。'
const EXCLUDED_POOL = '当前硬约束下没有找到可用候选。不会退回被你排除的音乐来凑数，请稍后重试。'
const EXCLUDED_RANKED = '当前硬约束下没有足够可靠的后续歌曲，不会用不符合要求的歌凑数；可以换一种描述或稍后重试。'
const GENERIC_POOL = '这次没有找到能加入播放队列的后续歌曲，请稍后重试，或把探索距离稍微打开一点。'
const GENERIC_RANKED = '候选全部被当前边界过滤掉了，可以把距离稍微打开一点。'

describe('emptyResultMessage - 空结果文案优先级', () => {
  it('要求器乐 → 器乐文案（即使同时有语言硬约束也最优先）', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: true, excludedLanguages: ['华语'], stage: 'ranked' })).toBe(INSTRUMENTAL)
  })

  it('要求器乐 + 召回池为空 → 器乐文案（不再被通用文案抢先）', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: true, excludedLanguages: [], stage: 'pool' })).toBe(INSTRUMENTAL)
  })

  it('未要求器乐 + 语言硬约束（排序后为空）→ 硬约束文案', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: ['华语'], stage: 'ranked' })).toBe(EXCLUDED_RANKED)
  })

  it('未要求器乐 + 语言硬约束 + 召回池为空 → 硬约束文案（原措辞）', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: ['华语'], stage: 'pool' })).toBe(EXCLUDED_POOL)
  })

  it('无器乐要求且无语言硬约束（排序后为空）→ 通用文案', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: [], stage: 'ranked' })).toBe(GENERIC_RANKED)
  })

  it('无器乐要求且无语言硬约束 + 召回池为空 → 通用文案（原措辞）', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: null, stage: 'pool' })).toBe(GENERIC_POOL)
  })

  it('excludedLanguages 为 undefined/空数组/null 均视作无语言约束', () => {
    // act & assert
    expect(emptyResultMessage({ wantsInstrumental: false })).toBe(GENERIC_RANKED)
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: [] })).toBe(GENERIC_RANKED)
    expect(emptyResultMessage({ wantsInstrumental: false, excludedLanguages: null })).toBe(GENERIC_RANKED)
  })
})
