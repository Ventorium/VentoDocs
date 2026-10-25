/**
 * VentoDocs 设计 Token 与主题配置
 *
 * 三层材质（借鉴 VentoOS，数值同步）：
 * - Surface 材质：面板/卡片（半透明、可读）
 * - Overlay 材质：弹层/菜单/对话框（高对比）
 * - 强调色：浅/深两套（苹果风格蓝）
 *
 * 解析后的主题写入 <html data-theme>，CSS 变量 --vd-* 见 assets/styles/app.css。
 */

import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'

export type ThemeMode = 'light' | 'dark'

export const tokens = {
  radius: {
    panel: 10,
    card: 12,
    control: 8,
    button: 6,
    input: 6,
    contextMenu: 8
  },
  blur: {
    surface: 32,
    overlay: 48,
    contextMenu: 40
  },
  shadow: {
    panel: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)',
    overlay: '0 20px 56px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.15)',
    contextMenu: '0 12px 36px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.12)'
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32
  },
  animation: {
    panelToggle: { duration: 0.2, ease: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    contextMenu: { duration: 0.12, ease: 'cubic-bezier(0.32, 0.72, 0, 1)' }
  }
} as const

export const lightTheme = {
  bg: {
    surface: 'rgba(255, 255, 255, 0.72)',
    surfaceHover: 'rgba(255, 255, 255, 0.85)',
    overlay: 'rgba(255, 255, 255, 0.90)',
    topBar: 'rgba(242, 242, 244, 0.62)',
    itemHover: 'rgba(0, 0, 0, 0.07)',
    input: 'rgba(0, 0, 0, 0.05)',
    selection: 'rgba(0, 122, 255, 0.15)'
  },
  text: {
    primary: '#1d1d1f',
    secondary: '#6e6e73',
    tertiary: '#aeaeb2',
    inverse: '#ffffff'
  },
  border: {
    default: 'rgba(0, 0, 0, 0.08)',
    subtle: 'rgba(0, 0, 0, 0.04)',
    strong: 'rgba(0, 0, 0, 0.15)'
  },
  accent: {
    primary: '#007AFF',
    success: '#34C759',
    warning: '#FF9500',
    danger: '#FF3B30',
    info: '#5AC8FA'
  }
} as const

export const darkTheme = {
  bg: {
    surface: 'rgba(34, 34, 36, 0.20)',
    surfaceHover: 'rgba(50, 50, 52, 0.82)',
    overlay: 'rgba(24, 24, 26, 0.88)',
    topBar: 'rgba(18, 18, 20, 0.68)',
    itemHover: 'rgba(255, 255, 255, 0.09)',
    input: 'rgba(255, 255, 255, 0.07)',
    selection: 'rgba(10, 132, 255, 0.25)'
  },
  text: {
    primary: '#dcdcdc',
    secondary: '#a1a1a6',
    tertiary: '#8f8f8f',
    inverse: '#1d1d1f'
  },
  border: {
    default: 'rgba(255, 255, 255, 0.10)',
    subtle: 'rgba(255, 255, 255, 0.05)',
    strong: 'rgba(255, 255, 255, 0.18)'
  },
  accent: {
    primary: '#0A84FF',
    success: '#30D158',
    warning: '#FF9F0A',
    danger: '#FF453A',
    info: '#64D2FF'
  }
} as const

/** 兼容旧代码引用。 */
export const AppTheme = {
  primaryColor: lightTheme.accent.primary
}

/** 生成 antd ThemeConfig（XProvider 的 theme prop 兼容 antd ConfigProvider）。 */
export function getAntdTheme(mode: ThemeMode): ThemeConfig {
  const t = mode === 'dark' ? darkTheme : lightTheme
  return {
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: t.accent.primary,
      colorSuccess: t.accent.success,
      colorWarning: t.accent.warning,
      colorError: t.accent.danger,
      colorInfo: t.accent.info,
      colorTextBase: t.text.primary,
      borderRadius: tokens.radius.control,
      borderRadiusLG: tokens.radius.card,
      borderRadiusSM: tokens.radius.button
    }
  }
}
