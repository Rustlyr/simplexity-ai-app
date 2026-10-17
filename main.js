const { app, BrowserWindow, ipcMain, BrowserView, Menu, globalShortcut, Tray, nativeImage, shell, Notification, clipboard, dialog, session, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const marked = require('marked');
const windowStateKeeper = require('electron-window-state');

// Migrate settings from older app versions if this is a fresh install
// Migration chain: perplexity-ai-app → simplexity-ai-app
(function migrateOldSettings() {
  try {
    const appDataBase = app.getPath('appData');
    const newAppDataDir = app.getPath('userData'); // .../simplexity-ai-app
    const newConfigPath = path.join(newAppDataDir, 'config.json');

    // Already has config — no migration needed
    if (fs.existsSync(newConfigPath)) return;

    // Try migrating from simplexity-ai-app first (most recent), then perplexity-ai-app (oldest)
    const oldDirs = [
      path.join(appDataBase, 'simplexity-ai-app'),
      path.join(appDataBase, 'perplexity-ai-app')
    ];

    for (const oldAppDataDir of oldDirs) {
      const oldConfigPath = path.join(oldAppDataDir, 'config.json');
      if (fs.existsSync(oldConfigPath)) {
        // Ensure new directory exists
        if (!fs.existsSync(newAppDataDir)) {
          fs.mkdirSync(newAppDataDir, { recursive: true });
        }

        // Copy config.json (settings)
        fs.copyFileSync(oldConfigPath, newConfigPath);
        console.log(`Migrated settings from ${path.basename(oldAppDataDir)}`);

        // Also copy window-state.json if it exists
        const oldWindowState = path.join(oldAppDataDir, 'window-state.json');
        const newWindowState = path.join(newAppDataDir, 'window-state.json');
        if (fs.existsSync(oldWindowState) && !fs.existsSync(newWindowState)) {
          fs.copyFileSync(oldWindowState, newWindowState);
          console.log(`Migrated window state from ${path.basename(oldAppDataDir)}`);
        }
        break; // Stop after first successful migration
      }
    }
  } catch (error) {
    console.error('Settings migration failed (non-fatal):', error.message);
  }
})();

const settings = new Store();
const SearchService = require('./search-service');

// Shown in the menu bar, window title, tray and notifications. package.json's top-level
// productName stays "SimplexityAI" because it names the userData folder holding the login.
const APP_DISPLAY_NAME = 'Simplex';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

if (process.platform === 'win32') {
  app.setAppUserModelId("SimplexityAI");
}

let mainWindow;
let currentView;

// Independent Perplexity workspaces, opened and closed from the tab bar.
// `views` is keyed by TAB ID, not by URL: keying by URL meant two tabs pointing
// at the same site collapsed onto a single cached BrowserView, so switching
// between them did nothing. Keying by tab identity gives each tab its own
// BrowserView, and therefore its own navigation history, scroll position and
// in-flight conversation. All tabs use the default Electron session, so cookies
// and localStorage -- and therefore the Perplexity login -- are shared.
// Ids are `tab<n>`; 'tab1' and 'tab2' keep their old meaning for the defaultAI
// setting and the two tab shortcuts, which reopen them if they were closed.
const HOME_URL = 'https://perplexity.ai';
const DEFAULT_TAB_ID = 'tab1';
const TAB_ID_PATTERN = /^tab\d+$/;
// Must match --tabbar-height in styles.css.
const TAB_BAR_HEIGHT = 44;
const tabHome = () => HOME_URL;

let views = {};
let tabOrder = [];
let tabMeta = {};
// See cleanupUnusedResources().
const DISCARD_AFTER_MS = 30 * 60 * 1000;
// Perplexity's sidebar out of the box: Finance takes Computer's place (see pageCSS).
const DEFAULT_SIDEBAR_SHORTCUTS = ['finance'];
// Finance's section tabs, by the id at the end of each tab's Radix id.
const FINANCE_TABS = ['market', 'crypto', 'earnings', 'predictions', 'screener', 'politicians', 'watchlist', 'workflows', 'gallery'];
let tabLastShown = {};
let discardedUrls = {};
let activeTabId = DEFAULT_TAB_ID;
const isTabId = (value) => tabOrder.includes(value);
let findBarOpen = false;
let tray = null;
let settingsWindow = null;
let searchService;
let prefixSearchWindow = null; 
let launchedHidden = process.argv.includes('--hidden') || process.argv.includes('--start-minimized');
let layoutCheckInterval;

let autoStartEnabled = settings.get('autoStartEnabled', false);

let originalClipboardContent = '';

let shortcutsRegistered = false;

function configureAutoStart(enable) {
  try {
    if (isMac) {
      // macOS implementation. Electron 44 removed the openAsHidden option, so
      // the window now opens normally at login.
      app.setLoginItemSettings({
        openAtLogin: enable
      });
    } else if (isWindows) {
      // Windows implementation with hidden flag
      app.setLoginItemSettings({
        openAtLogin: enable,
        path: process.execPath,
        args: ['--hidden'] 
      });
    } else {
      // Linux implementation (depends on desktop environment)
      app.setLoginItemSettings({
        openAtLogin: enable
      });
    }
    
    // Save the setting
    settings.set('autoStartEnabled', enable);
    autoStartEnabled = enable;
    
    console.log(`Autostart ${enable ? 'enabled' : 'disabled'} (in tray mode)`);
    return true;
  } catch (error) {
    console.error('Error configuring autostart:', error);
    return false;
  }
}

// Process command line arguments for searching
function processCommandLineArgs(argv) {
  const searchArg = argv.find(arg => 
    arg.startsWith('--search-text=') || 
    arg.startsWith('--explain=') || 
    arg.startsWith('--meaning=')
  );
  
  if (searchArg) {
    let searchText = '';
    let searchPrefix = '';
    let argType = '';
    
    if (searchArg.startsWith('--search-text=')) {
      argType = '--search-text=';
      searchText = searchArg.substring(argType.length);
    } else if (searchArg.startsWith('--explain=')) {
      argType = '--explain=';
      searchText = searchArg.substring(argType.length);
      searchPrefix = 'explain ';
    } else if (searchArg.startsWith('--meaning=')) {
      argType = '--meaning=';
      searchText = searchArg.substring(argType.length);
      searchPrefix = 'meaning of ';
    }
    
    searchText = searchText.trim();
    
    if (searchText.startsWith('"') && searchText.endsWith('"')) {
      searchText = searchText.slice(1, -1);
    }
    
    try {
      searchText = decodeURIComponent(searchText);
    } catch (e) {
      console.log('Error decoding URI component:', e);
    }
    
    console.log('Processed search text:', searchText);
    
    if (searchText) {
      return {
        formattedText: searchPrefix + searchText.trim(),
        searchUrl: `https://www.perplexity.ai/search?q=${encodeURIComponent(searchPrefix + searchText.trim())}`
      };
    }
  }
  
  return null;
}

const defaultShortcuts = isMac
  ? {
      perplexityAI: { key: 'Command+1', enabled: false },
      secondTab: { key: 'Command+2', enabled: false },
      sendToTray: { key: 'Command+Shift+W', enabled: false },
      restoreApp: { key: 'Command+Shift+T', enabled: false },
      quickSearch: { key: 'Command+Shift+P', enabled: false },
      customPrefixSearch: { key: 'Command+Shift+C', enabled: false }
    }
  : {
      perplexityAI: { key: 'Control+1', enabled: false },
      secondTab: { key: 'Control+2', enabled: false },
      sendToTray: { key: 'Alt+Shift+W', enabled: false },
      restoreApp: { key: 'Alt+Shift+Q', enabled: false },
      quickSearch: { key: 'Alt+Shift+X', enabled: false },
      customPrefixSearch: { key: 'Alt+Shift+D', enabled: false }
    };

let shortcuts = settings.get('shortcuts', defaultShortcuts);

function ensureShortcutsFormat() {
  let updated = false;
  for (const [key, value] of Object.entries(shortcuts)) {
    if (typeof value === 'string') {
      shortcuts[key] = {
        key: value,
        enabled: false 
      };
      updated = true;
    }
  }
  
  if (updated) {
    settings.set('shortcuts', shortcuts);
  }
  
  let hasAddedShortcuts = false;
  for (const [key, value] of Object.entries(defaultShortcuts)) {
    if (!shortcuts[key]) {
      shortcuts[key] = { ...value };
      hasAddedShortcuts = true;
    }
  }

  if (hasAddedShortcuts) {
    settings.set('shortcuts', shortcuts);
  }

  const validShortcutKeys = Object.keys(defaultShortcuts);
  let hasRemovedShortcuts = false;
  
  for (const key of Object.keys(shortcuts)) {
    if (!validShortcutKeys.includes(key)) {
      delete shortcuts[key];
      hasRemovedShortcuts = true;
    }
  }
  
  if (hasRemovedShortcuts) {
    settings.set('shortcuts', shortcuts);
  }
}

ensureShortcutsFormat();

function registerShortcuts() {
  globalShortcut.unregisterAll();

  const shortcutActions = {
    perplexityAI: () => switchView('tab1'),
    secondTab: () => switchView('tab2'),
    sendToTray: () => mainWindow.hide(),
    restoreApp: () => {
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
        setTimeout(() => adjustViewBounds(), 100);
      }
    },
    quickSearch: () => {
      if (searchService) {
        searchService.searchSelectedText();
      }
    },
    customPrefixSearch: () => {
      if (searchService) {
        showPrefixSearchWindow();
      }
    }
  };

  for (const [key, shortcutData] of Object.entries(shortcuts)) {
    const shortcutKey = typeof shortcutData === 'object' ? shortcutData.key : shortcutData;
    const isEnabled = typeof shortcutData === 'object' ? shortcutData.enabled === true : false;

    if (isEnabled && shortcutKey && shortcutActions[key]) {
      try {
        globalShortcut.register(shortcutKey, shortcutActions[key]);
      } catch (error) {
        console.error(`Failed to register shortcut for ${key}:`, error);
      }
    }
  }
  shortcutsRegistered = true;
}

