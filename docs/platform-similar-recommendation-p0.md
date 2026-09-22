# 平台相似歌曲能力调查记录（P0）

日期：2026-09-20（所有结论均来自当日从本机实际发出的网络请求，原始脱敏样本见仓库外调查过程记录；本文只收录经过实测验证的事实，未实测的端点不出现）

调查目标：确认网易（wy）、QQ（tx）是否存在「按单曲种子返回相似歌曲」的真实接口、匿名可用性、返回结构与限制，为平台相似推荐（`docs/platform-similar-recommendation-spec.md`）的 P1/P2 提供依据。

调查方法：以 Node 脚本复用本仓库 musicSdk 现有加密与传输实现（`wy/utils/crypto.js` 的 `eapi`/`weapi`、`tx/utils/crypto.js` 的 `zzcSign`），按 `wy/utils/index.js`（eapi/batch 表单 POST）与 `tx/musicSearch.js`（musics.fcg 签名 POST）的相同传输形态直接请求平台端点。种子歌曲先经平台搜索接口实测取得，不使用记忆中的端点或字段。

## 1. 网易（wy）

### 端点与调用方式（已实测）

- 端点：`POST https://music.163.com/weapi/v1/discovery/simiSong`（weapi 加密表单）。
- 等价传输：仓库现有 `eapiRequest` 形态同样可用——`POST http://interface.music.163.com/eapi/batch`，eapi 路径 `/api/v1/discovery/simiSong`，两种传输实测返回同构结果。
- 请求字段：`{ songid: <数字歌曲id>, limit, offset }`。`songid` 为 wy 数字歌曲 id（与 `musicSdk/wy` 搜索结果 `songmid` 同一标识）。
- 响应结构：`{ code: 200, songs: [...], artists: [...], mvs: [...] }`；`songs` 每项为完整歌曲对象，含 `id`、`name`、`artists[{id,name}]`、`album{id,name,picUrl}`、`duration`（毫秒）、`popularity`、`score`、`privilege{maxbr,...}`。

### 登录要求

匿名可用。请求未携带任何 Cookie，实测返回正常数据。未观察到需要登录才能拿到相似结果的迹象。

### 是否为按单曲的相似推荐（实测证据）

是。对不同种子实测返回明显追随种子风格的结果（脱敏摘录，实测时间 2026-09-20）：

- 种子「海阔天空 - Beyond」（id 1357375695）→ 5 首：真的爱你/无尽空虚（Beyond）、老男孩、过火 等；
- 种子「Lemon - 米津玄師」（id 536622304）→ 5 首：打上花火（Daoko/米津玄師）、Sincerely、secret base 等 J-Pop 曲；
- 种子「Bohemian Rhapsody - Queen」（id 1318816004）→ 5 首：Highway Star（Deep Purple）等经典摇滚；
- 种子「孤勇者 - 陈奕迅」（id 1901371647）→ 5 首：漠河舞厅、起风了、消愁 等华语流行。

不同种子结果集合互不相同且与种子风格相关，不是热门榜或推荐歌单。

### 顺序 / 分页 / 候选上限

- 每个种子实测固定返回最多 5 首（4 个可定位种子全部为 5 首）。
- `limit`/`offset` 参数被接受但实测无分页效果：`offset=0` 与 `offset=5`、`offset=50` 返回同样的条目集合（同一 `songid` 重复请求返回相同 id 序列，短时内顺序稳定）。结论：无真实分页能力，候选上限约 5 首。
- 返回顺序即平台排序；响应未提供可解释的相似度分数字段（`score`/`popularity` 为歌曲自身热度类字段，不是相似度）。适配器只应把返回序号当作来源内排名。

### 错误与限制表现（实测）

- 不存在的 songid（如 999999999999）：HTTP 200、`code: 200`、`songs: []`——空列表不区分「无相似结果」与「歌曲不存在」。
- 版权受限种子：实测「晴天 - 周杰伦」（id 186016，`privilege.st=-200`）返回 `songs: []`。即：种子本身被下架/受限时拿不到相似结果，且与其他空结果不可区分。
- 未观察到限流（本次调查频率约 1 请求/1.5s，无 4xx/限流响应）；无稳定性承诺，需按「可能失效」设计。

### 种子与结果到 `MusicInfo` 的映射

- 种子：wy 搜索结果 `songmid` 即数字 id；若当前播放歌曲 `source === 'wy'`，`musicInfo.meta.songId`（或 id 后缀）即种子 id，可免搜索直接使用。
- 结果：`songs[]` → 仓库既有归一化链（构造 `{ singer: artists.map(a=>a.name).join('、'), name, albumName: album.name, albumId: album.id, source: 'wy', interval: formatPlayTime(duration/1000), songmid: id, img: album.picUrl, types/_types: 由 privilege.maxbr/maxBrLevel 推导 }` 后经 `toNewMusicInfo`）。结果自带 `privilege`，可推导音质档位；未验证当前可播放性（播放仍走既有音源解析）。

