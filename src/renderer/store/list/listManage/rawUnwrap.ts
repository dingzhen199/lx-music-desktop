import { toRaw } from '../../../../common/utils/vueTools'

/** 逐条剥离 Vue 代理（toRaw 只解一层；数组字面量无代理可解，元素才可能是 proxy）。 */
export const unwrapMusicInfos = (musicInfos: LX.Music.MusicInfo[]): LX.Music.MusicInfo[] => musicInfos.map(item => toRaw(item))
