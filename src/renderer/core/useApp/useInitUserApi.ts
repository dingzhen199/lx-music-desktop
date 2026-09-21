import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { onUserApiStatus, getUserApiList, sendUserApiRequest as sendUserApiRequestRemote, userApiRequestCancel, onShowUserApiUpdateAlert } from '@renderer/utils/ipc'
import { openUrl } from '@common/utils/electron'
import { qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { dialog } from '@renderer/plugins/Dialog'
import { setUserApi, setUserApiBackups } from '@renderer/core/apiSource'

const sendUserApiRequest = async(params: LX.UserApi.UserApiRequestParams): Promise<any> => {
  let stop: () => void
  return new Promise<any>((resolve, reject) => {
    stop = watch(() => appSetting['common.apiSource'], (newVal, oldVal) => {
      // 仅主源的在途请求随主源切换作废；备源请求不受主源切换影响
      if (params.data?.apiId == null || params.data.apiId === oldVal) reject(new Error('source changed'))
    })
    void sendUserApiRequestRemote(params).then(resolve).catch(reject)
  }).finally(() => {
    stop()
  })
}

/** 为一个音源构建接口处理器与可用音质表（主源、备源共用） */
const buildApiHandlers = (apiInfo: LX.UserApi.UserApiInfo) => {
  let apis: any = {}
  let qualitys: LX.QualityList = {}
  for (const [source, { actions, type, qualitys: sourceQualitys }] of Object.entries(apiInfo.sources ?? {})) {
    if (type != 'music') continue
    apis[source as LX.Source] = {}
    for (const action of actions) {
      switch (action) {
        case 'musicUrl':
          apis[source].getMusicUrl = (songInfo: LX.Music.MusicInfo, type: LX.Quality) => {
            const requestKey = `request__${Math.random().toString().substring(2)}`
            return {
              canceleFn() {
                userApiRequestCancel(requestKey)
              },
              promise: sendUserApiRequest({
                requestKey,
                data: {
                  apiId: apiInfo.id,
                  source,
                  action: 'musicUrl',
                  info: {
                    type,
                    musicInfo: songInfo,
                  },
                },
                // eslint-disable-next-line @typescript-eslint/promise-function-async
              }).then(res => {
                // console.log(res)
                return { type, url: res.data.url }
              }).catch(async err => {
                console.log(err.message)
                return Promise.reject(err)
              }),
            }
          }
          break
        case 'lyric':
          apis[source].getLyric = (songInfo: LX.Music.MusicInfo) => {
            const requestKey = `request__${Math.random().toString().substring(2)}`
            return {
              canceleFn() {
                userApiRequestCancel(requestKey)
              },
              promise: sendUserApiRequest({
                requestKey,
                data: {
                  apiId: apiInfo.id,
                  source,
                  action: 'lyric',
                  info: {
                    type,
                    musicInfo: songInfo,
                  },
                },
                // eslint-disable-next-line @typescript-eslint/promise-function-async
              }).then(res => {
                // console.log(res)
                return res.data
              }).catch(async err => {
                console.log(err.message)
                return Promise.reject(err)
              }),
            }
          }
          break
        case 'pic':
          apis[source].getPic = (songInfo: LX.Music.MusicInfo) => {
            const requestKey = `request__${Math.random().toString().substring(2)}`
            return {
              canceleFn() {
                userApiRequestCancel(requestKey)
              },
              promise: sendUserApiRequest({
                requestKey,
                data: {
                  apiId: apiInfo.id,
                  source,
                  action: 'pic',
                  info: {
                    type,
                    musicInfo: songInfo,
                  },
                },
                // eslint-disable-next-line @typescript-eslint/promise-function-async
              }).then(res => {
                // console.log(res)
                return res.data
              }).catch(async err => {
                console.log(err.message)
                return Promise.reject(err)
              }),
            }
          }
          break
        default:
          break
      }
    }
    qualitys[source as LX.Source] = sourceQualitys
  }
  return { apis, qualitys }
}

export default () => {
  const t = useI18n()

  const rUserApiStatus = onUserApiStatus(({ params: { status, message, apiInfo } }) => {
    // console.log({ status, message, apiInfo })
    if (!apiInfo) return
    const isPrimary = apiInfo.id === appSetting['common.apiSource']
    if (isPrimary) {
      userApi.status = status
      userApi.message = message
    }
    if (status) {
      if (apiInfo.sources) {
        const { apis, qualitys } = buildApiHandlers(apiInfo)
        userApi.apis[apiInfo.id] = apis
        userApi.qualityLists[apiInfo.id] = qualitys
        if (isPrimary) qualityList.value = qualitys
      }
    } else {
      // 初始化失败的音源不可参与轮换
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete userApi.apis[apiInfo.id]
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete userApi.qualityLists[apiInfo.id]
      if (isPrimary) {
        qualityList.value = {}
        if (message) {
          void dialog({
            message: `${t('user_api__init_failed_alert', { name: apiInfo.name })}\n${message}`,
            selection: true,
            confirmButtonText: t('ok'),
          })
        }
      } else {
        // 备源失败不打断使用：仅记录，轮换时自然跳过
        console.log('backup api init failed:', apiInfo.name, message)
      }
    }
    if (isPrimary && !window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](status)
  })

  const rUserApiShowUpdateAlert = onShowUserApiUpdateAlert(({ params: { name, log, updateUrl } }) => {
    if (updateUrl) {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        showCancel: true,
        confirmButtonText: t('user_api__update_alert_open_url'),
        cancelButtonText: t('close'),
      }).then(confirm => {
        if (!confirm) return
        window.setTimeout(() => {
          void openUrl(updateUrl)
        }, 300)
      })
    } else {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        confirmButtonText: t('ok'),
      })
    }
  })

  onBeforeUnmount(() => {
    rUserApiStatus()
    rUserApiShowUpdateAlert()
  })

  return async() => {
    await setUserApi(appSetting['common.apiSource'])
    void setUserApiBackups(appSetting['common.apiSourceBackups']).catch(err => {
      console.log(err)
    })
    void getUserApiList().then(list => {
      // console.log(list)
      // if (![...apiSourceInfo.map(s => s.id), ...list.map(s => s.id)].includes(appSetting['common.apiSource'])) {
      //   console.warn('reset api')
      //   let api = apiSourceInfo.find(api => !api.disabled)
      //   if (api) apiSource.value = api.id
      // }
      userApi.list = list
    }).catch(err => {
      console.log(err)
    })
  }
}
