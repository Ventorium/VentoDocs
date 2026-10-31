/**
 * 权限位（与 vk-core/src/perm.rs 同步）。
 * 前 6 位为普通用户可配置（授权面板复选框）；SHARE/PUBLISH 自 M2.35 起不再可授权
 *（仅资源创建者本人可操作分享/发布），常量保留供位值解析；AGENT_* 为 v2 保留位，UI 不展示。
 */
export const PERM = {
  READ_PREVIEW: 1,
  DOWNLOAD: 2,
  CREATE_UPLOAD: 4,
  MODIFY_RENAME: 8,
  MOVE_COPY: 16,
  DELETE_RESTORE: 32,
  SHARE: 64,
  PUBLISH: 128,
} as const

export type PermBit = (typeof PERM)[keyof typeof PERM]

/** 普通用户可配置的全部权限（UI 授权面板复选框）。
 * M2.35 起移除 SHARE/PUBLISH：分享与网站发布仅资源创建者本人可操作，不可通过授权委派。 */
export const USER_CONFIGURABLE_PERMS: { bit: PermBit; label: string }[] = [
  { bit: PERM.READ_PREVIEW, label: '预览' },
  { bit: PERM.DOWNLOAD, label: '下载' },
  { bit: PERM.CREATE_UPLOAD, label: '上传' },
  { bit: PERM.MODIFY_RENAME, label: '修改' },
  { bit: PERM.MOVE_COPY, label: '移动复制' },
  { bit: PERM.DELETE_RESTORE, label: '删除恢复' },
]

export function hasPerm(perms: number, bit: PermBit): boolean {
  return (perms & bit) === bit
}

/** perms 位值 → 可读标签列表（如 ["预览", "下载"]）。 */
export function permLabels(perms: number): string[] {
  return USER_CONFIGURABLE_PERMS.filter(({ bit }) => hasPerm(perms, bit)).map(({ label }) => label)
}

/** perms 位值 → 简短摘要文本，用于表格展示。 */
export function permSummary(perms: number): string {
  const labels = permLabels(perms)
  if (labels.length === 0) return '无权限'
  if (labels.length >= 4) return `全部权限（${labels.length} 项）`
  return labels.join('、')
}
