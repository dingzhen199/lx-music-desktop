/**
 * 音源轮换编排（纯逻辑，无 lx 运行时依赖，由 vitest 直接测试）。
 *
 * 回退链采用「提供方外层、音源内层」：先穷尽当前提供方的所有启用音源（主源 → 备源按序），
 * 再切换到其他提供方（findMusic 同曲候选）并对其重复音源轮换（ADR-0003）。
 * 音源只是取流载体，换提供方才是换歌曲版本——用户对原提供方的版本偏好优先。
 */

export interface SourceRotationEnv {
  /** 主源 api id（可能是内置源 id） */
  primaryApiId: string
  /** 主源服务的提供方列表（内置源来自全局 qualityList，自定义源来自其初始化信息） */
  primaryServedProviders: string[]
  /** 备源 api id 列表（用户排序，即轮换顺序） */
  backupApiIds: string[]
  /** 已就绪（初始化成功）的自定义源 api id 集合 */
  readyApiIds: string[]
  /** 各备源服务的提供方：apiId -> 提供方列表 */
  servedProviders: Record<string, string[]>
}

/**
 * 某提供方可用的备源序列：按用户排序、去重、已就绪、且该源服务此提供方；主源不在其列
 * （主源永远是最先尝试的一次，由调用方先行完成）。
 */
export const buildBackupApiIds = (env: SourceRotationEnv, provider: string): string[] => {
  const ids: string[] = []
  for (const id of env.backupApiIds) {
    if (id == env.primaryApiId) continue
    if (ids.includes(id)) continue
    if (!env.readyApiIds.includes(id)) continue
    if (!env.servedProviders[id]?.includes(provider)) continue
    ids.push(id)
  }
  return ids
}

/** 某提供方是否任一启用音源可服务（主源或任一备源）；候选提供方过滤用，避免误杀仅备源支持的平台 */
export const isProviderServable = (env: SourceRotationEnv, provider: string): boolean => {
  if (env.primaryServedProviders.includes(provider)) return true
  return buildBackupApiIds(env, provider).length > 0
}
