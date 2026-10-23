import { useEffect, useState } from 'react'

export type ThemeMode = 'auto' | 'dark' | 'light'

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>('auto')
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('light')

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const updateTheme = () => {
      const prefersDark = mediaQuery.matches
      const root = document.documentElement

      let actualTheme: 'dark' | 'light'
      if (theme === 'auto') {
        actualTheme = prefersDark ? 'dark' : 'light'
      } else {
        actualTheme = theme
      }

      root.classList.toggle('dark', actualTheme === 'dark')
      setResolvedTheme(actualTheme)
    }

    // Initial theme setup
    updateTheme()

    // Listen for system theme changes when in auto mode
    const handleChange = () => {
      if (theme === 'auto') {
        updateTheme()
      }
    }

    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [theme])

  return { theme: resolvedTheme, mode: theme, setTheme }
}
