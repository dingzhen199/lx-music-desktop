import { setListUpdateTime, setListUpdateError } from '@renderer/utils/data'
import { setFetchingListStatus, overwriteListMusics, setUpdateTime } from './action'
import { getListDetailAll } from '@renderer/store/songList/action'
import { getListDetailAll as getBoardListAll } from '@renderer/store/leaderboard/action'
import { dateFormat } from '@common/utils/common'

const fetchList = async(id: string, source: LX.OnlineSource, sourceListId: string) => {
  setFetchingListStatus(id, true)

  let promise
  if (/^board__/.test(sourceListId)) {
    const id = sourceListId.replace(/^board__/, '')
    promise = id ? getBoardListAll(id, true) : Promise.reject(new Error('id not defined: ' + sourceListId))
  } else {
    promise = getListDetailAll(sourceListId, source, true)
  }
  return promise.finally(() => {
    setFetchingListStatus(id, false)
  })
}

const getErrorMsg = (err: unknown) => {
  if (err instanceof Error) return err.message
  if (typeof err == 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

export default async(targetListInfo: LX.List.UserListInfo) => {
  // console.log(targetListInfo)
  if (!targetListInfo.source || !targetListInfo.sourceListId) return
  try {
    const list = await fetchList(targetListInfo.id, targetListInfo.source, targetListInfo.sourceListId)
    // console.log(list)
    void overwriteListMusics({ listId: targetListInfo.id, musicInfos: list })
    const now = Date.now()
    void setListUpdateTime(targetListInfo.id, now)
    void setListUpdateError(targetListInfo.id, null)
    setUpdateTime(targetListInfo.id, dateFormat(now))
  } catch (err) {
    // 更新失败时记录错误信息，保留本地旧数据，等待下次启动自动更新时重试
    void setListUpdateError(targetListInfo.id, getErrorMsg(err))
    throw err
  }
}
