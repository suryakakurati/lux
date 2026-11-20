import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    }
  }
})
