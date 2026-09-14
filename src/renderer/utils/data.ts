/* eslint-disable @typescript-eslint/no-dynamic-delete */
import {
  saveListPositionInfo as saveListPositionInfoFromData,
  getListPositionInfo as getListPositionInfoFromData,
  saveListPrevSelectId as saveListPrevSelectIdFromData,
  getListPrevSelectId as getListPrevSelectIdFromData,
  saveListUpdateInfo as saveListUpdateInfoFromData,
  getListUpdateInfo as getListUpdateInfoFromData,
  saveSearchSetting as saveSearchSettingFromData,
  getSearchSetting as getSearchSettingFromData,
  saveSongListSetting as saveSongListSettingFromData,
  getSongListSetting as getSongListSettingFromData,
  saveLeaderboardSetting as saveLeaderboardSettingFromData,
  getLeaderboardSetting as getLeaderboardSettingFromData,
  saveViewPrevState as saveViewPrevStateFromData,
  saveRecommendMetrics as saveRecommendMetricsFromData,
  getRecommendMetrics as getRecommendMetricsFromData,
} from '@renderer/utils/ipc'
import type { MetricsState as RecommendMetrics } from '@renderer/core/recommend/session-core'
import { throttle } from '@common/utils'
import { type DEFAULT_SETTING, LIST_IDS } from '@common/constants'
import { dateFormat } from './index'
import { setUpdateTime } from '@renderer/store/list/action'

let listPosition: LX.List.ListPositionInfo
let listPrevSelectId: string
let listUpdateInfo: LX.List.ListUpdateInfo

let searchSetting: typeof DEFAULT_SETTING['search']
let songListSetting: typeof DEFAULT_SETTING['songList']
let leaderboardSetting: typeof DEFAULT_SETTING['leaderboard']

const saveListPositionThrottle = throttle(() => {
  saveListPositionInfoFromData(listPosition)
}, 1000)
const saveSearchSettingThrottle = throttle(() => {
  saveSearchSettingFromData(searchSetting)
}, 1000)
const saveSongListSettingThrottle = throttle(() => {
  saveSongListSettingFromData(songListSetting)
}, 1000)
const saveLeaderboardSettingThrottle = throttle(() => {
  saveLeaderboardSettingFromData(leaderboardSetting)
}, 1000)
const saveViewPrevStateThrottle = throttle((state) => {
  saveViewPrevStateFromData(state)
}, 1000)

const initPosition = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPosition ??= await getListPositionInfoFromData() ?? {}
}
export const getListPosition = async(id: string): Promise<number> => {
  await initPosition()
  return listPosition[id] ?? 0
}
export const setListPosition = async(id: string, position?: number) => {
  await initPosition()
  listPosition[id] = position ?? 0
  saveListPositionThrottle()
}
export const removeListPosition = async(id: string) => {
  await initPosition()
  if (listPosition[id] == null) return
  delete listPosition[id]
  saveListPositionThrottle()
}
export const overwriteListPosition = async(ids: string[]) => {
  await initPosition()
  const removedIds = []
  for (const id of Object.keys(listPosition)) {
    if (ids.includes(id)) continue
    removedIds.push(id)
  }
  for (const id of removedIds) delete listPosition[id]
  saveListPositionThrottle()
}

const saveListPrevSelectIdThrottle = throttle(() => {
  saveListPrevSelectIdFromData(listPrevSelectId)
}, 200)
export const getListPrevSelectId = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPrevSelectId ??= await getListPrevSelectIdFromData() ?? LIST_IDS.DEFAULT
  return listPrevSelectId ?? LIST_IDS.DEFAULT
}
export const saveListPrevSelectId = (id: string) => {
  listPrevSelectId = id
  saveListPrevSelectIdThrottle()
}

const saveListUpdateInfo = throttle(() => {
  saveListUpdateInfoFromData(listUpdateInfo)
}, 1000)

