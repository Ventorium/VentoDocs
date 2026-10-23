import '@unocss/reset/tailwind-compat.css'
import 'virtual:uno.css'
import '@/assets/styles/app.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-docs-core/lib/index.css'

import { createRoot } from 'react-dom/client'
import App from './App'
import { fetchConfig } from './store/config'

const root = createRoot(document.getElementById('root')!)

fetchConfig()
  .catch(() => {
    // /_env 不可用时降级（例如静态部署），不阻塞应用渲染
    console.warn('[config] /_env 加载失败，使用默认配置')
  })
  .finally(() => {
    root.render(<App />)
  })