/**
 * Gets selected text directly from X11 selections
 * Uses xclip to access both primary (mouse) and clipboard selections
 * @returns {Promise<string>} The selected text or empty string if no selection
 */
function getX11SelectionText() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    
    // Try primary selection first (mouse selection)
    exec('xclip -o -selection primary 2>/dev/null', { timeout: 1000 }, (primaryError, primaryText) => {
      if (!primaryError && primaryText && primaryText.trim()) {
        console.log('Got text from primary selection');
        resolve(primaryText.trim());
      } else {
        // Fall back to clipboard selection
        exec('xclip -o -selection clipboard 2>/dev/null', { timeout: 1000 }, (clipboardError, clipboardText) => {
          if (!clipboardError && clipboardText && clipboardText.trim()) {
            console.log('Got text from clipboard selection');
            resolve(clipboardText.trim());
          } else {
            // Last resort: Use the existing clipboard content
            const clipboardContent = clipboard.readText().trim();
            console.log('Using clipboard content as fallback', clipboardContent ? 'has content' : 'is empty');
            resolve(clipboardContent);
          }
        });
      }
    });
  });
}

function showPrefixSearchWindow() {
  originalClipboardContent = clipboard.readText();
  
  if (isLinux) {
    getX11SelectionText().then((selectedText) => {
      if (!selectedText) {
        const notification = new Notification({
          title: 'No text selected',
          body: 'Please select text before searching or install xclip: sudo pacman -S xclip'
        });
        notification.show();
        
        clipboard.writeText(originalClipboardContent);
        return;
      }
      
      createPrefixSearchWindow(selectedText);
    });
    return;
  }
  
  clipboard.writeText('');
  
  searchService.copySelectedText().then(() => {
    setTimeout(() => {
      const selectedText = clipboard.readText().trim();
      
      if (!selectedText) {
        const notification = new Notification({
          title: 'No text selected',
          body: 'Please select text before searching.'
        });
        notification.show();
        
        clipboard.writeText(originalClipboardContent);
        return;
      }
      
      createPrefixSearchWindow(selectedText);
    }, 400);
  });
}

/**
 * Creates and displays the prefix search window with the selected text
 * Extracted to a separate function for better code organization
 * @param {string} selectedText - The text that was selected by the user
 */
function createPrefixSearchWindow(selectedText) {
  if (!prefixSearchWindow || prefixSearchWindow.isDestroyed()) {
    const windowPosition = calculatePrefixWindowPosition();
    
    prefixSearchWindow = new BrowserWindow({
      width: 560,
      height: 420,
      x: windowPosition.x,
      y: windowPosition.y,
      frame: false,
      resizable: false,
      transparent: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'src', 'js', 'preload', 'preload_prefix.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, 
        devTools: false, 
        offscreen: false,
        disableBlinkFeatures: 'Accelerated2dCanvas,AcceleratedSmil'
      }
    });
    
    prefixSearchWindow.loadFile('prefix-search.html', { cache: false });
    
    prefixSearchWindow.once('ready-to-show', () => {
      prefixSearchWindow.webContents.send('set-selected-text', selectedText);
      prefixSearchWindow.show();
      prefixSearchWindow.focus();
    });
    
    prefixSearchWindow.on('blur', () => {
      if (prefixSearchWindow && !prefixSearchWindow.isDestroyed()) {
        prefixSearchWindow.close();
        
        setTimeout(() => {
          clipboard.writeText(originalClipboardContent);
        }, 500);
      }
    });
    
    prefixSearchWindow.on('closed', () => {
      setTimeout(() => {
        if (clipboard.readText() !== originalClipboardContent) {
          clipboard.writeText(originalClipboardContent);
        }
      }, 200);
    });
  } else {
    prefixSearchWindow.webContents.send('set-selected-text', selectedText);
    prefixSearchWindow.show();
    prefixSearchWindow.focus();
  }
}

