
import { httpFetch } from '../../../request'
import { zzcSign } from './crypto'

export const signRequest = (data) => {
  // console.log(data)
  let requestObj = null
  let cancelled = false
  const promise = zzcSign(JSON.stringify(data)).then(sign => {
    if (cancelled) throw new Error('request cancelled')
    // console.log('sign', sign)
    requestObj = httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
      method: 'post',
      headers: {
        'User-Agent': 'QQMusic 14090508(android 12)',
      },
      body: data,
    })
    return requestObj.promise
  })
  promise.cancel = () => {
    cancelled = true
    requestObj?.cancelHttp?.()
  }
  return promise
}
