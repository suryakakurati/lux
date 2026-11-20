import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  powerMonitor,
  protocol,
  shell,
  systemPreferences
} from 'electron'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { LuxEvent, Settings } from '../../shared/types'
import { dataDir, getSettings, saveSettings } from './config'
import { CommitmentLedger } from './commitments'
import { Memory } from './agent/memory'
import { EngineSupervisor } from './agent/engine'
import { ModelManager } from './agent/model-manager'
import { HotkeyBridge } from './hotkey'
import { registerIpc, permissionsStatus } from './ipc'
import { initLog, logLine } from './log'
import { Proactive } from './proactive'
import { Session } from './session'
import { Transcriber } from './stt'
import { notifyNative } from './tools/misc'
import { resolveVoice, speak, stopSpeaking } from './tts'
import { createTray } from './tray'
import {
  broadcastToWindows,
  closeOnboarding,
  createChatWindow,
  createHudWindow,
  createOnboardingWindow,
  getChatWindow,
  getHudWindow,
  hideHud,
  isHudVisible,
  showChatWindow,
  showHud,
  whenHudReady
} from './windows'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

// Must happen before the first getPath('userData'), otherwise macOS names the
// data directory after the Electron binary instead of the app.
app.setName('Lux')

let session: Session | null = null
let proactive: Proactive | null = null
let hotkey: HotkeyBridge | null = null
let listening = false
let quitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showChatWindow())
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  initLog()

  process.on('uncaughtException', (error) => logLine('crash', `uncaught: ${error?.stack ?? error}`))
  process.on('unhandledRejection', (reason) => logLine('crash', `unhandled rejection: ${String(reason)}`))

  registerAppProtocol()
  installAppMenu()

  const settings = getSettings()
  const transcriber = new Transcriber(getSettings)
  const models = new ModelManager(getSettings)
  const memory = new Memory(join(dataDir(), 'memory.json'), () => ({
    url: getSettings().ollamaUrl,
    model: getSettings().embeddingModel,
    mode: getSettings().memoryMode
  }))
  const commitments = new CommitmentLedger(join(dataDir(), 'commitments.json'))

  const broadcast = (event: LuxEvent): void => broadcastToWindows('lux:event', event)
  const engine = new EngineSupervisor(getSettings, (status) => broadcast({ kind: 'engine', status }))

  session = new Session({
    dataDir: dataDir(),
    settings: getSettings,
    commitments,
    models,
    memory,
    transcriber,
    broadcast,
    showChat: () => showChatWindow(),
    showHud: () => showHud(),
    hideHud: () => hideHud(),
    speak: (text) => speak(text, getSettings(), (active) => broadcast({ kind: 'speech', active })),
    stopSpeaking: () => stopSpeaking(),
    notify: (title, body) => notifyNative(title, body),
    ensureEngine: async () => {
      const status = await engine.ensure('turn')
      return status.reachable
    }
  })
  void models.reconcile()
  // Watch the engine for the whole session: Ollama can stop while the Mac is
  // asleep, and the next question should not be the thing that discovers it.
  engine.start()
  powerMonitor.on('resume', () => void engine.ensure('resume'))
  powerMonitor.on('unlock-screen', () => void engine.ensure('resume'))

  const saveAndBroadcast = (next: Settings): void => {
    broadcast({ kind: 'settings', settings: next })
  }

  hotkey = new HotkeyBridge({
    onDown: () => {
      if (listening) return
      listening = true
      void whenHudReady().then(() => session?.beginListening())
    },
    onUp: () => {
      if (!listening) return
      listening = false
      session?.endListening()
    },
    onChat: () => toggleChat(),
    onPermission: () => {
      void refreshPermissions()
    },
    onStateChange: () => {
      void refreshPermissions()
    }
  })

  registerIpc({
    session,
    engine,
    hotkey,
    transcriber,
    broadcast,
    onSettingsChanged: saveAndBroadcast,
    onSpeak: (text) => speak(text, getSettings()),
    onOnboarded: () => {
      saveSettings({ onboarded: true })
      closeOnboarding()
      showChatWindow()
    },
    onHudStopped: () => {
      listening = false
    }
  })

  // Warm the HUD renderer so the first keypress is instant and the mic stream
  // is already negotiated.
  createHudWindow()
  void whenHudReady().then(() => primeMicrophone())

  session.startStatsLoop((stats) => broadcast({ kind: 'stats', stats }))
  hotkey.start()
  void resolveVoice()

  // The brief is a visible HUD state, so only start the clock once the HUD
  // renderer is listening; otherwise a brief fired during startup is lost.
  const proactiveManager = new Proactive({
    dataDir: dataDir(),
    settings: getSettings,
    session,
    commitments,
    notify: (title, body) => notifyNative(title, body)
  })
  proactive = proactiveManager
  void whenHudReady().then(() => proactiveManager.start())

  registerGlobalShortcuts()

  if (!settings.onboarded) {
    createOnboardingWindow()
  } else {
    // Keep the app invisible until needed; the tray and hotkey are the entry points.
    createChatWindow()
  }

  // `LUX_SHOT=/path.png` renders the real chat window once and exits, so a UI
  // change can be inspected without taking over the person's screen.
  if (process.env.LUX_SHOT) {
    const target = process.env.LUX_SHOT
    const win = showChatWindow()
    const capture = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 1_400))
      const image = await win.webContents.capturePage()
      await writeFile(target, image.toPNG())
      console.log(`[lux] captured ${target}`)
      app.exit(0)
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => void capture())
    else void capture()
  }

  // Debug hooks: deliver the brief on demand and, optionally, capture the real
  // HUD so the proactive state can be inspected without waiting for 08:30.
  if (process.env.LUX_SHOT_HUD) {
    const target = process.env.LUX_SHOT_HUD
    void (async () => {
      await whenHudReady()
      // Let the renderer's event subscription settle before the first brief.
      await new Promise((resolve) => setTimeout(resolve, 300))
      proactive?.force()
      await new Promise((resolve) => setTimeout(resolve, 1_600))
      const hud = getHudWindow()
      if (!hud) {
        console.error('[lux] HUD window unavailable')
        app.exit(1)
        return
      }
      const image = await hud.webContents.capturePage()
      await writeFile(target, image.toPNG())
      console.log(`[lux] captured HUD ${target}`)
      app.exit(0)
    })()
  } else if (process.env.LUX_BRIEF_NOW) {
    void whenHudReady().then(() => {
      const delivered = proactive?.force()
      console.log(`[lux] morning brief ${delivered ? 'delivered' : 'skipped'}`)
    })
  }

  // The status item is created after the first window so macOS places it in the
  // menu bar proper rather than at the far-left edge.
  createTray({
    session,
    showChat: () => showChatWindow(),
    showWelcome: () => createOnboardingWindow(),
    openSettings: () => openSettings(),
    openPermissions: () =>
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'),
    broadcastSettings: () => broadcast({ kind: 'settings', settings: getSettings() })
  })
  app.dock?.show()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createChatWindow()
    showChatWindow()
  })

  app.on('window-all-closed', () => {
    // Lux lives in the menu bar; closing windows must not quit the assistant.
  })

  // `--ask "text"` runs one real turn inside the packaged app and exits. The
  // smoke harness runs from source, which hides packaged-only failures.
  const askFlag = process.argv.indexOf('--ask')
  if (askFlag !== -1) {
    const question = process.argv.slice(askFlag + 1).join(' ').trim()
    if (question) {
      process.env.LUX_ASK = '1'
      void (async () => {
        await session?.send(question, 'text')
        setTimeout(() => app.exit(0), 1_000)
      })()
    }
  }

  // Debug entry point used by the packaged browser test. It exercises the real
  // Chromium partition and the real confirmation path against a local form.
  if (process.argv.includes('--form-test')) {
    void import('./form-test')
      .then(({ runFormTest }) => runFormTest())
      .then((ok) => app.exit(ok ? 0 : 1))
      .catch((error) => {
        console.error('[form-test] failed', error)
        app.exit(1)
      })
  }

  app.on('before-quit', () => {
    quitting = true
    hotkey?.stop()
    engine.stop()
    proactive?.stop()
    session?.stopStatsLoop()
    stopSpeaking()
    globalShortcut.unregisterAll()
  })

  process.on('uncaughtException', (error) => {
    console.error('[lux] uncaught exception', error)
  })
}

