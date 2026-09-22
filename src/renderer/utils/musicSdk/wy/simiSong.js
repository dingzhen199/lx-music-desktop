// 平台相似歌曲接口封装（P0 实测记录见 docs/platform-similar-recommendation-p0.md）。
// 端点：eapi /api/v1/discovery/simiSong（与搜索同传输，POST interface.music.163.com/eapi/batch）。
// 匿名可用；无分页（limit/offset 被忽略，每种子最多约 5 首）；版权受限种子返回空列表。
// 本模块不做重试（重试统一在 core/recommend/platformRecall 适配层单层执行，避免叠加放大流量）。
import { sizeFormate, formatPlayTime } from '../../index'
import { eapiRequest } from './utils/index'

export default {
  limit: 5,
  getSinger(singers) {
    let arr = []
    singers.forEach(singer => {
      arr.push(singer.name)
    })
    return arr.join('、')
  },
  // simiSong 返回旧版歌曲结构（artists/album/duration，非搜索的 baseInfo.simpleSongData）；
  // 音质档位推导与 musicSearch.handleResult 同口径（privilege.maxBrLevel/maxbr）。
  buildTypes(item) {
    const types = []
    const _types = {}
    let size
    const privilege = item.privilege ?? {}
    if (privilege.maxBrLevel == 'hires') {
      size = item.hr ? sizeFormate(item.hr.size) : null
      types.push({ type: 'flac24bit', size })
      _types.flac24bit = {
        size,
      }
    }
    switch (privilege.maxbr) {
      case 999000:
        size = item.sq ? sizeFormate(item.sq.size) : null
        types.push({ type: 'flac', size })
        _types.flac = {
          size,
        }
      case 320000:
        size = item.h ? sizeFormate(item.h.size) : null
        types.push({ type: '320k', size })
        _types['320k'] = {
          size,
        }
      case 192000:
      case 128000:
        size = item.l ? sizeFormate(item.l.size) : null
        types.push({ type: '128k', size })
        _types['128k'] = {
          size,
        }
    }
    types.reverse()
    return { types, _types }
  },
  handleResult(rawList) {
    if (!rawList) return []
    return rawList.map(item => {
      const { types, _types } = this.buildTypes(item)
      return {
        singer: this.getSinger(item.artists ?? []),
        name: item.name,
        albumName: item.album?.name,
        albumId: item.album?.id,
        source: 'wy',
        interval: formatPlayTime(item.duration / 1000),
        songmid: item.id,
        img: item.album?.picUrl,
        lrc: null,
        types,
        _types,
        typeUrl: {},
      }
    })
  },
  /**
   * 按种子歌曲 id 获取相似歌曲。
   * @param {string|number} songId wy 数字歌曲 id（与搜索结果 songmid 同一标识）
   * @returns {Promise<{ source: 'wy', list: Array }>} 归一化为与搜索结果同构的列表（可直接 toNewMusicInfo）
   */
  async getSimiSong(songId) {
    const requestObj = eapiRequest('/api/v1/discovery/simiSong', {
      songid: Number(songId),
    })
    const { body, statusCode } = await requestObj.promise
    if (statusCode != 200 || body?.code !== 200) {
      // P0 实测：不存在的 id 也返回 code 200 + 空 songs；非 200 视为请求失败
      throw new Error('获取相似歌曲失败')
    }
    return { source: 'wy', list: this.handleResult(body.songs ?? []) }
  },
}
