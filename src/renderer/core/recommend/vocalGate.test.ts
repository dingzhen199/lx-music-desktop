/**
 * 器乐/纯音乐反向硬门纯逻辑测试（诉求 1 新增）。
 *
 * 覆盖：wantsInstrumental 语义判定、candidateIsInstrumental 元数据/AI 连续性信号、
 * passesInstrumentalGate 组合判定。
 */
import { describe, expect, it } from 'vitest'
import { candidateIsInstrumental, passesInstrumentalGate, wantsInstrumental } from './vocalGate'

describe('wantsInstrumental - 是否要求纯音乐/器乐', () => {
  it('纯音乐 → true', () => {
    // act & assert
    expect(wantsInstrumental('纯音乐')).toBe(true)
  })

  it('想听纯音乐 → true', () => {
    // act & assert
    expect(wantsInstrumental('想听纯音乐')).toBe(true)
  })

  it('来点器乐 → true', () => {
    // act & assert
    expect(wantsInstrumental('来点器乐')).toBe(true)
  })

  it('无人声 → true', () => {
    // act & assert
    expect(wantsInstrumental('无人声')).toBe(true)
  })

  it('不要纯音乐 → false', () => {
    // act & assert
    expect(wantsInstrumental('不要纯音乐')).toBe(false)
  })

  it('别来纯音乐 → false', () => {
    // act & assert
    expect(wantsInstrumental('别来纯音乐')).toBe(false)
  })

  it('喜欢林俊杰 → false', () => {
    // act & assert
    expect(wantsInstrumental('喜欢林俊杰')).toBe(false)
  })

  it('空串 → false', () => {
    // act & assert
    expect(wantsInstrumental('')).toBe(false)
  })
})

describe('candidateIsInstrumental - 候选器乐信号', () => {
  it('标题含“纯音乐” → true', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '月光下的海（纯音乐）' })).toBe(true)
  })

  it('标题含 instrumental → true', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: 'Midnight Piano (instrumental)' })).toBe(true)
  })

  it('标题含“无人声” → true', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '夜的序章（无人声）' })).toBe(true)
  })

  it('continuity.vocal = 0.1 → true', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '普通歌' }, { vocal: 0.1 })).toBe(true)
  })

  it('continuity.vocal = 0.8 → false', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '普通歌' }, { vocal: 0.8 })).toBe(false)
  })

  it('无任何器乐信号 → false', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '普通歌曲', artist: '普通歌手' })).toBe(false)
  })
})

describe('passesInstrumentalGate - 组合判定', () => {
  it('无要求时任何候选都通过', () => {
    // act & assert
    expect(passesInstrumentalGate({ title: '普通歌曲' }, '')).toBe(true)
  })

  it('要求纯音乐 + 人声候选 → false', () => {
    // act & assert
    expect(passesInstrumentalGate({ title: '人声歌曲' }, '想听纯音乐')).toBe(false)
  })

  it('要求纯音乐 + 器乐信号候选 → true', () => {
    // act & assert
    expect(passesInstrumentalGate({ title: '纯音乐' }, '想听纯音乐')).toBe(true)
  })
})
