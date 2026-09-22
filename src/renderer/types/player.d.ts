
declare namespace LX {
  namespace Player {
    interface PlayMusicInfo {
      /**
       * 当前播放歌曲的列表 id
       */
      musicInfo: LX.Download.ListItem | LX.Music.MusicInfo
      /**
        * 当前播放歌曲的列表 id
        */
      listId: string | null
      /**
        * 是否属于 “稍后播放”
        */
      isTempPlay: boolean
      /** 推荐实际入队时的会话代际；手动入队不携带。 */
      recommendationSessionId?: number
      /** 推荐已知的备用平台歌曲，只随播放上下文传递。 */
      alternativeMusicInfos?: LX.Music.MusicInfoOnline[]
    }

    interface PlayInfo {
      /**
       * 当前正在播放歌曲 index
       */
      playIndex: number
      /**
      * 播放器的播放列表 id
      */
      playerListId: string | null
      /**
      * 播放器播放歌曲 index
      */
      playerPlayIndex: number
    }

    interface TempPlayListItem {
      /**
       * 播放列表id
       */
      listId: string | null
      /**
       * 歌曲信息
       */
      musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
      /**
       * 是否添加到列表顶部
       */
      isTop?: boolean
      /** 推荐实际入队时的会话代际；手动入队不携带。 */
      recommendationSessionId?: number
      alternativeMusicInfos?: LX.Music.MusicInfoOnline[]
    }

    interface SavedPlayInfo {
      time: number
      maxTime: number
      listId: string
      index: number
    }

  }
}