function calculatePrefixWindowPosition() {
  const screenBounds = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const windowBounds = mainWindow ? mainWindow.getBounds() : { x: 0, y: 0, width: 800, height: 600 };
  
  return {
    x: Math.min(Math.max(windowBounds.x + windowBounds.width / 2 - 180, 0), screenBounds.width - 360),
    y: Math.min(Math.max(windowBounds.y + windowBounds.height / 2 - 230, 0), screenBounds.height - 460)
  };
}

function startLayoutChecks() {
  if (layoutCheckInterval) {
    clearInterval(layoutCheckInterval);
  }
  
  layoutCheckInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isMinimized() && mainWindow.isVisible()) {
      adjustViewBounds();
    }
  }, 120000); // Once every 2 minutes instead of every minute for better performance
}

function configureAppForBetterPerformance() {
  const disableHardwareAcceleration = settings.get('disableHardwareAcceleration', false);
  
  if (disableHardwareAcceleration) {
    app.disableHardwareAcceleration();
  }
  
  // No other Chromium switches on purpose. The old set cost more than it saved:
  // disable-gpu-compositing put every frame on the CPU (getGPUFeatureStatus
  // reported gpu_compositing "disabled_software"), num-raster-threads=1
  // serialised painting, disable-smooth-scrolling made wheel scrolling step, and
  // --max-old-space-size=256 capped the Perplexity page at a 280 MB heap, a
  // ceiling a long session plus a large paste can reach.
}

function createWindow() {
  let mainWindowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800
  });

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    show: !launchedHidden, // Don't show if launched with --hidden flag
    webPreferences: {
      preload: path.join(__dirname, 'src', 'js', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      disableBlinkFeatures: 'Accelerated2dCanvas,AcceleratedSmil',
      enableBlinkFeatures: 'PaintHolding',
      backgroundThrottling: true
    },
    // macOS: the tab bar sits in the title bar, beside the traffic lights, on
    // the system's own translucent material (the page background is transparent).
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 15 }, vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
      : { backgroundColor: '#FFFFFF' }),
    autoHideMenuBar: true
  });

  mainWindowState.manage(mainWindow);

  const sendFullScreen = () => mainWindow.webContents.send('fullscreen-changed', mainWindow.isFullScreen());
  mainWindow.on('enter-full-screen', sendFullScreen);
  mainWindow.on('leave-full-screen', sendFullScreen);

  // Application menu with Find and Zoom accelerators (menu bar hidden, accelerators still work).
  // Cmd+Q, Cmd+W and Cmd+M only exist on macOS when a menu item carries them, so the app and
  // window menus are needed, not decorative. They also hold what the removed sidebar offered.
  const settingsItems = [
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => { detachAllShortcuts(); openSettingsWindow(); } }
  ];
  // Close Tab acts on whichever window has focus, so Cmd+W in Settings closes Settings, not a tab.
  const tabItems = [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => switchView(nextTabId()) },
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: (item, focusedWindow) => {
        if (!focusedWindow || focusedWindow === mainWindow) closeTab(activeTabId);
        else focusedWindow.close();
      }
    }
  ];
  const appMenu = Menu.buildFromTemplate([
    ...(isMac ? [{
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_DISPLAY_NAME}` },
        { type: 'separator' },
        ...settingsItems,
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_DISPLAY_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_DISPLAY_NAME}` }
      ]
    }, {
      label: 'File',
      submenu: [...tabItems, { type: 'separator' }, { role: 'close', accelerator: 'Command+Shift+W' }]
    }] : [{
      label: 'File',
      submenu: [...tabItems, { type: 'separator' }, ...settingsItems, { type: 'separator' }, { role: 'quit' }]
    }]),
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('toggle-find-bar');
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Reload keeps the open thread; it is the way out when Perplexity's page gets stuck.
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => {
          const view = views[activeTabId] || currentView;
          if (view && !view.webContents.isDestroyed()) view.webContents.reload();
        } },
        // No accelerator: refresh goes back to the tab's home and drops the open thread.
        { label: 'Go to Home', click: () => switchView('refresh') },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            if (currentView) {
              const current = currentView.webContents.getZoomLevel();
              currentView.webContents.setZoomLevel(current + 0.5);
            }
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (currentView) {
              const current = currentView.webContents.getZoomLevel();
              currentView.webContents.setZoomLevel(current - 0.5);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (currentView) {
              currentView.webContents.setZoomLevel(0);
            }
          }
        }
      ]
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: 'Control+Tab', click: () => selectTabOffset(1) },
        { label: 'Show Previous Tab', accelerator: 'Control+Shift+Tab', click: () => selectTabOffset(-1) },
        // Cmd+1..8 pick that tab, Cmd+9 the last one, as in Safari.
        ...Array.from({ length: 9 }, (_, i) => ({
          label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          visible: false,
          click: () => { const id = i === 8 ? tabOrder[tabOrder.length - 1] : tabOrder[i]; if (id) switchView(id); }
        })),
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])
      ]
    },
    { role: 'help', submenu: [{ label: 'Buy me a Coffee', click: () => switchView('https://donate.inulute.com') }] }
  ]);
  Menu.setApplicationMenu(appMenu);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile('index.html').catch(console.error);

  mainWindow.webContents.on('did-finish-load', () => {
    if (!launchedHidden) {
      mainWindow.show();
    }
    registerShortcuts();
    loadDefaultAI();
    
    configureAutoStart(autoStartEnabled);
  });

  let resizeTimeout = null;
  mainWindow.on('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => adjustViewBounds(), 200);
  });

  mainWindow.on('focus', () => {
    setTimeout(() => adjustViewBounds(), 200);
    if (!settingsWindow) {
      reattachShortcuts();
    }
  });

  mainWindow.on('restore', () => {
    setTimeout(() => adjustViewBounds(), 200);
    if (!settingsWindow) {
      reattachShortcuts();
    }
  });

  mainWindow.on('show', () => {
    setTimeout(() => adjustViewBounds(), 200);
    startLayoutChecks();
    if (!settingsWindow) {
      reattachShortcuts();
    }
    // Toggling the window from a hotkey is the case in #46: the app reappears
    // and the caret should be ready to type, not on the main window's renderer.
    if (!settingsWindow) setTimeout(focusComposer, 250);
  });

  mainWindow.on('blur', () => {
    detachAllShortcuts();
  });

  mainWindow.on('minimize', () => {
    detachAllShortcuts();
  });

  mainWindow.on('hide', () => {
    detachAllShortcuts();
  });

  mainWindow.on('close', (event) => {
    if (app.isQuitting) {
      return;
    }

    const closeToTray = settings.get('closeToTray', true);

    if (closeToTray) {
      event.preventDefault();
      mainWindow.hide();

      if (!settings.get('hasShownTrayNotification', false)) {
        const notification = new Notification({
          title: APP_DISPLAY_NAME,
          body: 'Application is now running in the system tray'
        });
        notification.show();
        settings.set('hasShownTrayNotification', true);
      }
    } else {
      app.isQuitting = true;
    }
  });
  
  
  searchService = new SearchService(mainWindow, switchView);
  
  setInterval(() => cleanupUnusedResources(), 300000); // Every 5 minutes
}

app.on('before-quit', () => {
  app.isQuitting = true;
  if (layoutCheckInterval) {
    clearInterval(layoutCheckInterval);
  }
});

