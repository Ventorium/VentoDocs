import { useEffect, useRef } from 'react'
import { createUniver, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import sheetsZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core'
import docsZhCN from '@univerjs/preset-docs-core/locales/zh-CN'

type UniverCanvasProps = {
  /** Univer 快照 JSON（来自 preview 端点的 snapshot 字段）。 */
  snapshot: Record<string, unknown>
  /** sheet = xlsx/xls/csv；doc = docx */
  unit: 'sheet' | 'doc'
  /** 渲染区域高度，默认 calc(100vh - 320px)。 */
  height?: number | string
}

/**
 * 独立的只读 Univer 渲染组件（公开分享 / 发布站点页使用）。
 * 与 authed 的 UniverPreview 相同生命周期：
 * 每次挂载全新容器，卸载时 queueMicrotask 内 dispose；
 * sheet 用 setMode('viewer')，doc 用 setReadOnly()。
 */
const UniverCanvas = ({ snapshot, unit, height = 'calc(100vh - 320px)' }: UniverCanvasProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    try {
      const preset =
        unit === 'sheet'
          ? UniverSheetsCorePreset({ container: el })
          : UniverDocsCorePreset({ container: el })
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: unit === 'sheet' ? sheetsZhCN : docsZhCN },
        presets: [preset],
      })
      if (unit === 'sheet') {
        const wb = univerAPI.createWorkbook(snapshot)
        void wb.getWorkbookPermission().setMode('viewer').catch((e: unknown) => {
          console.warn('[UniverCanvas] 设置只读失败', e)
        })
      } else {
        const doc = univerAPI.createDocument(snapshot)
        void doc.getPermission().setReadOnly().catch((e: unknown) => {
          console.warn('[UniverCanvas] 设置只读失败', e)
        })
      }
      return () => {
        queueMicrotask(() => {
          try {
            univer.dispose()
          } catch {
            // 忽略销毁异常
          }
        })
      }
    } catch (e) {
      console.error('[UniverCanvas] 初始化失败', e)
    }
  }, [snapshot, unit])

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-8px"
      style={{ height, minHeight: 360 }}
    />
  )
}

export default UniverCanvas
