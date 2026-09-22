import { expect, it, vi } from 'vitest'
import useList from '@renderer/views/Search/MusicList/useList'
import { playList } from '@renderer/core/player/action'
import { isProviderServable } from '@renderer/core/music/sourceRotation'

const mocks = vi.hoisted(() => ({ songs: [] as any[] }))
vi.mock('@renderer/core/player/action', () => ({ playList: vi.fn() }))
vi.mock('@renderer/store/list/action', () => ({ getListMusics: async() => mocks.songs, addListMusics: vi.fn(async() => {}) }))
vi.mock('@renderer/store/search/action', () => ({ addHistoryWord: vi.fn() }))
vi.mock('@renderer/store/search/music', () => ({ search: vi.fn(), listInfos: {} }))
vi.mock('@common/utils/nodejs', () => ({ joinPath: vi.fn() }))
vi.mock('@renderer/utils/ipc', () => ({ getThemes: vi.fn() }))
vi.mock('@renderer/store/setting', () => ({ appSetting: { 'common.apiSource': 'primary', 'common.apiSourceBackups': ['backup'] } }))
vi.mock('@renderer/store', () => ({
  qualityList: { value: { kw: ['128k'] } },
  userApi: { apis: { backup: { wy: { getMusicUrl: vi.fn() } } }, qualityLists: { backup: { wy: ['128k'] } } },
  themeInfo: {},
  themeShouldUseDarkColors: {},
}))

it('仅备源支持的平台，搜索结果仍应能进入播放回退链', async() => {
  const env = { primaryApiId: 'primary', primaryServedProviders: ['kw'], backupApiIds: ['backup'], readyApiIds: ['backup'], servedProviders: { backup: ['wy'] } }
  expect(isProviderServable(env, 'wy')).toBe(true)
  const song = { id: 'wy_1', source: 'wy', name: 'Song', singer: 'Artist', interval: null, meta: { songId: '1', albumName: '', qualitys: [], _qualitys: { '128k': { size: null } } } }
  mocks.songs = [song]
  const search = useList()
  search.listInfo.value.list = [song] as any
  await search.handlePlayList(0)
  expect(playList).toHaveBeenCalled()
})
