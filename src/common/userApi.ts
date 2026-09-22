/** 主源与备源互斥；兼容旧配置中的重复、空值和非法数组项。 */
export const normalizeApiSourceBackups = (primaryId: string, value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id.trim() && id !== primaryId))]
}

/** 单个主源的初始化等待上限，不占满播放器的整体取流预算。 */
export const USER_API_INIT_TIMEOUT_MS = 10_000
