import { mainOn } from '@common/mainIpc'

import USER_API_RENDERER_EVENT_NAME from './name'
import { createWindow, closeWindow, getApiIdByWebContentsId, getProxy, hasWindow, openDevTools, sendEventToApi } from '../main'
import { getUserApis } from '../utils'
import { sendShowUpdateAlert, sendStatusChange } from '@main/modules/winMain'

/** 已加载音源信息：apiId -> UserApiInfo（多活音源，主源与备源同时在场） */
const loadedApis = new Map<string, LX.UserApi.UserApiInfo>()
/** 各音源初始化状态：apiId -> UserApiStatus */
const apiStatusMap = new Map<string, LX.UserApi.UserApiStatus>()
/** 主源 api id（搜索、歌词、封面等非取流调用只走主源） */
let primaryApiId: string | null = null
/** 备源 api id 列表（有序，播放取流失败时按序轮换） */
let backupApiIds: string[] = []
const requestQueue = new Map()
const timeouts = new Map<string, NodeJS.Timeout>()
// 主源、备源及关窗操作串行执行，避免重开窗口与上一轮销毁交错。
let windowUpdate: Promise<void> = Promise.resolve()
const updateWindows = async(action: () => Promise<void>) => {
  const next = windowUpdate.then(action)
  windowUpdate = next.catch(() => {})
  return next
}
interface InitParams {
  event: Electron.IpcMainEvent
  params: {
    status: boolean
    message: string
    data: LX.UserApi.UserApiInfo
  }
}
interface ResponseParams {
  event: Electron.IpcMainEvent
  params: {
    status: boolean
    message: string
    data: {
      requestKey: string
      result: any
    }
  }
}
interface UpdateInfoParams {
  event: Electron.IpcMainEvent
  params: {
    data: {
      log: string
      updateUrl: string
    }
  }
}

