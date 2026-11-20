import type { LuxBridge } from '../shared/types'

declare global {
  interface Window {
    lux: LuxBridge
  }
}

export {}