// `defaultAI` now stores a tab id rather than a URL. Older installs may hold a
// URL, including the dead labs.perplexity.ai destination (it 301s to
// playground.perplexity.ai and then to the generic www.perplexity.ai homepage),
// so map any legacy value onto a real tab and persist the migration.
function normalizeDefaultAI(value) {
  // Settings only offers these two; tabs opened later are not a launch choice.
  if (value === 'tab1' || value === 'tab2') return value;

  if (typeof value === 'string' && value.includes('labs.perplexity.ai')) {
    settings.set('defaultAI', DEFAULT_TAB_ID);
    return DEFAULT_TAB_ID;
  }

  if (typeof value === 'string' && value.startsWith('http')) {
    settings.set('defaultAI', DEFAULT_TAB_ID);
    return DEFAULT_TAB_ID;
  }

  return DEFAULT_TAB_ID;
}

// Restores the tab list, but only the tab being shown loads a page. The rest
// get their BrowserView when first selected, so ten restored tabs do not mean
// ten Perplexity renderers in memory.
function loadDefaultAI() {
  const saved = settings.get('restoreLastSession', true) === true ? settings.get('tabOrder', []) : [];
  const restored = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string' && TAB_ID_PATTERN.test(id)) : [];
  // A search from the command line or a second instance can open a tab before
  // this runs; keep it, and keep it in front.
  const openedEarly = [...tabOrder];
  tabOrder = [...new Set([...restored, ...openedEarly])];
  const titles = settings.get('tabTitles', {});
  tabOrder.forEach((id) => {
    if (!tabMeta[id]) tabMeta[id] = { title: typeof titles[id] === 'string' ? titles[id] : '' };
  });
  persistTabs();
  if (openedEarly.length) {
    sendTabs();
    return;
  }

  const preferred = normalizeDefaultAI(settings.get('defaultAI', DEFAULT_TAB_ID));
  switchView(tabOrder.includes(preferred) || !tabOrder.length ? preferred : tabOrder[0]);
}

function nextTabId() {
  let n = 1;
  while (tabOrder.includes(`tab${n}`)) n++;
  return `tab${n}`;
}

function selectTabOffset(offset) {
  if (tabOrder.length < 2) return;
  const index = tabOrder.indexOf(activeTabId);
  switchView(tabOrder[(index + offset + tabOrder.length) % tabOrder.length]);
}

function persistTabs() {
  settings.set('tabOrder', tabOrder);
}

function sendTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-changed', {
    activeId: activeTabId,
    // `asleep`: unloaded to save memory; the tab bar shows it dimmed with a moon.
    tabs: tabOrder.map((id) => ({ id, ...tabMeta[id], asleep: id in discardedUrls }))
  });
}

function updateTabMeta(tabId, changes) {
  if (!tabMeta[tabId]) return;
  Object.assign(tabMeta[tabId], changes);
  if (typeof changes.title === 'string' && changes.title) {
    const titles = settings.get('tabTitles', {});
    if (titles[tabId] !== changes.title) {
      titles[tabId] = changes.title;
      settings.set('tabTitles', titles);
    }
  }
  sendTabs();
}

// Closing the last tab closes the window instead, which hides to the tray or
// quits per the existing closeToTray setting -- the same thing Safari does.
function closeTab(tabId) {
  const index = tabOrder.indexOf(tabId);
  if (index === -1) return;
  if (tabOrder.length === 1) {
    mainWindow.close();
    return;
  }

  tabOrder.splice(index, 1);
  persistTabs();
  for (const key of ['tabUrls', 'tabTitles']) {
    const stored = settings.get(key, {});
    delete stored[tabId];
    settings.set(key, stored);
  }

  const view = views[tabId];
  delete views[tabId];
  delete tabMeta[tabId];
  delete tabLastShown[tabId];
  delete discardedUrls[tabId];
  if (tabId === activeTabId) switchView(tabOrder[Math.min(index, tabOrder.length - 1)]);
  if (view) {
    mainWindow.removeBrowserView(view);
    view.webContents.close();
  }
  sendTabs();
}

function adjustViewBounds() {
  if (currentView && mainWindow) {
    const bounds = mainWindow.getContentBounds();
    const findBarHeight = findBarOpen ? 36 : 0;
    const top = TAB_BAR_HEIGHT + findBarHeight;

    const viewWidth = Math.max(bounds.width, 500);
    const viewHeight = Math.max(bounds.height - top, 400);

    currentView.setBounds({
      x: 0,
      y: top,
      width: viewWidth,
      height: viewHeight,
    });

    if (process.platform === 'win32' && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.webContents.invalidate();
    }
  }
}

// Each tab remembers the page it was last on, so reopening the app puts you
// back where you left off instead of dropping you on whatever perplexity.ai
// happens to land on that week. Only perplexity.ai pages are restored, so a
// stale or hostile stored value cannot send a tab somewhere unexpected.
function isRestorableUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'perplexity.ai' || host.endsWith('.perplexity.ai');
  } catch {
    return false;
  }
}

function rememberTabUrl(tabId, url) {
  if (!isTabId(tabId) || !isRestorableUrl(url)) return;
  const stored = settings.get('tabUrls', {});
  if (stored[tabId] === url) return;
  stored[tabId] = url;
  settings.set('tabUrls', stored);
}

function restoredTabUrl(tabId) {
  if (settings.get('restoreLastSession', true) !== true) return tabHome(tabId);
  const stored = settings.get('tabUrls', {});
  return isRestorableUrl(stored[tabId]) ? stored[tabId] : tabHome(tabId);
}

// Issue #46: every focus() call in this file targets mainWindow, whose own
// renderer only holds the tab bar and find bar, so opening the app parked the
// caret there and Tab could not reach the page. Focus the BrowserView and put
// the caret in the composer instead. Selectors are tried in order because
// Perplexity's markup changes; if none match we still leave focus on the page,
// which is already the improvement being asked for.
function focusComposer() {
  const view = views[activeTabId] || currentView;
  if (!view || view.webContents.isDestroyed()) return;

  view.webContents.focus();
  view.webContents.executeJavaScript(`
    (function focusComposer() {
      const selectors = [
        'textarea:not([readonly]):not([disabled])',
        'div[contenteditable="true"]',
        'input[type="search"]:not([readonly]):not([disabled])'
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.focus();
            if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
              el.setSelectionRange(el.value.length, el.value.length);
            }
            return true;
          }
        }
      }
      return false;
    })();
  `).catch(() => {});
}

