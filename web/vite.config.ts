import { resolve } from 'node:path'
import react from '@vitejs/plugin-react-swc'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'
import pages from 'vite-plugin-pages'
import svgr from 'vite-plugin-svgr'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      UnoCSS(),
      svgr(),
      pages({
        extensions: ['tsx'],
        exclude: ['**/{components,assets,blocks,hooks,store}/**/*.*', '**/_*.*'],
        routeStyle: 'next',
        importMode: 'async',
        dirs: 'src/pages',
        resolver: 'react'
      }),
      {
        name: 'api-handler',
        configureServer(server) {
          server.middlewares.use('/_env', (_req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            const data = {
              publishDomain: env.VIENTO_PUBLISH_DOMAIN || null
            }
            res.end(JSON.stringify(data))
          })
        }
      }
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src')
      }
    },
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:8080',
        '^/ws': {
          target: 'http://127.0.0.1:8080',
          ws: true,
          changeOrigin: true
        }
      }
    }
  }
})
