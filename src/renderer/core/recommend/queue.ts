import { sameSong } from './sameSong'

interface Candidate {
  musicInfo?: LX.Music.MusicInfo
}

/** 提交前按实时队列去重；同时保留候选顺序、来源证据和批内唯一性。 */
export const filterQueuedResult = <T extends { candidates: Candidate[] }>(
  result: T,
  queue: ReadonlyArray<Pick<LX.Player.PlayMusicInfo, 'musicInfo'>>,
): T => {
  const seen = queue.map(({ musicInfo }) => 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo)
  const candidates = result.candidates.filter(({ musicInfo }) => {
    if (!musicInfo) return false
    const ref = { artist: musicInfo.singer, title: musicInfo.name }
    if (seen.some(info => info.id === musicInfo.id || sameSong({ artist: info.singer, title: info.name }, ref))) return false
    seen.push(musicInfo)
    return true
  })
  return { ...result, candidates }
}
