import { useEffect, useState } from 'react'
import type { PermissionsStatus } from '../../shared/types'
import { Reactor } from '../components/Reactor'
import '../styles/welcome.css'

export function Welcome() {
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [microphoneAsked, setMicrophoneAsked] = useState(false)

  const refresh = (): void => {
    void window.lux.permissions().then(setPermissions)
  }

  useEffect(() => {
    refresh()
    const unsubscribe = window.lux.onEvent((event) => {
      if (event.kind === 'permissions') setPermissions(event.permissions)
    })
    return unsubscribe
  }, [])

  const micOk = permissions?.microphone === 'granted'
  const inputOk = permissions?.inputMonitoring
  const binaryOk = permissions?.hotkeyBinary

  return (
    <div className="welcome">
      <header className="welcome-head">
        <Reactor size={26} />
        <span className="welcome-mark">LUX</span>
        <span className="welcome-kicker mono">private · local · always here</span>
      </header>

      <h1 className="welcome-title">
        Three permissions,<br />
        then I’m yours.
      </h1>
      <p className="welcome-sub">
        Lux never sends audio, text or screen content anywhere. The model runs on this Mac, and the
        only network calls are the ones you ask for.
      </p>

      <ol className="steps">
        <Step
          index="01"
          title="Microphone"
          description="Only open while you hold right ⌥."
          state={micOk ? 'done' : 'todo'}
          action={micOk ? undefined : microphoneAsked ? 'Open settings' : 'Allow'}
          onAction={async () => {
            if (microphoneAsked) {
              void window.lux.openPermissionPane('microphone')
              return
            }
            setMicrophoneAsked(true)
            await window.lux.hud.ready()
            refresh()
          }}
        />
        <Step
          index="02"
          title="Input monitoring"
          description="Lets the native listener see a held right Option without reading your keystrokes."
          state={inputOk ? 'done' : 'todo'}
          action={inputOk ? undefined : 'Open settings'}
          onAction={() => void window.lux.openPermissionPane('input')}
        />
        <Step
          index="03"
          title="Hotkey helper"
          description={
            binaryOk
              ? 'Built and ready.'
              : 'Run “npm run hotkey” once in the project folder, then reopen this window.'
          }
          state={binaryOk ? 'done' : 'todo'}
          action={binaryOk ? undefined : 'How?'}
          onAction={() => void window.lux.openPermissionPane('input')}
        />
      </ol>

      <div className="keys">
        <div className="keycap-group">
          <kbd className="keycap">⌥</kbd>
          <span className="key-label">hold to talk</span>
        </div>
        <div className="key-divider" />
        <div className="keycap-group">
          <kbd className="keycap">⇧</kbd>
          <kbd className="keycap">⌥</kbd>
          <span className="key-label">open chat</span>
        </div>
      </div>

      <div className="welcome-foot">
        <button className="welcome-skip mono" onClick={() => refresh()}>
          Re-check
        </button>
        <button className="welcome-start" onClick={() => void window.lux.finishSetup()}>
          Start using Lux
        </button>
      </div>
    </div>
  )
}

function Step({
  index,
  title,
  description,
  state,
  action,
  onAction
}: {
  index: string
  title: string
  description: string
  state: 'done' | 'todo'
  action?: string
  onAction?: () => void
}) {
  return (
    <li className="step" data-state={state}>
      <span className="step-index mono">{index}</span>
      <div className="step-copy">
        <span className="step-title">{title}</span>
        <span className="step-desc">{description}</span>
      </div>
      {action ? (
        <button className="step-action mono" onClick={onAction}>
          {action}
        </button>
      ) : (
        <span className="step-done mono">ready</span>
      )}
    </li>
  )
}
