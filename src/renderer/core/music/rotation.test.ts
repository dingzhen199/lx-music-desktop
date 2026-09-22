import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleGetOnlineMusicUrl, getOnlineOtherSourceMusicUrl } from './utils'
import { qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'

const mocks = vi.hoisted(() => ({ primary: vi.fn(), backup: vi.fn(), cachedUrl: vi.fn() }))
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
vi.mock('@renderer/utils/ipc', () => ({ getMusicUrl: mocks.cachedUrl, getPlayerLyric: vi.fn() }))

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
  qualityList.value = {}
  userApi.qualityLists.backup = { wy: ['128k'] }
  appSetting['player.playQuality'] = '128k'
  mocks.cachedUrl.mockResolvedValue(null)
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

it.each([
  { name: '音质元数据为空', playQuality: '128k' as const, qualitys: {} },
  { name: '高音质偏好但元数据为空', playQuality: 'flac' as const, qualitys: {} },
  { name: '元数据缺少 128k 标记', playQuality: '128k' as const, qualitys: { flac: { size: null } } },
])('$name 时备源仍尝试默认 128k 取流', async({ playQuality, qualitys }) => {
  window.lx.apiInitPromise[0] = Promise.resolve(true)
  appSetting['player.playQuality'] = playQuality
  const track = { ...musicInfo, meta: { ...musicInfo.meta, _qualitys: qualitys } }

  await expect(handleGetOnlineMusicUrl({ musicInfo: track, isRefresh: true, allowToggleSource: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'https://example.test/audio', quality: '128k', musicInfo: track })
  expect(mocks.primary).toHaveBeenCalledWith(track, '128k')
  expect(mocks.backup).toHaveBeenCalledExactlyOnceWith(track, '128k')
})

it('跨提供方候选缺少音质元数据时也可由备源默认取流', async() => {
  const track = { ...musicInfo, meta: { ...musicInfo.meta, _qualitys: {} } }

  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [track], isRefresh: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'https://example.test/audio', quality: '128k', musicInfo: track })
  expect(mocks.backup).toHaveBeenCalledExactlyOnceWith(track, '128k')
})

it('缺少音质元数据时不把显式指定的音质改为默认 128k', async() => {
  const track = { ...musicInfo, meta: { ...musicInfo.meta, _qualitys: {} } }

  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [track], quality: '320k', isRefresh: true, onToggleSource: vi.fn() }))
    .rejects.toThrow('toggle_source_failed')
  expect(mocks.backup).not.toHaveBeenCalled()
})

it('显式禁止换源时不使用备源', async() => {
  await expect(handleGetOnlineMusicUrl({ musicInfo, isRefresh: true, allowToggleSource: false, onToggleSource: vi.fn() }))
    .rejects.toThrow('source init failed')
  expect(mocks.backup).not.toHaveBeenCalled()
})

it.each([false, true])('跨提供方候选只有 FLAC 时按备源能力取流（主源就绪=%s）', async(primaryReady) => {
  window.lx.apiInitPromise[0] = Promise.resolve(primaryReady)
  appSetting['player.playQuality'] = 'flac'
  userApi.qualityLists.backup = { wy: ['flac'] }
  const track = { ...musicInfo, meta: { ...musicInfo.meta, _qualitys: { flac: { size: null } } } }
  mocks.backup.mockImplementation(() => ({ promise: Promise.resolve({ url: 'backup-flac', type: 'flac' }) }))

  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [track], isRefresh: true, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'backup-flac', quality: 'flac', musicInfo: track })
  expect(mocks.backup).toHaveBeenCalledWith(track, 'flac')
})

it('跨提供方回退仍遵守显式指定音质，不擅自改用备源其他音质', async() => {
  userApi.qualityLists.backup = { wy: ['flac'] }
  const track = { ...musicInfo, meta: { ...musicInfo.meta, _qualitys: { flac: { size: null } } } }
  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [track], quality: '320k', isRefresh: true, onToggleSource: vi.fn() }))
    .rejects.toThrow('toggle_source_failed')
  expect(mocks.backup).not.toHaveBeenCalled()
})

it('跨提供方回退命中当前音质缓存时不再取流', async() => {
  mocks.cachedUrl.mockResolvedValue('cached-url')
  await expect(getOnlineOtherSourceMusicUrl({ musicInfos: [musicInfo], isRefresh: false, onToggleSource: vi.fn() }))
    .resolves.toMatchObject({ url: 'cached-url', quality: '128k', isFromCache: true })
  expect(mocks.primary).not.toHaveBeenCalled()
  expect(mocks.backup).not.toHaveBeenCalled()
})
