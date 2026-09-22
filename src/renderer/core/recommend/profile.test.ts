import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ProfileModule from './profile'
import { createProfileState } from './profile-core'

const mocks = vi.hoisted(() => {
  // 摘要流程测试按显式旧 AI 引擎配置（平台推荐默认路径零 LLM，见下方平台模式用例）
  const setting: Record<string, any> = { 'ai.enable': true, 'ai.apiKey': 'test', 'ai.model': 'test', 'recommend.engine': 'ai' }
  return {
    load: vi.fn(),
    save: vi.fn(),
    llm: vi.fn(),
    player: { musicInfo: null as any },
    progress: { maxPlayTime: 0 },
    setting,
  }
})
vi.mock('@renderer/store/player/state', () => ({ playMusicInfo: mocks.player, isPlay: { value: true } }))
vi.mock('@renderer/store/player/playProgress', () => ({ playProgress: mocks.progress }))
vi.mock('@renderer/store/setting', () => ({ appSetting: mocks.setting }))
vi.mock('@renderer/utils/data', () => ({ getRecommendProfile: mocks.load, saveRecommendProfile: mocks.save }))
vi.mock('./llm', () => ({ llmComplete: mocks.llm }))

let profile: typeof ProfileModule
let events: EventEmitter
const changeTrack = (id: string): void => {
  mocks.player.musicInfo = { id, singer: 'Artist', name: id }
  events.emit('musicToggled')
}
beforeEach(async() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  mocks.player.musicInfo = null
  mocks.progress.maxPlayTime = 0
  mocks.load.mockResolvedValue(createProfileState())
  events = new EventEmitter()
  vi.stubGlobal('window', { lx: { isProd: true }, app_event: events })
  profile = await import('./profile')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('摘要只确认请求实际覆盖的信号，在途积累满阈值后继续生成', async() => {
  mocks.load.mockResolvedValue({ ...createProfileState(), loves: 19 })
  const releases: Array<(value: { content: string }) => void> = []
  mocks.llm.mockImplementation(async() => new Promise(resolve => releases.push(resolve)))
  profile.initRecommendProfile()
  await vi.advanceTimersByTimeAsync(0)
  const love = (id: string): void => { events.emit('loveListMusicsAdded', [{ id, singer: 'Artist', name: id }]) }
  love('first')
  expect(mocks.llm).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 20; i++) love(`next-${i}`)
  releases[0]({ content: '第一次摘要' })
  await vi.advanceTimersByTimeAsync(0)
  expect(profile.getProfileState()?.summary?.basedOnCount).toBe(20)
  expect(profile.getProfileState()?.loves).toBe(40)
  expect(mocks.llm).toHaveBeenCalledTimes(2)
  releases[1]({ content: '第二次摘要' })
  await vi.advanceTimersByTimeAsync(0)
  expect(profile.getProfileState()?.summary?.basedOnCount).toBe(40)
})

it.each(['before', 'after'])('短曲之后的元数据未加载曲目跳过，不能借用短曲时长（session %s profile）', async(order) => {
  profile.initRecommendProfile()
  await vi.advanceTimersByTimeAsync(0)
  changeTrack('short')
  mocks.progress.maxPlayTime = 20
  events.emit('playerLoadeddata')
  await vi.advanceTimersByTimeAsync(20000)
  changeTrack('unknown')
  await vi.advanceTimersByTimeAsync(20000)
  const skip = (): void => { profile.recordRecommendedSkip({ id: 'unknown', artist: 'Artist', title: 'unknown', playedSeconds: 20 }) }
  if (order === 'before') skip()
  changeTrack('next')
  if (order === 'after') skip()
  expect(profile.getProfileState()?.completes).toBe(1)
  expect(profile.getProfileState()?.skips).toBe(1)
})

it.each(['before', 'after'])('短曲自然播完仍与 skip 互斥（session %s profile）', async(order) => {
  profile.initRecommendProfile()
  await vi.advanceTimersByTimeAsync(0)
  changeTrack('short')
  mocks.progress.maxPlayTime = 20
  events.emit('playerLoadeddata')
  await vi.advanceTimersByTimeAsync(20000)
  const skip = (): void => { profile.recordRecommendedSkip({ id: 'short', artist: 'Artist', title: 'short', playedSeconds: 20 }) }
  if (order === 'before') skip()
  changeTrack('next')
  if (order === 'after') skip()
  expect(profile.getProfileState()?.completes).toBe(1)
  expect(profile.getProfileState()?.skips).toBe(0)
})

// 平台相似推荐（默认路径）零 LLM：即使旧 ai.enable=true，画像摘要阈值到达也不发请求（AC3）
it.each([
  ['平台默认（无 engine 设置）', undefined],
  ['显式 platform', 'platform'],
  ['显式 local', 'local'],
])('累计满画像摘要阈值：%s + ai.enable=true 不发 LLM 请求', async(_name, engine) => {
  mocks.setting['recommend.engine'] = engine
  mocks.load.mockResolvedValue({ ...createProfileState(), loves: 19 })
  profile.initRecommendProfile()
  await vi.advanceTimersByTimeAsync(0)
  const love = (id: string): void => { events.emit('loveListMusicsAdded', [{ id, singer: 'Artist', name: id }]) }
  love('first')
  await vi.advanceTimersByTimeAsync(0)
  expect(profile.getProfileState()?.loves).toBe(20)
  expect(mocks.llm).not.toHaveBeenCalled()
  expect(profile.getProfileState()?.summary?.text).toBeUndefined()
})
