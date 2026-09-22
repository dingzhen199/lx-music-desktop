import { qualityList, userApi } from '@renderer/store'
import musicSdk from '@renderer/utils/musicSdk'
import {
  // getOtherSource as getOtherSourceFromStore,
  // saveOtherSource as saveOtherSourceFromStore,
  getMusicUrl as getStoreMusicUrl,
  getPlayerLyric as getStoreLyric,
} from '@renderer/utils/ipc'
import { appSetting } from '@renderer/store/setting'
import { langS2T, toNewMusicInfo, toOldMusicInfo } from '@renderer/utils'
import { apis } from '@renderer/utils/musicSdk/api-source'
import { buildBackupApiIds, isProviderServable } from './sourceRotation'
import { sourceRotationEnv } from './sourceCapabilities'
import { matchSeed, parseIntervalSec } from '../recommend/seedMatch'


const getOtherSourcePromises = new Map()
const otherSourceCache = new Map<LX.Music.MusicInfo | LX.Download.ListItem, LX.Music.MusicInfoOnline[]>()
export const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/

export const getOtherSource = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  // if (!isRefresh && musicInfo.id) {
  //   const cachedInfo = await getOtherSourceFromStore(musicInfo.id)
  //   if (cachedInfo.length) return cachedInfo
  // }
  if (otherSourceCache.has(musicInfo)) return otherSourceCache.get(musicInfo)!
  let key: string
  let searchMusicInfo: {
    name: string
    singer: string
    source: string
    albumName: string
    interval: string
  }
  if ('progress' in musicInfo) {
    key = `local_${musicInfo.id}`
    searchMusicInfo = {
      name: musicInfo.metadata.musicInfo.name,
      singer: musicInfo.metadata.musicInfo.singer,
      source: musicInfo.metadata.musicInfo.source,
      albumName: musicInfo.metadata.musicInfo.meta.albumName,
      interval: musicInfo.metadata.musicInfo.interval ?? '',
    }
  } else {
    key = `${musicInfo.source}_${musicInfo.id}`
    searchMusicInfo = {
      name: musicInfo.name,
      singer: musicInfo.singer,
      source: musicInfo.source,
      albumName: musicInfo.meta.albumName,
      interval: musicInfo.interval ?? '',
    }
  }
  if (getOtherSourcePromises.has(key)) return getOtherSourcePromises.get(key)

  const promise = new Promise<LX.Music.MusicInfoOnline[]>((resolve, reject) => {
    let timeout: null | NodeJS.Timeout = setTimeout(() => {
      timeout = null
      reject(new Error('find music timeout'))
    }, 15_000)
    musicSdk.findMusic(searchMusicInfo).then((otherSource) => {
      if (otherSourceCache.size > 10) otherSourceCache.clear()
      const source = otherSource.map(toNewMusicInfo) as LX.Music.MusicInfoOnline[]
      otherSourceCache.set(musicInfo, source)
      resolve(source)
    }).catch(reject).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
  }).then((otherSource) => {
    // if (otherSource.length) void saveOtherSourceFromStore(musicInfo.id, otherSource)
    return otherSource
  }).finally(() => {
    if (getOtherSourcePromises.has(key)) getOtherSourcePromises.delete(key)
  })
  getOtherSourcePromises.set(key, promise)
  return promise
}


export const buildLyricInfo = async(lyricInfo: MakeOptional<LX.Player.LyricInfo, 'rawlrcInfo'>): Promise<LX.Player.LyricInfo> => {
  if (!appSetting['player.isS2t']) {
    // @ts-expect-error
    if (lyricInfo.rawlrcInfo) return lyricInfo
    return { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
  }

  if (appSetting['player.isS2t']) {
    const tasks = [
      lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''),
      lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''),
      lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''),
      lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''),
    ]
    if (lyricInfo.rawlrcInfo) {
      tasks.push(lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''))
      tasks.push(lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''))
    }
    return Promise.all(tasks).then(([lyric, tlyric, rlyric, lxlyric, lyric_raw, tlyric_raw, rlyric_raw, lxlyric_raw]) => {
      const rawlrcInfo = lyric_raw ? {
        lyric: lyric_raw,
        tlyric: tlyric_raw,
        rlyric: rlyric_raw,
        lxlyric: lxlyric_raw,
      } : {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
      }
      return {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
        rawlrcInfo,
      }
    })
  }

  // @ts-expect-error
  return lyricInfo.rawlrcInfo ? lyricInfo : { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
}