export const init = () => {
  const handleInit = ({ event, params: { status, message, data: apiInfo } }: InitParams) => {
    // console.log('inited')
    const apiId = getApiIdByWebContentsId(event.sender.id)
    const loadedApi = apiId == null ? undefined : loadedApis.get(apiId)
    if (!loadedApi) return
    const apiStatus: LX.UserApi.UserApiStatus = status
      ? { status: true, apiInfo: { ...loadedApi, sources: apiInfo.sources } }
      : { status: false, apiInfo: loadedApi, message }
    apiStatusMap.set(loadedApi.id, apiStatus)
    sendStatusChange(apiStatus)
  }
  const handleResponse = ({ params: { status, data: { requestKey, result }, message } }: ResponseParams) => {
    const request = requestQueue.get(requestKey)
    if (!request) return
    requestQueue.delete(requestKey)
    clearRequestTimeout(requestKey)
    if (status) {
      request[0](result)
    } else {
      request[1](new Error(message))
    }
  }
  const handleOpenDevTools = ({ event }: LX.IpcMainEvent) => {
    const apiId = getApiIdByWebContentsId(event.sender.id)
    openDevTools(apiId ?? undefined)
  }
  const handleShowUpdateAlert = ({ event, params: { data } }: UpdateInfoParams) => {
    const apiId = getApiIdByWebContentsId(event.sender.id)
    const targetApi = apiId == null ? undefined : loadedApis.get(apiId)
    if (!targetApi?.allowShowUpdateAlert) return
    sendShowUpdateAlert({
      name: targetApi.name,
      description: targetApi.description,
      log: data.log,
      updateUrl: data.updateUrl,
    })
  }
  const handleGetProxy = ({ event }: LX.IpcMainEvent) => {
    const apiId = getApiIdByWebContentsId(event.sender.id)
    if (apiId == null) return
    sendEventToApi(apiId, USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
  mainOn(USER_API_RENDERER_EVENT_NAME.init, handleInit)
  mainOn(USER_API_RENDERER_EVENT_NAME.response, handleResponse)
  mainOn(USER_API_RENDERER_EVENT_NAME.openDevTools, handleOpenDevTools)
  mainOn(USER_API_RENDERER_EVENT_NAME.showUpdateAlert, handleShowUpdateAlert)
  mainOn(USER_API_RENDERER_EVENT_NAME.getProxy, handleGetProxy)
}

export const clearRequestTimeout = (requestKey: string) => {
  const timeout = timeouts.get(requestKey)
  if (timeout) {
    clearTimeout(timeout)
    timeouts.delete(requestKey)
  }
}

export const loadApi = async(apiId: string) => {
  const targetApi = getUserApis().find(api => api.id == apiId)
  if (!targetApi) throw new Error('api not found')
  loadedApis.set(apiId, targetApi)
  console.log('load api', targetApi.name)
  if (hasWindow(apiId)) return
  apiStatusMap.delete(apiId)
  try {
    await createWindow(targetApi)
  } catch (err) {
    loadedApis.delete(apiId)
    await closeWindow(apiId)
    throw err
  }
}

export const unloadApi = async(apiId: string) => {
  if (!loadedApis.has(apiId)) return
  loadedApis.delete(apiId)
  apiStatusMap.delete(apiId)
  await closeWindow(apiId)
}

/** 按需增删音源窗口：需要保留的 = 主源 ∪ 备源，其余卸载；主源加载失败向上抛（渲染层有回退逻辑），备源尽力而为 */
const reconcileWindows = async() => {
  if (primaryApiId && !hasWindow(primaryApiId)) await loadApi(primaryApiId)
  for (const apiId of backupApiIds) {
    if (apiId && apiId != primaryApiId && !hasWindow(apiId)) await loadApi(apiId).catch(err => { console.log(err) })
  }
  const keepIds = new Set([primaryApiId, ...backupApiIds].filter((id): id is string => !!id))
  for (const apiId of [...loadedApis.keys()]) {
    if (!keepIds.has(apiId)) await unloadApi(apiId)
  }
}

export const setApi = async(apiId: string) => updateWindows(async() => {
  // temp/内置源由渲染端处理，主进程只装载自定义脚本。
  const isUserApi = /^user_api/.test(apiId)
  if (isUserApi && !getUserApis().some(api => api.id == apiId)) throw new Error('api not found')
  primaryApiId = isUserApi ? apiId : null
  await reconcileWindows()
  if (!primaryApiId) {
    sendStatusChange({ status: false, message: 'api id is null' })
    return
  }
  // 主源切换到已初始化的窗口时不会有新的 init 事件，补发缓存的状态让渲染层更新 qualityList
  const cachedStatus = apiStatusMap.get(primaryApiId)
  if (cachedStatus) sendStatusChange(cachedStatus)
})

export const setBackups = async(apiIds: string[]) => updateWindows(async() => {
  backupApiIds = [...new Set(apiIds)]
  await reconcileWindows()
  // 渲染窗口重载后也需要收到已有备源的初始化信息。
  for (const id of backupApiIds) {
    const status = apiStatusMap.get(id)
    if (status) sendStatusChange(status)
  }
})

export const unloadAllApis = async() => updateWindows(async() => {
  primaryApiId = null
  backupApiIds = []
  loadedApis.clear()
  apiStatusMap.clear()
  for (const key of requestQueue.keys()) cancelRequest(key)
  await closeWindow()
})

export const getStatus = (): LX.UserApi.UserApiStatus => primaryApiId ? (apiStatusMap.get(primaryApiId) ?? { status: false }) : { status: false }

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const targetApi = loadedApis.get(id)
  if (!targetApi) return
  targetApi.allowShowUpdateAlert = enable
}

export const cancelRequest = (requestKey: string) => {
  if (!requestQueue.has(requestKey)) return
  const request = requestQueue.get(requestKey)
  request[1](new Error('Cancel request'))
  requestQueue.delete(requestKey)
  clearRequestTimeout(requestKey)
}

export const request = async({ requestKey, data }: LX.UserApi.UserApiRequestParams): Promise<any> => await new Promise((resolve, reject) => {
  const apiId: string | null | undefined = data?.apiId ?? primaryApiId
  if (!apiId || !loadedApis.has(apiId) || !hasWindow(apiId)) {
    reject(new Error('user api is not load'))
    return
  }

  // const requestKey = `request__${Math.random().toString().substring(2)}`
  const timeout = timeouts.get(requestKey)
  if (timeout) {
    clearTimeout(timeout)
    timeouts.delete(requestKey)
    cancelRequest(requestKey)
  }

  timeouts.set(requestKey, setTimeout(() => {
    cancelRequest(requestKey)
  }, 20000))

  requestQueue.set(requestKey, [resolve, reject, data])
  sendRequest({ requestKey, data, apiId })
})

export const sendRequest = (reqData: { requestKey: string, data: any, apiId: string }) => {
  sendEventToApi(reqData.apiId, USER_API_RENDERER_EVENT_NAME.request, { requestKey: reqData.requestKey, data: reqData.data })
}
