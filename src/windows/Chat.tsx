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
  ToolRun
} from '../../shared/types'
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCopy,
  IconGear,
  IconGlobe,
  IconMic,
  IconPlus,
  IconSend,
  IconSparkle,
  IconStop,
  IconTrash
} from '../components/Icon'
import { Markdown } from '../components/Markdown'
import { Reactor } from '../components/Reactor'
import '../styles/chat.css'

const ENGINE_LABEL: Record<EngineState, string> = {
  checking: 'checking',
  ready: 'online',
  starting: 'starting',
  waking: 'waking',
  offline: 'offline',
  missing: 'no model'
}

const ENGINE_TITLE: Record<EngineState, string> = {
  checking: 'CHECKING ENGINE',
  ready: 'ENGINE ONLINE',
  starting: 'STARTING ENGINE',
  waking: 'WAKING MODEL',
  offline: 'ENGINE OFFLINE',
  missing: 'MODEL MISSING'
}

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
  const [railOpen, setRailOpen] = useState(true)
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
  const cpuPercent = stats && stats.cores > 0 ? Math.min(100, (stats.cpuLoad / stats.cores) * 100) : 0
  const cpu = stats ? `${Math.round(cpuPercent)}%` : '—'
  const engineState: EngineState = engine?.state ?? (reachable ? 'ready' : 'offline')
  const engineBusy = engineState === 'starting' || engineState === 'waking' || enginePending
  const activeTitle = conversations.find((conversation) => conversation.id === activeId)?.title ?? 'New session'
  const banner = engineState !== 'ready' && engineState !== 'checking'

  return (
    <div className="shell" data-rail={railOpen ? 'open' : 'closed'} data-engine={engineState}>
      <aside className="rail">
        <div className="rail-brand">
          <Reactor size={30} active={engineState === 'ready' || engineState === 'waking'} />
          <div className="brand-copy">
            <span className="brand-word">LUX</span>
            <span className="brand-sub mono">on-device agent</span>
          </div>
          <span className="brand-state mono" data-state={engineState}>
            <span className="brand-dot" />
            {engineState === 'ready' ? 'live' : engineState === 'offline' ? 'down' : ENGINE_LABEL[engineState]}
          </span>
        </div>

        <div className="rail-head">
          <span className="label">Conversations</span>
          <span className="rail-count mono">{String(conversations.length).padStart(2, '0')}</span>
          <button
            className="rail-new"
            title="New conversation"
            aria-label="New conversation"
            onClick={() => {
              void window.lux.newConversation()
              void refreshConversations()
            }}
          >
            <IconPlus size={13} />
          </button>
        </div>

        <nav className="rail-list">
          {conversations.map((conversation) => (
            <div className="rail-row" key={conversation.id}>
              <button
                className="rail-item"
                data-active={conversation.id === activeId}
                onClick={() => {
                  setActiveId(conversation.id)
                  void window.lux.openConversation(conversation.id)
                }}
              >
                <span className="rail-bar" />
                <span className="rail-text">
                  <span className="rail-title">{conversation.title}</span>
                  <span className="rail-time mono">{relativeTime(conversation.updatedAt)}</span>
                </span>
              </button>
              <button
                className="rail-delete"
                title="Delete this conversation"
                aria-label={`Delete ${conversation.title}`}
                onClick={async () => {
                  const list = await window.lux.deleteConversation(conversation.id)
                  setConversations(list)
                  const refreshed = await window.lux.bootstrap()
                  setActiveId(refreshed.activeConversationId)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="rail-empty">No sessions yet.</p>}
        </nav>

        <div className="rail-actions">
          {conversations.length > 0 && (
            <button
              className="rail-action"
              onClick={async () => {
                const list = await window.lux.clearConversations()
                setConversations(list)
                const refreshed = await window.lux.bootstrap()
                setActiveId(refreshed.activeConversationId)
              }}
            >
              <IconTrash size={13} />
              Delete all
            </button>
          )}
          <button className="rail-action" onClick={() => setSettingsOpen(true)}>
            <IconGear size={13} />
            Settings
          </button>
        </div>

        <button
          className="rail-engine"
          data-state={engineState}
          onClick={wakeEngine}
          title={engine?.detail ?? 'Check the local engine'}
        >
          <span className="engine-dot" />
          <span className="engine-name mono">Engine</span>
          <span className="engine-state mono">{ENGINE_LABEL[engineState]}</span>
        </button>

        <div className="rail-vitals">
          <div className="vitals-head">
            <span className="label">Vitals</span>
            <span className="vitals-live mono">
              <span className="live-dot" />
              live
            </span>
          </div>
          <Vital label="CPU" value={cpu} percent={cpuPercent} tone={cpuPercent > 85 ? 'hot' : 'normal'} />
          <Vital
            label="MEM"
            value={stats ? `${stats.memPercent}%` : '—'}
            percent={stats?.memPercent ?? 0}
            tone={(stats?.memPercent ?? 0) > 88 ? 'hot' : 'normal'}
          />
          <Vital
            label="PWR"
            value={stats?.batteryPercent != null ? `${stats.batteryPercent}%` : 'AC'}
            percent={stats?.batteryPercent ?? 100}
            tone={stats?.batteryPercent != null && stats.batteryPercent < 20 ? 'hot' : 'normal'}
          />
        </div>

        <p className="rail-privacy mono">
          <span className={micReady ? 'ok' : 'warn'}>{micReady ? 'mic armed' : 'mic locked'}</span>
          <span className="sep">/</span>
          no cloud
        </p>

        <button className="rail-collapse" onClick={() => setRailOpen(false)} title="Hide conversations">
          <IconChevron size={10} />
          Hide panel
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          {!railOpen && (
            <button className="rail-open" onClick={() => setRailOpen(true)} title="Show conversations">
              <IconChevron size={9} />
              History
            </button>
          )}
          <div className="topbar-title">
            <span className="topbar-kicker mono">
              <span className="beacon" />
              on-device channel
            </span>
            <span className="topbar-name">{activeTitle}</span>
          </div>
          <span className="topbar-spacer" />
          <button
            className="engine-pill"
            data-state={engineState}
            onClick={wakeEngine}
            disabled={engineBusy}
            title={engine?.detail ?? 'Local engine status'}
          >
            <span className="engine-bars">
              <i />
              <i />
              <i />
            </span>
            <span className="mono">{enginePending ? 'engaging' : ENGINE_LABEL[engineState]}</span>
          </button>
          <button className="model-chip" onClick={() => setSettingsOpen(true)} title="Model">
            <span className="model-chip-dot" />
            {model || 'no model'}
            <IconChevron size={9} />
          </button>
          <button
            className="gear-button"
            onClick={() => setSettingsOpen((open) => !open)}
            title="Settings"
            aria-label="Settings"
          >
            <IconGear size={15} />
          </button>
        </header>

        <div className="thread" ref={threadRef} onScroll={onScroll}>
          {showEmpty ? (
            <EmptyState onPick={send} engineState={engineState} />
          ) : (
            <div className="thread-inner">
              {groupItems(items).map((group) =>
                group.kind === 'tools' ? (
                  <ToolGroup key={group.key} items={group.items} />
                ) : (
                  <MessageRow key={group.item.id} item={group.item} />
                )
              )}
              {running && <Thinking />}
              <div className="thread-tail" />
            </div>
          )}
        </div>

        <div className="dock">
          {banner && engine && (
            <div className="engine-banner" data-state={engineState}>
              <Reactor size={20} active={engineBusy} />
              <div className="engine-banner-copy">
                <span className="engine-banner-title mono">{ENGINE_TITLE[engineState]}</span>
                <span className="engine-banner-text">{engine.detail}</span>
              </div>
              <button
                className="engine-banner-action mono"
                onClick={wakeEngine}
                disabled={engineBusy}
              >
                {engineBusy ? 'working' : engineState === 'missing' ? 'recheck' : 'wake'}
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
            <div className="composer-row">
              <span className="composer-glyph mono">›</span>
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                placeholder="Issue a command, or ask anything…"
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
            </div>
            <div className="composer-foot">
              <span className="hint mono">
                <IconMic size={10} /> hold right ⌥
              </span>
              <span className="hint-mid mono">⏎ send</span>
              <span className="hint-mid mono">⇧⏎ line</span>
              {running ? (
                <button
                  type="button"
                  className="send-button stop"
                  onClick={() => void window.lux.cancel()}
                  title="Stop"
                >
                  <IconStop />
                </button>
              ) : (
                <button type="submit" className="send-button" disabled={!draft.trim()} title="Send">
                  <IconSend />
                </button>
              )}
            </div>
          </form>
        </div>
      </main>

      {settingsOpen && settings && (
        <SettingsSheet
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
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */

function Vital({
  label,
  value,
  percent,
  tone
}: {
  label: string
  value: string
  percent: number
  tone: 'normal' | 'hot'
}) {
  return (
    <div className="vital">
      <span className="vital-label mono">{label}</span>
      <span className="vital-track">
        <span className="vital-fill" data-tone={tone} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </span>
      <span className="vital-value mono">{value}</span>
    </div>
  )
}

function MessageRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <article className="msg user">
        <div className="msg-body">
          <div className="msg-meta mono">
            {item.source === 'voice' && <span className="msg-voice">voice</span>}
            <span>{clock(item.at)}</span>
            <span className="msg-author">You</span>
          </div>
          <div className="bubble">
            <p className="msg-text selectable">{item.text}</p>
          </div>
        </div>
      </article>
    )
  }

  if (item.kind === 'assistant') {
    return (
      <article className="msg assistant" data-streaming={Boolean(item.streaming)}>
        <div className="msg-gutter">
          <span className="msg-avatar">
            <IconSparkle size={11} />
          </span>
        </div>
        <div className="msg-body">
          <div className="msg-meta mono">
            <span className="msg-author">Lux</span>
            <span>{clock(item.at)}</span>
            {item.streaming && (
              <span className="msg-live">
                <span className="msg-live-dot" />
                streaming
              </span>
            )}
          </div>
          <div className="bubble">
            {item.text ? <Markdown text={item.text} /> : <span className="caret" />}
            {item.streaming && item.text && <span className="caret" />}
            {item.text && <CopyButton text={item.text} />}
          </div>
        </div>
      </article>
    )
  }

  if (item.kind === 'tool') return <ToolGroup items={[item]} />

  return <div className="system-row mono">{item.text}</div>
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="bubble-action"
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
  const time = running ? 'running' : total > 0 ? `${(total / 1000).toFixed(1)}s` : ''

  return (
    <section className="tool-card" data-live={running}>
      <header className="tool-card-head">
        <span className="tool-glyph">
          <IconGlobe size={12} />
        </span>
        <span className="tool-card-label mono">{groupLabel(tools)}</span>
        <span className="tool-card-count mono">{String(tools.length).padStart(2, '0')}</span>
        <span className="tool-card-args">{headlineArg(tools[0].args)}</span>
        <span className={`tool-card-time mono${failed ? ' failed' : ''}`}>
          {running && <span className="trace-pulse" />}
          {time}
        </span>
      </header>
      <div className="tool-rows">
        {tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}
      </div>
    </section>
  )
}

function ToolRow({ tool }: { tool: ToolRun }) {
  const [open, setOpen] = useState(false)
  const args = useMemo(() => headlineArg(tool.args), [tool.args])
  return (
    <div className="tool-item" data-status={tool.status}>
      <button className="tool-row" onClick={() => setOpen((value) => !value)}>
        <span className="tool-dot" />
        <span className="tool-name mono">{tool.name.replace(/_/g, ' ')}</span>
        <span className="tool-args mono">{args}</span>
        <span className="tool-meta mono">
          {tool.status === 'running' ? '···' : tool.ms !== undefined ? `${tool.ms}ms` : tool.status}
        </span>
      </button>
      {open && (
        <div className="tool-detail mono">
          {Object.entries(tool.args).map(([key, value]) => (
            <div key={key}>
              <span className="tool-key">{key}</span> {String(value).slice(0, 400)}
            </div>
          ))}
          {tool.summary && <div className="tool-summary">{tool.summary}</div>}
        </div>
      )}
    </div>
  )
}

function Thinking() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="thinking" aria-label="Lux is working">
      <span className="thinking-bars">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label mono">processing</span>
      <span className="thinking-clock mono">{seconds}s</span>
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
    <div className="confirm">
      <div className="confirm-copy">
        <span className="confirm-title mono">Approval required</span>
        <span className="confirm-body">
          <span className="mono">{request.tool.replace(/_/g, ' ')}</span>
          {typeof request.args.command === 'string' ? (
            <code className="confirm-command mono">{request.args.command}</code>
          ) : (
            <span className="mono confirm-args">{summariseArgs(request.args)}</span>
          )}
        </span>
      </div>
      <div className="confirm-actions">
        <button className="confirm-deny mono" onClick={() => onRespond(false)}>
          Deny
        </button>
        <button className="confirm-allow mono" onClick={() => onRespond(true)}>
          Approve
        </button>
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  'How’s this machine doing?',
  'Put me in my coding setup',
  'What’s on my clipboard?',
  'What can you do?'
]

function EmptyState({ onPick, engineState }: { onPick: (text: string) => void; engineState: EngineState }) {
  return (
    <div className="empty">
      <div className="empty-orbit">
        <Reactor size={112} active={engineState === 'ready' || engineState === 'waking'} />
      </div>
      <p className="empty-kicker mono">
        <span className="beacon" />
        {engineState === 'ready' ? 'system ready · all local' : ENGINE_TITLE[engineState].toLowerCase()}
      </p>
      <h1 className="empty-title">
        At your service<span className="empty-stop">.</span>
      </h1>
      <p className="empty-sub">
        Every thought stays on this Mac. Ask a question, or give an order — I’ll work it out and act.
      </p>
      <div className="commands">
        {SUGGESTIONS.map((suggestion, index) => (
          <button key={suggestion} className="command" onClick={() => onPick(suggestion)}>
            <span className="cmd-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="cmd-text">{suggestion}</span>
            <IconChevron size={10} className="cmd-arrow" />
          </button>
        ))}
      </div>
    </div>
  )
}

function SettingsSheet({
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
  const [local, setLocal] = useState<Settings>(settings)
  const engineState: EngineState = engine?.state ?? 'checking'

  useEffect(() => {
    if (engine?.state === 'ready' || engine?.state === 'missing' || engine === null) {
      void window.lux.listModels().then(setModels)
    }
  }, [engine?.state])

  const update = (patch: Partial<Settings>): void => {
    const next = { ...local, ...patch }
    setLocal(next)
    void window.lux.saveSettings(patch).then(onSaved)
  }

  return (
    <aside className="sheet">
      <header className="sheet-head">
        <div className="sheet-heading">
          <span className="sheet-kicker mono">configuration</span>
          <span className="sheet-title">Settings</span>
        </div>
        <button className="icon-button small" onClick={onClose} aria-label="Close settings">
          <IconClose />
        </button>
      </header>

      <section className="sheet-section">
        <span className="label">Local engine</span>
        <div className="engine-row" data-state={engineState}>
          <span className="engine-row-dot" />
          <div className="engine-row-copy">
            <span className="engine-row-title mono">{ENGINE_TITLE[engineState]}</span>
            <span className="engine-row-detail">{engine?.detail ?? 'Checking the local engine…'}</span>
          </div>
          <button className="ghost-button mono" onClick={onWake}>
            Wake
          </button>
        </div>
        <p className="sheet-note">
          Lux starts Ollama when the app is open and it is not running, then reloads the model after a
          long sleep. A URL that is not on this Mac is never started for you.
        </p>
      </section>

      <section className="sheet-section">
        <span className="label">Model</span>
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
        <p className="sheet-note">Any model installed in Ollama works. Tool calling is required.</p>
        <div className="model-grid">
          <label className="field">
            <span>Context window</span>
            <input
              className="input mono"
              type="number"
              min={2048}
              max={32768}
              step={1024}
              value={local.contextWindow}
              onChange={(event) => setLocal({ ...local, contextWindow: Number(event.target.value) })}
              onBlur={() => update({ contextWindow: local.contextWindow })}
            />
          </label>
          <label className="field">
            <span>Max output tokens</span>
            <input
              className="input mono"
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
              className="input mono"
              placeholder="30m"
              value={local.modelKeepAlive}
              onChange={(event) => setLocal({ ...local, modelKeepAlive: event.target.value })}
              onBlur={() => update({ modelKeepAlive: local.modelKeepAlive })}
            />
          </label>
          <label className="field">
            <span>Specialist model (optional)</span>
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
        <label className="row-toggle">
          <span>Keep the agent model warm</span>
          <input
            type="checkbox"
            checked={local.keepModelLoaded}
            onChange={(event) => update({ keepModelLoaded: event.target.checked })}
          />
        </label>
        <p className="sheet-note">
          8K context and a 30-minute keep-alive are the sane defaults on 16 GB. Raising the context
          costs unified memory; the specialist is only loaded when a task explicitly asks for it.
        </p>
      </section>

      <section className="sheet-section">
        <span className="label">Voice</span>
        <label className="row-toggle">
          <span>Speak replies out loud</span>
          <input
            type="checkbox"
            checked={local.speechEnabled}
            onChange={(event) => update({ speechEnabled: event.target.checked })}
          />
        </label>
        <label className="row-slider">
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
          <span className="mono slider-value">{local.speechRate}</span>
        </label>
        <button className="ghost-button" onClick={() => void window.lux.speakTest('Lux is ready.')}>
          Try the voice
        </button>
      </section>

      <section className="sheet-section">
        <span className="label">Proactive</span>
        <label className="row-toggle">
          <span>Morning brief</span>
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
              className="input mono"
              type="time"
              value={local.morningBriefTime}
              onChange={(event) => setLocal({ ...local, morningBriefTime: event.target.value })}
              onBlur={() => update({ morningBriefTime: local.morningBriefTime })}
            />
          </label>
          <label className="field">
            <span>Quiet from</span>
            <input
              className="input mono"
              type="time"
              value={local.quietHoursStart}
              onChange={(event) => setLocal({ ...local, quietHoursStart: event.target.value })}
              onBlur={() => update({ quietHoursStart: local.quietHoursStart })}
            />
          </label>
          <label className="field">
            <span>Quiet until</span>
            <input
              className="input mono"
              type="time"
              value={local.quietHoursEnd}
              onChange={(event) => setLocal({ ...local, quietHoursEnd: event.target.value })}
              onBlur={() => update({ quietHoursEnd: local.quietHoursEnd })}
            />
          </label>
        </div>
        <p className="sheet-note">
          A short, deterministic summary of open commitments, delivered once a day. Quiet hours suppress
          delivery; a brief missed while the Mac is asleep waits until the next time it wakes, within three
          hours.
        </p>
      </section>

      <section className="sheet-section">
        <span className="label">Permissions</span>
        <PermissionRow
          label="Microphone"
          state={permissions?.microphone === 'granted' ? 'ok' : 'warn'}
          action="Open"
          onAction={() => void window.lux.openPermissionPane('microphone')}
        />
        <PermissionRow
          label="Input monitoring (right ⌥)"
          state={permissions?.inputMonitoring ? 'ok' : 'warn'}
          action="Open"
          onAction={() => void window.lux.openPermissionPane('input')}
        />
        <PermissionRow
          label="App automation"
          state={permissions?.automation === 'denied' ? 'warn' : 'ok'}
          action="Open"
          onAction={() => void window.lux.openPermissionPane('automation')}
        />
        <PermissionRow
          label="Native hotkey helper"
          state={permissions?.hotkeyBinary ? 'ok' : 'warn'}
          action="Build"
          onAction={() => void window.lux.speakTest('Run npm run hotkey to build the listener.')}
        />
        <p className="sheet-note">
          Input monitoring is what lets Lux hear a held right Option without watching everything you type.
        </p>
      </section>

      <section className="sheet-section">
        <span className="label">Notes &amp; memory</span>
        <label className="field">
          <span>Notes folder</span>
          <input
            className="input mono"
            value={local.notesDir}
            onChange={(event) => setLocal({ ...local, notesDir: event.target.value })}
            onBlur={() => update({ notesDir: local.notesDir })}
          />
        </label>
        <label className="field">
          <span>Obsidian vault (optional)</span>
          <input
            className="input mono"
            placeholder="/Users/you/Vault"
            value={local.vaultPath}
            onChange={(event) => setLocal({ ...local, vaultPath: event.target.value })}
            onBlur={() => update({ vaultPath: local.vaultPath })}
          />
        </label>
        <label className="field">
          <span>Local knowledge database (optional)</span>
          <input
            className="input mono"
            placeholder="~/Library/Application Support/example/knowledge.db"
            value={local.agniDbPath}
            onChange={(event) => setLocal({ ...local, agniDbPath: event.target.value })}
            onBlur={() => update({ agniDbPath: local.agniDbPath })}
          />
        </label>
        <p className="sheet-note">
          A read-only SQLite database with events, links and reports. Leave empty to disable those tools.
        </p>
        <label className="row-slider">
          <span>Open chat above</span>
          <input
            type="range"
            min={80}
            max={600}
            step={20}
            value={local.openChatThreshold}
            onChange={(event) => setLocal({ ...local, openChatThreshold: Number(event.target.value) })}
            onMouseUp={() => update({ openChatThreshold: local.openChatThreshold })}
          />
          <span className="mono slider-value">{local.openChatThreshold}</span>
        </label>
        <label className="row-toggle">
          <span>Semantic memory (loads embedding model)</span>
          <input
            type="checkbox"
            checked={local.memoryMode === 'semantic'}
            onChange={(event) => update({ memoryMode: event.target.checked ? 'semantic' : 'lexical' })}
          />
        </label>
        <p className="sheet-note">
          Lexical recall is instant and needs no extra model. Semantic recall is better at paraphrases but
          brings nomic into memory and adds an embedding call per turn.
        </p>
      </section>

      <section className="sheet-section">
        <span className="label">Spotify</span>
        <p className="sheet-note">
          Spotify&apos;s scripting interface cannot search, so playing a song by name needs a free developer
          app. Create one at developer.spotify.com/dashboard (redirect URI
          http://127.0.0.1:8888/callback) and paste its two values. Looking up names needs no login and no
          Premium.
        </p>
        <label className="field">
          <span>Client ID</span>
          <input
            className="input mono"
            placeholder="optional"
            value={local.spotifyClientId}
            onChange={(event) => setLocal({ ...local, spotifyClientId: event.target.value })}
            onBlur={() => update({ spotifyClientId: local.spotifyClientId })}
          />
        </label>
        <label className="field">
          <span>Client Secret</span>
          <input
            className="input mono"
            type="password"
            placeholder="optional"
            value={local.spotifyClientSecret}
            onChange={(event) => setLocal({ ...local, spotifyClientSecret: event.target.value })}
            onBlur={() => update({ spotifyClientSecret: local.spotifyClientSecret })}
          />
        </label>
      </section>

      <footer className="sheet-foot mono">
        <span>Lux 0.1.0</span>
        <span>{settings.sttEngine} stt</span>
      </footer>
    </aside>
  )
}

function PermissionRow({
  label,
  state,
  action,
  onAction
}: {
  label: string
  state: 'ok' | 'warn'
  action: string
  onAction: () => void
}) {
  return (
    <div className="permission-row">
      <span className={`permission-dot ${state}`} />
      <span className="permission-label">{label}</span>
      <button className="permission-action mono" onClick={onAction}>
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
  const allWeb = tools.every((tool) => tool.name.startsWith('web_'))
  if (allWeb) {
    return tools.some((tool) => tool.name === 'web_search') ? 'web search' : 'web pages'
  }
  const names = new Set(tools.map((tool) => tool.name))
  if (names.size === 1) return tools[0].name.replace(/_/g, ' ')
  return 'tool trace'
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
      return text.length > 48 ? `${text.slice(0, 48)}…` : text
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
