import { qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { normalizeApiSourceBackups } from '@common/userApi'
import { isProviderServable, type SourceRotationEnv } from './sourceRotation'

/** UI 与取流链使用同一份启用、就绪及取流能力快照。 */
export const sourceRotationEnv = (): SourceRotationEnv => {
  const primaryApiId = appSetting['common.apiSource']
  const readyApiIds = Object.keys(userApi.apis)
  const servedProviders: Record<string, string[]> = {}
  for (const apiId of readyApiIds) {
    servedProviders[apiId] = Object.keys(userApi.qualityLists[apiId] ?? {})
      .filter(provider => typeof userApi.apis[apiId]?.[provider as LX.Source]?.getMusicUrl === 'function')
  }
  return {
    primaryApiId,
    primaryServedProviders: Object.keys(qualityList.value),
    backupApiIds: normalizeApiSourceBackups(primaryApiId, appSetting['common.apiSourceBackups']),
    readyApiIds,
    servedProviders,
  }
}

/** 仅供播放入口使用；下载等其他能力仍按其自身规则判断。 */
export const assertPlaybackSupport = (source: LX.Source): boolean => {
  return source === 'local' || isProviderServable(sourceRotationEnv(), source)
}