export const getCachedLyricInfo = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Player.LyricInfo | null> => {
  let lrcInfo = await getStoreLyric(musicInfo)
  // lrcInfo = {} as unknown as LX.Player.LyricInfo
  if (existTimeExp.test(lrcInfo.lyric)) {
    if (lrcInfo.tlyric != null) {
      // if (musicInfo.lrc.startsWith('\ufeff[id:$00000000]')) {
      //   let str = musicInfo.lrc.replace('\ufeff[id:$00000000]\n', '')
      //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
      // } else if (musicInfo.lrc.startsWith('[id:$00000000]')) {
      //   let str = musicInfo.lrc.replace('[id:$00000000]\n', '')
      //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
      // }

      if (lrcInfo.lxlyric == null) {
        switch (musicInfo.source) { // 以下源支持lxlyric 重新获取
          case 'kg':
          case 'kw':
          case 'mg':
          case 'wy':
          case 'tx':
            break
          default:
            return lrcInfo
        }
      } else if (lrcInfo.rlyric == null) {
        // 以下源支持 rlyric 重新获取
        if (!['wy', 'kg', 'tx'].includes(musicInfo.source)) return lrcInfo
      } else return lrcInfo
    }
    if (musicInfo.source == 'local') return lrcInfo
  }
  return null
}

export const getOnlineOtherSourceMusicUrlByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean): Promise<{
  url: string
  quality: LX.Quality
  isFromCache: boolean
}> => {
  if (!await window.lx.apiInitPromise[0]) throw new Error('source init failed')

  const quality = '128k'

  const cachedUrl = await getStoreMusicUrl(musicInfo, quality)
  if (cachedUrl && !isRefresh) return { url: cachedUrl, quality, isFromCache: true }

  let reqPromise
  try {
    reqPromise = apis('local').getMusicUrl(toOldMusicInfo(musicInfo), null).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return reqPromise.then(({ url }: { url: string }) => {
    return { url, quality, isFromCache: false }
  })
}

export const getOnlineOtherSourceLyricByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean): Promise<{
  lyricInfo: LX.Music.LyricInfo
  isFromCache: boolean
}> => {
  if (!await window.lx.apiInitPromise[0]) throw new Error('source init failed')

  const lyricInfo = await getCachedLyricInfo(musicInfo)
  if (lyricInfo && !isRefresh) return { lyricInfo, isFromCache: true }

  let reqPromise
  try {
    reqPromise = apis('local').getLyric(toOldMusicInfo(musicInfo)).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return { lyricInfo, isFromCache: false }
  })
}

export const getOnlineOtherSourcePicByLocal = async(musicInfo: LX.Music.MusicInfoLocal): Promise<{
  url: string
}> => {
  if (!await window.lx.apiInitPromise[0]) throw new Error('source init failed')

  let reqPromise
  try {
    reqPromise = apis('local').getPic(toOldMusicInfo(musicInfo)).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }

  return reqPromise.then((url: string) => {
    return { url }
  })
}

export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k'] as const
type TryQualityType = typeof TRY_QUALITYS_LIST[number]
export const getPlayQuality = (highQuality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline, apiId?: string): LX.Quality => {
  let type: LX.Quality = '128k'
  if (TRY_QUALITYS_LIST.includes(highQuality as TryQualityType)) {
    // 指定 apiId 时按该音源自己的可用音质取档（备源与主源支持的档位可能不同）
    let list = apiId == null ? qualityList.value[musicInfo.source] : userApi.qualityLists[apiId]?.[musicInfo.source]

    let t = TRY_QUALITYS_LIST
      .slice(TRY_QUALITYS_LIST.indexOf(highQuality as TryQualityType))
      .find(q => musicInfo.meta._qualitys[q] && list?.includes(q))

    if (t) type = t
  }
  return type
}

/** 通过指定音源取流（apiId 为空走主源默认路径） */
const fetchMusicUrlByApi = async(musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality, apiId?: string): Promise<{ url: string, type: LX.Quality }> => {
  let reqPromise: Promise<{ url: string, type: LX.Quality }> | null = null
  try {
    if (apiId) {
      const handler = apis(musicInfo.source, apiId)
      if (handler?.getMusicUrl) reqPromise = handler.getMusicUrl(toOldMusicInfo(musicInfo), quality).promise
    } else {
      reqPromise = musicSdk[musicInfo.source].getMusicUrl(toOldMusicInfo(musicInfo), quality).promise
    }
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise ?? Promise.reject(new Error('api is not found'))
}

/**
 * 主源失败后按序轮换备源（提供方内层）。429 限流与普通失败同样立即切下一个源，不做同源等待重试。
 * allowToggleSource 为 false 时不轮换（保持既有语义：换源重放分支与关闭自动换源的下载不切换）。
 */
const fetchMusicUrlWithRotation = async({ musicInfo, quality, onToggleApiSource, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  onToggleApiSource?: () => void
  allowToggleSource: boolean
}): Promise<{ url: string, quality: LX.Quality }> => {
  let firstError: any
  try {
    if (!await window.lx.apiInitPromise[0]) throw new Error('source init failed')
    const primaryQuality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo)
    const { url, type } = await fetchMusicUrlByApi(musicInfo, primaryQuality)
    return { url, quality: type }
  } catch (err: any) {
    firstError = err
    console.log(err)
  }
  if (!allowToggleSource) throw firstError
  for (const apiId of buildBackupApiIds(sourceRotationEnv(), musicInfo.source)) {
    const itemQuality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo, apiId)
    if (!musicInfo.meta._qualitys[itemQuality]) continue
    onToggleApiSource?.()
    try {
      const { url, type } = await fetchMusicUrlByApi(musicInfo, itemQuality, apiId)
      return { url, quality: type }
    } catch (err: any) {
      console.log(err)
    }
  }
  throw firstError
}