// Styling layered onto Perplexity's page with insertCSS, so its React tree is
// never edited: the app's glyph replaces Perplexity's logo in the sidebar, and
// the Computer row is hidden unless Settings asks for it. The glyph is a mask
// filled with the text colour, so it has no tile and follows light and dark.
let appGlyphDataUrl = null;
function pageCSS() {
  appGlyphDataUrl = appGlyphDataUrl || nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icons', 'png', 'glyph.png'))
    .toDataURL();
  const logo = 'nav[class*="group/sidebar"] a[href="/"]:not([aria-label])';
  let css = `${logo} { position: relative; }
    ${logo} > * { visibility: hidden; }
    ${logo}::after { content: ""; position: absolute; inset: 0; background: currentColor;
      -webkit-mask: url("${appGlyphDataUrl}") center / 24px no-repeat; pointer-events: none; }`;
  if (!settings.get('showSidebarComputer', false)) {
    css += '\nnav [class*="collapsible-sidebar-section"]:has(a[href^="/computer/tasks"]) { display: none !important; }';
  }
  if (!settings.get('showSidebarAutomations', false)) {
    css += '\nnav [class*="collapsible-sidebar-section"]:has(a[href^="/computer/automations"]) { display: none !important; }';
  }
  const financeTabs = settings.get('financeTabs', FINANCE_TABS);
  for (const id of FINANCE_TABS.filter((tab) => !financeTabs.includes(tab))) {
    css += `\n[role="tablist"][aria-label="Finance sections"] > [role="tab"][id$="-trigger-${id}"] { display: none !important; }`;
  }
  // preload_inject.js marks the block; it has no stable hook of its own.
  if (!settings.get('showMarketSummary', false)) {
    css += '\n[data-simplex-market-summary] { display: none !important; }';
  }
  return css;
}

async function applyPageCSS(contents) {
  if (!contents || contents.isDestroyed()) return;
  try {
    if (contents.simplexCssKey) await contents.removeInsertedCSS(contents.simplexCssKey);
    contents.simplexCssKey = await contents.insertCSS(pageCSS());
  } catch (err) {
    console.error('Could not style the Perplexity page:', err);
  }
}

// Notifications are kept referenced until handled; one collected early never fires 'click'.
const shownNotifications = new Set();
function notifyAnswerReady(webContentsId) {
  if (!settings.get('notifyAnswers', true) || !Notification.isSupported()) return;
  const tabId = Object.keys(views).find((id) => !views[id].webContents.isDestroyed() && views[id].webContents.id === webContentsId);
  if (!tabId || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFocused() && tabId === activeTabId) return;

  const notification = new Notification({ title: (tabMeta[tabId] && tabMeta[tabId].title) || 'Perplexity', body: 'Answer ready' });
  shownNotifications.add(notification);
  const release = () => shownNotifications.delete(notification);
  notification.on('click', () => {
    release();
    mainWindow.show();
    mainWindow.focus();
    switchView(tabId);
  });
  notification.on('close', release);
  notification.show();
}

function isCtrlEnterToSendEnabled() {
  return settings.get('ctrlEnterToSend', false);
}

