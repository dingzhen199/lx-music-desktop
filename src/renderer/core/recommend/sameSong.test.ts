/**
 * sameSong 同曲判定的纯函数测试。
 *
 * 背景：音乐平台对同一首歌返回的 artist 串顺序/分隔符/合作者数量可能不同
 * （如 Möbius 一条 artist="Benjamin, Laco, 薄野弘之"，另一条 "mpi, Laco, Benjamin, 薄野弘之"；
 * Inferno 两条 artist 相同但 id 不同），导致同曲以多 id/artist 变体穿过去重。
 */
import { describe, expect, it } from 'vitest'
import { sameSong } from './sameSong'

describe('sameSong - 同曲判定', () => {
  it('截图真实变体：合作者数量/顺序不同 → true', () => {
    // act & assert
    expect(sameSong(
      { artist: 'Benjamin, Laco, 薄野弘之', title: 'Möbius' },
      { artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius' },
    )).toBe(true)
  })

  it('分隔符差异（、 vs ,） → true', () => {
    // act & assert
    expect(sameSong(
      { artist: 'Benjamin、薄野弘之、mpi', title: 'Möbius' },
      { artist: 'Benjamin, 薄野弘之, mpi', title: 'Möbius' },
    )).toBe(true)
  })

  it('大小写/首尾空格差异 → true', () => {
    // act & assert
    expect(sameSong(
      { artist: '  Adele ', title: ' Hello  ' },
      { artist: 'adele', title: 'hello' },
    )).toBe(true)
  })

  it('同名但艺人完全无交集 → false', () => {
    // act & assert
    expect(sameSong(
      { artist: '周杰伦', title: '晴天' },
      { artist: '王菲', title: '晴天' },
    )).toBe(false)
  })

  it('标题不同（含 (Live) 版本差异） → false', () => {
    // act & assert
    expect(sameSong(
      { artist: 'Adele', title: 'Hello' },
      { artist: 'Adele', title: 'Hello (Live)' },
    )).toBe(false)
  })

  it('双方 artist 均为空、title 相同 → true', () => {
    // act & assert
    expect(sameSong(
      { artist: '', title: '纯音乐' },
      { artist: '', title: '纯音乐' },
    )).toBe(true)
  })

  it('任一方 artist 为空、另一方非空 → false（同名不同艺人归属不判同曲）', () => {
    // act & assert
    expect(sameSong(
      { artist: '', title: '晴天' },
      { artist: '周杰伦', title: '晴天' },
    )).toBe(false)
  })

  it('完全相同的 id/artist/title → true', () => {
    // act & assert
    expect(sameSong(
      { artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius' },
      { artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius' },
    )).toBe(true)
  })
})
