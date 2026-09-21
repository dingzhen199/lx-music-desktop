import { mainSend } from '@common/mainIpc'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'node:path'
import { openDevTools as handleOpenDevTools } from '@main/utils'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { getScript } from './utils'

/** 已加载音源的窗口注册表：apiId -> 隐藏窗口（多活音源，一源一窗，脚本彼此隔离） */
const windows = new Map<string, Electron.BrowserWindow>()
/** 窗口 webContents id -> apiId（用于窗口→主进程事件按来源路由） */
const webContentsApiMap = new Map<number, string>()

let html: string | null = null
let dir: string | null = null

const denyEvents = [
  'will-navigate',
  'will-redirect',
  'will-attach-webview',
  'will-prevent-unload',
  'media-started-playing',
] as const


export const getProxy = () => {
  if (global.lx.appSetting['network.proxy.enable'] && global.lx.appSetting['network.proxy.host']) {
    return {
      host: global.lx.appSetting['network.proxy.host'],
      port: global.lx.appSetting['network.proxy.port'],
    }
  }
  const envProxy = envParams.cmdParams['proxy-server']
  if (envProxy) {
    if (envProxy && typeof envProxy == 'string') {
      const [host, port = ''] = envProxy.split(':')
      return {
        host,
        port,
      }
    }
  }
  return {
    host: '',
    port: '',
  }
}
const handleUpdateProxy = (keys: Array<keyof LX.AppSetting>) => {
  if (keys.includes('network.proxy.enable') || (global.lx.appSetting['network.proxy.enable'] && keys.some(k => k.startsWith('network.proxy.')))) {
    broadcastEvent(USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
}

const winEvent = (apiId: string, browserWindow: Electron.BrowserWindow) => {
  browserWindow.on('closed', () => {
    if (windows.get(apiId) === browserWindow) windows.delete(apiId)
    webContentsApiMap.delete(browserWindow.webContents.id)
  })
}

export const createWindow = async(userApi: LX.UserApi.UserApiInfo) => {
  await closeWindow(userApi.id)
  dir ??= process.env.NODE_ENV !== 'production' ? webpackUserApiPath : path.join(__dirname, 'userApi')

  if (!html) {
    // eslint-disable-next-line require-atomic-updates
    html = await fs.promises.readFile(path.join(dir, 'renderer/user-api.html'), 'utf8')
  }
  const preloadUrl = process.env.NODE_ENV !== 'production'
    ? `${path.join(__dirname, '../dist/user-api-preload.js')}`
    : `${path.join(__dirname, 'user-api-preload.js')}`
  // console.log(preloadUrl)

  /**
   * Initial window options
   */
  const browserWindow = new BrowserWindow({
    // enableRemoteModule: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      // worldSafeExecuteJavaScript: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,

      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
      enableWebSQL: false,
      disableDialogs: true,
      // nativeWindowOpen: false,
      webgl: false,
      images: false,

      preload: preloadUrl,
    },
  })

  for (const eventName of denyEvents) {
    // @ts-expect-error
    browserWindow.webContents.on(eventName, (event: Electron.Event) => {
      event.preventDefault()
    })
  }
  browserWindow.webContents.session.setPermissionRequestHandler((webContents, permission, resolve) => {
    if (webContents === browserWindow?.webContents) {
      resolve(false)
      return
    }
    resolve(true)
  })
  browserWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  windows.set(userApi.id, browserWindow)
  webContentsApiMap.set(browserWindow.webContents.id, userApi.id)
  winEvent(userApi.id, browserWindow)

  // console.log(html.replace('</body>', `<script>${userApi.script}</script></body>`))
  // const randomNum = Math.random().toString().substring(2, 10)
  await browserWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))

  browserWindow.on('ready-to-show', async() => {
    global.lx.event_app.on('updated_config', handleUpdateProxy)
    sendEventToApi(userApi.id, USER_API_RENDERER_EVENT_NAME.initEnv, { ...userApi, script: await getScript(userApi.id), proxy: getProxy() })
  })

  // global.modules.userApiWindow.loadFile(join(dir, 'renderer/user-api.html'))
  // global.modules.userApiWindow.webContents.openDevTools()
}

export const closeWindow = async(apiId?: string) => {
  if (apiId == null) {
    global.lx.event_app.off('updated_config', handleUpdateProxy)
    if (!windows.size) return
    const allWindows = [...windows.values()]
    windows.clear()
    webContentsApiMap.clear()
    await Promise.all(allWindows.flatMap(browserWindow => [
      browserWindow.webContents.session.clearAuthCache(),
      browserWindow.webContents.session.clearStorageData(),
      browserWindow.webContents.session.clearCache(),
    ]))
    for (const browserWindow of allWindows) browserWindow.destroy()
    return
  }
  const browserWindow = windows.get(apiId)
  if (!browserWindow) return
  windows.delete(apiId)
  webContentsApiMap.delete(browserWindow.webContents.id)
  await Promise.all([
    browserWindow.webContents.session.clearAuthCache(),
    browserWindow.webContents.session.clearStorageData(),
    browserWindow.webContents.session.clearCache(),
  ])
  browserWindow.destroy()
}

export const hasWindow = (apiId: string): boolean => windows.has(apiId)

export const getApiIdByWebContentsId = (webContentsId: number): string | undefined => webContentsApiMap.get(webContentsId)

export const sendEventToApi = <T = any>(apiId: string, name: string, params?: T) => {
  const browserWindow = windows.get(apiId)
  if (!browserWindow) return
  mainSend(browserWindow, name, params)
}

export const broadcastEvent = <T = any>(name: string, params?: T) => {
  for (const browserWindow of windows.values()) {
    mainSend(browserWindow, name, params)
  }
}

export const openDevTools = (apiId?: string) => {
  const browserWindow = apiId == null ? [...windows.values()][0] : windows.get(apiId)
  if (!browserWindow) return
  handleOpenDevTools(browserWindow.webContents)
}