// Accepts a tab id ('tab<n>'), 'refresh', 'search:<query>', or a plain URL.
// A tab id selects that tab, opening it if it is not open yet; anything that navigates
// (quick search, the donate link) is loaded into whichever tab is active, the
// same way a browser opens a link in the current tab.
function switchView(target) {
  if (target === 'refresh') {
    const activeView = views[activeTabId] || currentView;
    if (activeView) {
      const home = tabHome(activeTabId);
      console.log(`Refreshing ${activeTabId} to base URL: ${home}`);
      activeView.webContents.loadURL(home);
    }
    return;
  }

  let tabId;
  let navigateTo = null;

  if (typeof target === 'string' && TAB_ID_PATTERN.test(target)) {
    tabId = target;
  } else if (typeof target === 'string' && target.startsWith('search:')) {
    const searchQuery = target.substring(7).trim();
    tabId = activeTabId;
    navigateTo = searchQuery
      ? `https://www.perplexity.ai/search?q=${encodeURIComponent(searchQuery)}`
      : tabHome(tabId);
  } else if (typeof target === 'string' && target.startsWith('http')) {
    tabId = activeTabId;
    navigateTo = target;
  } else {
    tabId = DEFAULT_TAB_ID;
  }

  const url = navigateTo || (isRestorableUrl(discardedUrls[tabId]) ? discardedUrls[tabId] : restoredTabUrl(tabId));
  delete discardedUrls[tabId];
  // Both the tab being left and the one being shown are "seen" now.
  if (views[activeTabId]) tabLastShown[activeTabId] = Date.now();
  tabLastShown[tabId] = Date.now();

  if (currentView) {
    mainWindow.removeBrowserView(currentView);
  }

  if (!tabOrder.includes(tabId)) {
    tabOrder.push(tabId);
    persistTabs();
  }
  if (!tabMeta[tabId]) tabMeta[tabId] = { title: '' };

  // No eviction here. `views` holds only the open tabs; closeTab() is the one
  // place a view is destroyed.
  if (views[tabId]) {
    currentView = views[tabId];
    activeTabId = tabId;
    if (navigateTo) {
      currentView.webContents.loadURL(navigateTo);
    }
  } else {
    currentView = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'src', 'js', 'preload', 'preload_inject.js'),
        backgroundThrottling: true,
        worldSafeExecuteJavaScript: true,
        sandbox: false,
        spellcheck: true,
        webgl: true,
        enableWebSQL: false,
        enableBlinkFeatures: 'PaintHolding',
      },
    });

    if (currentView.webContents.setBackgroundThrottling) {
      currentView.webContents.setBackgroundThrottling(true);
    }

    currentView.webContents.loadURL(url);
    views[tabId] = currentView;
    activeTabId = tabId;

    const trackedTabId = tabId;
    // Events can still arrive from a view closeTab() just closed, and its id may
    // already belong to a new tab, so each handler checks the view is still that tab's.
    const isLive = () => views[trackedTabId] === viewRef;
    // viewRef, not currentView: a background tab navigating must record its own URL.
    const track = () => { if (isLive()) rememberTabUrl(trackedTabId, viewRef.webContents.getURL()); };
    currentView.webContents.on('did-navigate', track);
    currentView.webContents.on('did-navigate-in-page', track);

    currentView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // Context menu with spell check, copy link, and standard editing
    const viewRef = currentView;
    viewRef.webContents.on('context-menu', (event, params) => {
      const menuItems = [];

      // Spell check suggestions first (most actionable)
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions) {
          menuItems.push({
            label: suggestion,
            click: () => viewRef.webContents.replaceMisspelling(suggestion)
          });
        }
        menuItems.push({ type: 'separator' });
      }

      if (params.misspelledWord) {
        menuItems.push({
          label: 'Add to dictionary',
          click: () => viewRef.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        });
        menuItems.push({ type: 'separator' });
      }

      // Only show editing options that are actually available
      if (params.editFlags.canCut) {
        menuItems.push({ label: 'Cut', role: 'cut' });
      }
      if (params.selectionText.trim().length > 0) {
        menuItems.push({ label: 'Copy', role: 'copy' });
      }
      if (params.editFlags.canPaste) {
        menuItems.push({ label: 'Paste', role: 'paste' });
      }
      if (params.editFlags.canSelectAll) {
        menuItems.push({ label: 'Select All', role: 'selectAll' });
      }

      // Copy Link (only visible when right-clicking a link)
      if (params.linkURL) {
        if (menuItems.length > 0) {
          menuItems.push({ type: 'separator' });
        }
        menuItems.push({
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL)
        });
      }

      if (menuItems.length > 0) {
        const menu = Menu.buildFromTemplate(menuItems);
        menu.popup(mainWindow);
      }
    });

    // Forward find-in-page results to the main window renderer
    viewRef.webContents.on('found-in-page', (event, result) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('find-result', {
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches
        });
      }
    });

    // Intercept keyboard shortcuts at the BrowserView level before the website can handle them
    let sendingEnter = false;
    viewRef.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;

      const key = input.key.toLowerCase();

      // Ctrl+Enter to Send: block plain Enter in textarea, allow Ctrl+Enter
      if (key === 'enter' && isCtrlEnterToSendEnabled() && !sendingEnter) {
        const mod = process.platform === 'darwin' ? input.meta : input.control;

        // Shift+Enter → allow default (newline)
        if (input.shift) {
          // let it through
        }
        // Ctrl/Cmd+Enter → submit by sending a clean Enter keypress
        else if (mod) {
          event.preventDefault();
          // Send a raw Enter key without modifiers so Perplexity sees a normal Enter (submit)
          sendingEnter = true;
          viewRef.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          viewRef.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          viewRef.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          sendingEnter = false;
        }
        // Plain Enter → block and insert newline
        else {
          event.preventDefault();
          viewRef.webContents.executeJavaScript(`
            (function() {
              const ta = document.activeElement;
              if (ta && ta.tagName === 'TEXTAREA') {
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                // Use native input setter to update React state
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeInputValueSetter.call(ta, ta.value.substring(0, start) + '\\n' + ta.value.substring(end));
                ta.selectionStart = ta.selectionEnd = start + 1;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `).catch(() => {});
        }
        return;
      }

      // Escape → close find bar if open
      if (key === 'escape' && findBarOpen) {
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-find-bar');
        }
        return;
      }

      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (!mod) return;

      // Ctrl/Cmd+F → toggle find bar
      if (key === 'f' && !input.alt && !input.shift) {
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-find-bar');
        }
        return;
      }

      // Ctrl/Cmd+= or Ctrl/Cmd+Shift+= → zoom in
      if (key === '=' || key === '+') {
        event.preventDefault();
        const current = viewRef.webContents.getZoomLevel();
        viewRef.webContents.setZoomLevel(current + 0.5);
        return;
      }

      // Ctrl/Cmd+- → zoom out
      if (key === '-') {
        event.preventDefault();
        const current = viewRef.webContents.getZoomLevel();
        viewRef.webContents.setZoomLevel(current - 0.5);
        return;
      }

      // Ctrl/Cmd+0 → reset zoom
      if (key === '0') {
        event.preventDefault();
        viewRef.webContents.setZoomLevel(0);
        return;
      }
    });

    const setMeta = (changes) => { if (isLive()) updateTabMeta(trackedTabId, changes); };
    // insertCSS lasts until the next full load, so apply it on every one.
    viewRef.webContents.on('dom-ready', () => { viewRef.webContents.simplexCssKey = null; applyPageCSS(viewRef.webContents); });
    viewRef.webContents.on('page-title-updated', (event, title) => setMeta({ title }));
    viewRef.webContents.on('page-favicon-updated', (event, favicons) => {
      // Perplexity's own pages carry the app's icon in the tab bar, like the Dock.
      let host = '';
      try { host = new URL(viewRef.webContents.getURL()).hostname; } catch {}
      setMeta({ favicon: host === 'perplexity.ai' || host.endsWith('.perplexity.ai') ? 'app' : favicons[0] });
    });
    viewRef.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
      if (isMainFrame && errorCode !== -3) setMeta({ error: errorDescription || 'Failed to load' });
    });

    viewRef.webContents.on('did-finish-load', () => {
      if (!isLive()) return;
      // The page owns focus from here; without this the main window's renderer keeps it.
      if (views[activeTabId] === viewRef) setTimeout(focusComposer, 150);

      viewRef.webContents.executeJavaScript(`
        (function removeNagScreens() {
          const nagScreenSelectors = [
            'div.max-w-\\\\[400px\\\\].rounded-xl',
            'div.rounded-lg.p-md.animate-in.fade-in',
            'div.flex.items-center.gap-sm',
          ];
          nagScreenSelectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => el.remove());
          });

          // Add CSS to optimize rendering performance
          const style = document.createElement('style');
          style.textContent = 'img { will-change: auto !important; } .will-change-transform { will-change: auto !important; }';
          document.head.appendChild(style);
        })();
      `);

    });

    viewRef.webContents.on('did-start-loading', () => setMeta({ loading: true, error: null }));
    viewRef.webContents.on('did-stop-loading', () => setMeta({ loading: false }));
  }

  mainWindow.addBrowserView(currentView);
  adjustViewBounds();
  sendTabs();
  // Switching tabs should hand the caret to the page you switched to. A new
  // view has not loaded yet, so did-finish-load covers that case instead.
  if (!currentView.webContents.isLoading()) setTimeout(focusComposer, 50);
}

// Every tab holds a whole Perplexity renderer (about 200 MB). A tab left in the
// background for DISCARD_AFTER_MS is unloaded and reloads its last URL when it is
// selected again, like Chrome's Memory Saver. Perplexity keeps composer drafts
// across reloads (seen while benchmarking), so what is lost is the scroll
// position. Tabs still loading or playing audio are left alone; an answer
// streaming over fetch does not count as loading, hence the long 30-minute wait. (An older version of this sweep destroyed every
// background view because the timestamp it checked was never set; tabLastShown is
// set on every switch.)
function cleanupUnusedResources() {
  if (!settings.get('discardTabs', true)) return;
  const now = Date.now();
  let discardedAny = false;
  for (const tabId of Object.keys(views)) {
    const contents = views[tabId].webContents;
    if (contents.isDestroyed()) {
      delete views[tabId];
      continue;
    }
    if (tabId === activeTabId || now - (tabLastShown[tabId] || now) < DISCARD_AFTER_MS) continue;
    if (contents.isLoading() || contents.isCurrentlyAudible()) continue;
    discardedUrls[tabId] = contents.getURL();
    delete views[tabId];
    contents.close();
    discardedAny = true;
  }
  if (discardedAny) sendTabs();
}

