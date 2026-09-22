import { hasDislike } from '@renderer/store/dislikeList/action'
import { getListMusics } from '@renderer/store/list/listManage/rendererListManage'
import { loveList } from '@renderer/store/list/listManage/state'
import { tempPlayList } from '@renderer/store/player/state'
import { sameSong, type SongRef } from './sameSong'
import { filterQueuedResult } from './queue'

/** 所有推荐入口在提交前重新读取收藏，等待结束后检查实时排除规则与队列。 */
export const filterForSubmission = async<T extends { candidates: Array<{ musicInfo?: LX.Music.MusicInfo }> }>(
  result: T,
  options: { isCancelled?: () => boolean, dislikedTracks?: () => SongRef[] } = {},
): Promise<T> => {
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error('推荐计划已取消')
  }
  checkCancelled()
  // 读取失败交给计划层处理，不能把未知收藏状态当作空列表而推荐已收藏歌曲。
  const loved = await getListMusics(loveList.id)
  checkCancelled()
  const excluded = [
    ...loved.map(info => ({ artist: info.singer, title: info.name })),
    ...(options.dislikedTracks?.() ?? []),
  ]
  return filterQueuedResult({
    ...result,
    candidates: result.candidates.filter(({ musicInfo }) => musicInfo && !hasDislike(musicInfo) &&
      !excluded.some(track => sameSong(track, { artist: musicInfo.singer, title: musicInfo.name }))),
  }, tempPlayList)
}