function registerGlobalShortcuts(): void {
  const toggleOk = globalShortcut.register('Control+Alt+L', () => toggleChat())
  // Keyboard-only fallback for when Input Monitoring has not been granted yet.
  const speakOk = globalShortcut.register('Control+Alt+Space', () => {
    if (listening) {
      listening = false
      session?.endListening()
      return
    }
    listening = true
    void whenHudReady().then(() => session?.beginListening())
  })
  if (!toggleOk) console.warn('[lux] Control+Alt+L is already taken by another app')
  if (!speakOk) console.warn('[lux] Control+Alt+Space is already taken by another app')
}

/** Open the chat window and reveal its settings sheet, even on first load. */
function openSettings(): void {
  const win = showChatWindow()
  const reveal = (): void => {
    win.webContents.send('lux:event', { kind: 'open-settings' })
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(reveal, 150))
    return
  }
  reveal()
}

function toggleChat(): void {
  const win = getChatWindow()
  if (win && win.isVisible() && win.isFocused()) {
    win.hide()
    return
  }
  showChatWindow()
}

async function primeMicrophone(): Promise<void> {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone')
  }
  await refreshPermissions()
}

async function refreshPermissions(): Promise<void> {
  if (!hotkey) return
  const permissions = await permissionsStatus(hotkey)
  broadcastToWindows('lux:event', { kind: 'permissions', permissions })
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm'
}

function registerAppProtocol(): void {
  const rendererRoot = join(__dirname, '../renderer')
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      const pathname = decodeURIComponent(url.pathname)
      const target = pathname === '/' ? '/index.html' : pathname
      const resolved = join(rendererRoot, target)
      if (!resolved.startsWith(rendererRoot)) {
        return new Response('Not allowed', { status: 403 })
      }
      // Read through node:fs rather than net.fetch: in the packaged build these
      // files live inside app.asar, which the Chromium network stack cannot open.
      const body = await readFile(resolved)
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': MIME_TYPES[extname(resolved)] ?? 'application/octet-stream' }
      })
    } catch (error) {
      console.error('[lux] renderer asset failed', error)
      return new Response('Not found', { status: 404 })
    }
  })
}

function installAppMenu(): void {
  // A proper Edit menu is required for ⌘C/⌘V inside the composer.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Lux',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'New conversation', accelerator: 'CmdOrCtrl+N', click: () => session?.newConversation() },
        { label: 'Open Lux', accelerator: 'CmdOrCtrl+O', click: () => showChatWindow() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function markOnboarded(): void {
  saveSettings({ onboarded: true })
  closeOnboarding()
  showChatWindow()
}

export function hudIsVisible(): boolean {
  return isHudVisible()
}

export function isQuitting(): boolean {
  return quitting
}
