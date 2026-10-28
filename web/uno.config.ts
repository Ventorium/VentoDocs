import { defineConfig } from 'unocss'
import { darkTheme } from './src/theme'

export default defineConfig({
  content: {
    filesystem: ['./src/**/*.{ts,tsx}']
  },
  theme: {
    colors: {
      primary: darkTheme.accent.primary,
    }
  }
})
