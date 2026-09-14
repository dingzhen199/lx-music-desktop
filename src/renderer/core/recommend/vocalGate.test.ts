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

  it('我不喜欢纯音乐 → false', () => {
    // act & assert
    expect(wantsInstrumental('我不喜欢纯音乐')).toBe(false)
  })

  it('不要纯音乐，要华语 → false（否定前缀先行）', () => {
    // act & assert
    expect(wantsInstrumental('不要纯音乐，要华语')).toBe(false)
  })

  it('不要华语，纯音乐 → true（标点截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语，纯音乐')).toBe(true)
  })

  it('不要华语！纯音乐 → true（感叹号截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语！纯音乐')).toBe(true)
  })

  it('不要华语？纯音乐 → true（问号截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语？纯音乐')).toBe(true)
  })

  it('不要华语!纯音乐 → true（半角感叹号截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语!纯音乐')).toBe(true)
  })

  it('不要华语\\n纯音乐 → true（换行截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语\n纯音乐')).toBe(true)
  })

  it('不要华语、纯音乐 → false（顿号不截断否定链：并列列举读作“不要华语和纯音乐”，故意锁定）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语、纯音乐')).toBe(false)
  })

  it('不要华语?纯音乐 → true（半角问号截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语?纯音乐')).toBe(true)
  })

  it('不要华语\\r纯音乐 → true（回车截断否定链）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语\r纯音乐')).toBe(true)
  })

  it('不要华语：纯音乐 → false（全角冒号不截断否定链，补语读法，故意锁定）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语：纯音乐')).toBe(false)
  })

  it('不要华语:纯音乐 → false（半角冒号不截断否定链，补语读法，故意锁定）', () => {
    // act & assert
    expect(wantsInstrumental('不要华语:纯音乐')).toBe(false)
  })

  it('；纯音乐 → true（前导无前缀直接命中）', () => {
    // act & assert
    expect(wantsInstrumental('让我静一静；纯音乐')).toBe(true)
  })

  it('想听轻音乐 → true', () => {
    // act & assert
    expect(wantsInstrumental('想听轻音乐')).toBe(true)
  })

  it('轻音乐 → true', () => {
    // act & assert
    expect(wantsInstrumental('轻音乐')).toBe(true)
  })

  it('没有人声 → true', () => {
    // act & assert
    expect(wantsInstrumental('没有人声')).toBe(true)
  })

  it('不要人声 → true（“不要人声”是器乐诉求，不是否定）', () => {
    // act & assert
    expect(wantsInstrumental('不要人声')).toBe(true)
  })

  it('不要无歌词的 → false（否定语指向歌词/人声，不是器乐诉求）', () => {
    // act & assert
    expect(wantsInstrumental('不要无歌词的')).toBe(false)
  })

  it('不要无人声的 → false', () => {
    // act & assert
    expect(wantsInstrumental('不要无人声的')).toBe(false)
  })

  it('不喜欢没人声的 → false', () => {
    // act & assert
    expect(wantsInstrumental('不喜欢没人声的')).toBe(false)
  })

  it('不要没有歌词的 → false', () => {
    // act & assert
    expect(wantsInstrumental('不要没有歌词的')).toBe(false)
  })

  it('不要去掉人声 → false（否定“去掉人声”= 要求人声，不是器乐诉求）', () => {
    // act & assert
    expect(wantsInstrumental('不要去掉人声')).toBe(false)
  })

  it('去掉人声（无否定前缀）→ true（裸诉求是器乐）', () => {
    // act & assert
    expect(wantsInstrumental('去掉人声')).toBe(true)
  })

  it('喜欢人声 → false', () => {
    // act & assert
    expect(wantsInstrumental('喜欢人声')).toBe(false)
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

  it('标题含“器乐”（器乐版）→ true（元数据词表与诉求词表对齐，无需 continuity）', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '夜曲（器乐版）' })).toBe(true)
  })

  it('continuity.vocal = 0.1 → true', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '普通歌' }, { vocal: 0.1 })).toBe(true)
  })

  it('continuity.vocal = 0.8 → false', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '普通歌' }, { vocal: 0.8 })).toBe(false)
  })

  it('continuity.vocal = null → false（缺失不算低连续性，Number(null) 恒为 0）', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '人声歌曲' }, { vocal: null })).toBe(false)
  })

  it('continuity.vocal = 空串 → false（缺失不算低连续性，Number("") 恒为 0）', () => {
    // act & assert
    expect(candidateIsInstrumental({ title: '人声歌曲' }, { vocal: '' })).toBe(false)
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
