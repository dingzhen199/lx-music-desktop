// 平台相似歌曲接口封装（P0 实测记录见 docs/platform-similar-recommendation-p0.md）。
// 端点：POST https://u.y.qq.com/cgi-bin/musicu.fcg（普通 JSON，无需 zzc 签名），
// module rcmusic.similarSongRadioServer / method get_simsongs，param { songid: 数字id }。
// 匿名可用；无分页（每种子 0–5 首，is_finish 恒 1）；参数类型错误返回 simsongs.code=2001。
// 本模块不做重试（重试统一在 core/recommend/platformRecall 适配层单层执行，避免叠加放大流量）。
import { httpFetch } from '../../request'
import { sizeFormate, formatPlayTime } from '../../index'
import { formatSingerName } from '../utils'

export default {
  // songInfoList 条目与搜索结果同构（singer/album/file.size_* 等），映射口径与 musicSearch.handleResult 一致
  handleResult(rawList) {
    if (!rawList || !Array.isArray(rawList)) return []
    const list = []
    rawList.forEach(item => {
      if (!item.file?.media_mid) return

      let types = []
      let _types = {}
      const file = item.file
      if (file.size_128mp3 != 0) {
        let size = sizeFormate(file.size_128mp3)
        types.push({ type: '128k', size })
        _types['128k'] = {
          size,
        }
      }
      if (file.size_320mp3 !== 0) {
        let size = sizeFormate(file.size_320mp3)
        types.push({ type: '320k', size })
        _types['320k'] = {
          size,
        }
      }
      if (file.size_flac !== 0) {
        let size = sizeFormate(file.size_flac)
        types.push({ type: 'flac', size })
        _types.flac = {
          size,
        }
      }
      if (file.size_hires !== 0) {
        let size = sizeFormate(file.size_hires)
        types.push({ type: 'flac24bit', size })
        _types.flac24bit = {
          size,
        }
      }
      let albumId = ''
      let albumName = ''
      if (item.album) {
        albumName = item.album.name
        albumId = item.album.mid
      }
      list.push({
        singer: formatSingerName(item.singer, 'name'),
        name: item.title,
        albumName,
        albumId,
        source: 'tx',
        interval: item.interval ? formatPlayTime(item.interval) : null,
        songId: item.id,
        albumMid: item.album?.mid ?? '',
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: (albumId === '' || albumId === '空')
          ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : ''
          : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
        types,
        _types,
        typeUrl: {},
      })
    })
    return list
  },
  /**
   * 按种子歌曲 id 获取相似歌曲（“相关歌曲”）。
   * @param {string|number} songId tx 数字歌曲 id（搜索结果的 songId 字段，非 songmid）
   * @returns {Promise<{ source: 'tx', list: Array }>} 归一化为与搜索结果同构的列表（可直接 toNewMusicInfo）
   */
  getSimiSong(songId) {
    const requestObj = httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
      },
      body: {
        comm: {
          g_tk: 5381,
          format: 'json',
          inCharset: 'utf-8',
          outCharset: 'utf-8',
          notice: 0,
          platform: 'h5',
          needNewCode: 1,
        },
        simsongs: {
          module: 'rcmusic.similarSongRadioServer',
          method: 'get_simsongs',
          param: {
            songid: Number(songId),
          },
        },
      },
    })
    const promise = requestObj.promise.then(({ body, statusCode }) => {
      if (statusCode != 200) throw new Error('获取相似歌曲失败')
      const sub = body?.simsongs
      // P0 实测：成功 code=0；参数类型错误 code=2001；空列表与错误可区分
      if (!sub || sub.code !== 0) throw new Error(`获取相似歌曲失败(${sub?.code ?? 'unknown'})`)
      return { source: 'tx', list: this.handleResult(sub.data?.songInfoList ?? []) }
    })
    promise.cancel = () => requestObj.cancelHttp?.()
    return promise
  },
}
