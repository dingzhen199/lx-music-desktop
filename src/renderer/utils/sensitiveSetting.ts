/**
 * 备份导出前的敏感字段剔除：AI API Key 仅保存在本机，不随 .lxmc 备份文件导出与分享。
 */

/** 返回剔除 ai.apiKey 后的设置副本（不改动入参；其余 ai 配置如 provider/model/baseUrl 保留以便恢复后只需补 Key）。 */
export const stripSensitiveSetting = (setting: LX.AppSetting): LX.AppSetting => {
  if (!setting['ai.apiKey']) return { ...setting }
  return { ...setting, 'ai.apiKey': '' }
}
