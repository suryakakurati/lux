import { osascript, truncate } from '../mac/exec'
import type { ToolDef } from './types'

/**
 * Spotify lives in `music.ts`, where it can read the local play history.
 * This file covers the built-in Music app.
 */
export const mediaTools: ToolDef[] = [
  {
    name: 'apple_music_control',
    description: 'Control the built-in Music app: play, pause, or next track.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'next'] }
      },
      required: ['action']
    },
    async run(args) {
      const action = String(args.action ?? 'play')
      const command = action === 'next' ? 'next track' : action
      const result = await osascript(`tell application "Music" to ${command}`)
      if (result.code !== 0) {
        return { content: `Music app not available: ${truncate(result.stderr, 160)}`, summary: 'music failed' }
      }
      return { content: `Music: ${action}.`, summary: `music ${action}` }
    }
  }
]
