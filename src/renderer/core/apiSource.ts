import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { setUserApi as setUserApiAction, setUserApiBackups as setUserApiBackupsAction } from '@renderer/utils/ipc'
import musicSdk from '@renderer/utils/musicSdk'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { USER_API_INIT_TIMEOUT_MS } from '@common/userApi'

let prevId = ''
export const setUserApi = async(apiId: string) => {
  if (prevId == apiId) return
  // 切源先释放上一代等待者；新源始终拥有独立的初始化期限。
  if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
  prevId = apiId
  window.lx.apiInitPromise[1] = false
  window.lx.apiInitPromise[0] = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      if (prevId === apiId) {
        userApi.message = 'init timeout'
        window.lx.apiInitPromise[2](false)
      }
    }, USER_API_INIT_TIMEOUT_MS)
    window.lx.apiInitPromise[2] = (result: boolean) => {
      clearTimeout(timer)
      resolve(result)
      if (prevId !== apiId) return
      window.lx.apiInitPromise[1] = true
      // 超时后迟到的成功初始化仍可恢复后续播放。
      window.lx.apiInitPromise[0] = Promise.resolve(result)
    }
  })

  if (/^user_api/.test(apiId)) {
    qualityList.value = {}
    userApi.status = false
    userApi.message = 'initing'

    await setUserApiAction(apiId).then(() => {
      if (prevId != apiId) return
      apiSource.value = apiId
    }).catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
      let api = apiSourceInfo.find(api => !api.disabled)
      if (!api) return
      apiSource.value = api.id
      if (api.id != appSetting['common.apiSource']) setApiSource(api.id)
    })
  } else {
    // @ts-expect-error
    qualityList.value = musicSdk.supportQuality[apiId] ?? {}
    apiSource.value = apiId
    void setUserApiAction(apiId).catch(err => { console.log(err) })
    if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
  }

  if (prevId != apiId) return
  if (apiId != appSetting['common.apiSource']) setApiSource(apiId)
}

/** 装载/卸载备源窗口（主源不受影响；顺序即播放取流失败时的轮换顺序） */
export const setUserApiBackups = async(apiIds: string[]) => {
  // 展开为普通数组：响应式数组（Proxy）无法被 IPC 结构化克隆
  await setUserApiBackupsAction([...apiIds]).catch(err => {
    console.log(err)
  })
}
