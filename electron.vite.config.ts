import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * Vite's dev client needs an inline script; the packaged window does not. The
 * committed HTML carries the strict policy, and only `electron-vite dev` relaxes
 * it, so a production build cannot ship `'unsafe-inline'` by accident.
 */
function devOnlyInlineScript(): Plugin {
  return {
    name: 'lux-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self' app: blob:;", "script-src 'self' app: blob: 'unsafe-inline';")
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          smoke: resolve(__dirname, 'electron/main/smoke.ts'),
          audit: resolve(__dirname, 'electron/main/audit.ts'),
          bench: resolve(__dirname, 'electron/main/bench.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    },
    plugins: [react(), devOnlyInlineScript()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    }
  }
})
