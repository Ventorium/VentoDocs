import { defineConfig } from 'unocss'
import { AppTheme } from './src/theme'

export default defineConfig({
  content: {
    filesystem: ['./src/**/*.{ts,tsx}']
  },
  theme: {
    colors: {
      primary: AppTheme.primaryColor,
    }
  }
})
