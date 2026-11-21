import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatItem,
  ConfirmRequest,
  ConversationSummary,
  EngineState,
  EngineStatus,
  LuxEvent,
  PermissionsStatus,
  Settings,
  SystemStats,
  ToolRun,
  VoiceOption
} from '../../shared/types'
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconGear,
  IconMic,
  IconPlus,
  IconSend,
  IconSidebar,
  IconStop,
  IconTrash
} from '../components/Icon'
import { Markdown } from '../components/Markdown'
import '../styles/chat.css'

const ENGINE_LABEL: Record<EngineState, string> = {
  checking: 'Checking',
  ready: 'Ready',
  starting: 'Starting',
  waking: 'Starting',
  offline: 'Offline',
  missing: 'Model missing'
}

const ENGINE_HEADLINE: Record<EngineState, string> = {
  checking: 'Connecting to the local engine',
  ready: 'Local engine ready',
  starting: 'Starting the local engine',
  waking: 'Loading the model',
  offline: 'The local engine is not responding',
  missing: 'The configured model is not installed'
}

const THEME_OPTIONS: { value: Settings['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const SUGGESTIONS = [
  'How is this Mac doing?',
  'Put me in my coding setup',
  'What is on my clipboard?',
  'What can you do?'
]

export function Chat() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [model, setModel] = useState('')
  const [reachable, setReachable] = useState(true)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [enginePending, setEnginePending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [draft, setDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const threadRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refreshConversations = useCallback(async () => {
    const list = await window.lux.conversations()
    setConversations(list)
  }, [])

  const wakeEngine = useCallback(() => {
    setEnginePending(true)
    void window.lux
      .recoverEngine()
      .then((status) => {
        setEngine(status)
        setReachable(status.reachable)
        setEnginePending(false)
      })
      .catch(() => setEnginePending(false))
  }, [])

  useEffect(() => {
    let alive = true
    let poll: number | null = null

    void window.lux.bootstrap().then((data) => {
      if (!alive) return
      setItems(data.items)
      setConversations(data.conversations)
      setActiveId(data.activeConversationId)
      setSettings(data.settings)
      setStats(data.stats)
      setPermissions(data.permissions)
      setModel(data.model)
      setEngine(data.engine)
      setReachable(data.ollamaReachable || data.engine.reachable)

      // The supervisor may still be starting Ollama when the window loads. Its
      // event will arrive, but a short poll covers a renderer that mounted
      // after that broadcast.
      if (data.engine.state === 'checking') {
        const tick = async (): Promise<void> => {
          const status = await window.lux.engineStatus()
          if (!alive) return
          setEngine(status)
          setReachable(status.reachable)
          if (status.state === 'checking') poll = window.setTimeout(() => void tick(), 1_200)
        }
        poll = window.setTimeout(() => void tick(), 1_200)
      }
    })

    const unsubscribe = window.lux.onEvent((event: LuxEvent) => {
      switch (event.kind) {
        case 'history':
          setItems(event.items)
          setBusy(false)
          break
        case 'turn-start':
          setBusy(true)
          setItems((current) => [
            ...current,
            { id: event.id, kind: 'user', text: event.text, at: Date.now(), source: event.source }
          ])
          break
        case 'assistant-start':
          setItems((current) =>
            current.some((item) => item.id === event.id)
              ? current
              : [...current, { id: event.id, kind: 'assistant', text: '', at: Date.now(), streaming: true }]
          )
          break
        case 'token':
          setItems((current) =>
            current.map((item) =>
              item.id === event.id && item.kind === 'assistant'
                ? { ...item, text: item.text + event.delta }
                : item
            )
          )
          break
        case 'replace':
          // A turn that was nudged to keep working discards its "I'll open…" text.
          setItems((current) =>
            current.map((item) =>
              item.id === event.id && item.kind === 'assistant' ? { ...item, text: event.text } : item
            )
          )
          break
        case 'turn-end':
          setBusy(false)
          setItems((current) =>
            current.map((item) =>
              item.id === event.id && item.kind === 'assistant'
                ? { ...item, text: event.text || item.text, streaming: false }
                : item
            )
          )
          void refreshConversations()
          break
        case 'tool':
          setItems((current) => mergeTool(current, event.tool))
          break
        case 'confirm':
          setConfirm(event.request)
          break
        case 'stats':
          setStats(event.stats)
          break
        case 'settings':
          setSettings(event.settings)
          setModel(event.settings.model)
          break
        case 'permissions':
          setPermissions(event.permissions)
          break
        case 'engine':
          setEngine(event.status)
          setReachable(event.status.reachable)
          break
        case 'open-settings':
          setSettingsOpen(true)
          break
        case 'error':
          setBusy(false)
          setItems((current) => [
            ...current,
            { id: `error-${Date.now()}`, kind: 'system', text: event.message, at: Date.now() }
          ])
          break
        case 'hud':
          if (event.state === 'idle') setBusy(false)
          break
        default:
          break
      }
    })

    return () => {
      alive = false
      if (poll) window.clearTimeout(poll)
      unsubscribe()
    }
  }, [refreshConversations])

  useEffect(() => {
    const node = threadRef.current
    if (!node || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [items])

  // Escape closes the settings panel from anywhere in the window.
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  const onScroll = (): void => {
    const node = threadRef.current
    if (!node) return
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
  }

  const send = (text: string): void => {
    const clean = text.trim()
    if (!clean) return
    pinned.current = true
    setDraft('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    void window.lux.send(clean)
  }

  const running = busy
  const showEmpty = items.length === 0
  const micReady = permissions?.microphone === 'granted'
  const engineState: EngineState = engine?.state ?? (reachable ? 'ready' : 'offline')
  const engineBusy = engineState === 'starting' || engineState === 'waking' || enginePending
  const activeTitle = conversations.find((conversation) => conversation.id === activeId)?.title ?? 'New chat'
  const banner = engineState !== 'ready' && engineState !== 'checking'

  const cpuPercent = stats && stats.cores > 0 ? Math.min(100, (stats.cpuLoad / stats.cores) * 100) : 0
  const battery =
    stats?.batteryPercent != null
      ? `Battery ${stats.batteryPercent}%`
      : stats?.onAc
        ? 'Power adapter'
        : 'Battery —'

  return (
    <div className="shell" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <aside className="sidebar" aria-label="Conversations">
        <div className="sidebar-brand">
          <span className="brand-name">Lux</span>
          <span className="brand-version">0.1</span>
        </div>

        <button
          className="sidebar-new"
          onClick={() => {
            void window.lux.newConversation()
            void refreshConversations()
          }}
        >
          <IconPlus size={13} />
          New chat
        </button>

        <div className="sidebar-label">
          <span>Conversations</span>
          <span className="sidebar-count">{conversations.length}</span>
        </div>

        <nav className="conversation-list">
          {conversations.map((conversation) => (
            <div
              className="conversation"
              key={conversation.id}
              data-active={conversation.id === activeId}
            >
              <button
                className="conversation-link"
                aria-current={conversation.id === activeId ? 'page' : undefined}
                onClick={() => {
                  setActiveId(conversation.id)
                  void window.lux.openConversation(conversation.id)
                }}
              >
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-time">{relativeTime(conversation.updatedAt)}</span>
              </button>
              <button
                className="conversation-delete"
                title="Delete conversation"
                aria-label={`Delete ${conversation.title}`}
                onClick={async () => {
                  const list = await window.lux.deleteConversation(conversation.id)
                  setConversations(list)
                  const refreshed = await window.lux.bootstrap()
                  setActiveId(refreshed.activeConversationId)
                }}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="sidebar-empty">No conversations yet.</p>}
        </nav>

        <div className="sidebar-footer">
          {conversations.length > 0 && (
            <button
              className="sidebar-danger"
              onClick={async () => {
                const list = await window.lux.clearConversations()
                setConversations(list)
                const refreshed = await window.lux.bootstrap()
                setActiveId(refreshed.activeConversationId)
              }}
            >
              <IconTrash size={11} /> Delete all conversations
            </button>
          )}

          <button
            className="engine-row"
            data-state={engineState}
            onClick={wakeEngine}
            title={engine?.detail ?? 'Check the local engine'}
          >
            <span className="engine-dot" />
            <span className="engine-text">
              <span className="engine-label">{ENGINE_LABEL[engineState]}</span>
              <span className="engine-detail">{engine?.detail ?? 'Local engine on this Mac'}</span>
            </span>
          </button>

          <div className="system-stats" aria-label="System status">
            <span>CPU {stats ? `${Math.round(cpuPercent)}%` : '—'}</span>
            <span>Memory {stats ? `${stats.memPercent}%` : '—'}</span>
            <span>{battery}</span>
          </div>

          <p className="sidebar-privacy" data-mic={micReady ? 'on' : 'off'}>
            <IconMic size={11} />
            {micReady ? 'Microphone on' : 'Microphone off'} · Runs on this Mac
          </p>

          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
            <IconGear size={13} />
            Settings
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          {!sidebarOpen && (
            <button
              className="icon-button"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              <IconSidebar size={14} />
            </button>
          )}
          <h1 className="toolbar-title">{activeTitle}</h1>
          <span className="toolbar-spacer" />
          <button
            className="engine-chip"
            data-state={engineState}
            onClick={wakeEngine}
            disabled={engineBusy}
            title={engine?.detail ?? 'Local engine status'}
          >
            <span className="engine-dot" />
            {enginePending ? 'Starting' : ENGINE_LABEL[engineState]}
          </button>
          <button className="model-chip" onClick={() => setSettingsOpen(true)} title="Model settings">
            {model || 'No model'}
          </button>
          <button
            className="icon-button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <IconSidebar size={14} />
          </button>
          <button
            className="icon-button"
            onClick={() => setSettingsOpen((open) => !open)}
            title="Settings"
            aria-label="Settings"
          >
            <IconGear size={15} />
          </button>
        </header>

        <div className="thread" ref={threadRef} onScroll={onScroll}>
          {showEmpty ? (
            <EmptyState
              onPick={send}
              engineState={engineState}
              engine={engine}
              micReady={micReady}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenMicrophone={() => void window.lux.openPermissionPane('microphone')}
            />
          ) : (
            <div className="thread-inner">
              {groupItems(items).map((group) =>
                group.kind === 'tools' ? (
                  <ToolGroup key={group.key} items={group.items} />
                ) : (
                  <MessageRow key={group.item.id} item={group.item} />
                )
              )}
              {running && <Working />}
              <div className="thread-tail" />
            </div>
          )}
        </div>

        <div className="dock">
          {banner && engine && (
            <div className="engine-banner" data-state={engineState} role="status">
              <div className="banner-copy">
                <span className="banner-title">{ENGINE_HEADLINE[engineState]}</span>
                <span className="banner-text">{engine.detail}</span>
              </div>
              <button className="banner-action" onClick={wakeEngine} disabled={engineBusy}>
                {engineBusy ? 'Working…' : engineState === 'missing' ? 'Check again' : 'Start engine'}
              </button>
            </div>
          )}

          {confirm && (
            <ConfirmBar
              request={confirm}
              onRespond={(approved) => {
                void window.lux.respondToConfirm(confirm.id, approved)
                setConfirm(null)
              }}
            />
          )}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              send(draft)
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              aria-label="Message Lux"
              placeholder="Ask a question, or tell Lux what to do"
              onChange={(event) => {
                setDraft(event.target.value)
                const node = event.target
                node.style.height = 'auto'
                node.style.height = `${Math.min(200, node.scrollHeight)}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  send(draft)
                }
                if (event.key === 'Escape' && running) void window.lux.cancel()
              }}
            />
            <div className="composer-bar">
              <span className="composer-hint">
                <IconMic size={10} /> Hold right ⌥ to talk · Return to send
              </span>
              {running ? (
                <button
                  type="button"
                  className="send-button stop"
                  onClick={() => void window.lux.cancel()}
                  title="Stop"
                  aria-label="Stop"
                >
                  <IconStop size={11} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!draft.trim()}
                  title="Send"
                  aria-label="Send"
                >
                  <IconSend size={13} />
                </button>
              )}
            </div>
          </form>
        </div>
      </main>

      {settingsOpen && settings && (
        <>
          <div className="scrim" onClick={() => setSettingsOpen(false)} aria-hidden="true" />
          <SettingsPanel
            settings={settings}
            permissions={permissions}
            engine={engine}
            onWake={wakeEngine}
            onClose={() => setSettingsOpen(false)}
            onSaved={(next) => {
              setSettings(next)
              setModel(next.model)
            }}
          />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */

function MessageRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <article className="msg user">
        <div className="msg-bubble">
          <p className="msg-text selectable">{item.text}</p>
        </div>
        <div className="msg-meta">
          {item.source === 'voice' && <span className="tag">Voice</span>}
          <time dateTime={new Date(item.at).toISOString()}>{clock(item.at)}</time>
        </div>
      </article>
    )
  }

  if (item.kind === 'assistant') {
    return (
      <article className="msg assistant" data-streaming={Boolean(item.streaming)}>
        <div className="msg-avatar" aria-hidden="true">
          L
        </div>
        <div className="msg-main">
          <div className="msg-meta">
            <span className="msg-author">Lux</span>
            <time dateTime={new Date(item.at).toISOString()}>{clock(item.at)}</time>
            {item.streaming && <span>Writing…</span>}
            {item.text && <CopyButton text={item.text} />}
          </div>
          <div className="msg-content" aria-live="polite">
            {item.text ? <Markdown text={item.text} /> : <span className="stream-caret" />}
            {item.streaming && item.text && <span className="stream-caret" />}
          </div>
        </div>
      </article>
    )
  }

  if (item.kind === 'tool') return <ToolGroup items={[item]} />

  return (
    <div className="notice" role="status">
      {item.text}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="copy-button"
      title={copied ? 'Copied' : 'Copy reply'}
      aria-label="Copy reply"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          } catch {
            // Clipboard can be unavailable without focus; the reply stays selectable.
          }
        })()
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  )
}

function ToolGroup({ items }: { items: ChatItem[] }) {
  const tools = items.flatMap((item) => (item.kind === 'tool' ? [item.tool] : []))
  if (tools.length === 0) return null

  const total = tools.reduce((sum, tool) => sum + (tool.ms ?? 0), 0)
  const running = tools.some((tool) => tool.status === 'running')
  const failed = tools.some((tool) => tool.status === 'error' || tool.status === 'denied')
  const time = running ? 'Running' : total > 0 ? `${(total / 1000).toFixed(1)}s` : ''

  return (
    <section className="tool-group" data-live={running} aria-label="Tool activity">
      <div className="tool-group-head">
        <span className="tool-group-label">{groupLabel(tools)}</span>
        <span className="tool-group-meta">
          {tools.length} {tools.length === 1 ? 'step' : 'steps'}
          {time && ` · ${time}`}
          {failed && !running ? ' · failed' : ''}
        </span>
      </div>
      <ul className="tool-list">
        {tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}
      </ul>
    </section>
  )
}

function ToolRow({ tool }: { tool: ToolRun }) {
  const [open, setOpen] = useState(false)
  const arg = useMemo(() => headlineArg(tool.args), [tool.args])
  return (
    <li className="tool-entry" data-status={tool.status}>
      <button
        className="tool-entry-row"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-status" aria-hidden="true" />
        <span className="tool-name">{tool.name.replace(/_/g, ' ')}</span>
        <span className="tool-arg">{arg}</span>
        <span className="tool-duration">
          {tool.status === 'running'
            ? 'Running'
            : tool.status === 'denied'
              ? 'Denied'
              : tool.ms !== undefined
                ? `${tool.ms}ms`
                : tool.status === 'error'
                  ? 'Failed'
                  : 'Done'}
        </span>
      </button>
      {open && (
        <div className="tool-detail">
          {Object.entries(tool.args).map(([key, value]) => (
            <div key={key}>
              <span className="tool-detail-key">{key}</span> {String(value).slice(0, 400)}
            </div>
          ))}
          {tool.summary && <div className="tool-detail-summary">{tool.summary}</div>}
        </div>
      )}
    </li>
  )
}

function Working() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Working</span>
      <span className="working-time">{seconds}s</span>
    </div>
  )
}

function ConfirmBar({
  request,
  onRespond
}: {
  request: ConfirmRequest
  onRespond: (approved: boolean) => void
}) {
  return (
    <div className="confirm" role="alertdialog" aria-label="Approval required">
      <div className="confirm-copy">
        <span className="confirm-title">Approve this action?</span>
        <div className="confirm-body">
          <span>{request.tool.replace(/_/g, ' ')}</span>
          {typeof request.args.command === 'string' ? (
            <code className="confirm-command">{request.args.command}</code>
          ) : (
            <span className="confirm-args">{summariseArgs(request.args)}</span>
          )}
        </div>
      </div>
      <div className="confirm-actions">
        <button className="button-secondary" onClick={() => onRespond(false)}>
          Deny
        </button>
        <button className="button-primary" onClick={() => onRespond(true)}>
          Approve
        </button>
      </div>
    </div>
  )
}

function EmptyState({
  onPick,
  engineState,
  engine,
  micReady,
  onOpenSettings,
  onOpenMicrophone
}: {
  onPick: (text: string) => void
  engineState: EngineState
  engine: EngineStatus | null
  micReady: boolean
  onOpenSettings: () => void
  onOpenMicrophone: () => void
}) {
  const checking = engineState === 'checking'

  return (
    <div className="empty">
      <h1 className="empty-title">How can I help?</h1>
      <p className="empty-sub">
        Lux runs entirely on this Mac. Ask a question, or describe the task and it will use the local
        apps, browser, music and files to get it done.
      </p>

      <ul className="suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button className="suggestion" onClick={() => onPick(suggestion)}>
              <span>{suggestion}</span>
              <IconChevron size={11} className="suggestion-arrow" />
            </button>
          </li>
        ))}
      </ul>

      <p className="empty-status" role="status">
        <span className="engine-dot" data-state={engineState} />
        {checking ? 'Connecting to the local engine…' : (engine?.detail ?? ENGINE_HEADLINE[engineState])}
      </p>

      {!micReady && !checking && (
        <div className="empty-permission">
          <IconMic size={12} />
          <span>Microphone access is off, so voice input will not work.</span>
          <button className="text-button" onClick={onOpenMicrophone}>
            Open settings
          </button>
        </div>
      )}

      {checking && (
        <p className="empty-status">
          <button className="text-button" onClick={onOpenSettings}>
            Engine settings
          </button>
        </p>
      )}
    </div>
  )
}

function SettingsPanel({
  settings,
  permissions,
  engine,
  onWake,
  onClose,
  onSaved
}: {
  settings: Settings
  permissions: PermissionsStatus | null
  engine: EngineStatus | null
  onWake: () => void
  onClose: () => void
  onSaved: (settings: Settings) => void
}) {
  const [models, setModels] = useState<string[]>([])
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [local, setLocal] = useState<Settings>(settings)
  const engineState: EngineState = engine?.state ?? 'checking'

  useEffect(() => {
    if (engine?.state === 'ready' || engine?.state === 'missing' || engine === null) {
      void window.lux.listModels().then(setModels)
    }
  }, [engine])

  useEffect(() => {
    void window.lux.listVoices().then(setVoices)
  }, [])

  const update = (patch: Partial<Settings>): void => {
    const next = { ...local, ...patch }
    setLocal(next)
    void window.lux.saveSettings(patch).then(onSaved)
  }

  return (
    <aside className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-head">
        <h2 className="settings-title" id="settings-title">
          Settings
        </h2>
        <button className="icon-button" onClick={onClose} aria-label="Close settings">
          <IconClose size={13} />
        </button>
      </header>

      <div className="settings-body">
        <section className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>
          <div className="segmented" role="group" aria-label="Appearance">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                className="segmented-option"
                data-active={local.theme === option.value}
                aria-pressed={local.theme === option.value}
                onClick={() => update({ theme: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="settings-note">
            System follows macOS. Light and Dark keep Lux in one appearance, including the menu bar
            panel and the floating HUD.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Local engine</h3>
          <div className="engine-card">
            <span className="engine-dot" data-state={engineState} />
            <div className="engine-card-copy">
              <span className="engine-card-title">{ENGINE_HEADLINE[engineState]}</span>
              <span className="engine-card-detail">{engine?.detail ?? 'Checking the local engine…'}</span>
            </div>
            <button className="text-button" onClick={onWake}>
              Restart
            </button>
          </div>
          <p className="settings-note">
            Lux starts Ollama when the app is open and it is not running, then reloads the model after
            a long sleep. Addresses outside this Mac are never started for you.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Model</h3>
          <label className="field">
            <span>Agent model</span>
            <select
              className="select"
              value={local.model}
              onChange={(event) => update({ model: event.target.value })}
            >
              {models.length === 0 && <option value={local.model}>{local.model}</option>}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Context window</span>
              <input
                className="input"
                type="number"
                min={2048}
                max={65536}
                step={1024}
                value={local.contextWindow}
                onChange={(event) => setLocal({ ...local, contextWindow: Number(event.target.value) })}
                onBlur={() => update({ contextWindow: local.contextWindow })}
              />
            </label>
            <label className="field">
              <span>Max output tokens</span>
              <input
                className="input"
                type="number"
                min={256}
                max={8192}
                step={128}
                value={local.maxOutputTokens}
                onChange={(event) => setLocal({ ...local, maxOutputTokens: Number(event.target.value) })}
                onBlur={() => update({ maxOutputTokens: local.maxOutputTokens })}
              />
            </label>
            <label className="field">
              <span>Keep warm</span>
              <input
                className="input"
                placeholder="30m"
                value={local.modelKeepAlive}
                onChange={(event) => setLocal({ ...local, modelKeepAlive: event.target.value })}
                onBlur={() => update({ modelKeepAlive: local.modelKeepAlive })}
              />
            </label>
            <label className="field">
              <span>Specialist model</span>
              <select
                className="select"
                value={local.specializedModel}
                onChange={(event) => update({ specializedModel: event.target.value })}
              >
                <option value="">None</option>
                {models
                  .filter((name) => name !== local.model && !name.startsWith('nomic-embed'))
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label className="toggle-row">
            <span>Keep the agent model loaded</span>
            <input
              type="checkbox"
              checked={local.keepModelLoaded}
              onChange={(event) => update({ keepModelLoaded: event.target.checked })}
            />
          </label>
          <p className="settings-note">
            24K context and a 30-minute keep-alive are the defaults on 16 GB. A larger context
            costs memory; the specialist only loads when a task explicitly asks for it.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Voice</h3>
          <label className="toggle-row">
            <span>Speak replies out loud</span>
            <input
              type="checkbox"
              checked={local.speechEnabled}
              onChange={(event) => update({ speechEnabled: event.target.checked })}
            />
          </label>
          <label className="field">
            <span>Voice</span>
            <select
              className="select"
              value={local.voice}
              onChange={(event) => update({ voice: event.target.value })}
            >
              <option value="">Automatic — most natural installed</option>
              {local.voice && !voices.some((voice) => voice.name === local.voice) && (
                <option value={local.voice}>{local.voice}</option>
              )}
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} · {voice.language}
                  {voice.quality === 'standard' ? '' : ` · ${voice.quality}`}
                </option>
              ))}
            </select>
          </label>
          <button className="text-button" onClick={() => void window.lux.openVoiceSettings()}>
            Download more natural voices
          </button>
          <p className="settings-note">
            macOS ships compact voices. A Premium or Enhanced download in Accessibility → Spoken
            Content sounds far more natural, and Lux picks it up here without a restart.
          </p>
          <label className="slider-row">
            <span>Speech rate</span>
            <input
              type="range"
              min={130}
              max={250}
              step={5}
              value={local.speechRate}
              onChange={(event) => setLocal({ ...local, speechRate: Number(event.target.value) })}
              onMouseUp={() => update({ speechRate: local.speechRate })}
            />
            <span className="slider-value">{local.speechRate}</span>
          </label>
          <button className="text-button" onClick={() => void window.lux.speakTest('Lux is ready.')}>
            Test the voice
          </button>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Morning brief</h3>
          <label className="toggle-row">
            <span>Deliver a daily brief</span>
            <input
              type="checkbox"
              checked={local.proactiveEnabled}
              onChange={(event) => update({ proactiveEnabled: event.target.checked })}
            />
          </label>
          <div className="time-grid">
            <label className="field">
              <span>Brief at</span>
              <input
                className="input"
                type="time"
                value={local.morningBriefTime}
                onChange={(event) => setLocal({ ...local, morningBriefTime: event.target.value })}
                onBlur={() => update({ morningBriefTime: local.morningBriefTime })}
              />
            </label>
            <label className="field">
              <span>Quiet from</span>
              <input
                className="input"
                type="time"
                value={local.quietHoursStart}
                onChange={(event) => setLocal({ ...local, quietHoursStart: event.target.value })}
                onBlur={() => update({ quietHoursStart: local.quietHoursStart })}
              />
            </label>
            <label className="field">
              <span>Quiet until</span>
              <input
                className="input"
                type="time"
                value={local.quietHoursEnd}
                onChange={(event) => setLocal({ ...local, quietHoursEnd: event.target.value })}
                onBlur={() => update({ quietHoursEnd: local.quietHoursEnd })}
              />
            </label>
          </div>
          <p className="settings-note">
            A short, deterministic summary of open commitments, delivered once a day. Quiet hours
            suppress delivery; a brief missed while the Mac is asleep waits up to three hours after it
            wakes.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Permissions</h3>
          <PermissionRow
            label="Microphone"
            ok={permissions?.microphone === 'granted'}
            action="Open"
            onAction={() => void window.lux.openPermissionPane('microphone')}
          />
          <PermissionRow
            label="Input monitoring (right ⌥)"
            ok={Boolean(permissions?.inputMonitoring)}
            action="Open"
            onAction={() => void window.lux.openPermissionPane('input')}
          />
          <PermissionRow
            label="App automation"
            ok={permissions?.automation !== 'denied'}
            action="Open"
            onAction={() => void window.lux.openPermissionPane('automation')}
          />
          <PermissionRow
            label="Hotkey helper"
            ok={Boolean(permissions?.hotkeyBinary)}
            action="Info"
            onAction={() => void window.lux.speakTest('Run npm run hotkey to build the listener.')}
          />
          <p className="settings-note">
            Input monitoring lets Lux hear a held right Option without reading what you type.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Knowledge and memory</h3>
          <label className="field">
            <span>Notes folder</span>
            <input
              className="input"
              value={local.notesDir}
              onChange={(event) => setLocal({ ...local, notesDir: event.target.value })}
              onBlur={() => update({ notesDir: local.notesDir })}
            />
          </label>
          <label className="field">
            <span>Obsidian vault (optional)</span>
            <input
              className="input"
              placeholder="/Users/you/Vault"
              value={local.vaultPath}
              onChange={(event) => setLocal({ ...local, vaultPath: event.target.value })}
              onBlur={() => update({ vaultPath: local.vaultPath })}
            />
          </label>
          <label className="field">
            <span>Local knowledge database (optional)</span>
            <input
              className="input"
              placeholder="~/Library/Application Support/example/knowledge.db"
              value={local.agniDbPath}
              onChange={(event) => setLocal({ ...local, agniDbPath: event.target.value })}
              onBlur={() => update({ agniDbPath: local.agniDbPath })}
            />
          </label>
          <p className="settings-note">
            A read-only SQLite database with events, links and reports. Leave empty to disable those
            tools.
          </p>
          <label className="slider-row">
            <span>Open the chat window above</span>
            <input
              type="range"
              min={80}
              max={600}
              step={20}
              value={local.openChatThreshold}
              onChange={(event) => setLocal({ ...local, openChatThreshold: Number(event.target.value) })}
              onMouseUp={() => update({ openChatThreshold: local.openChatThreshold })}
            />
            <span className="slider-value">{local.openChatThreshold}</span>
          </label>
          <label className="toggle-row">
            <span>Semantic memory (loads the embedding model)</span>
            <input
              type="checkbox"
              checked={local.memoryMode === 'semantic'}
              onChange={(event) => update({ memoryMode: event.target.checked ? 'semantic' : 'lexical' })}
            />
          </label>
          <p className="settings-note">
            Lexical recall is instant and needs no extra model. Semantic recall handles paraphrases
            better but keeps nomic in memory and adds an embedding call per turn.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Spotify</h3>
          <p className="settings-note">
            Spotify&apos;s scripting interface cannot search, so playing a track by name can use a free
            developer app. Create one at developer.spotify.com/dashboard with the redirect URI
            http://127.0.0.1:8888/callback and paste its two values. Looking up names needs no login.
          </p>
          <label className="field">
            <span>Client ID</span>
            <input
              className="input"
              placeholder="Optional"
              value={local.spotifyClientId}
              onChange={(event) => setLocal({ ...local, spotifyClientId: event.target.value })}
              onBlur={() => update({ spotifyClientId: local.spotifyClientId })}
            />
          </label>
          <label className="field">
            <span>Client secret</span>
            <input
              className="input"
              type="password"
              placeholder="Optional"
              value={local.spotifyClientSecret}
              onChange={(event) => setLocal({ ...local, spotifyClientSecret: event.target.value })}
              onBlur={() => update({ spotifyClientSecret: local.spotifyClientSecret })}
            />
          </label>
        </section>

        <footer className="settings-foot">
          <span>Lux 0.1.0</span>
          <span>{settings.sttEngine} speech recognition</span>
        </footer>
      </div>
    </aside>
  )
}

function PermissionRow({
  label,
  ok,
  action,
  onAction
}: {
  label: string
  ok: boolean
  action: string
  onAction: () => void
}) {
  return (
    <div className="permission-row">
      <span className={`permission-dot ${ok ? 'ok' : 'warn'}`} aria-hidden="true" />
      <span className="permission-label">{label}</span>
      <button className="text-button" onClick={onAction}>
        {action}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------- utils */

type Group =
  | { kind: 'single'; key: string; item: ChatItem }
  | { kind: 'tools'; key: string; items: ChatItem[] }

/** Consecutive tool runs belong to one agent step, so they render as a unit. */
function groupItems(items: ChatItem[]): Group[] {
  const groups: Group[] = []
  for (const item of items) {
    if (item.kind !== 'tool') {
      groups.push({ kind: 'single', key: item.id, item })
      continue
    }
    const last = groups.at(-1)
    if (last?.kind === 'tools') {
      last.items.push(item)
    } else {
      groups.push({ kind: 'tools', key: `tools-${item.id}`, items: [item] })
    }
  }
  return groups
}

function mergeTool(items: ChatItem[], tool: ToolRun): ChatItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.tool.id === tool.id)
  if (index === -1) {
    return [...items, { id: `tool-item-${tool.id}`, kind: 'tool', at: Date.now(), tool }]
  }
  const next = [...items]
  next[index] = { id: `tool-item-${tool.id}`, kind: 'tool', at: Date.now(), tool }
  return next
}

function groupLabel(tools: ToolRun[]): string {
  const names = new Set(tools.map((tool) => tool.name))
  if (names.size === 1) return tools[0].name.replace(/_/g, ' ')
  return 'Tools'
}

/** The argument a person recognises at a glance: the query, page or path. */
function headlineArg(args: Record<string, unknown>): string {
  for (const key of ['query', 'url', 'path', 'name', 'text', 'title']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  const first = Object.entries(args).find(
    ([key, value]) =>
      key !== 'reason' && typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())
  )
  return first ? String(first[1]) : ''
}

function summariseArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([key]) => key !== 'reason')
  if (entries.length === 0) return ''
  return entries
    .map(([, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    })
    .join(' · ')
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function relativeTime(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
