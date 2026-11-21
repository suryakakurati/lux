import { useEffect, useRef } from 'react'

interface WaveformProps {
  level: number
  active: boolean
  bars?: number
}

/**
 * The HUD level indicator. A rolling buffer of measured microphone levels, so
 * the meter moves with the voice instead of following a CSS loop.
 */
export function Waveform({ level, active, bars = 16 }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const values = useRef<number[]>(new Array(bars).fill(0.05))

  useEffect(() => {
    if (!active) {
      const nodes = containerRef.current?.children
      if (!nodes) return
      for (const node of Array.from(nodes)) {
        ;(node as HTMLElement).style.setProperty('--h', '0.06')
      }
      return
    }
    const buffer = values.current
    buffer.shift()
    buffer.push(Math.max(0.05, Math.min(1, level)))
    const nodes = containerRef.current?.children
    if (!nodes) return
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as HTMLElement
      const value = buffer[i] ?? 0.05
      node.style.setProperty('--h', value.toFixed(3))
    }
  }, [level, active])

  return (
    <div className="waveform" ref={containerRef} aria-hidden="true">
      {Array.from({ length: bars }).map((_, index) => (
        <span key={index} className="wave-bar" style={{ ['--h' as string]: '0.06' }} />
      ))}
    </div>
  )
}
