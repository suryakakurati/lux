import { contextBridge, ipcRenderer } from 'electron'
import type { LuxBridge, LuxEvent, Settings } from '../../shared/types'

const bridge: LuxBridge = {
  onEvent(handler: (event: LuxEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: LuxEvent): void => handler(payload)
    ipcRenderer.on('lux:event', listener)
    return () => ipcRenderer.removeListener('lux:event', listener)
  },

  bootstrap: () => ipcRenderer.invoke('lux:bootstrap'),
  send: (text: string) => ipcRenderer.invoke('lux:send', text),
  cancel: () => ipcRenderer.invoke('lux:cancel'),
  newConversation: () => ipcRenderer.invoke('lux:new-conversation'),
  openConversation: (id: string) => ipcRenderer.invoke('lux:open-conversation', id),
  deleteConversation: (id: string) => ipcRenderer.invoke('lux:delete-conversation', id),
  clearConversations: () => ipcRenderer.invoke('lux:clear-conversations'),

  getSettings: () => ipcRenderer.invoke('lux:settings:get'),
  saveSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('lux:settings:save', patch),

  respondToConfirm: (id: string, approved: boolean) =>
    ipcRenderer.invoke('lux:confirm:respond', id, approved),

  getStats: () => ipcRenderer.invoke('lux:stats'),
  listModels: () => ipcRenderer.invoke('lux:models'),
  engineStatus: () => ipcRenderer.invoke('lux:engine:status'),
  recoverEngine: () => ipcRenderer.invoke('lux:engine:recover'),
  conversations: () => ipcRenderer.invoke('lux:conversations'),
  speakTest: (text: string) => ipcRenderer.invoke('lux:speak-test', text),
  finishSetup: () => ipcRenderer.invoke('lux:onboarding-done'),
  permissions: () => ipcRenderer.invoke('lux:permissions'),
  openPermissionPane: (kind: 'microphone' | 'input' | 'automation' | 'screen') =>
    ipcRenderer.invoke('lux:open-permission', kind),

  hud: {
    ready: () => ipcRenderer.invoke('lux:hud:permission'),
    defaultDeviceOk: () => ipcRenderer.invoke('lux:hud:permission'),
    start: () => ipcRenderer.invoke('lux:hud:start'),
    stop: () => ipcRenderer.invoke('lux:hud:stop'),
    cancel: () => ipcRenderer.invoke('lux:hud:cancel'),
    audio: (wav: ArrayBuffer) => ipcRenderer.send('lux:hud:audio', wav),
    error: (message: string) => ipcRenderer.send('lux:hud:empty', message)
  },

  win: {
    minimize: () => ipcRenderer.send('lux:win:minimize'),
    hide: () => ipcRenderer.send('lux:win:hide'),
    close: () => ipcRenderer.send('lux:win:close'),
    toggleMaximize: () => ipcRenderer.send('lux:win:toggle-maximize')
  }
}

contextBridge.exposeInMainWorld('lux', bridge)
