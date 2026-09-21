import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { playMusicInfoNow, playNext } from './action'
import { playInfo, playMusicInfo, tempPlayList } from '@renderer/store/player/state'
import { clearTempPlayeList, setPlayMusicInfo, removeTempPlayList, addPlayedList } from '@renderer/store/player/action'
import { setStop } from '@renderer/plugins/player'

vi.mock('@renderer/plugins/player', () => ({ isEmpty: vi.fn(), setPause: vi.fn(), setPlay: vi.fn(), setResource: vi.fn(), setStop: vi.fn() }))
vi.mock('@renderer/store/player/state', () => ({
  isPlay: { value: false },
  playedList: [],
  tempPlayList: [],
  musicInfo: {},
  playInfo: { playerListId: 'original', playerPlayIndex: 4 },
  playMusicInfo: { musicInfo: null, listId: 'original', isTempPlay: false },
}))
vi.mock('@renderer/store/player/action', () => ({
  getList: vi.fn(),
  clearPlayedList: vi.fn(),
  clearTempPlayeList: vi.fn(),
  setPlayMusicInfo: vi.fn(),
  addPlayedList: vi.fn(),
  setMusicInfo: vi.fn(),
  setAllStatus: vi.fn(),
  removeTempPlayList: vi.fn(),
  setPlayListId: vi.fn(),
  removePlayedList: vi.fn(),
}))
vi.mock('@renderer/store/setting', () => ({ appSetting: { 'player.togglePlayMethod': 'random' } }))
vi.mock('../music/index', () => ({
  getMusicUrl: vi.fn(async() => null),
  getPicPath: vi.fn(async() => null),
  getLyricInfo: vi.fn(async() => ({ rawlrcInfo: { lyric: '' } })),
}))
vi.mock('./utils', () => ({ filterList: vi.fn() }))
vi.mock('@renderer/utils/message', () => ({ requestMsg: {} }))
vi.mock('@renderer/utils/index', () => ({ getRandom: vi.fn() }))
vi.mock('@renderer/store/list/action', () => ({ addListMusics: vi.fn(), removeListMusics: vi.fn() }))
vi.mock('@renderer/store/list/state', () => ({ loveList: {} }))
vi.mock('@renderer/core/dislikeList', () => ({ addDislikeInfo: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  tempPlayList.splice(0)
  vi.stubGlobal('window', {
    lx: { isPlayedStop: false },
    i18n: { t: (value: string) => value },
    app_event: { pause: vi.fn(), picUpdated: vi.fn(), lyricUpdated: vi.fn(), error: vi.fn() },
  })
  vi.mocked(setPlayMusicInfo).mockImplementation((listId, musicInfo, isTempPlay = false) => {
    Object.assign(playMusicInfo, { listId, musicInfo, isTempPlay })
  })
  vi.mocked(removeTempPlayList).mockImplementation(index => { tempPlayList.splice(index, 1) })
})
afterEach(async() => {
  // 排空取 URL/歌词 Promise 后再撤除播放器事件环境。
  for (let i = 0; i < 10; i++) await Promise.resolve()
  vi.unstubAllGlobals()
})
it('路径即播标记为临时播放并重新启动播放，保留原列表位置和稍后播放', () => {
  const song: LX.Music.MusicInfo = { id: 'recommended', name: 'Recommended', singer: 'Artist', source: 'wy', interval: null, meta: { songId: 'recommended', albumName: '', qualitys: [], _qualitys: {} } }
  tempPlayList.push({ listId: 'later', musicInfo: song, isTempPlay: true })
  playMusicInfoNow(song)
  expect(setPlayMusicInfo).toHaveBeenCalledWith(null, song, true)
  expect(setStop).toHaveBeenCalledOnce()
  expect(clearTempPlayeList).not.toHaveBeenCalled()
  expect(addPlayedList).not.toHaveBeenCalled()
  expect(playInfo.playerPlayIndex).toBe(4)
  expect(tempPlayList).toHaveLength(1)
})
it('下一曲消费 FIFO 队首一次，继续保持临时播放身份', async() => {
  const song: LX.Music.MusicInfo = { id: 'next', name: 'Next', singer: 'Artist', source: 'wy', interval: null, meta: { songId: 'next', albumName: '', qualitys: [], _qualitys: {} } }
  tempPlayList.push({ listId: 'later', musicInfo: song, isTempPlay: true })
  await playNext()
  expect(removeTempPlayList).toHaveBeenCalledExactlyOnceWith(0)
  expect(setPlayMusicInfo).toHaveBeenCalledWith('later', song, true)
  expect(tempPlayList).toHaveLength(0)
})