function createTray() {
  let iconPath;

  if (isWindows) {
    iconPath = path.join(__dirname, 'assets', 'icons', 'win', 'icon.ico');
  } else if (isMac) {
    // A template image: macOS tints it to match light and dark menu bars, and
    // nativeImage picks up trayTemplate@2x.png beside it on Retina displays.
    iconPath = path.join(__dirname, 'assets', 'icons', 'png', 'trayTemplate.png');
  } else {
    iconPath = path.join(__dirname, 'assets', 'icons', 'png', 'favicon.png');
  }

  if (!fs.existsSync(iconPath)) {
    console.error(`Tray icon not found at path: ${iconPath}`);
    return;
  }

  try {
    const trayIcon = isMac ? nativeImage.createFromPath(iconPath) : iconPath;

    tray = new Tray(trayIcon);
    tray.setToolTip(APP_DISPLAY_NAME);

    const contextMenu = Menu.buildFromTemplate([
      { 
        label: 'Quick Search', 
        click: () => {
          if (searchService) {
            searchService.searchSelectedText();
          }
        }
      },
      { 
        label: 'Show App', 
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            setTimeout(() => adjustViewBounds(), 100);
          }
        } 
      },
      { type: 'separator' },
      {
        label: 'Disable Hardware Acceleration',
        type: 'checkbox',
        checked: settings.get('disableHardwareAcceleration', false),
        click: (menuItem) => {
          settings.set('disableHardwareAcceleration', menuItem.checked);
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Restart Required',
            message: 'Please restart the application for this change to take effect.',
            buttons: ['OK']
          });
        }
      },
      { type: 'separator' },
      { 
        label: 'Quit', 
        click: () => {
          app.isQuitting = true;
          app.quit();
        } 
      }
    ]);
    
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
      if (mainWindow && (mainWindow.isMinimized() || !mainWindow.isVisible())) {
        mainWindow.show();
        setTimeout(() => adjustViewBounds(), 100);
      }
      mainWindow?.focus();
    });

  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function detachAllShortcuts() {
  if (shortcutsRegistered) {
    globalShortcut.unregisterAll();
    shortcutsRegistered = false;
  }
}

function reattachShortcuts() {
  if (!shortcutsRegistered) {
    registerShortcuts();
  }
}

app.on('second-instance', (event, commandLine, workingDirectory) => {
  console.log('Second instance detected with args:', commandLine);
  
  const searchInfo = processCommandLineArgs(commandLine);
  
  if (searchInfo) {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      
      setTimeout(() => adjustViewBounds(), 100);
    }
    
    setTimeout(() => {
      switchView(searchInfo.searchUrl);
    }, 100);
  } else {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      
      setTimeout(() => adjustViewBounds(), 100);
    }
  }
});

ipcMain.on('get-shortcuts', (event) => {
  event.sender.send('shortcuts', shortcuts);
});

ipcMain.on('set-shortcuts', (event, newShortcuts) => {
  shortcuts = newShortcuts;
  settings.set('shortcuts', shortcuts);
  reattachShortcuts();
});

ipcMain.on('open-settings', () => {
  detachAllShortcuts();
  openSettingsWindow();
});

ipcMain.on('close-settings', () => {
  if (settingsWindow) {
    settingsWindow.hide();
    
    const windowToClose = settingsWindow;
    settingsWindow = null;
    
    setTimeout(() => {
      if (!windowToClose.isDestroyed()) {
        windowToClose.close();
      }
      reattachShortcuts();
    }, 100);
  }
});

ipcMain.on('set-settings', (event, data) => {
  if (data.shortcuts) {
    shortcuts = data.shortcuts;
    settings.set('shortcuts', shortcuts);
  }
  
  if (data.defaultAI) {
    settings.set('defaultAI', data.defaultAI);
  }
  
  if (data.disableHardwareAcceleration !== undefined) {
    settings.set('disableHardwareAcceleration', data.disableHardwareAcceleration);
  }
  
  if (data.autoStartEnabled !== undefined) {
    configureAutoStart(data.autoStartEnabled);
  }

  if (data.restoreLastSession !== undefined) {
    settings.set('restoreLastSession', data.restoreLastSession);
  }

  if (Array.isArray(data.sidebarShortcuts)) {
    settings.set('sidebarShortcuts', data.sidebarShortcuts);
    broadcastSidebarShortcuts();
  }

  // These only change the page stylesheet, so re-apply it to every tab.
  let restyle = false;
  for (const key of ['showSidebarComputer', 'showSidebarAutomations', 'showMarketSummary']) {
    if (data[key] !== undefined && data[key] !== settings.get(key, false)) {
      settings.set(key, data[key] === true);
      restyle = true;
    }
  }
  if (Array.isArray(data.financeTabs)) {
    const tabs = FINANCE_TABS.filter((id) => data.financeTabs.includes(id));
    if (tabs.join() !== settings.get('financeTabs', FINANCE_TABS).join()) {
      settings.set('financeTabs', tabs);
      restyle = true;
    }
  }
  if (restyle) Object.values(views).forEach((view) => applyPageCSS(view.webContents));

  if (data.closeToTray !== undefined) {
    settings.set('closeToTray', data.closeToTray);
  }

  if (data.ctrlEnterToSend !== undefined) {
    settings.set('ctrlEnterToSend', data.ctrlEnterToSend);
  }

  if (data.notifyAnswers !== undefined) {
    settings.set('notifyAnswers', data.notifyAnswers === true);
  }

  if (data.discardTabs !== undefined) {
    settings.set('discardTabs', data.discardTabs === true);
  }

  reattachShortcuts();
});

// The sidebar injector in preload_inject.js asks for this on every page load.
ipcMain.handle('get-sidebar-shortcuts', () => settings.get('sidebarShortcuts', DEFAULT_SIDEBAR_SHORTCUTS));

function broadcastSidebarShortcuts() {
  const ids = settings.get('sidebarShortcuts', DEFAULT_SIDEBAR_SHORTCUTS);
  Object.values(views).forEach((view) => {
    if (view && view.webContents && !view.webContents.isDestroyed()) {
      view.webContents.send('sidebar-shortcuts-changed', ids);
    }
  });
}

ipcMain.on('get-settings', (event) => {
  const data = {
    shortcuts,
    defaultAI: normalizeDefaultAI(settings.get('defaultAI', DEFAULT_TAB_ID)),
    disableHardwareAcceleration: settings.get('disableHardwareAcceleration', false),
    autoStartEnabled: autoStartEnabled,
    closeToTray: settings.get('closeToTray', true),
    restoreLastSession: settings.get('restoreLastSession', true),
    sidebarShortcuts: settings.get('sidebarShortcuts', DEFAULT_SIDEBAR_SHORTCUTS),
    showSidebarComputer: settings.get('showSidebarComputer', false),
    showSidebarAutomations: settings.get('showSidebarAutomations', false),
    financeTabs: settings.get('financeTabs', FINANCE_TABS),
    showMarketSummary: settings.get('showMarketSummary', false),
    defaultShortcuts,
    ctrlEnterToSend: settings.get('ctrlEnterToSend', false),
    discardTabs: settings.get('discardTabs', true),
    notifyAnswers: settings.get('notifyAnswers', true)
  };
  event.sender.send('settings', data);
});

ipcMain.on('toggle-autostart', (event, enable) => {
  const success = configureAutoStart(enable);
  event.sender.send('autostart-status', { enabled: enable, success });
});

ipcMain.handle('get-autostart-status', () => {
  return autoStartEnabled;
});

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});


ipcMain.on('open-external-link', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url).catch(err => {
      console.error('Failed to open external link:', err);
    });
  } else {
    console.error('Invalid URL format:', url);
  }
});

ipcMain.on('perform-prefix-search', (event, data) => {
  if (prefixSearchWindow && !prefixSearchWindow.isDestroyed()) {
    prefixSearchWindow.close();
  }
  
  if (searchService) {
    const { text, prefix } = data;
    searchService.performSearch(text, prefix);
    
    if (mainWindow && (mainWindow.isMinimized() || !mainWindow.isVisible())) {
      mainWindow.show();
      mainWindow.focus();
      setTimeout(() => adjustViewBounds(), 100);
    }
    
    setTimeout(() => {
      clipboard.writeText(originalClipboardContent);
    }, 1000);
  }
});