## 2. QQ（tx）

### 端点与调用方式（已实测）

- 端点：`POST https://u.y.qq.com/cgi-bin/musicu.fcg`（普通 JSON POST，无需 zzc 签名；实测带签名调用 musics.fcg 亦可）。
- 请求体：`{ comm: { g_tk: 5381, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'h5', needNewCode: 1 }, simsongs: { module: 'rcmusic.similarSongRadioServer', method: 'get_simsongs', param: { songid: <数字歌曲id> } } }`。
- 响应结构：`{ code: 0, simsongs: { code: 0, data: { is_finish, rec_reason, songInfoList: [...], title: '相关歌曲', vecRecType } } }`；`songInfoList` 每项为完整歌曲对象（`id`、`mid`、`name`、`singer[{name,mid}]`、`album{id,mid,name}`、`interval`（秒）、`file{media_mid,...}` 等，与 tx 搜索结果同构）。
- 端点来源：经开源项目 jsososo/QQMusicApi 的 `routes/song.js`（`/similar`）定位候选端点后，在本环境实测验证有效；上文请求/响应结构以本机实测为准。

### 登录要求

匿名可用（未携带任何登录凭证，实测正常返回数据）。未观察到登录态要求。

### 是否为按单曲的相似推荐（实测证据）

是。实测样例（2026-09-20）：

- 种子「告白气球 - 周杰伦」（id 107192078）→ 5 首：温暖你的冬（欧阳娜娜）、全世界谁倾听你（林宥嘉）、漫动作（潘玮柏/关晓彤）、当我找到了你（徐佳莹）、超越无限（林俊杰）；
- 种子「Lemon - 米津玄師」（id 213086592）→ 5 首：Ref:rain（Aimer）、Pain, pain（E-Girls）等 J-Pop；
- 种子「孤勇者 - 陈奕迅」（id 331839675）→ 2 首；
- 种子「晴天 - 周杰伦」（id 97773）→ 0 首。

不同种子结果集合互不相同且与种子风格相关，不是热门榜。

### 顺序 / 分页 / 候选上限

- 每种子实测返回 0–5 首，`is_finish` 恒为 1（实测值），无分页参数（请求体未提供分页字段，实测亦无翻页语义）。
- 返回顺序即平台排序；响应无相似度分数字段。适配器只应把返回序号当作来源内排名。

### 错误与限制表现（实测）

- 参数类型错误（传 `songmid` 字符串而非数字 `songid`）：`simsongs.code = 2001`、空列表。
- 未观察到相似接口本身的限流；但**种子定位所依赖的 tx 搜索接口限流明显**：连续请求后返回 `music.search.SearchCgiService.code = 2001`（空结果），间隔数秒至数十秒后恢复；固定复用同一 searchid 的请求被拒（实测固定 searchid 一次即 2001，随机 searchid 可用）。适配器需对搜索失败按「限流/失败」单独建状态，不得当作「无匹配」。
- 空列表（`songInfoList: []`）与错误（code≠0）可区分。

### 种子与结果到 `MusicInfo` 的映射

- 种子：需要 tx 数字歌曲 id。若当前播放歌曲 `source === 'tx'`，`musicInfo.meta.id` 即数字 id（`toNewMusicInfo` 的 tx 分支写入 `meta.id = songId`）可直接使用；其他来源时按歌手+歌名搜索 tx 后严格匹配（注意歌手名大小写差异，如 Beyond 在 tx 为「BEYOND」）。
- 结果：`songInfoList[]` 与 tx 搜索结果同构 → 构造 `{ singer: singer.map(s=>s.name).join('、'), name: title, albumName: album.name, albumId: album.mid, source: 'tx', interval: formatPlayTime(interval), songId: id, albumMid: album.mid, strMediaMid: file.media_mid, songmid: mid, img, types/_types: 由 file.size_* 推导 }` 后经 `toNewMusicInfo`。

## 3. 结论与对实现的影响

1. wy、tx 均存在真实的按单曲相似推荐接口，匿名可用，可作为 P1/P2 平台。
2. 两平台均无分页、每种子候选 ≤5 首、无相似度分数——「候选用尽」是常态而非异常，续补必须把「同一锚点的有限结果消费完」与网络失败区分。
3. wy 版权受限种子返回空列表（与无结果不可区分）；tx 部分种子返回 0 首。种子定位失败/无匹配的平台必须跳过，不得取搜索第一条充数。
4. tx 依赖搜索定位种子时受搜索限流影响，需独立状态与有限重试；wy 搜索实测稳定。
5. 两平台返回结构均含可播放标识与完整元数据，可直接走 `toNewMusicInfo` 归一化；不承诺当前可播放，播放仍走既有解析/切源。
6. 本次未实测：长时间稳定性、地域差异、高频限流阈值；未验证其他平台（kg/kw/mg/xm）的相似能力。
