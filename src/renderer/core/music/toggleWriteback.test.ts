import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PlayerState from '@renderer/store/player/state'
import type { writebackToggleMusicInfo } from './toggleWriteback'

const mocks = vi.hoisted(() => ({
  list: [] as LX.Music.MusicInfo[],
  playNext: vi.fn(),
  stop: vi.fn(),
  setProgress: vi.fn(),
  changed: vi.fn(),
  delay: 0,
}))
const waitForIpc = async() => {
  if (mocks.delay) await new Promise(resolve => setTimeout(resolve, mocks.delay))
}
vi.mock('@renderer/core/player', () => ({ playNext: mocks.playNext, stop: mocks.stop }))
vi.mock('@renderer/store/download/state', () => ({ downloadList: [] }))
vi.mock('@renderer/store/player/playProgress', () => ({ setProgress: mocks.setProgress }))
vi.mock('@renderer/store/list/listManage', () => ({
  allMusicList: new Map([['test-list', mocks.list]]),
  defaultList: { id: 'default' },
  loveList: { id: 'love' },
  userLists: [{ id: 'test-list' }],
  removeListMusics: async({ ids }: LX.List.ListActionMusicRemove) => {
    await waitForIpc()
    for (let i = mocks.list.length - 1; i >= 0; i--) {
      if (ids.includes(mocks.list[i].id)) mocks.list.splice(i, 1)
    }
    mocks.changed()
  },
}))
vi.mock('@renderer/store/list/action', () => ({
  getListMusicsFromCache: () => mocks.list,
  addListMusics: async(id: string, items: LX.Music.MusicInfo[]) => {
    await waitForIpc()
    mocks.list.push(...items.filter(item => !mocks.list.some(existing => existing.id === item.id)))
    mocks.changed()
  },
  updateListMusicsPosition: async({ ids, position }: LX.List.ListActionMusicUpdatePosition) => {
    await waitForIpc()
    const index = mocks.list.findIndex(item => ids.includes(item.id))
    const [item] = mocks.list.splice(index, 1)
    mocks.list.splice(position, 0, item)
    mocks.changed()
  },
}))

const song = (id: string, source: 'kw' | 'wy' = 'kw'): LX.Music.MusicInfoOnline => ({
  id,
  source,
  name: 'Song',
  singer: 'Artist',
  interval: '03:00',
  meta: { songId: id, albumName: 'Album', qualitys: [], _qualitys: {} },
})

let events: EventEmitter
let player: typeof PlayerState
let writeback: typeof writebackToggleMusicInfo
beforeEach(async() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.list.splice(0)
  mocks.delay = 0
  events = new EventEmitter()
  vi.stubGlobal('window', { lxData: {}, lx: { isPlayedStop: false }, app_event: events })
  mocks.changed.mockImplementation(() => events.emit('myListUpdate', ['test-list']))
  player = await import('@renderer/store/player/state')
  const { default: useWatchList } = await import('@renderer/core/useApp/usePlayer/useWatchList')
  writeback = (await import('./toggleWriteback')).writebackToggleMusicInfo
  useWatchList()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('自动换源写回与播放器列表监听', () => {
  it('慢速 IPC 的每一步都保留当前曲目，不跳歌、不清进度或歌词', async() => {
    const original = song('kw_a')
    const replacement = song('wy_a', 'wy')
    mocks.list.push(original, song('kw_b'))
    Object.assign(player.playMusicInfo, { listId: 'test-list', musicInfo: original, isTempPlay: false })
    Object.assign(player.playInfo, { playerListId: 'test-list', playIndex: 0, playerPlayIndex: 0 })
    player.musicInfo.lrc = 'existing lyric'
    player.playedList.push({ listId: 'test-list', musicInfo: original, isTempPlay: false })
    const toggled = vi.fn()
    events.on('musicToggled', toggled)
    mocks.delay = 200

    const pending = writeback(original, replacement)
    await vi.advanceTimersByTimeAsync(800)
    await pending

    expect(mocks.list.map(item => item.id)).toEqual(['wy_a', 'kw_b'])
    expect(player.playMusicInfo.musicInfo).toBe(replacement)
    expect(player.playInfo.playIndex).toBe(0)
    expect(player.playedList[0].musicInfo).toBe(replacement)
    expect(player.musicInfo.lrc).toBe('existing lyric')
    expect(mocks.playNext).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.setProgress).not.toHaveBeenCalled()
    expect(toggled).not.toHaveBeenCalled()
  })

  it('列表中已存在目标提供方条目时合并并保留原位置', async() => {
    const original = song('kw_a')
    const replacement = song('wy_a', 'wy')
    mocks.list.push(replacement, song('kw_b'), original, song('kw_c'))
    Object.assign(player.playMusicInfo, { listId: 'test-list', musicInfo: original, isTempPlay: false })
    Object.assign(player.playInfo, { playerListId: 'test-list', playIndex: 2, playerPlayIndex: 2 })
    await writeback(original, replacement)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.list.map(item => item.id)).toEqual(['kw_b', 'wy_a', 'kw_c'])
    expect(player.playInfo.playIndex).toBe(1)
    expect(mocks.playNext).not.toHaveBeenCalled()
  })

  it('写回途中切歌不会替换新播放的身份', async() => {
    const original = song('kw_a')
    const next = song('kw_b')
    mocks.list.push(original, next)
    Object.assign(player.playMusicInfo, { listId: 'test-list', musicInfo: original, isTempPlay: false })
    mocks.delay = 200
    const pending = writeback(original, song('wy_a', 'wy'))
    player.playMusicInfo.musicInfo = next
    await vi.advanceTimersByTimeAsync(800)
    await pending
    expect(player.playMusicInfo.musicInfo).toBe(next)
    expect(mocks.playNext).not.toHaveBeenCalled()
  })

  it('临时播放、同提供方或已切走的取流结果不写列表', async() => {
    const original = song('kw_a')
    mocks.list.push(original)
    Object.assign(player.playMusicInfo, { listId: 'test-list', musicInfo: original, isTempPlay: true })
    await writeback(original, song('wy_a', 'wy'))
    player.playMusicInfo.isTempPlay = false
    await writeback(original, song('kw_other'))
    player.playMusicInfo.musicInfo = song('kw_b')
    await writeback(original, song('wy_a', 'wy'))
    expect(mocks.list).toEqual([original])
    expect(mocks.changed).not.toHaveBeenCalled()
  })
})
