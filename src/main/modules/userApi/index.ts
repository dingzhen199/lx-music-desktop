import { closeWindow } from './main'
import { getUserApis, importApi as handleImportApi, removeApi as handleRemoveApi, setAllowShowUpdateAlert as saveAllowShowUpdateAlert } from './utils'
import {
  init,
  setApi as setRendererEventApi,
  setBackups as setRendererEventBackups,
  unloadApi,
  setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert,
} from './rendererEvent/rendererEvent'

export const getApiList = getUserApis

export const importApi = async(script: string): Promise<LX.UserApi.ImportUserApi> => {
  return {
    apiInfo: await handleImportApi(script),
    apiList: getUserApis(),
  }
}
export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  for (const id of ids) await unloadApi(id)
  handleRemoveApi(ids)
  return getUserApis()
}

export const setApi = setRendererEventApi
export const setBackups = setRendererEventBackups

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  saveAllowShowUpdateAlert(id, enable)
  setRendererEventAllowShowUpdateAlert(id, enable)
}


export * from './rendererEvent/rendererEvent'

export default () => {
  init()

  global.lx.event_app.on('main_window_close', () => {
    void closeWindow()
  })
}
