import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { playMusicInfoNow, playNext, setMusicUrl } from './action'
import { playInfo, playMusicInfo, tempPlayList } from '@renderer/store/player/state'
import { clearTempPlayeList, setPlayMusicInfo, removeTempPlayList, addPlayedList } from '@renderer/store/player/action'
import { setResource, setStop } from '@renderer/plugins/player'
import { getMusicUrl } from '../music/index'
import { writebackToggleMusicInfo } from '../music/toggleWriteback'

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
vi.mock('../music/toggleWriteback', () => ({ writebackToggleMusicInfo: vi.fn(async() => {}) }))
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

const onlineSong = (id: string, source: 'kw' | 'wy' = 'kw'): LX.Music.MusicInfoOnline => ({
  id,
  source,
  name: 'Song',
  singer: 'Artist',
  interval: null,
  meta: { songId: id, albumName: '', qualitys: [], _qualitys: {} },
})

it('播放器接受 URL 后才执行换源写回', async() => {
  const original = onlineSong('kw_original')
  const replacement = onlineSong('wy_replacement', 'wy')
  playMusicInfo.musicInfo = original
  vi.mocked(getMusicUrl).mockImplementationOnce(async({ onResolvedMusicInfo }) => {
    onResolvedMusicInfo?.(replacement)
    return 'https://example.test/music'
  })
  setMusicUrl(original)
  await vi.waitFor(() => { expect(writebackToggleMusicInfo).toHaveBeenCalledWith(original, replacement) })
  expect(vi.mocked(setResource).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writebackToggleMusicInfo).mock.invocationCallOrder[0])
})

it('取流期间已切歌则不写回迟到结果', async() => {
  const original = onlineSong('kw_old')
  let resolveUrl!: (url: string) => void
  playMusicInfo.musicInfo = original
  vi.mocked(getMusicUrl).mockImplementationOnce(async({ onResolvedMusicInfo }) => {
    onResolvedMusicInfo?.(onlineSong('wy_old', 'wy'))
    return new Promise(resolve => { resolveUrl = resolve })
  })
  setMusicUrl(original)
  await vi.waitFor(() => { expect(resolveUrl).toBeDefined() })
  playMusicInfo.musicInfo = onlineSong('other')
  resolveUrl('https://example.test/old')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(setResource).not.toHaveBeenCalled()
  expect(writebackToggleMusicInfo).not.toHaveBeenCalled()
})
