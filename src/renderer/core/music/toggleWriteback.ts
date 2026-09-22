import { allMusicList, defaultList, loveList, removeListMusics, userLists } from '@renderer/store/list/listManage'
import { addListMusics, updateListMusicsPosition } from '@renderer/store/list/action'
import { playMusicInfo } from '@renderer/store/player/state'

const isUserList = (listId: string | null): boolean => {
  if (!listId) return false
  return listId == defaultList.id || listId == loveList.id || userLists.some(l => l.id == listId)
}

/**
 * 自动换源成功后把提供方变更写回「我的列表」（ADR-0003）。
 *
 * 数据变更序列与手动「歌曲换源」一致（移除原曲 → 追加同曲变体 → 归位到原位置），
 * 但不调用 playListById、不改写 playMusicInfo.musicInfo——歌曲已在播，播放状态保持原对象，
 * 不触发 musicToggled（对探索电台而言换源是同曲，不跟歌重锚）。
 * 排行榜、搜索结果、稍后播放等临时上下文不写回。
 */
export const writebackToggleMusicInfo = async(originalInfo: LX.Music.MusicInfoOnline, toggleInfo: LX.Music.MusicInfoOnline) => {
  const listId = playMusicInfo.listId
  if (playMusicInfo.isTempPlay || !listId || !isUserList(listId)) return
  // 取流期间已切歌则放弃写回
  if (playMusicInfo.musicInfo !== originalInfo) return
  const list = allMusicList.get(listId)
  if (!list) return

  const oldId = originalInfo.id
  let oldIdx = list.findIndex(m => m.id == oldId)
  if (oldIdx < 0) return
  const id = toggleInfo.id
  const index = list.findIndex(m => m.id == id)
  const removeIds = [oldId]
  if (index > -1) removeIds.push(id)

  await removeListMusics({ listId, ids: removeIds })
  await addListMusics(listId, [toggleInfo], 'bottom')
  if (index != -1 && index < oldIdx) oldIdx--
  await updateListMusicsPosition({ listId, ids: [id], position: oldIdx })

  // 复用既有 toggleMusicInfo 机制：原对象再次播放时优先走已验证的同曲变体
  originalInfo.meta.toggleMusicInfo = toggleInfo
}
