// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Tab bar
  onTabsChanged: (callback) => ipcRenderer.on('tabs-changed', (event, state) => callback(state)),
  onFullScreenChanged: (callback) => ipcRenderer.on('fullscreen-changed', (event, isFullScreen) => callback(isFullScreen)),
  selectTab: (tabId) => ipcRenderer.send('tab-select', tabId),
  closeTab: (tabId) => ipcRenderer.send('tab-close', tabId),
  newTab: () => ipcRenderer.send('tab-new'),
  openSettings: () => ipcRenderer.send('open-settings'),
  getShortcuts: () => ipcRenderer.send('get-shortcuts'),
  onShortcutsReceived: (callback) => ipcRenderer.on('shortcuts', (event, shortcuts) => callback(shortcuts)),
  setShortcuts: (shortcuts) => ipcRenderer.send('set-shortcuts', shortcuts),
  closeSettings: () => ipcRenderer.send('close-settings'),
  getSettings: () => ipcRenderer.send('get-settings'),
  onSettingsReceived: (callback) => ipcRenderer.on('settings', (event, data) => callback(data)),
  setSettings: (data) => ipcRenderer.send('set-settings', data),  
  platform: process.platform,

  performQuickSearch: (searchText) => ipcRenderer.send('perform-quick-search', searchText),
  installContextMenu: () => ipcRenderer.send('install-context-menu'),
  
  getShortcutInstructions: () => ipcRenderer.send('get-shortcut-instructions'),
  onShortcutInstructions: (callback) => 
    ipcRenderer.on('shortcut-instructions', (event, html) => callback(html)),
    
  openExternalLink: (url) => ipcRenderer.send('open-external-link', url),

  toggleAutostart: (enable) => ipcRenderer.send('toggle-autostart', enable),
  getAutostartStatus: () => ipcRenderer.invoke('get-autostart-status'),
  onAutostartStatus: (callback) => ipcRenderer.on('autostart-status', (_, data) => callback(data)),

  // Find bar
  findInPage: (text, options) => ipcRenderer.send('find-in-page', text, options),
  stopFindInPage: (action) => ipcRenderer.send('stop-find-in-page', action),
  onFindResult: (callback) => ipcRenderer.on('find-result', (event, result) => callback(result)),
  onToggleFindBar: (callback) => ipcRenderer.on('toggle-find-bar', () => callback()),
  findBarOpened: () => ipcRenderer.send('find-bar-opened'),
  findBarClosed: () => ipcRenderer.send('find-bar-closed')
});