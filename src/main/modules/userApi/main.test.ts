import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ApiModule from './main'

const mocks = vi.hoisted(() => ({ windows: [] as any[], sessions: new Map<string, any>(), send: vi.fn() }))
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
        session: null as any,
      }

      constructor(options: Electron.BrowserWindowConstructorOptions) {
        super()
        const key = options.webPreferences?.partition ?? 'default'
        if (!mocks.sessions.has(key)) {
          const cookies = new Map<string, string>()
          mocks.sessions.set(key, {
            cookies,
            setPermissionCheckHandler: vi.fn(),
            setPermissionRequestHandler: vi.fn(),
            clearAuthCache: vi.fn(async() => {}),
            clearStorageData: vi.fn(async() => { cookies.clear() }),
            clearCache: vi.fn(async() => {}),
          })
        }
        this.contents.session = mocks.sessions.get(key)
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
  mocks.sessions.clear()
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


it('各音源隔离 Session，权限检查和申请均拒绝，卸载不清除其他源存储', async() => {
  await api.createWindow(info('primary'))
  await api.createWindow(info('backup'))
  const primary = mocks.windows[0].webContents.session
  const backup = mocks.windows[1].webContents.session
  expect(primary).not.toBe(backup)
  expect(mocks.sessions.has('default')).toBe(false)
  backup.cookies.set('auth', 'kept')
  for (const session of [primary, backup]) {
    expect(session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const resolve = vi.fn()
    session.setPermissionRequestHandler.mock.calls[0][0](mocks.windows[0].webContents, 'notifications', resolve)
    expect(resolve).toHaveBeenCalledWith(false)
  }
  await api.closeWindow('primary')
  expect(backup.cookies.get('auth')).toBe('kept')
  expect(backup.clearStorageData).not.toHaveBeenCalled()
})
