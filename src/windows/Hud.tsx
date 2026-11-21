import { useEffect, useRef, useState } from 'react'
import type { HudState } from '../../shared/types'
import { Waveform } from '../components/Waveform'
import { VoiceRecorder } from '../lib/recorder'
import '../styles/hud.css'

const LABELS: Record<HudState, string> = {
  idle: 'Lux',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  planning: 'Planning',
  researching: 'Researching',
  reading: 'Reading',
  verifying: 'Checking',
  acting: 'Working',
  done: 'Done',
  brief: 'Morning brief',
  error: 'Something went wrong'
}

const BUSY: HudState[] = [
  'transcribing',
  'thinking',
  'planning',
  'researching',
  'reading',
  'verifying',
  'acting'
]

export function Hud() {
  const [state, setState] = useState<HudState>('idle')
  const [transcript, setTranscript] = useState('')
  const [detail, setDetail] = useState('')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)

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
        window.lux.hud.error('No audio was recorded.')
        return
      }
      if (result.peak < 0.004) {
        window.lux.hud.error('No audio detected — is the microphone muted?')
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

  const status = LABELS[state]
  const primary =
    transcript ||
    detail ||
    (state === 'listening'
      ? 'Go ahead, I’m listening.'
      : state === 'transcribing'
        ? 'One moment.'
        : state === 'thinking'
          ? 'Working it out.'
          : state === 'idle'
            ? 'Hold right ⌥ to speak.'
            : '')

  const elapsed = state === 'listening' ? `${seconds.toFixed(1)}s` : ''

  return (
    <div className="hud" data-state={state}>
      <div className="hud-pill">
        <span className="hud-status-dot" aria-hidden="true" />

        <div className="hud-copy">
          <div className="hud-status">
            <span>{status}</span>
            {elapsed && <span className="hud-clock">{elapsed}</span>}
            {state !== 'listening' && BUSY.includes(state) && <Elapsed key={state} />}
          </div>
          <div className="hud-primary" title={primary}>
            {primary}
          </div>
        </div>

        {state === 'listening' && <Waveform level={level} active bars={16} />}
      </div>
    </div>
  )
}

/** Elapsed time for a working state: a silent minute reads as a hang. */
function Elapsed() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      1_000
    )
    return () => window.clearInterval(timer)
  }, [])
  return seconds > 0 ? <span className="hud-clock">{seconds}s</span> : null
}
