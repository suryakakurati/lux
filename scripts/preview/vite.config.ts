import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appRoot = resolve(__dirname, '../..')

/** Serve the preview page at `/`, so the panel's root URL just works. */
function rootRedirect(): Plugin {
  return {
    name: 'lux-preview-root',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.statusCode = 302
          res.setHeader('location', '/scripts/preview/index.html')
          res.end()
          return
        }
        next()
      })
    }
  }
}

/**
 * Renderer preview: the real React windows and styles, served by Vite with the
 * browser stand-in bridge in scripts/preview/bridge.ts. Development only.
 *
 * The Vite root is the repository, so the page imports `/src/main.tsx` exactly
 * as the app's own HTML does.
 */
export default defineConfig({
  root: appRoot,
  plugins: [react(), rootRedirect()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  }
})