ipcMain.on('close-prefix-search', () => {
  if (prefixSearchWindow && !prefixSearchWindow.isDestroyed()) {
    prefixSearchWindow.close();
    
    setTimeout(() => {
      clipboard.writeText(originalClipboardContent);
    }, 500);
  }
});

ipcMain.on('perform-quick-search', (event, searchText) => {
  if (searchService) {
    searchService.performSearch(searchText);
  }
});

// Tab bar
ipcMain.on('tab-select', (event, tabId) => { if (isTabId(tabId)) switchView(tabId); });
ipcMain.on('tab-close', (event, tabId) => { if (isTabId(tabId)) closeTab(tabId); });
ipcMain.on('tab-new', () => switchView(nextTabId()));

// Find bar state management
ipcMain.on('find-bar-opened', () => {
  findBarOpen = true;
  adjustViewBounds();
});

ipcMain.on('find-bar-closed', () => {
  findBarOpen = false;
  adjustViewBounds();
});

// Find in page
ipcMain.on('find-in-page', (event, text, options) => {
  if (currentView && text) {
    currentView.webContents.findInPage(text, {
      forward: options.forward !== false,
      matchCase: false
    });
  }
});

ipcMain.on('stop-find-in-page', (event, action) => {
  if (currentView) {
    currentView.webContents.stopFindInPage(action || 'clearSelection');
  }
});

ipcMain.on('get-shortcut-instructions', (event) => {
  try {
    const instructionsPath = path.join(__dirname, 'shortcut-instructions.md');
    if (fs.existsSync(instructionsPath)) {
      const markdown = fs.readFileSync(instructionsPath, 'utf8');
      const html = marked.parse(markdown);
      event.sender.send('shortcut-instructions', html);
    } else {
      event.sender.send('shortcut-instructions', 'Instructions file not found.');
    }
  } catch (error) {
    console.error('Error getting shortcut instructions:', error);
    event.sender.send('shortcut-instructions', 'Error loading instructions.');
  }
});

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 745,
    parent: mainWindow,
    modal: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'js', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      disableBlinkFeatures: 'Accelerated2dCanvas'
    },
    show: false,
    backgroundColor: '#2b2b2b',
    paintWhenInitiallyHidden: true
  });

  settingsWindow.loadFile('settings.html')
    .then(() => {
      settingsWindow.show();
    })
    .catch(console.error);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    reattachShortcuts();
  });
}

ipcMain.on('close-settings', () => {
  if (settingsWindow) {
    settingsWindow.hide();
    
    reattachShortcuts();
    
    // Close the window after a short delay
    setTimeout(() => {
      if (settingsWindow) {
        settingsWindow.close();
        settingsWindow = null;
      }
    }, 100);
  }
});

configureAppForBetterPerformance();

// The default user agent advertises "SimplexityAI/x" and "Electron/x" to every
// site; drop both so requests look like the Chrome build Electron ships.
app.userAgentFallback = app.userAgentFallback.replace(/ (SimplexityAI|Electron)\/\S+/g, '');

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });
  // Analytics and tracking the page sends on its own, none of which the app
  // needs (measured while logged in): Perplexity's usage events and its count
  // beacon (an iframe that also spawned its own renderer), Datadog session
  // recording, Singular ad attribution and Cloudflare's analytics beacon.
  // Perplexity's service worker is NOT blocked: it delivers notifications
  // (push -> showNotification) and serves cached assets, and blocking it broke both.
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: [
        '*://count.perplexity.ai/*',
        '*://r2cdn.perplexity.ai/js/count/*',
        '*://www.perplexity.ai/rest/event/analytics*',
        '*://browser-intake-datadoghq.com/*',
        '*://*.singular.net/*',
        '*://static.cloudflareinsights.com/*',
      ],
    },
    (_details, callback) => callback({ cancel: true })
  );

  // Electron has no Web Push service (subscribe fails with "push service not
  // available"), so Perplexity's own notifications never arrive here. Instead,
  // say so when an answer finishes while Simplex is not in front. The page closes
  // the answer stream itself after the last message, so it ends as ERR_ABORTED
  // (measured), not as a completed request: both endings count.
  const answerStream = { urls: ['*://www.perplexity.ai/rest/sse/perplexity_ask*'] };
  const answering = new Set();
  session.defaultSession.webRequest.onResponseStarted(answerStream, (details) => {
    if (details.statusCode === 200) answering.add(details.id);
  });
  const answerEnded = (details) => { if (answering.delete(details.id)) notifyAnswerReady(details.webContentsId); };

  // A long thread sometimes took 10-20 s to open for the user, but measured
  // runs never did (thread API 1.3-1.9 s, render under 2.5 s). Write down any
  // Perplexity API call slower than SLOW_REQUEST_MS, with how long since the
  // Mac last woke, so the next slow open shows where the time went. Electron
  // keeps one listener per event, so this shares onCompleted with the above.
  const SLOW_REQUEST_MS = 5000;
  const api = { urls: ['*://www.perplexity.ai/rest/*'] };
  const started = new Map();
  let resumedAt = 0;
  powerMonitor.on('resume', () => { resumedAt = Date.now(); });
  session.defaultSession.webRequest.onSendHeaders(api, (details) => { started.set(details.id, details.timestamp); });
  const apiEnded = (details) => {
    answerEnded(details);
    const start = started.get(details.id);
    started.delete(details.id);
    // The answer stream stays open while the answer is written; it is slow by design.
    if (!start || details.url.includes('/rest/sse/') || details.timestamp - start < SLOW_REQUEST_MS) return;
    const line = [new Date().toISOString(), `${Math.round(details.timestamp - start)}ms`,
      details.statusCode || details.error, details.fromCache ? 'cache' : 'net',
      resumedAt ? `woke ${Math.round((Date.now() - resumedAt) / 1000)}s ago` : 'no wake since launch',
      details.url.split('?')[0]].join('  ');
    fs.appendFile(path.join(app.getPath('userData'), 'slow-requests.log'), line + '\n', () => {});
  };
  session.defaultSession.webRequest.onCompleted(api, apiEnded);
  session.defaultSession.webRequest.onErrorOccurred(api, apiEnded);
  // A packaged build takes its Dock icon from the bundle's .icns, which macOS can
  // restyle; `npm start` runs the stock Electron.app, so show ours there too.
  if (isMac && !app.isPackaged) app.dock.setIcon(path.join(__dirname, 'assets', 'icons', 'png', 'favicon.png'));
  
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    const searchInfo = processCommandLineArgs(process.argv);
    
    createWindow();
    createTray();
    
    startLayoutChecks();
    
    if (searchInfo) {
      setTimeout(() => {
        switchView(searchInfo.searchUrl);
      }, 500);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        mainWindow.show();
        setTimeout(() => adjustViewBounds(), 100);
      }
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll(); // Unregister all shortcuts
});
