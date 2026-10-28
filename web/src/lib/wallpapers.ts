import type { CSSProperties } from 'react'

export type WallpaperDef = {
  id: string
  name: string
  /** '' = 无壁纸；/wallpapers/xxx.jpg = 内置图；也可存 css 背景串（url()/gradient） */
  value: string
}

/** 内置壁纸（借鉴 VentoOS 桌面壁纸库，图片在 web/public/wallpapers/）。 */
export const WALLPAPERS: WallpaperDef[] = [
  { id: 'none', name: '无', value: '' },
  { id: 'light-field', name: '绿野', value: '/wallpapers/light-field.jpg' },
  { id: 'light-beach', name: '海滨', value: '/wallpapers/light-beach.jpg' },
  { id: 'light-sunset', name: '落霞', value: '/wallpapers/light-sunset.jpg' },
  { id: 'dark-aurora', name: '极光', value: '/wallpapers/dark-aurora.jpg' },
  { id: 'dark-mountain', name: '高山', value: '/wallpapers/dark-mountain.jpg' },
  { id: 'dark-ocean', name: '深海', value: '/wallpapers/dark-ocean.jpg' },
]

/**
 * 计算页面根壁纸背景；深色模式叠一层压暗 scrim，保证内容可读。
 * 返回 null 表示无壁纸（调用方回退纯色背景）。
 *
 * 注意：必须用长手属性（backgroundImage/Size/Position/Repeat），
 * 不能用 `background` 简写 + 长手属性混用——React 运行时更新简写值时，
 * CSSOM 会把简写展开并重置内联 background-size/position/repeat 为初始值，
 * 而 diff 中"未变化"的长手属性会被跳过重设，壁纸会退化成
 * auto + repeat：大屏（宽 > 图片原生 1920px）出现平铺、未填满（M2.10）。
 */
export function wallpaperStyle(wallpaper: string, dark: boolean): CSSProperties | null {
  if (!wallpaper) return null
  const layer = wallpaper.startsWith('/') ? `url('${wallpaper}')` : wallpaper
  const scrim = 'linear-gradient(rgba(8, 10, 16, 0.45), rgba(8, 10, 16, 0.45))'
  if (dark) {
    return {
      backgroundImage: `${scrim}, ${layer}`,
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, center',
      backgroundRepeat: 'no-repeat',
    }
  }
  return {
    backgroundImage: layer,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }
}
