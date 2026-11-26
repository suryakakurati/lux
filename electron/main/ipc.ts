import { app, ipcMain, shell, systemPreferences } from 'electron'
import type {
  LuxEvent,
  PermissionsStatus,
  Settings,
  Bootstrap
} from '../../shared/types'
import { getSettings, saveSettings } from './config'
import { listModels, ping } from './agent/ollama'
import type { EngineSupervisor } from './agent/engine'
import type { HotkeyBridge } from './hotkey'
import type { Session } from './session'
import type { Transcriber } from './stt'
import { listVoices, resolveVoice } from './tts'
import { getChatWindow, hideHud } from './windows'

export interface IpcDeps {
  session: Session
  engine: EngineSupervisor
  hotkey: HotkeyBridge
  transcriber: Transcriber
  broadcast: (event: LuxEvent) => void
  onSettingsChanged: (settings: Settings) => void
  onSpeak: (text: string) => void
  onOnboarded: () => void
  onHudStopped: () => void
}

export async function permissionsStatus(hotkey: HotkeyBridge): Promise<PermissionsStatus> {
  const raw = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown'
  const microphone: PermissionsStatus['microphone'] =
    raw === 'granted' || raw === 'denied' || raw === 'restricted' || raw === 'not-determined'
      ? raw
      : 'unknown'
  const state = hotkey.getState()
  return {
    microphone,
    inputMonitoring: state.permissionGranted,
    automation: 'unknown',
    hotkeyBinary: state.binaryFound
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { session, hotkey, transcriber } = deps

  ipcMain.handle('lux:bootstrap', async (): Promise<Bootstrap> => {
    const settings = getSettings()
    const [permissions, models, reachable] = await Promise.all([
      permissionsStatus(hotkey),
      listModels(settings.ollamaUrl),
      ping(settings.ollamaUrl)
    ])
    const base = session.bootstrap()
    if (models.length > 0 && !models.includes(settings.model)) {
      // The configured model is gone: fall back to what is actually installed.
      const installedChat = models.find((name) => !name.startsWith('nomic-embed')) ?? models[0]
      if (installedChat && installedChat !== settings.model) {
        const next = saveSettings({ model: installedChat })
        deps.onSettingsChanged(next)
      }
    }
    const engine = deps.engine.current()
    return {
      ...base,
      version: app.getVersion(),
      settings: getSettings(),
      permissions,
      ollamaReachable: reachable || engine.reachable,
      engine,
      model: getSettings().model
    }
  })

  ipcMain.handle('lux:send', async (_event, text: string) => {
    await session.send(String(text ?? ''), 'text')
  })

  ipcMain.handle('lux:cancel', () => {
    session.cancel()
  })

  ipcMain.handle('lux:new-conversation', () => {
    session.newConversation()
  })

  ipcMain.handle('lux:open-conversation', (_event, id: string) => {
    session.openConversation(String(id))
  })

  ipcMain.handle('lux:delete-conversation', (_event, id: string) => {
    session.deleteConversation(String(id))
    return session.summaries()
  })

  ipcMain.handle('lux:clear-conversations', () => {
    session.clearConversations()
    return session.summaries()
  })

  ipcMain.handle('lux:settings:get', () => getSettings())

  ipcMain.handle('lux:settings:save', (_event, patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    if (patch.sttModel || patch.sttEngine) transcriber.invalidate()
    // A newly downloaded Premium voice should become the automatic choice, and
    // clearing the override should fall back to it without a restart.
    if (patch.voice !== undefined) void resolveVoice(true)
    deps.onSettingsChanged(next)
    deps.broadcast({ kind: 'settings', settings: next })
    return next
  })

  ipcMain.handle('lux:confirm:respond', (_event, id: string, approved: boolean) => {
    session.respondToConfirm(String(id), Boolean(approved))
  })

  ipcMain.handle('lux:stats', async () => session.currentStats())

  ipcMain.handle('lux:models', async () => listModels(getSettings().ollamaUrl))

  ipcMain.handle('lux:engine:status', () => deps.engine.current())

  ipcMain.handle('lux:engine:recover', async () => deps.engine.ensure('manual'))

  ipcMain.handle('lux:version', () => app.getVersion())

  ipcMain.handle('lux:conversations', () => session.summaries())

  ipcMain.handle('lux:permissions', async () => permissionsStatus(hotkey))

  ipcMain.handle('lux:open-permission', async (_event, kind: string) => {
    const pane =
      kind === 'microphone'
        ? 'Privacy_Microphone'
        : kind === 'input'
          ? 'Privacy_ListenEvent'
          : kind === 'automation'
            ? 'Privacy_Automation'
            : 'Privacy_ScreenCapture'
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  })

  ipcMain.handle('lux:onboarding-done', () => {
    deps.onOnboarded()
  })

  ipcMain.handle('lux:speak-test', (_event, text: string) => {
    deps.onSpeak(String(text ?? 'Lux is ready.'))
  })

  // Re-read the list each time Settings opens: a voice downloaded while Lux is
  // running should appear without a restart.
  ipcMain.handle('lux:voices', () => listVoices(true))

  ipcMain.handle('lux:voice-settings', async () => {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent'
    )
  })

  // ------------------------------------------------------------------ HUD

  ipcMain.handle('lux:hud:start', () => {
    session.beginListening()
  })

  ipcMain.handle('lux:hud:stop', () => {
    deps.onHudStopped()
    session.endListening()
  })

  ipcMain.handle('lux:hud:cancel', () => {
    session.cancel()
  })

  ipcMain.on('lux:hud:audio', (_event, buffer: ArrayBuffer) => {
    void session.handleAudio(Buffer.from(buffer))
  })

  ipcMain.on('lux:hud:empty', (_event, message: string) => {
    session.clearVoiceActivity()
    deps.broadcast({ kind: 'hud', state: 'error', detail: String(message).slice(0, 160) })
    setTimeout(() => hideHud(), 2_400)
  })

  ipcMain.handle('lux:hud:permission', async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied') return false
    return systemPreferences.askForMediaAccess('microphone')
  })

  // --------------------------------------------------------------- windows

  ipcMain.on('lux:win:minimize', (event) => {
    const win = getChatWindow()
    if (win && event.sender === win.webContents) win.minimize()
  })

  ipcMain.on('lux:win:hide', (event) => {
    const win = getChatWindow()
    if (win && event.sender === win.webContents) win.hide()
  })

  ipcMain.on('lux:win:close', (event) => {
    const win = getChatWindow()
    if (win && event.sender === win.webContents) win.hide()
  })

  ipcMain.on('lux:win:toggle-maximize', (event) => {
    const win = getChatWindow()
    if (!win || event.sender !== win.webContents) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on('lux:app:quit', () => app.quit())
}

