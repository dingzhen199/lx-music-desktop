import Event from './Event'


// {
//   // sync: {
//   //   send_action_list: 'send_action_list',
//   //   handle_action_list: 'handle_action_list',
//   //   send_sync_list: 'send_sync_list',
//   //   handle_sync_list: 'handle_sync_list',
//   // },
// }

export class AppEvent extends Event {
  configUpdate(setting: Partial<LX.AppSetting>) {
    this.emit('configUpdate', setting)
  }

  focus() {
    this.emit('focus')
  }

  dragStart() {
    this.emit('dragStart')
  }

  dragEnd() {
    this.emit('dragEnd')
  }

  /**
   * 音乐信息切换
   */
  musicToggled() {
    this.emit('musicToggled')
  }

  /**
   * 手动改变进度
   * @param progress 进度
   */
  setProgress(progress: number, maxPlayTime?: number) {
    this.emit('setProgress', progress, maxPlayTime)
  }

  /**
   * 设置音量大小
   * @param volume 音量大小
   */
  setVolume(volume: number) {
    this.emit('setVolume', volume)
  }

  /**
   * 设置播放速率大小
   * @param rate 播放速率
   */
  setPlaybackRate(rate: number) {
    this.emit('setPlaybackRate', rate)
  }

  /**
   * 设置是否静音
   * @param isMute 是否静音
   */
  setVolumeIsMute(isMute: boolean) {
    this.emit('setVolumeIsMute', isMute)
  }

  // 播放器事件
  play() {
    this.emit('play')
  }

  pause() {
    this.emit('pause')
  }

  stop() {
    this.emit('stop')
  }

  error(code?: number) {
    this.emit('error', code)
  }

  // 播放器原始事件
  playerPlaying() {
    this.emit('playerPlaying')
  }

  playerPause() {
    this.emit('playerPause')
  }

  playerStop() {
    this.emit('playerStop')
  }

  playerEnded() {
    this.emit('playerEnded')
  }

  playerError(code?: number) {
    this.emit('playerError', code)
  }

  playerLoadeddata() {
    this.emit('playerLoadeddata')
  }

  playerLoadstart() {
    this.emit('playerLoadstart')
  }

  playerCanplay() {
    this.emit('playerCanplay')
  }

  playerEmptied() {
    this.emit('playerEmptied')
  }

  playerWaiting() {
    this.emit('playerWaiting')
  }

  playerDeviceChanged() {
    this.emit('playerDeviceChanged')
  }

  // 激活进度条动画事件
  activePlayProgressTransition() {
    this.emit('activePlayProgressTransition')
  }

  // 更新图片事件
  picUpdated() {
    this.emit('picUpdated')
  }

  // 更新歌词事件
  lyricUpdated() {
    this.emit('lyricUpdated')
  }

  // 更新歌词偏移
  lyricOffsetUpdate() {
    this.emit('lyricOffsetUpdate')
  }

  // 歌词行播放
  lyricLinePlay(text: string, line: number) {
    this.emit('lyricLinePlay', text, line)
  }

  // 我的列表改变事件
  myListUpdate(ids: string[]) {
    this.emit('myListUpdate', ids)
  }

  /**
   * 「我喜欢」实际新增收藏事件（TP-2 画像收藏信号桥，D10/D11）：
   * 由 listMusicAdd 在按 id 去重过滤后仍有实际新增时发射，携带实际新增的曲目；
   * 取消收藏不发射，整单恢复/迁移（overwriteMusicList 路径）不发射（D13）。
   */
  loveListMusicsAdded(musicInfos: LX.Music.MusicInfo[]) {
    this.emit('loveListMusicsAdded', musicInfos)
  }

  // 下载列表改变事件
  downloadListUpdate() {
    this.emit('downloadListUpdate')
  }

  // 列表里的音乐信息改变事件
  // musicInfoUpdate(musicInfo: LX.Music.MusicInfo) {
  //   this.emit('musicInfoUpdate', musicInfo)
  // }

  keyDown(event: LX.KeyDownEevent) {
    this.emit('keyDown', event)
  }
}


type EventMethods = Omit<EventType, keyof Event>


declare class EventType extends AppEvent {
  on<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
  off<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
}

export type AppEventTypes = Omit<EventType, keyof Omit<Event, 'on' | 'off'>>
export const createAppEventHub = (): AppEventTypes => {
  return new AppEvent()
}
