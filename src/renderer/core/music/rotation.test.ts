import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleGetOnlineMusicUrl, getOnlineOtherSourceMusicUrl } from './utils'

const mocks = vi.hoisted(() => ({ primary: vi.fn(), backup: vi.fn() }))
vi.mock('@renderer/store', () => ({
  qualityList: { value: {} },
  userApi: { apis: { backup: { wy: { getMusicUrl: mocks.backup } } }, qualityLists: { backup: { wy: ['128k'] } } },
}))
vi.mock('@renderer/store/setting', () => ({
  appSetting: { 'common.apiSource': 'primary', 'common.apiSourceBackups': ['backup'], 'player.playQuality': '128k' },
}))
vi.mock('@renderer/utils', () => ({ langS2T: vi.fn(), toNewMusicInfo: (info: unknown) => info, toOldMusicInfo: (info: unknown) => info }))
vi.mock('@renderer/utils/musicSdk', () => ({ default: { wy: { getMusicUrl: mocks.primary }, findMusic: vi.fn() } }))
vi.mock('@renderer/utils/musicSdk/api-source', () => ({ apis: () => ({ getMusicUrl: mocks.backup }) }))
vi.mock('@renderer/utils/ipc', () => ({ getMusicUrl: async() => null, getPlayerLyric: vi.fn() }))

const musicInfo: LX.Music.MusicInfoOnline = {
  id: 'wy_1',
  source: 'wy',
  name: 'Song',
  singer: 'Artist',
  interval: null,
  meta: { songId: '1', albumName: '', qualitys: [], _qualitys: { '128k': { size: null } } },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { lx: { apiInitPromise: [Promise.resolve(false)] }, i18n: { t: (key: string) => key } })
  mocks.primary.mockImplementation(() => ({ promise: Promise.reject(new Error('primary failed')) }))
  mocks.backup.mockImplementation(() => ({ promise: Promise.resolve({ url: 'https://example.test/audio', type: '128k' }) }))
})
afterEach(() => vi.unstubAllGlobals())

it('主源初始化失败时仍可使用已就绪备源', async() => {
  await expect(handleGetOnlineMusicUrl({ musicInfo, isRefresh: true, allowToggleSource: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'https://example.test/audio' })
  expect(mocks.primary).not.toHaveBeenCalled()
  expect(mocks.backup).toHaveBeenCalledOnce()
})

it('跨提供方回退入口也不要求主源初始化成功', async() => {
  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [musicInfo], isRefresh: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'https://example.test/audio' })
})

it('主源初始化成功但取流失败时仍按序轮换', async() => {
  window.lx.apiInitPromise[0] = Promise.resolve(true)
  await expect(handleGetOnlineMusicUrl({ musicInfo, isRefresh: true, allowToggleSource: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'https://example.test/audio' })
  expect(mocks.primary).toHaveBeenCalledOnce()
  expect(mocks.backup).toHaveBeenCalledOnce()
})

it('显式禁止换源时不使用备源', async() => {
  await expect(handleGetOnlineMusicUrl({ musicInfo, isRefresh: true, allowToggleSource: false, onToggleSource: vi.fn() }))
    .rejects.toThrow('source init failed')
  expect(mocks.backup).not.toHaveBeenCalled()
})
