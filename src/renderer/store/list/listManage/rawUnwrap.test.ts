import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { unwrapMusicInfos } from './rawUnwrap'

const createMusicInfo = (id: string): LX.Music.MusicInfo => ({
  id,
  name: `歌曲${id}`,
  singer: '歌手',
  source: 'kw',
  interval: '03:55',
  meta: {
    songId: id,
    albumName: '专辑',
    qualitys: [],
    _qualitys: {},
  },
})

describe('unwrapMusicInfos - 逐条剥离 Vue 代理', () => {
  it('元素为 reactive 对象时逐条解包，结果可通过结构化克隆（复现 Electron IPC 拒绝克隆 Proxy）', () => {
    // arrange
    const raw = createMusicInfo('1')
    const input: LX.Music.MusicInfo[] = [reactive(raw)]
    // 输入本身携带 Proxy，structuredClone 应拒绝 —— 复现异常场景
    expect(() => structuredClone(input)).toThrow()

    // act
    const result = unwrapMusicInfos(input)

    // assert
    expect(() => structuredClone(result)).not.toThrow()
    expect(structuredClone(result)).toEqual([raw])
    expect(result[0]).toBe(raw)
  })

  it('普通数组（非代理）输入不受影响', () => {
    // arrange
    const raw = createMusicInfo('2')
    const input: LX.Music.MusicInfo[] = [raw, createMusicInfo('3')]

    // act
    const result = unwrapMusicInfos(input)

    // assert
    expect(result).not.toBe(input)
    expect(result).toEqual(input)
    expect(() => structuredClone(result)).not.toThrow()
  })
})
