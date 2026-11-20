import { useEffect, useRef, useState } from 'react'
import type { HudState } from '../../shared/types'
import { Waveform } from '../components/Waveform'
import { VoiceRecorder } from '../lib/recorder'
import '../styles/hud.css'

const LABELS: Record<HudState, string> = {
  idle: 'LUX',
  listening: 'LISTENING',
  transcribing: 'TRANSCRIBING',
  thinking: 'THINKING',
  planning: 'PLANNING',
  researching: 'RESEARCHING',
  reading: 'READING',
  verifying: 'VERIFYING',
  acting: 'WORKING',
  done: 'DONE',
  brief: 'MORNING BRIEF',
  error: 'TROUBLE'
}

export function Hud() {
  const [state, setState] = useState<HudState>('idle')
  const [transcript, setTranscript] = useState('')
  const [detail, setDetail] = useState('')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  // Time spent thinking/acting: a 90-second silent HUD reads as a hang.
  const [working, setWorking] = useState(0)

  const recorder = useRef<VoiceRecorder | null>(null)
  const stateRef = useRef<HudState>('idle')

  useEffect(() => {
    const voice = new VoiceRecorder()
    recorder.current = voice
    voice.onLevel = (value) => setLevel(value)
    voice.onAutoStop = () => {
      // Tell main the hold ended so its dictation state does not stay stuck.
      void window.lux.hud.stop()
    }

    let ticker: number | null = null
    let startedAt = 0

    const stopTicker = (): void => {
      if (ticker) window.clearInterval(ticker)
      ticker = null
    }

    const beginCapture = async (): Promise<void> => {
      setTranscript('')
      setDetail('')
      setSeconds(0)
      const started = await voice.start()
      if (!started) {
        window.lux.hud.error('Microphone unavailable — check permissions.')
        return
      }
      startedAt = Date.now()
      stopTicker()
      ticker = window.setInterval(() => {
        setSeconds(Math.round((Date.now() - startedAt) / 100) / 10)
      }, 100)
    }

    const finish = async (): Promise<void> => {
      stopTicker()
      const result = voice.stop()
      if (!result) {
        window.lux.hud.error('I didn’t hear anything.')
        return
      }
      if (result.peak < 0.004) {
        window.lux.hud.error('No audio detected — is the mic muted?')
        return
      }
      window.lux.hud.audio(result.wav)
    }

    const unsubscribe = window.lux.onEvent((event) => {
      if (event.kind !== 'hud') return
      const next = event.state
      const previous = stateRef.current
      stateRef.current = next
      setState(next)

      if (event.transcript !== undefined) setTranscript(event.transcript)
      if (event.detail !== undefined) setDetail(event.detail)

      if (next === 'listening') {
        setTranscript('')
        setDetail('')
        void beginCapture()
        return
      }

      if (previous === 'listening' && voice.active) {
        void finish()
      }
      if (next === 'idle') {
        stopTicker()
        setTranscript('')
        setDetail('')
        setSeconds(0)
        setLevel(0)
      }
    })

    void window.lux.hud.ready().then(async (granted) => {
      if (!granted) return
      await voice.prime()
    })

    return () => {
      unsubscribe()
      stopTicker()
      voice.dispose()
      recorder.current = null
    }
  }, [])

  useEffect(() => {
    if (state !== 'thinking' && state !== 'acting') {
      setWorking(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(() => {
      setWorking(Math.round((Date.now() - started) / 1000))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [state])

  const status = LABELS[state]
  const primary =
    transcript ||
    detail ||
    (state === 'listening'
      ? 'Go ahead — I’m listening.'
      : state === 'transcribing'
        ? 'One moment.'
        : state === 'thinking'
          ? 'Working it out.'
          : state === 'idle'
            ? 'Hold right ⌥ to speak.'
            : '')

  return (
    <div className="hud" data-state={state}>
      <div className="hud-pill">
        <div className="hud-orb" data-state={state}>
          <span className="orb-ring" />
          <span className="orb-ring orb-ring--inner" />
          <span className="orb-core" style={{ transform: `scale(${0.72 + Math.min(level, 1) * 0.35})` }} />
        </div>

        <div className="hud-copy">
          <div className="hud-status mono">
            <span>{status}</span>
            {state === 'listening' && <span className="hud-clock">{seconds.toFixed(1)}s</span>}
            {(state === 'thinking' || state === 'acting') && working > 0 && (
              <span className="hud-clock">{working}s</span>
            )}
          </div>
          <div className="hud-primary" title={primary}>
            {primary}
          </div>
        </div>

        <Waveform level={level} active={state === 'listening'} />
      </div>
    </div>
  )
}
