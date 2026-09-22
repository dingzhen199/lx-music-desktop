import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import names from './name'
import type * as ApiModule from './rendererEvent'

const mocks = vi.hoisted(() => ({
  windows: new Map<string, number>(),
  handlers: new Map<string, (args: any) => void>(),
  create: vi.fn(),
  close: vi.fn(),
  status: vi.fn(),
  send: vi.fn(),
  apis: ['user_api_primary', 'user_api_backup'].map(id => ({ id, name: id, description: '', allowShowUpdateAlert: false })),
}))
vi.mock('@common/mainIpc', () => ({
  mainOn: (name: string, handler: (args: any) => void) => mocks.handlers.set(name, handler),
}))
vi.mock('../main', () => ({
  createWindow: mocks.create,
  closeWindow: mocks.close,
  hasWindow: (id: string) => mocks.windows.has(id),
  getApiIdByWebContentsId: (id: number) => [...mocks.windows.entries()].find(([, value]) => value === id)?.[0],
  getProxy: vi.fn(),
  openDevTools: vi.fn(),
  sendEventToApi: mocks.send,
}))
vi.mock('../utils', () => ({ getUserApis: () => mocks.apis }))
vi.mock('@main/modules/winMain', () => ({ sendStatusChange: mocks.status, sendShowUpdateAlert: vi.fn() }))

let api: typeof ApiModule
beforeEach(async() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.windows.clear()
  mocks.handlers.clear()
  mocks.create.mockImplementation(async(info: LX.UserApi.UserApiInfo) => {
    mocks.windows.set(info.id, mocks.create.mock.calls.length)
  })
  mocks.close.mockImplementation(async(id?: string) => {
    if (id == null) mocks.windows.clear()
    else mocks.windows.delete(id)
  })
  api = await import('./rendererEvent')
  api.init()
})
afterEach(async() => {
  await api.unloadAllApis()
  vi.useRealTimers()
})

const ready = (id: string) => {
  mocks.handlers.get(names.init)!({
    event: { sender: { id: mocks.windows.get(id) } },
    params: { status: true, data: { sources: {} } },
  })
}

describe('自定义音源生命周期', () => {
  it('默认 temp 状态不按不存在的自定义脚本报错', async() => {
    await expect(api.setApi('temp')).resolves.toBeUndefined()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(api.getStatus().status).toBe(false)
    await expect(api.setApi('user_api_missing')).rejects.toThrow('api not found')
  })

  it('主窗口关闭后重开会重新创建主源和备源，并丢弃旧初始化状态', async() => {
    await Promise.all([api.setApi('user_api_primary'), api.setBackups(['user_api_backup'])])
    ready('user_api_primary')
    ready('user_api_backup')
    expect(api.getStatus().status).toBe(true)
    await api.unloadAllApis()
    expect(mocks.windows.size).toBe(0)
    expect(api.getStatus().status).toBe(false)
    await Promise.all([api.setApi('user_api_primary'), api.setBackups(['user_api_backup'])])
    expect(mocks.windows.size).toBe(2)
    expect(mocks.create).toHaveBeenCalledTimes(4)
    expect(api.getStatus().status).toBe(false)
    ready('user_api_primary')
    expect(api.getStatus().status).toBe(true)
  })

  it('窗口意外消失后重新配置同一源也会重建', async() => {
    await api.setApi('user_api_primary')
    ready('user_api_primary')
    mocks.windows.clear()
    await api.setApi('user_api_primary')
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(api.getStatus().status).toBe(false)
  })

  it('切到默认源会卸载原主源但保留已启用备源', async() => {
    await api.setApi('user_api_primary')
    await api.setBackups(['user_api_backup'])
    await api.setApi('temp')
    expect([...mocks.windows.keys()]).toEqual(['user_api_backup'])
  })

  it('渲染窗口重载时可重新获取已初始化备源状态', async() => {
    await api.setBackups(['user_api_backup'])
    ready('user_api_backup')
    mocks.status.mockClear()
    await api.setBackups(['user_api_backup'])
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({
      status: true, apiInfo: expect.objectContaining({ id: 'user_api_backup' }),
    }))
  })

  it('销毁期间的新配置等待旧窗口清理完成', async() => {
    await api.setApi('user_api_primary')
    let finishClose!: () => void
    mocks.close.mockImplementationOnce(async() => {
      await new Promise<void>(resolve => { finishClose = resolve })
      mocks.windows.clear()
    })
    const closing = api.unloadAllApis()
    await vi.waitFor(() => { expect(finishClose).toBeDefined() })
    const reopening = api.setApi('user_api_primary')
    expect(mocks.create).toHaveBeenCalledOnce()
    finishClose()
    await Promise.all([closing, reopening])
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.windows.has('user_api_primary')).toBe(true)
  })

  it('关闭音源时取消待响应请求，避免重开后遗留超时', async() => {
    await api.setApi('user_api_primary')
    const request = api.request({ requestKey: 'pending', data: { action: 'musicUrl' } })
    const rejected = expect(request).rejects.toThrow('Cancel request')
    await api.unloadAllApis()
    await rejected
  })

  it.each(['disable', 'remove'])('单独卸载备源即时结束其请求，保留其他源请求（%s）', async(action) => {
    await api.setApi('user_api_primary')
    await api.setBackups(['user_api_backup'])
    const primarySettled = vi.fn()
    const backupRejected = vi.fn()
    const primary = api.request({ requestKey: 'primary-pending', data: { action: 'musicUrl' } }).then(primarySettled, primarySettled)
    const backup = api.request({ requestKey: 'backup-pending', data: { apiId: 'user_api_backup', action: 'musicUrl' } }).catch(backupRejected)
    if (action === 'disable') await api.setBackups([])
    else await api.unloadApi('user_api_backup')
    await Promise.resolve()

    expect(backupRejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cancel request' }))
    expect(primarySettled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    mocks.handlers.get(names.response)!({ params: { status: true, data: { requestKey: 'primary-pending', result: 'primary-url' } } })
    await Promise.all([primary, backup])
    expect(primarySettled).toHaveBeenCalledWith('primary-url')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('未显式指定 apiId 的请求也按发起时主源归属清理', async() => {
    await api.setApi('user_api_primary')
    const rejected = vi.fn()
    const pending = api.request({ requestKey: 'implicit-primary', data: { action: 'musicUrl' } }).catch(rejected)
    await api.setApi('user_api_backup')
    await Promise.resolve()
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cancel request' }))
    expect(vi.getTimerCount()).toBe(0)
    await pending
    expect(api.getStatus().status).toBe(false)
    expect(mocks.windows.has('user_api_backup')).toBe(true)
  })
})
