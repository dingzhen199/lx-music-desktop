import { beforeEach, expect, it, vi } from 'vitest'
import { addDislikeInfo, clearDislikeInfo } from '@renderer/store/dislikeList/action'
import { filterForSubmission } from './submission'
import type { SongRef } from './sameSong'

const mocks = vi.hoisted(() => ({ getList: vi.fn(), queue: [] as any[] }))
vi.mock('@renderer/store/list/listManage/rendererListManage', () => ({ getListMusics: mocks.getList }))
vi.mock('@renderer/store/list/listManage/state', () => ({ loveList: { id: 'love' } }))
vi.mock('@renderer/store/player/state', () => ({ tempPlayList: mocks.queue }))

const song = (id: string, name = 'Song', singer = 'Artist'): LX.Music.MusicInfoOnline => ({
  id,
  name,
  singer,
  source: 'wy',
  interval: null,
  meta: { songId: id, albumName: '', qualitys: [], _qualitys: {} },
})
const result = () => ({ candidates: [{ musicInfo: song('wy_1'), sources: ['wy', 'tx'], reason: '两个平台共同推荐' }] })
beforeEach(() => {
  vi.clearAllMocks()
  clearDislikeInfo()
  mocks.queue.splice(0)
  mocks.getList.mockResolvedValue([])
})

it.each([{ name: 'Song', singer: '' }, { name: '', singer: 'Artist' }, { name: 'Song', singer: 'Artist' }])('遵守全局屏蔽规则 %j', async(rule) => {
  addDislikeInfo([rule])
  expect((await filterForSubmission(result())).candidates).toEqual([])
})

it('等待读取收藏时发生的屏蔽、会话反馈和手动排队均以最新状态为准', async() => {
  let release!: (items: LX.Music.MusicInfo[]) => void
  mocks.getList.mockImplementationOnce(async() => new Promise(resolve => { release = resolve }))
  let disliked: SongRef[] = []
  const input = { candidates: ['blocked', 'disliked', 'queued', 'kept'].map(name => ({ musicInfo: song(name, name) })) }
  const pending = filterForSubmission(input, { dislikedTracks: () => disliked })
  addDislikeInfo([{ name: 'blocked', singer: '' }])
  disliked = [{ artist: 'Artist', title: 'disliked' }]
  const manual = { musicInfo: song('manual', 'queued') }
  mocks.queue.push(manual)
  release([])
  expect((await pending).candidates.map(c => c.musicInfo.name)).toEqual(['kept'])
  expect(mocks.queue).toEqual([manual])
})

it('收藏按同曲排除跨平台条目；保留未过滤条目的来源证据', async() => {
  const input = result()
  expect((await filterForSubmission(input)).candidates[0]).toBe(input.candidates[0])
  mocks.getList.mockResolvedValue([song('tx_2')])
  expect((await filterForSubmission(input)).candidates).toEqual([])
})

it('读取收藏期间取消，迟到结果不得提交', async() => {
  let release!: (items: LX.Music.MusicInfo[]) => void
  mocks.getList.mockImplementationOnce(async() => new Promise(resolve => { release = resolve }))
  let cancelled = false
  const pending = filterForSubmission(result(), { isCancelled: () => cancelled })
  const assertion = expect(pending).rejects.toThrow('取消')
  cancelled = true
  release([])
  await assertion
})

it('收藏读取失败不能作为空列表放行', async() => {
  mocks.getList.mockRejectedValueOnce(new Error('library unavailable'))
  await expect(filterForSubmission(result())).rejects.toThrow('library unavailable')
})
