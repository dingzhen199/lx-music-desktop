import { allMusicList, defaultList, loveList, removeListMusics, userLists } from '@renderer/store/list/listManage'
import { addListMusics, updateListMusicsPosition } from '@renderer/store/list/action'
import { playMusicInfo } from '@renderer/store/player/state'
import { replacePlayMusicInfo } from '@renderer/store/player/action'
import { isProviderChanged } from './sourceRotation'

const isUserList = (listId: string | null): boolean => {
  if (!listId) return false
  return listId == defaultList.id || listId == loveList.id || userLists.some(l => l.id == listId)
}

/**
 * 自动换源成功后把提供方变更写回「我的列表」（ADR-0003）。
 *
 * 先插入并归位新条目，再迁移当前播放身份，最后移除旧条目。
 * 每个列表变更事件都能找到当前歌曲；不重置音频、进度或触发 musicToggled。
 * 排行榜、搜索结果、稍后播放等临时上下文不写回。
 */
export const writebackToggleMusicInfo = async(originalInfo: LX.Music.MusicInfoOnline, toggleInfo: LX.Music.MusicInfoOnline) => {
  if (!isProviderChanged(originalInfo.source, toggleInfo.source)) return
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
  await addListMusics(listId, [toggleInfo], 'bottom')
  if (index != -1 && index < oldIdx) oldIdx--
  await updateListMusicsPosition({ listId, ids: [id], position: oldIdx })

  // 迟到的封面/歌词仍属于同曲；若已切歌，replacePlayMusicInfo 不修改新播放。
  originalInfo.meta.toggleMusicInfo = toggleInfo
  replacePlayMusicInfo(listId, originalInfo, toggleInfo)
  await removeListMusics({ listId, ids: [oldId] })
}