export const getOnlineOtherSourceMusicUrl = async({ musicInfos, quality, onToggleSource, onToggleApiSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  quality?: LX.Quality
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  onToggleApiSource?: () => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
}> => {
  await window.lx.apiInitPromise[0]

  const env = sourceRotationEnv()
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // 主源或任一备源可服务即不跳过（仅主源不支持的平台可能由备源救回）
    if (!isProviderServable(env, musicInfo.source)) continue

    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(window.i18n.t('toggle_source_failed'))

  // 主源音质仅用于查询缓存，不能据此淘汰提供方；取流时各音源独立选档。
  const itemQuality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo)
  const cachedUrl = await getStoreMusicUrl(musicInfo, itemQuality)
  if (cachedUrl && !isRefresh) return { url: cachedUrl, musicInfo, quality: itemQuality, isFromCache: true }

  // 提供方内层：主源 → 备源按序轮换；穷尽后递归下一个候选提供方
  try {
    const { url, quality: type } = await fetchMusicUrlWithRotation({ musicInfo, quality, onToggleApiSource, allowToggleSource: true })
    return { musicInfo, url, quality: type, isFromCache: false }
  } catch (err: any) {
    console.log(err)
    return getOnlineOtherSourceMusicUrl({ musicInfos, quality, onToggleSource, onToggleApiSource, isRefresh, retryedSource })
  }
}

/**
 * 获取在线音乐URL
 */
export const handleGetOnlineMusicUrl = async({ musicInfo, quality, onToggleSource, onToggleApiSource, isRefresh, allowToggleSource, alternativeMusicInfos = [] }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource: boolean
  alternativeMusicInfos?: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  onToggleApiSource?: () => void
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  // 提供方内层：先穷尽本提供方的所有启用音源（主源 → 备源按序）
  try {
    const { url, quality: type } = await fetchMusicUrlWithRotation({ musicInfo, quality, onToggleApiSource, allowToggleSource })
    return { musicInfo, url, quality: type, isFromCache: false }
  } catch (err: any) {
    console.log(err)
    if (!allowToggleSource) throw err
    // 聚合的同作品去重不等于同录音：先校验标题/艺人/版本，并沿用换源的 ±5 秒时长限制。
    const toTrack = (info: LX.Music.MusicInfoOnline) => ({
      artist: info.singer, title: info.name, album: info.meta.albumName, intervalSec: parseIntervalSec(info.interval),
    })
    const target = toTrack(musicInfo)
    const known = alternativeMusicInfos.filter(info => {
      if (info.source === musicInfo.source) return false
      const track = toTrack(info)
      if (target.intervalSec != null && track.intervalSec != null && Math.abs(target.intervalSec - track.intervalSec) > 5) return false
      return matchSeed(target, [track]) != null
    })
    const retryedSource = [musicInfo.source]
    if (known.length) {
      try {
        return await getOnlineOtherSourceMusicUrl({ musicInfos: known, quality, onToggleSource, onToggleApiSource, isRefresh, retryedSource })
      } catch {}
    }
    // 提供方外层：切换到其他提供方的同曲变体（findMusic 候选，按音质丰富度排序）
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourceMusicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          onToggleApiSource,
          quality,
          isRefresh,
          retryedSource,
        })
      }
      throw err
    })
  }
}


export const getOnlineOtherSourcePicUrl = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(window.i18n.t('toggle_source_failed'))

  if (musicInfo.meta.picUrl && !isRefresh) return { musicInfo, url: musicInfo.meta.picUrl, isFromCache: true }

  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourcePicUrl({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌曲封面
 */
export const handleGetOnlinePicUrl = async({ musicInfo, isRefresh, onToggleSource, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourcePicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}


export const getOnlineOtherSourceLyricInfo = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(window.i18n.t('toggle_source_failed'))

  if (!isRefresh) {
    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo) return { musicInfo, lyricInfo, isFromCache: true }
  }

  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = (musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)) as any).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      lyricInfo,
      musicInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourceLyricInfo({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌词信息
 */
export const handleGetOnlineLyricInfo = async({ musicInfo, onToggleSource, isRefresh, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  musicInfo: LX.Music.MusicInfoOnline
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = (musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)) as any).promise
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      musicInfo,
      lyricInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err

    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourceLyricInfo({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}
