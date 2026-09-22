import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { explorePlatformOnce } from '@renderer/core/recommend/platformEngine'
import { handleGetOnlineMusicUrl } from '@renderer/core/music/utils'
import { addTempPlayList } from '@renderer/store/player/action'

const mocks = vi.hoisted(() => ({ recall: vi.fn(), findMusic: vi.fn(async() => []), txUrl: vi.fn(() => ({ promise: Promise.resolve({ url: 'https://review.invalid/tx', type: '128k' }) })) }))
vi.mock('@renderer/core/recommend/platformRecall', () => ({ recallPlatformSimilar: mocks.recall }))
vi.mock('@renderer/store/player/action', () => ({ addTempPlayList: vi.fn() }))
vi.mock('@renderer/store/player/state', () => ({ tempPlayList: [] }))
vi.mock('@renderer/store/list/listManage/rendererListManage', () => ({ getListMusics: async() => [] }))
vi.mock('@renderer/store/list/listManage/state', () => ({ loveList: { id: 'love' } }))
vi.mock('@renderer/store', () => ({ qualityList: { value: { wy: ['128k'], tx: ['128k'] } }, userApi: { apis: {}, qualityLists: {} } }))
vi.mock('@renderer/store/setting', () => ({ appSetting: { 'common.apiSource': 'primary', 'common.apiSourceBackups': [], 'player.playQuality': '128k' } }))
vi.mock('@renderer/utils', () => ({ toNewMusicInfo: (x: unknown) => x, toOldMusicInfo: (x: unknown) => x, langS2T: vi.fn() }))
vi.mock('@renderer/utils/musicSdk', () => ({
  default: {
    wy: { getMusicUrl: () => ({ promise: Promise.reject(new Error('wy unavailable')) }) },
    tx: { getMusicUrl: mocks.txUrl },
    findMusic: mocks.findMusic,
  },
}))
vi.mock('@renderer/utils/musicSdk/api-source', () => ({ apis: vi.fn() }))
vi.mock('@renderer/utils/ipc', () => ({ getMusicUrl: async() => null, getPlayerLyric: vi.fn() }))

const song = (source: 'wy' | 'tx'): LX.Music.MusicInfoOnline => {
  const common = { name: 'Song', singer: 'Artist', interval: '03:00', meta: { songId: '1', albumName: '', qualitys: [], _qualitys: { '128k': { size: null } } } }
  return source === 'tx'
    ? { ...common, id: 'tx_1', source: 'tx', meta: { ...common.meta, strMediaMid: 'media-1' } }
    : { ...common, id: 'wy_1', source: 'wy' }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: (x: string) => x } })
})
afterEach(() => { vi.unstubAllGlobals() })

it('已知可播放的备用平台在重新搜索之前尝试', async() => {
  const wy = song('wy')
  const tx = song('tx')
  mocks.recall.mockResolvedValue({ state: 'ok', providers: [], error: null, items: [{ artist: 'Artist', title: 'Song', album: '', fusionScore: 1, musicInfo: wy, sources: [{ provider: 'wy', rank: 1, musicInfo: wy }, { provider: 'tx', rank: 1, musicInfo: tx }] }] })
  const result = await explorePlatformOnce({ anchor: { artist: 'Other', title: 'Anchor' } })
  expect(result.candidates[0].sources).toHaveLength(2)
  const queued = vi.mocked(addTempPlayList).mock.calls[0][0][0]
  expect(queued.alternativeMusicInfos).toEqual([tx])
  await expect(handleGetOnlineMusicUrl({ musicInfo: queued.musicInfo as LX.Music.MusicInfoOnline, alternativeMusicInfos: queued.alternativeMusicInfos, isRefresh: true, allowToggleSource: true, onToggleSource() {} })).resolves.toMatchObject({ url: 'https://review.invalid/tx' })
  expect(mocks.findMusic).not.toHaveBeenCalled()
})

it.each([
  { name: 'Song (Live)' },
  { singer: 'Cover Artist' },
  { interval: '03:06' },
])('拒绝备用条目中的错版本/翻唱/时长差异：%j', async(override) => {
  await expect(handleGetOnlineMusicUrl({
    musicInfo: song('wy'),
    alternativeMusicInfos: [{ ...song('tx'), ...override }],
    isRefresh: true,
    allowToggleSource: true,
    onToggleSource() {},
  })).rejects.toThrow('wy unavailable')
  expect(mocks.txUrl).not.toHaveBeenCalled()
  expect(mocks.findMusic).toHaveBeenCalledOnce()
})

it('禁止自动换源时不尝试已知备用平台', async() => {
  await expect(handleGetOnlineMusicUrl({
    musicInfo: song('wy'),
    alternativeMusicInfos: [song('tx')],
    isRefresh: true,
    allowToggleSource: false,
    onToggleSource() {},
  })).rejects.toThrow('wy unavailable')
  expect(mocks.txUrl).not.toHaveBeenCalled()
  expect(mocks.findMusic).not.toHaveBeenCalled()
})

it('已知备用平台也失败后仍可进入原有搜索回退', async() => {
  mocks.txUrl.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('tx failed')) }))
  await expect(handleGetOnlineMusicUrl({
    musicInfo: song('wy'),
    alternativeMusicInfos: [song('tx')],
    isRefresh: true,
    allowToggleSource: true,
    onToggleSource() {},
  })).rejects.toThrow('wy unavailable')
  expect(mocks.txUrl).toHaveBeenCalledOnce()
  expect(mocks.findMusic).toHaveBeenCalledOnce()
})
