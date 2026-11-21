import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'

const preloadPath = join(__dirname, '../preload/index.js')

/** Matches the renderer window colour so a launch never flashes the wrong theme. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f6f6f7'
}

export const HUD_WIDTH = 400
export const HUD_HEIGHT = 132

let chatWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null
const hudWaiters: (() => void)[] = []

/** Resolves once the HUD renderer has loaded, so the first keypress is not lost. */
export function whenHudReady(): Promise<void> {
  if (hudWindow && !hudWindow.isDestroyed() && !hudWindow.webContents.isLoading()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => hudWaiters.push(resolve))
}

function routeUrl(route: string): string {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) return `${devServer}#/${route}`
  return `app://lux/index.html#/${route}`
}

function applyWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://') && !url.startsWith('http://localhost')) event.preventDefault()
  })
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow
}

export function getHudWindow(): BrowserWindow | null {
  return hudWindow
}

export function createChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow

  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Lux',
    backgroundColor: windowBackground(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  applyWindowSecurity(win)
  void win.loadURL(routeUrl('chat'))
  win.once('ready-to-show', () => win.show())
  chatWindow = win
  win.on('closed', () => {
    chatWindow = null
  })
  return win
}

export function showChatWindow(): BrowserWindow {
  const win = createChatWindow()
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
  return win
}

export function createHudWindow(): BrowserWindow {
  if (hudWindow && !hudWindow.isDestroyed()) return hudWindow

  const win = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the hidden voice window alive: on macOS an occluded window is
      // otherwise treated as hidden, which can suspend capture.
      backgroundThrottling: false
    }
  })

  applyWindowSecurity(win)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void win.loadURL(routeUrl('hud'))
  win.webContents.on('did-finish-load', () => {
    for (const resolve of hudWaiters.splice(0)) resolve()
  })
  hudWindow = win
  win.on('closed', () => {
    hudWindow = null
  })
  return win
}

export function positionHud(): void {
  if (!hudWindow || hudWindow.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  hudWindow.setPosition(
    Math.round(x + (width - HUD_WIDTH) / 2),
    Math.round(y + height - HUD_HEIGHT - 56),
    false
  )
}

export function showHud(): void {
  const win = createHudWindow()
  positionHud()
  // Never steal focus from the app the person is working in.
  win.showInactive()
}

export function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide()
}

export function isHudVisible(): boolean {
  return Boolean(hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible())
}

export function sendToHud(channel: string, payload: unknown): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send(channel, payload)
}

export function createOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return onboardingWindow
  }
  const win = new BrowserWindow({
    width: 620,
    height: 660,
    resizable: false,
    show: false,
    title: 'Welcome to Lux',
    backgroundColor: windowBackground(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  applyWindowSecurity(win)
  void win.loadURL(routeUrl('welcome'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    onboardingWindow = null
  })
  onboardingWindow = win
  return win
}

export function closeOnboarding(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close()
}

export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of [chatWindow, hudWindow, onboardingWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
