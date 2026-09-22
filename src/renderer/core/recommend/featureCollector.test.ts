import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AudioFeatureCollector } from './feature'

vi.mock('@renderer/plugins/player', () => ({ getAnalyser: () => null }))
let collector: AudioFeatureCollector
let events: EventEmitter
beforeEach(() => {
  vi.useFakeTimers()
  events = new EventEmitter()
  vi.stubGlobal('window', { app_event: events })
  collector = new AudioFeatureCollector()
})
afterEach(() => { collector.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('播放器模块加载期间停止，不得在加载结束后留下定时器和订阅', async() => {
  const started = collector.start()
  collector.stop()
  await started
  expect(collector.isStarted()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(events.listenerCount('musicToggled')).toBe(0)
})

it('加载期间重启仅注册新一代采集器，stop 可清理全部资源', async() => {
  const first = collector.start()
  collector.stop()
  const second = collector.start()
  await Promise.all([first, second])
  expect(vi.getTimerCount()).toBe(1)
  expect(events.listenerCount('musicToggled')).toBe(1)
  collector.stop()
  expect(vi.getTimerCount()).toBe(0)
  expect(events.listenerCount('musicToggled')).toBe(0)
})
