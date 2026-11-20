import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getSettings, saveSettings } from './config'
import type { Session } from './session'

export interface TrayDeps {
  session: Session
  showChat: () => void
  showWelcome: () => void
  openSettings: () => void
  openPermissions: () => void
  broadcastSettings: () => void
}

let tray: Tray | null = null

export function createTray(deps: TrayDeps): Tray {
  if (tray) return tray

  const candidates = [
    // Packaged: copied next to app.asar by --extra-resource.
    join(process.resourcesPath ?? '', 'trayTemplate.png'),
    // Running from source: out/main -> project root.
    join(__dirname, '../../resources/trayTemplate.png'),
    join(app.getAppPath(), 'resources', 'trayTemplate.png')
  ]
  const iconPath = candidates.find((candidate) => existsSync(candidate))
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (icon.isEmpty()) console.warn('[lux] tray icon missing; tried', candidates.join(', '))
  if (!icon.isEmpty()) icon.setTemplateImage(true)
  tray = new Tray(icon)
  // A glyph alone gets lost in a busy menu bar, so the app name is always shown.
  tray.setTitle(' Lux')
  tray.setToolTip('Lux — hold right ⌥ to speak')
  if (process.env.LUX_DEBUG) {
    setTimeout(() => console.log('[lux] tray bounds', tray?.getBounds()), 1_500)
  }

  const build = (): Menu => {
    const speech = getSettings().speechEnabled
    return Menu.buildFromTemplate([
      { label: 'Open Lux', accelerator: 'CmdOrCtrl+L', click: () => deps.showChat() },
      { label: 'New conversation', click: () => deps.session.newConversation() },
      { type: 'separator' },
      {
        label: 'Hold right ⌥ to speak',
        enabled: false
      },
      {
        label: 'Speak replies out loud',
        type: 'checkbox',
        checked: speech,
        click: () => {
          saveSettings({ speechEnabled: !speech })
          deps.broadcastSettings()
        }
      },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => deps.openSettings() },
      { label: 'Permissions…', click: () => deps.openPermissions() },
      { label: 'Setup guide', click: () => deps.showWelcome() },
      { type: 'separator' },
      { label: 'Quit Lux', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
    ])
  }

  tray.setContextMenu(build())
  tray.on('click', () => {
    tray?.setContextMenu(build())
    deps.showChat()
  })
  return tray
}

export function refreshTrayMenu(): void {
  if (!tray) return
  tray.popUpContextMenu()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
