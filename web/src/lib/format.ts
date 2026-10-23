import dayjs from 'dayjs'

/** 字节数转可读大小。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const v = bytes / 1024 ** i
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** ISO 时间 → YYYY-MM-DD HH:mm（本地时区）。 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const t = dayjs(iso)
  return t.isValid() ? t.format('YYYY-MM-DD HH:mm') : iso
}

/** ISO 时间 → YYYY-MM-DD HH:mm:ss（本地时区）。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const t = dayjs(iso)
  return t.isValid() ? t.format('YYYY-MM-DD HH:mm:ss') : iso
}
