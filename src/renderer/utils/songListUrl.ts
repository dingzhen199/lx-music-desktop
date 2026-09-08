/**
 * 从“打开歌单”弹窗的输入内容中识别平台歌单链接的音源与歌单 id
 *
 * 各音源可识别的链接形式与 musicSdk/<source>/songList.js 中的解析正则保持一致，
 * 避免自动识别出 SDK 无法打开的链接形式
 */

export interface ParsedSongListUrl {
  source: LX.OnlineSource
  id: string
}

// 各音源歌单网页域名
const sourceHostRegExps: Array<{ source: LX.OnlineSource, regExp: RegExp }> = [
  { source: 'tx', regExp: /(^|\.)y\.qq\.com$/ },
  { source: 'kg', regExp: /(^|\.)kugou\.com$/ },
  { source: 'kw', regExp: /(^|\.)kuwo\.cn$/ },
  { source: 'wy', regExp: /(^|\.)music\.163\.com$/ },
  { source: 'mg', regExp: /(^|\.)migu\.cn$/ },
]

// 与 src/renderer/utils/musicSdk/wy/songList.js 的 regExps.listDetailLink / listDetailLink2 保持一致
const wyRegExps = [
  /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/,
  /^.+\/playlist\/(\d+)\/\d+\/.+$/,
]
// 与 src/renderer/utils/musicSdk/tx/songList.js 的 regExps.listDetailLink / listDetailLink2 保持一致
const txRegExps = [
  /\/playlist\/(\d+)/,
  /id=(\d+)/,
]
// 与 src/renderer/utils/musicSdk/kg/songList.js 的 regExps.listDetailLink 保持一致
const kgRegExp = /^.+\/(\d+)\.html(?:\?.*|&.*$|#.*$|$)/
// 与 src/renderer/utils/musicSdk/kw/songList.js 的 regExps.listDetailLink 保持一致
const kwRegExp = /^.+\/playlist(?:_detail)?\/(\d+)(?:\?.*|&.*$|#.*$|$)/
// 与 src/renderer/utils/musicSdk/mg/songList.js 的 regExps.listDetailLink 及 getListDetail 中的链接解析保持一致
const mgQueryRegExp = /(?:playlistId|id)=(\d+)/
const mgRegExp = /^.+\/playlist\/(\d+)(?:\?.*|&.*$|#.*$|$)/

const parseIdBySource: Record<LX.OnlineSource, (url: string) => string | null> = {
  wy: url => wyRegExps[0].exec(url)?.[1] ?? wyRegExps[1].exec(url)?.[1] ?? null,
  tx: url => txRegExps[0].exec(url)?.[1] ?? txRegExps[1].exec(url)?.[1] ?? null,
  kg: url => kgRegExp.exec(url)?.[1] ?? null,
  kw: url => kwRegExp.exec(url)?.[1] ?? null,
  mg: url => {
    if (/\/playlist[/?]/.test(url)) {
      const result = mgQueryRegExp.exec(url)
      if (result) return result[1]
    }
    return mgRegExp.exec(url)?.[1] ?? null
  },
}

/**
 * 解析歌单链接
 * @param input 用户输入内容，可能为歌单链接或分享文字附带链接
 * @returns 解析成功返回音源与纯数字歌单 id，否则返回 null
 */
export const parseSongListUrl = (input: string): ParsedSongListUrl | null => {
  const value = input.trim()
  // 纯数字 id、空输入不识别
  if (!value || /^\d+$/.test(value)) return null
  // 分享文字的粘贴内容可能附带说明文字，取其中的第一个链接
  const urlText = (value.match(/https?:\/\/[^\s]+/i)?.[0] ?? value)
    // 去除链接末尾混入的标点与中文等非链接内容
    .replace(/[.,;!?'"()\u4e00-\u9fff，。；：！？、）】》'’”]+$/, '')
  if (!urlText) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`)
  } catch {
    return null
  }
  const hostname = url.hostname.toLowerCase()
  for (const { source, regExp } of sourceHostRegExps) {
    if (!regExp.test(hostname)) continue
    const id = parseIdBySource[source](urlText)
    return id ? { source, id } : null
  }
  return null
}
