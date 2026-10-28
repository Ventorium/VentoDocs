/**
 * Dock 图标屏幕坐标登记：窗口最小化动画飞向对应 dock 图标时读取。
 */
export type DockRect = { x: number; y: number; width: number; height: number }

const rects = new Map<string, DockRect>()

export function setDockRect(appId: string, r: DockRect) {
  rects.set(appId, r)
}

export function getDockRect(appId: string): DockRect | undefined {
  return rects.get(appId)
}