const initListUpdateInfo = async() => {
  if (listUpdateInfo == null) {
    // eslint-disable-next-line require-atomic-updates
    listUpdateInfo = await getListUpdateInfoFromData() ?? {}
    for (const [id, info] of Object.entries(listUpdateInfo)) {
      setUpdateTime(id, info.updateTime ? dateFormat(info.updateTime) : '')
    }
  }
}
export const getListUpdateInfo = async() => {
  await initListUpdateInfo()
  return listUpdateInfo
}
export const setListUpdateInfo = async(info: LX.List.ListUpdateInfo) => {
  await initListUpdateInfo()
  listUpdateInfo = info
  saveListUpdateInfo()
}
// 记录不存在时按“默认参与启动自动更新”补建（与启动谓词 isAutoUpdate !== false 保持一致）
const getOrCreateListUpdateInfo = (id: string): LX.List.ListUpdateInfo[string] => listUpdateInfo[id] ?? { updateTime: 0, isAutoUpdate: true }
export const setListAutoUpdate = async(id: string, enable: boolean) => {
  await initListUpdateInfo()
  const targetInfo = getOrCreateListUpdateInfo(id)
  targetInfo.isAutoUpdate = enable
  listUpdateInfo[id] = targetInfo
  saveListUpdateInfo()
}
export const setListUpdateTime = async(id: string, time: number) => {
  await initListUpdateInfo()
  const targetInfo = getOrCreateListUpdateInfo(id)
  targetInfo.updateTime = time
  listUpdateInfo[id] = targetInfo
  saveListUpdateInfo()
}
export const setListUpdateError = async(id: string, error: string | null) => {
  await initListUpdateInfo()
  const targetInfo = getOrCreateListUpdateInfo(id)
  targetInfo.updateError = error
  listUpdateInfo[id] = targetInfo
  saveListUpdateInfo()
}
// export const setListUpdateInfo = (id, { updateTime, isAutoUpdate }) => {
//   listUpdateInfo[id] = { updateTime, isAutoUpdate }
//   saveListUpdateInfo()
// }
export const removeListUpdateInfo = async(id: string) => {
  await initListUpdateInfo()
  if (listUpdateInfo[id] == null) return
  delete listUpdateInfo[id]
  saveListUpdateInfo()
}
export const overwriteListUpdateInfo = async(ids: string[]) => {
  await initListUpdateInfo()
  const removedIds = []
  for (const id of Object.keys(listUpdateInfo)) {
    if (ids.includes(id)) continue
    removedIds.push(id)
  }
  for (const id of removedIds) delete listUpdateInfo[id]
  saveListUpdateInfo()
}


export const getSearchSetting = async() => {
  // eslint-disable-next-line require-atomic-updates
  searchSetting ??= await getSearchSettingFromData()
  return { ...searchSetting }
}
export const setSearchSetting = async(setting: Partial<typeof DEFAULT_SETTING['search']>) => {
  if (!searchSetting) await getSearchSetting()
  let requiredSave = false
  if (setting.source && searchSetting.source != setting.source) requiredSave = true
  if (setting.type && searchSetting.type != setting.type) requiredSave = true
  if (setting.temp_source && searchSetting.temp_source != setting.temp_source) requiredSave = true

  if (!requiredSave) return
  searchSetting = Object.assign(searchSetting, setting)
  saveSearchSettingThrottle()
}

export const getSongListSetting = async() => {
  // eslint-disable-next-line require-atomic-updates
  songListSetting ??= await getSongListSettingFromData()
  return { ...songListSetting }
}
export const setSongListSetting = async(setting: Partial<typeof DEFAULT_SETTING['songList']>) => {
  if (!songListSetting) await getSongListSetting()
  songListSetting = Object.assign(songListSetting, setting)
  saveSongListSettingThrottle()
}

export const getLeaderboardSetting = async() => {
  // eslint-disable-next-line require-atomic-updates
  leaderboardSetting ??= await getLeaderboardSettingFromData()
  return { ...leaderboardSetting }
}
export const setLeaderboardSetting = async(setting: Partial<typeof DEFAULT_SETTING['leaderboard']>) => {
  if (!leaderboardSetting) await getLeaderboardSetting()
  leaderboardSetting = Object.assign(leaderboardSetting, setting)
  saveLeaderboardSettingThrottle()
}

export const saveViewPrevState = (state: typeof DEFAULT_SETTING['viewPrevState']) => {
  saveViewPrevStateThrottle(state)
}

// ===== 探索电台本地指标（TT-4，D9/D14）：单 JSON 快照读写对 =====
let recommendMetrics: RecommendMetrics | null
const initRecommendMetrics = async() => {
  // ipc 管道已收窄为 unknown 透传（通用层不识特性类型），本门面是类型收口点：按 session-core 的形状落型。
  // no-unnecessary-type-assertion 豁免原因：eslint 的 type 程序用根 tsconfig（路径别名未开），
  // ipc 模块在其视角下为 any，断言被误判多余；真实 tsc（src/renderer/tsconfig.json，别名生效）下断言必需
  // eslint-disable-next-line require-atomic-updates, @typescript-eslint/no-unnecessary-type-assertion
  recommendMetrics ??= await getRecommendMetricsFromData() as RecommendMetrics | null
}
/** 读取指标快照（无存档为 null，归一口径在 session-core.hydrateMetrics）。 */
export const getRecommendMetrics = async(): Promise<RecommendMetrics | null> => {
  await initRecommendMetrics()
  return recommendMetrics ?? null
}
/**
 * 写入指标快照：关键事件直写不节流（事件量级小——只发生在切歌/反馈/开收台/计划完成点），
 * 延迟合并会把“最后一次事件”的落盘时机让给不确定的节流窗口，对计数器没有收益。
 */
export const saveRecommendMetrics = (metrics: RecommendMetrics): void => {
  recommendMetrics = metrics
  saveRecommendMetricsFromData(metrics)
}
