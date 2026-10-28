/**
 * M2.15：压缩包内文件的虚拟文件 id 方案。
 *
 * 形如 `zip:<zip文件id>@<encodeURIComponent(条目相对路径)>`，可无损解析还原
 * （条目路径不含 `@` 由后端路径校验保证，encodeURIComponent 亦不产生未编码 `@`）。
 * 该 id 走现有窗口/registry 管线，zip 内不同条目天然得到独立窗口。
 */
export type ZipFileRef = {
  zipFileId: string
  entryPath: string
}

export const isZipFileId = (fileId: string): boolean =>
  fileId.startsWith('zip:') && fileId.indexOf('@', 4) > 4

export function encodeZipFileId(zipFileId: string, entryPath: string): string {
  return `zip:${zipFileId}@${encodeURIComponent(entryPath)}`
}

export function parseZipFileId(fileId: string): ZipFileRef | null {
  if (!isZipFileId(fileId)) return null
  const at = fileId.indexOf('@', 4)
  const zipFileId = fileId.slice(4, at)
  let entryPath: string
  try {
    entryPath = decodeURIComponent(fileId.slice(at + 1))
  } catch {
    return null
  }
  if (!zipFileId || !entryPath) return null
  return { zipFileId, entryPath }
}
