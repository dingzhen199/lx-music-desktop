import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ApiModule from './main'

const mocks = vi.hoisted(() => ({ windows: [] as any[], send: vi.fn() }))
vi.mock('fs', () => ({ default: { promises: { readFile: async() => '<html></html>' } } }))
vi.mock('@common/mainIpc', () => ({ mainSend: mocks.send }))
vi.mock('@main/utils', () => ({ openDevTools: vi.fn() }))
vi.mock('./utils', () => ({ getScript: async() => 'script' }))
vi.mock('electron', async() => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false
      contents = {
        id: mocks.windows.length + 1,
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        session: {
          setPermissionRequestHandler: vi.fn(),
          clearAuthCache: async() => {},
          clearStorageData: async() => {},
          clearCache: async() => {},
        },
      }

      constructor() {
        super()
        mocks.windows.push(this)
      }

      get webContents() {
        if (this.destroyed) throw new Error('Object has been destroyed')
        return this.contents
      }

      async loadURL() {
        this.emit('ready-to-show')
      }

      destroy() {
        this.destroyed = true
        this.emit('closed')
      }
    },
  }
})

let api: typeof ApiModule
let events: EventEmitter
beforeEach(async() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.windows.splice(0)
  events = new EventEmitter()
  vi.stubGlobal('lx', { appSetting: {}, event_app: events })
  vi.stubGlobal('envParams', { cmdParams: {} })
  vi.stubGlobal('webpackUserApiPath', '/tmp/lx-test-user-api')
  api = await import('./main')
})
afterEach(async() => {
  await api.closeWindow()
  vi.unstubAllGlobals()
})

const info = (id: string): LX.UserApi.UserApiInfo => ({ id, name: id, description: '', allowShowUpdateAlert: false })

it('窗口销毁后不再读取 webContents，映射与代理订阅随最后一个窗口释放', async() => {
  await api.createWindow(info('primary'))
  await api.createWindow(info('backup'))
  const id = mocks.windows[0].webContents.id
  expect(api.getApiIdByWebContentsId(id)).toBe('primary')
  expect(events.listenerCount('updated_config')).toBe(1)
  await expect(api.closeWindow('primary')).resolves.toBeUndefined()
  expect(api.getApiIdByWebContentsId(id)).toBeUndefined()
  expect(api.hasWindow('backup')).toBe(true)
  expect(events.listenerCount('updated_config')).toBe(1)
  await expect(api.closeWindow()).resolves.toBeUndefined()
  expect(events.listenerCount('updated_config')).toBe(0)
})

it('反复装载卸载音源不累积代理监听器，初始化不遗漏早到的 ready-to-show', async() => {
  for (let i = 0; i < 3; i++) {
    await api.createWindow(info('primary'))
    expect(events.listenerCount('updated_config')).toBe(1)
    await api.closeWindow('primary')
    expect(events.listenerCount('updated_config')).toBe(0)
  }
  expect(mocks.send).toHaveBeenCalledTimes(3)
})
