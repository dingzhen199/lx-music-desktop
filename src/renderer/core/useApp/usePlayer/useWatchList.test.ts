import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import useWatchList from './useWatchList'
import { playMusicInfo } from '@renderer/store/player/state'
import { playNext, stop } from '@renderer/core/player'
vi.mock('@common/utils/vueTools', () => ({ onBeforeUnmount: vi.fn() }))
vi.mock('@common/utils', () => ({ throttle: (fn: unknown) => fn }))
vi.mock('@renderer/store/player/state', () => ({ playInfo: { playerListId: 'original' }, playMusicInfo: { listId: null, isTempPlay: true } }))
vi.mock('@renderer/store/player/action', () => ({ updatePlayIndex: () => ({ playIndex: -1 }), setPlayMusicInfo: vi.fn() }))
vi.mock('@renderer/core/player', () => ({ playNext: vi.fn(), stop: vi.fn() }))
let events: EventEmitter
beforeEach(() => {
  vi.clearAllMocks()
  events = new EventEmitter()
  vi.stubGlobal('window', { app_event: events, lx: { isPlayedStop: false } })
  playMusicInfo.isTempPlay = true
  useWatchList()
})
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('推荐临时播放时，收藏更新不跳歌/清空（isPlayedStop=%s）', stopped => {
  window.lx.isPlayedStop = stopped
  events.emit('myListUpdate', ['love'])
  expect(playNext).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})
it('普通列表歌曲删除后仍自动播放下一曲', () => {
  playMusicInfo.isTempPlay = false
  events.emit('myListUpdate', ['original'])
  expect(playNext).toHaveBeenCalledWith(true)
})
