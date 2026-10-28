/**
 * VentoDocs 设计 Token 与主题配置（M5：对齐 VentoOS 桌面级设计语言）。
 *
 * 三层材质：
 * - Surface 材质：窗口/面板（半透明、可读）
 * - Overlay 材质：弹层/菜单/对话框（高对比毛玻璃）
 * - 强调色：深/浅两套（苹果风格蓝）
 *
 * 解析后的主题写入 <html data-theme>，CSS 变量 --vd-* 见 assets/styles/app.css。
 * 默认主题：深色（与 VentoOS 一致）。
 */

export type ThemeMode = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const tokens = {
  radius: {
    window: 12,
    panel: 10,
    control: 8,
    button: 6,
    input: 6,
    contextMenu: 8,
    launchpadIcon: 18,
  },
  blur: {
    surface: 32,
    overlay: 48,
    contextMenu: 40,
    dock: 48,
    topBar: 48,
  },
  shadow: {
    window: '0 8px 40px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)',
    windowFocused: '0 24px 72px rgba(0,0,0,0.35), 0 6px 20px rgba(0,0,0,0.18)',
    panel: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)',
    dock: '0 12px 40px rgba(0,0,0,0.35)',
    overlay: '0 20px 56px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.15)',
    contextMenu: '0 12px 36px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.12)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  /** framer-motion 动画参数（与 VentoOS 一致） */
  animation: {
    windowOpen: { duration: 0.22, ease: [0.32, 0.72, 0, 1] as const },
    windowClose: { duration: 0.18, ease: [0.4, 0, 1, 1] as const },
    windowMinimize: { duration: 0.3, ease: [0.32, 0.72, 0, 1] as const },
    panelToggle: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
    launchpad: { duration: 0.3, ease: [0.32, 0.72, 0, 1] as const },
    contextMenu: { duration: 0.12, ease: [0.32, 0.72, 0, 1] as const },
  },
  topBar: { height: 28 },
  dock: { height: 68, iconSize: 40, hoveredIconSize: 64, margin: 8, gap: 6 },
  window: { titleBarHeight: 38, minWidth: 320, minHeight: 200 },
  launchpad: { iconSize: 64, columns: 5 },
} as const

export const lightTheme = {
  bg: {
    surface: 'rgba(255, 255, 255, 0.72)',
    surfaceHover: 'rgba(255, 255, 255, 0.85)',
    overlay: 'rgba(255, 255, 255, 0.92)',
    topBar: 'rgba(242, 242, 244, 0.62)',
    dock: 'rgba(255, 255, 255, 0.58)',
    window: 'rgba(248, 248, 250, 0.68)',
    windowTitle: 'rgba(240, 240, 242, 0.70)',
    windowActive: 'rgba(255, 255, 255, 0.82)',
    contextMenu: 'rgba(248, 248, 250, 0.92)',
    input: 'rgba(0, 0, 0, 0.05)',
    selection: 'rgba(0, 122, 255, 0.15)',
    itemHover: 'rgba(0, 0, 0, 0.07)',
    launchpad: 'rgba(255, 255, 255, 0.55)',
  },
  text: {
    primary: '#1d1d1f',
    secondary: '#6e6e73',
    tertiary: '#aeaeb2',
    inverse: '#ffffff',
  },
  border: {
    default: 'rgba(0, 0, 0, 0.08)',
    subtle: 'rgba(0, 0, 0, 0.04)',
    strong: 'rgba(0, 0, 0, 0.15)',
  },
  accent: {
    primary: '#007AFF',
    success: '#34C759',
    warning: '#FF9500',
    danger: '#FF3B30',
    info: '#5AC8FA',
  },
  trafficLight: {
    close: '#FF5F57',
    minimize: '#FEBC2E',
    maximize: '#28C840',
    inactive: '#DCDCDC',
  },
} as const

export const darkTheme = {
  bg: {
    surface: 'rgba(34, 34, 36, 0.20)',
    surfaceHover: 'rgba(50, 50, 52, 0.82)',
    overlay: 'rgba(24, 24, 26, 0.88)',
    topBar: 'rgba(18, 18, 20, 0.68)',
    dock: 'rgba(24, 24, 26, 0.62)',
    window: 'rgba(32, 32, 34, 0.62)',
    windowTitle: 'rgba(26, 26, 28, 0.68)',
    windowActive: 'rgba(44, 44, 48, 0.78)',
    contextMenu: 'rgba(30, 30, 32, 0.90)',
    input: 'rgba(255, 255, 255, 0.07)',
    selection: 'rgba(10, 132, 255, 0.25)',
    itemHover: 'rgba(255, 255, 255, 0.09)',
    launchpad: 'rgba(0, 0, 0, 0.60)',
  },
  text: {
    primary: '#dcdcdc',
    secondary: '#a1a1a6',
    tertiary: '#8f8f8f',
    inverse: '#1d1d1f',
  },
  border: {
    default: 'rgba(255, 255, 255, 0.10)',
    subtle: 'rgba(255, 255, 255, 0.05)',
    strong: 'rgba(255, 255, 255, 0.18)',
  },
  accent: {
    primary: '#0A84FF',
    success: '#30D158',
    warning: '#FF9F0A',
    danger: '#FF453A',
    info: '#64D2FF',
  },
  trafficLight: {
    close: '#FF5F57',
    minimize: '#FEBC2E',
    maximize: '#28C840',
    inactive: '#4A4A4C',
  },
} as const

export const themeOf = (mode: ResolvedTheme) => (mode === 'dark' ? darkTheme : lightTheme)
