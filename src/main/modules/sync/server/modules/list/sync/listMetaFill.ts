/**
 * 首次同步（无快照）的列表元数据空值填充：
 * 来源侧未携带（旧版本设备无此字段）或为空字符串时保留目标侧（本地）值，
 * 避免 mergeList/overwriteList 首次同步后封面/简介/作者被 NULL 覆盖丢失。
 * 与快照路径 mergeListField 的「远端空值保留本地」语义一致，但无快照可比对时不做三向选择。
 */

/** 单字段空值保留：source 为 null/undefined/'' 时回退 target。 */
export const fillMetaField = (source: string | null | undefined, target: string | null | undefined): string | null => {
  return source == null || source == '' ? (target ?? null) : source
}

/** 用目标列表填充来源列表的空元数据字段（原地写回来源对象，与 sync 合并流程的引用语义一致）。 */
export const fillUserListMeta = (source: LX.List.UserListInfo, target: LX.List.UserListInfo): void => {
  source.cover = fillMetaField(source.cover, target.cover)
  source.desc = fillMetaField(source.desc, target.desc)
  source.author = fillMetaField(source.author, target.author)
}
