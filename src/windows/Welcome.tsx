import { useEffect, useState } from 'react'
import type { PermissionsStatus } from '../../shared/types'
import '../styles/welcome.css'

export function Welcome() {
  const [version, setVersion] = useState('')
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [microphoneAsked, setMicrophoneAsked] = useState(false)

  const refresh = (): void => {
    void window.lux.permissions().then(setPermissions)
  }

  useEffect(() => {
    void window.lux.appVersion().then(setVersion)
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
        <span className="welcome-mark">Lux</span>
        <span className="welcome-version">{version}</span>
        <span className="welcome-kicker">Private, local, on this Mac</span>
      </header>

      <h1 className="welcome-title">Set up three permissions</h1>
      <p className="welcome-sub">
        Lux never sends audio, text or screen content anywhere. The model runs on this Mac, and the only
        network requests are the ones you ask for.
      </p>

      <ol className="steps">
        <Step
          index="1"
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
          index="2"
          title="Input monitoring"
          description="Lets the native listener see a held right Option without reading your keystrokes."
          state={inputOk ? 'done' : 'todo'}
          action={inputOk ? undefined : 'Open settings'}
          onAction={() => void window.lux.openPermissionPane('input')}
        />
        <Step
          index="3"
          title="Hotkey helper"
          description={
            binaryOk
              ? 'Built and ready.'
              : 'Run “npm run hotkey” once in the project folder, then reopen this window.'
          }
          state={binaryOk ? 'done' : 'todo'}
          action={binaryOk ? undefined : 'Details'}
          onAction={() => void window.lux.openPermissionPane('input')}
        />
      </ol>

      <div className="keys">
        <div className="keycap-group">
          <kbd className="keycap">⌥</kbd>
          <span className="key-label">Hold to talk</span>
        </div>
        <div className="key-divider" />
        <div className="keycap-group">
          <kbd className="keycap">⇧</kbd>
          <kbd className="keycap">⌥</kbd>
          <span className="key-label">Open chat</span>
        </div>
      </div>

      <div className="welcome-foot">
        <button className="welcome-skip" onClick={() => refresh()}>
          Check again
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
      <span className="step-index">{index}</span>
      <div className="step-copy">
        <span className="step-title">{title}</span>
        <span className="step-desc">{description}</span>
      </div>
      {action ? (
        <button className="step-action" onClick={onAction}>
          {action}
        </button>
      ) : (
        <span className="step-done">Ready</span>
      )}
    </li>
  )
}
