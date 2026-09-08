import { getListUpdateInfo } from '@renderer/utils/data'
import { userLists } from '@renderer/store/list/state'
import syncSourceList from '@renderer/store/list/syncSourceList'

const handleSyncSourceList = async(waitUpdateLists: LX.List.UserListInfo[]) => {
  if (!waitUpdateLists.length) return
  const targetListInfo = waitUpdateLists.shift()!
  // console.log(targetListInfo)
  try {
    await syncSourceList(targetListInfo)
  } catch {}
  void handleSyncSourceList(waitUpdateLists)
}

export default () => {
  void getListUpdateInfo().then(listUpdateInfo => {
    // 默认同步所有在线列表（带 sourceListId），除非用户在「列表更新管理」中显式关闭了自动更新
    const waitUpdateLists = userLists
      .filter(l => !!l.source && !!l.sourceListId && listUpdateInfo[l.id]?.isAutoUpdate !== false)
    // for (let i = 2; i > 0; i--) {
    //   void handleSyncSourceList(waitUpdateLists)
    void handleSyncSourceList(waitUpdateLists)
    // }
  })
}
