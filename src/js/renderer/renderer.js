// renderer.js

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('settings-container')) {
    const shortcutFields = {
      perplexityAI: document.getElementById('shortcut-perplexityAI'),
      secondTab: document.getElementById('shortcut-secondTab'),
      sendToTray: document.getElementById('shortcut-sendToTray'),
      restoreApp: document.getElementById('shortcut-restoreApp'),
      quickSearch: document.getElementById('shortcut-quickSearch'),
      customPrefixSearch: document.getElementById('shortcut-customPrefixSearch')
    };
    
    const shortcutToggles = {
      perplexityAI: document.getElementById('toggle-perplexityAI'),
      secondTab: document.getElementById('toggle-secondTab'),
      sendToTray: document.getElementById('toggle-sendToTray'),
      restoreApp: document.getElementById('toggle-restoreApp'),
      quickSearch: document.getElementById('toggle-quickSearch'),
      customPrefixSearch: document.getElementById('toggle-customPrefixSearch')
    };
    
    const defaultAISelect = document.getElementById('defaultAI');
    let newShortcuts = {};
    let savedShortcuts = {};
    const isMac = window.electronAPI.platform === 'darwin';

    function cleanupNumpadKeys(shortcut) {
      if (!shortcut) return '';
      
      const numpadMap = {
        'Numpad0': '0', 'Numpad1': '1', 'Numpad2': '2', 'Numpad3': '3', 'Numpad4': '4',
        'Numpad5': '5', 'Numpad6': '6', 'Numpad7': '7', 'Numpad8': '8', 'Numpad9': '9',
        'NumpadAdd': '+', 'NumpadSubtract': '-', 'NumpadMultiply': '*', 'NumpadDivide': '/',
        'NumpadDecimal': '.', 'NumpadEnter': 'Enter'
      };
      
      let cleanedShortcut = shortcut;
      Object.entries(numpadMap).forEach(([numpadKey, regularKey]) => {
        cleanedShortcut = cleanedShortcut.replace(new RegExp(numpadKey, 'g'), regularKey);
      });
      
      return cleanedShortcut;
    }

    for (const key in shortcutToggles) {
      if (shortcutToggles[key]) {
        shortcutToggles[key].addEventListener('change', (event) => {
          updateToggleState(key, event.target.checked);
        });
      }
    }
    
    function updateToggleState(key, isEnabled) {
      if (shortcutFields[key]) {
        shortcutFields[key].disabled = !isEnabled;
      }
      
      if (typeof newShortcuts[key] === 'object') {
        newShortcuts[key].enabled = isEnabled;
      } else if (newShortcuts[key]) {
        newShortcuts[key] = {
          key: newShortcuts[key],
          enabled: isEnabled
        };
      } else {
        // Main already resolved the platform when it built the table.
        const defaultKey = defaultShortcutKey(key);
        
        newShortcuts[key] = {
          key: defaultKey,
          enabled: isEnabled
        };
      }
    }

    function loadCurrentShortcuts() {
      for (const [key, input] of Object.entries(shortcutFields)) {
        if (!input) continue;
        
        const shortcutData = savedShortcuts[key];
        let shortcutKey, isEnabled;
        
        if (typeof shortcutData === 'object' && shortcutData !== null) {
          shortcutKey = shortcutData.key;
          isEnabled = shortcutData.enabled === true; 
        } else {
          shortcutKey = shortcutData;
          isEnabled = false; 
        }
        
        if (shortcutKey) {
          shortcutKey = cleanupNumpadKeys(shortcutKey);
          
          if (typeof savedShortcuts[key] === 'object') {
            savedShortcuts[key].key = shortcutKey;
            newShortcuts[key].key = shortcutKey;
          }
        }
        
        input.value = displayShortcut(shortcutKey);
        
        if (shortcutToggles[key]) {
          shortcutToggles[key].checked = isEnabled;
          updateToggleState(key, isEnabled);
        }
      }
    }

    window.electronAPI.getSettings();

    window.electronAPI.onSettingsReceived((data) => {
      if (!data) {
        console.error("Received invalid settings data");
        return;
      }
      
      const processedShortcuts = {};
      
      if (data.shortcuts) {
        for (const [key, value] of Object.entries(data.shortcuts)) {
          if (typeof value === 'string') {
            processedShortcuts[key] = {
              key: value,
              enabled: false 
            };
          } else {
            processedShortcuts[key] = value;
          }
        }
      }
      
      newShortcuts = { ...processedShortcuts };
      savedShortcuts = { ...processedShortcuts };
    
      if (data.defaultShortcuts) {
        window.__defaultShortcuts = data.defaultShortcuts;
      }

      loadCurrentShortcuts();
      
      if (defaultAISelect) {
        defaultAISelect.value = data.defaultAI || 'tab1';
      }
      
      const autostartToggle = document.getElementById('toggle-autostart');
      if (autostartToggle) {
        autostartToggle.checked = data.autoStartEnabled || false;

        autostartToggle.addEventListener('change', (event) => {
          window.electronAPI.toggleAutostart(event.target.checked);
        });
      }

      const restoreLastSessionToggle = document.getElementById('toggle-restoreLastSession');
      if (restoreLastSessionToggle) {
        restoreLastSessionToggle.checked = data.restoreLastSession !== false;
      }

      const chosenShortcuts = Array.isArray(data.sidebarShortcuts) ? data.sidebarShortcuts : [];
      document.querySelectorAll('.sidebar-shortcut').forEach((box) => {
        box.checked = chosenShortcuts.includes(box.value);
      });

      const closeToTrayToggle = document.getElementById('toggle-closeToTray');
      if (closeToTrayToggle) {
        closeToTrayToggle.checked = data.closeToTray !== false;
      }

      document.getElementById('toggle-discardTabs').checked = data.discardTabs !== false;
      document.getElementById('toggle-notifyAnswers').checked = data.notifyAnswers !== false;
      document.getElementById('toggle-showSidebarComputer').checked = data.showSidebarComputer === true;

      const ctrlEnterToSendToggle = document.getElementById('toggle-ctrlEnterToSend');
      if (ctrlEnterToSendToggle) {
        ctrlEnterToSendToggle.checked = data.ctrlEnterToSend || false;
      }
    });

    for (const [key, input] of Object.entries(shortcutFields)) {
      if (!input) continue; 
      
      input.addEventListener('focus', () => {
        input.classList.add('active');
      });

      input.addEventListener('blur', () => {
        input.classList.remove('active');
        checkForDuplicates();
      });

      input.addEventListener('keydown', (event) => {
        event.preventDefault();
        
        const toggle = shortcutToggles[key];
        if (toggle && !toggle.checked) {
          return;
        }

        if (event.code === 'NumLock' || event.code === 'CapsLock' || event.code === 'ScrollLock') {
          return;
        }

        let modifiers = [];
        if (isMac) {
          if (event.metaKey) modifiers.push('Cmd');
          if (event.altKey) modifiers.push('Alt');
          if (event.shiftKey) modifiers.push('Shift');
        } else {
          if (event.ctrlKey) modifiers.push('Ctrl');
          if (event.altKey) modifiers.push('Alt');
          if (event.shiftKey) modifiers.push('Shift');
        }

        const modifierKeyCodes = [
          'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'
        ];

        if (modifierKeyCodes.includes(event.code)) return;

        if (modifiers.length === 0) {
          alert('Shortcuts must include at least one modifier key (Ctrl or Cmd, Alt, Shift).');
          input.value = '';
          return;
        }

        let keyName;
        if (event.code.startsWith('Numpad')) {
          const numpadMap = {
            'Numpad0': '0', 'Numpad1': '1', 'Numpad2': '2', 'Numpad3': '3', 'Numpad4': '4',
            'Numpad5': '5', 'Numpad6': '6', 'Numpad7': '7', 'Numpad8': '8', 'Numpad9': '9',
            'NumpadAdd': '+', 'NumpadSubtract': '-', 'NumpadMultiply': '*', 'NumpadDivide': '/',
            'NumpadDecimal': '.', 'NumpadEnter': 'Enter'
          };
          keyName = numpadMap[event.code] || event.code;
        } else {
          keyName = event.code.startsWith('Key') ? event.code.slice(3).toUpperCase() : event.key;
        }
        
        const keyCombo = [...modifiers, keyName].join('+');
        input.value = displayShortcut(keyCombo);

        const normalizedKey = keyCombo
          .replace(/Cmd/g, 'Command')
          .replace(/Ctrl/g, 'Control');
          
        if (typeof newShortcuts[key] === 'object') {
          newShortcuts[key].key = normalizedKey;
        } else {
          newShortcuts[key] = {
            key: normalizedKey,
            enabled: true
          };
        }

        checkForDuplicates();
        saveSettings();
      });
    }

    const installContextMenuButton = document.getElementById('install-context-menu');
    if (installContextMenuButton) {
      installContextMenuButton.addEventListener('click', () => {
        window.electronAPI.installContextMenu();
      });
    }
    
    const instructionsButton = document.querySelector('.instructions-button');
    if (instructionsButton) {
      instructionsButton.addEventListener('click', () => {
        window.electronAPI.getShortcutInstructions();
        
        const instructionsContainer = document.getElementById('instructions-container');
        if (instructionsContainer) {
          instructionsContainer.style.display = 'block';
        }
      });
    }
    
    window.electronAPI.onShortcutInstructions((html) => {
      const instructionsContent = document.getElementById('instructions-content');
      if (instructionsContent) {
        instructionsContent.innerHTML = html;
        
        instructionsContent.addEventListener('click', (event) => {
          if (event.target.tagName === 'A' && event.target.href) {
            event.preventDefault(); 
            
            window.electronAPI.openExternalLink(event.target.href);
          }
        });
      }
    });

    document.getElementById('restore-button').addEventListener('click', () => {
      // Defaults come from the main process, which is the only place they are
      // defined. Keeping a second copy here is how the two drifted apart.
      const defaultShortcuts = window.__defaultShortcuts || {};

      newShortcuts = { ...defaultShortcuts };
      savedShortcuts = { ...defaultShortcuts };
      loadCurrentShortcuts();
      saveSettings();
    });

    // Every control applies as soon as it changes, like System Settings; there
    // is no Save button. Duplicate or empty shortcuts are not saved and show a
    // warning on their row instead.
    const settingsForm = document.getElementById('settings-form');
    settingsForm.addEventListener('submit', (event) => event.preventDefault());
    settingsForm.addEventListener('change', (event) => {
      if (event.target.id === 'toggle-autostart') return; // applied by its own handler
      saveSettings();
    });

    function saveSettings() {
      if (checkForDuplicates(true)) {
        const autostartToggle = document.getElementById('toggle-autostart');
        
        const restoreLastSessionToggle = document.getElementById('toggle-restoreLastSession');
        const closeToTrayToggle = document.getElementById('toggle-closeToTray');
        const ctrlEnterToSendToggle = document.getElementById('toggle-ctrlEnterToSend');

        const settingsToSave = {
          shortcuts: newShortcuts,
          defaultAI: defaultAISelect.value,
          disableHardwareAcceleration: document.getElementById('toggle-hardware-acceleration')
            ? document.getElementById('toggle-hardware-acceleration').checked
            : false,
          autoStartEnabled: autostartToggle ? autostartToggle.checked : false,
          restoreLastSession: restoreLastSessionToggle ? restoreLastSessionToggle.checked : true,
          sidebarShortcuts: [...document.querySelectorAll('.sidebar-shortcut')]
            .filter((box) => box.checked)
            .map((box) => box.value),
          closeToTray: closeToTrayToggle ? closeToTrayToggle.checked : true,
          discardTabs: document.getElementById('toggle-discardTabs').checked,
          notifyAnswers: document.getElementById('toggle-notifyAnswers').checked,
          showSidebarComputer: document.getElementById('toggle-showSidebarComputer').checked,
          ctrlEnterToSend: ctrlEnterToSendToggle ? ctrlEnterToSendToggle.checked : false
        };
        window.electronAPI.setSettings(settingsToSave);
        savedShortcuts = { ...newShortcuts };
      }
    }

    function checkForDuplicates(finalCheck = false) {
      let valid = true;
      const shortcutValues = {};
      
      document.querySelectorAll(".warning").forEach(warning => {
        warning.textContent = '';
      });
    
      for (const [key, input] of Object.entries(shortcutFields)) {
        if (!input) continue; 
        
        const toggle = shortcutToggles[key];
        const isEnabled = toggle ? toggle.checked : false;
        
        if (!isEnabled) continue;
        
        const value = input.value.trim();
    
        if (!value && finalCheck && isEnabled) {
          valid = false;
          showWarning(key, `Please set a shortcut for "${getFriendlyName(key)}".`);
          continue;
        }
    
        if (isEnabled && value) {
          const normalizedShortcut = normalizeShortcut(
            typeof newShortcuts[key] === 'object' ? newShortcuts[key].key : newShortcuts[key]
          );
      
          if (shortcutValues[normalizedShortcut]) {
            valid = false;
            const existingKey = shortcutValues[normalizedShortcut];
            showWarning(key, `Shortcut "${value}" is already assigned to "${getFriendlyName(existingKey)}".`);
            showWarning(existingKey, `Shortcut "${value}" is already assigned to "${getFriendlyName(key)}".`);
          } else {
            shortcutValues[normalizedShortcut] = key;
          }
        }
      }
    
      return valid;
    }

    function showWarning(key, message) {
      const input = shortcutFields[key];
      if (!input) return;
      
      const shortcutItem = input.closest('.shortcut-item');
      if (!shortcutItem) return;
      
      let warningEl = shortcutItem.querySelector('.warning');
      if (!warningEl) {
        warningEl = document.createElement('div');
        warningEl.className = 'warning';
        shortcutItem.appendChild(warningEl);
      }
      
      warningEl.textContent = message;
    }

    function normalizeShortcut(shortcut) {
      if (!shortcut) return '';
      
      shortcut = String(shortcut)
        .replace(/Command/g, 'Cmd')
        .replace(/Control/g, 'Ctrl')
        .replace(/Option/g, 'Alt')
        .replace(/Shift/g, 'Shift')
        .replace(/ /g, '');
      const parts = shortcut.split('+');
      const modifiers = [];
      let key = '';
      parts.forEach((part) => {
        if (['Ctrl', 'Cmd', 'Alt', 'Shift'].includes(part)) {
          modifiers.push(part);
        } else {
          key = part.toLowerCase();
        }
      });
      const modifierOrder = isMac ? ['Cmd', 'Alt', 'Shift'] : ['Ctrl', 'Alt', 'Shift'];
      modifiers.sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b));
      return [...modifiers, key].join('+').toLowerCase();
    }

    // macOS shows shortcuts as symbols in the order ⌃⌥⇧⌘ (menus, System
    // Settings); elsewhere the stored form ("Control+Shift+P") reads fine.
    function displayShortcut(shortcut) {
      if (!shortcut) return '';
      if (!isMac) return shortcut.replace(/Command|Cmd/g, 'Ctrl').replace(/Control/g, 'Ctrl');
      const symbols = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘' };
      const order = ['⌃', '⌥', '⇧', '⌘'];
      const parts = shortcut.split('+');
      const mods = parts.filter((p) => symbols[p]).map((p) => symbols[p]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const key = parts.filter((p) => !symbols[p]).join('+');
      return mods.join('') + key;
    }

    function defaultShortcutKey(key) {
      const defaults = window.__defaultShortcuts || {};
      return (defaults[key] && defaults[key].key) || '';
    }

    function getFriendlyName(key) {
      const nameMap = {
        perplexityAI: 'AI Search',
        secondTab: 'Second Tab',
        sendToTray: 'Send to Tray',
        restoreApp: 'Restore App',
        quickSearch: 'Quick Search',
        customPrefixSearch: 'Custom Prefix'
      };
      return nameMap[key] || key;
    }
    
    
  } else if (document.getElementById('prefix-search-container')) {
    const prefixButtons = document.querySelectorAll('.prefix-button');
    const selectedTextElement = document.getElementById('selected-text');
    let selectedText = '';
    
    window.electronAPI.onSelectedText((text) => {
      selectedText = text;
      
      if (selectedTextElement) {
        if (text.length > 100) {
          selectedTextElement.textContent = text.substring(0, 100) + '...';
        } else {
          selectedTextElement.textContent = text;
        }
      }
    });
    
    prefixButtons.forEach(button => {
      button.addEventListener('click', () => {
        const prefix = button.getAttribute('data-prefix') || '';
        
        window.electronAPI.performPrefixSearch({
          text: selectedText,
          prefix: prefix
        });
      });
    });
    
    const closeButton = document.getElementById('close-button');
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        window.electronAPI.closePrefixSearch();
      });
    }
    
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        window.electronAPI.closePrefixSearch();
      }

      if (['1', '2', '3', '4', '5', '6'].includes(event.key)) {
        const index = parseInt(event.key) - 1;
        const buttons = document.querySelectorAll('.prefix-button');

        if (index >= 0 && index < buttons.length) {
          buttons[index].click();
        }
      }
    });
  } else {
    initTabBar();

    initQuickSearch();

    initFindBar();
  }
});

function closeSettings() {
  window.electronAPI.closeSettings();
}

// Main owns the tab list and sends the whole state on every change. One element
// per tab id is kept and updated in place, so hover and keyboard focus survive
// the frequent title and loading updates.
const TAB_MARKUP = `
  <span class="tab-icon" aria-hidden="true">
    <img class="tab-favicon" alt="">
    <svg class="tab-glyph tab-glyph-page" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.9 1.6 1.9 9.9 0 11.5M8 2.25c-1.9 1.6-1.9 9.9 0 11.5"/></svg>
    <svg class="tab-glyph tab-glyph-error" viewBox="0 0 16 16"><path d="M8 2.5 14 13.5H2Z"/><path d="M8 6.5v3.25M8 11.75v.01"/></svg>
    <svg class="tab-glyph tab-glyph-asleep" viewBox="0 0 16 16"><path d="M12.5 10.5A5.25 5.25 0 0 1 5.5 3.5a5.25 5.25 0 1 0 7 7Z"/></svg>
    <span class="tab-spinner"></span>
  </span>
  <span class="tab-title"></span>
  <button class="tab-close" type="button" tabindex="-1">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6m0-6-6 6"/></svg>
  </button>`;

function initTabBar() {
  const tabList = document.getElementById('tabs');
  const newTabButton = document.getElementById('new-tab');
  if (!tabList || !newTabButton) return;

  document.body.classList.toggle('platform-mac', window.electronAPI.platform === 'darwin');
  window.electronAPI.onFullScreenChanged((isFullScreen) => {
    document.body.classList.toggle('fullscreen', isFullScreen);
  });
  newTabButton.addEventListener('click', () => window.electronAPI.newTab());

  const elements = new Map();

  function createTab(id) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.id = id;
    tab.innerHTML = TAB_MARKUP;
    tab.addEventListener('click', (event) => {
      if (!event.target.closest('.tab-close')) window.electronAPI.selectTab(id);
    });
    // Middle-click closes, as in every browser.
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) window.electronAPI.closeTab(id);
    });
    tab.querySelector('.tab-close').addEventListener('click', () => window.electronAPI.closeTab(id));
    const favicon = tab.querySelector('.tab-favicon');
    favicon.addEventListener('error', () => {
      favicon.dataset.failed = favicon.getAttribute('src');
      tab.classList.remove('has-favicon');
    });
    return tab;
  }

  // Arrow keys move focus only; Enter or Space opens the tab. Opening hands
  // focus to the page, so automatic activation would end keyboard navigation.
  tabList.addEventListener('keydown', (event) => {
    const tabs = [...tabList.children];
    const index = tabs.indexOf(document.activeElement);
    if (index === -1) return;
    const id = tabs[index].dataset.id;
    const moveTo = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1]
    }[event.key];

    if (moveTo) {
      tabs.forEach((tab) => { tab.tabIndex = tab === moveTo ? 0 : -1; });
      moveTo.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      window.electronAPI.selectTab(id);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      window.electronAPI.closeTab(id);
    } else {
      return;
    }
    event.preventDefault();
  });

  window.electronAPI.onTabsChanged(({ tabs, activeId }) => {
    const open = new Set();
    tabs.forEach((info, index) => {
      open.add(info.id);
      let tab = elements.get(info.id);
      if (!tab) {
        tab = createTab(info.id);
        elements.set(info.id, tab);
      }
      if (tabList.children[index] !== tab) tabList.insertBefore(tab, tabList.children[index] || null);

      const title = info.error ? 'Couldn’t load page' : (info.title || 'New Tab');
      const isActive = info.id === activeId;
      tab.querySelector('.tab-title').textContent = title;
      tab.title = info.error ? `${info.title || 'Page'}: ${info.error}`
        : info.asleep ? `${title} (asleep to save memory; reloads when opened)` : title;
      tab.querySelector('.tab-close').setAttribute('aria-label', `Close ${title}`);
      tab.setAttribute('aria-selected', String(isActive));
      if (!tabList.contains(document.activeElement)) tab.tabIndex = isActive ? 0 : -1;
      tab.classList.toggle('active', isActive);
      tab.classList.toggle('loading', Boolean(info.loading));
      tab.classList.toggle('error', Boolean(info.error));
      tab.classList.toggle('asleep', Boolean(info.asleep) && !isActive);

      // Only https favicons, so a page cannot point the tab bar at a local file.
      // 'app' comes from main (never from a page): Perplexity tabs show the app icon.
      const favicon = tab.querySelector('.tab-favicon');
      const src = info.favicon === 'app' ? 'assets/icons/png/glyph.png'
        : typeof info.favicon === 'string' && info.favicon.startsWith('https:') ? info.favicon : '';
      if (src && favicon.getAttribute('src') !== src) favicon.src = src;
      tab.classList.toggle('has-favicon', Boolean(src) && favicon.dataset.failed !== src);
    });

    for (const [id, tab] of elements) {
      if (!open.has(id)) {
        tab.remove();
        elements.delete(id);
      }
    }
    elements.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function initQuickSearch() {
  const searchButton = document.getElementById('search-button');

  if (searchButton) {
    searchButton.addEventListener('click', () => {
      navigator.clipboard.readText()
        .then(text => {
          if (text && text.trim()) {
            window.electronAPI.performQuickSearch(text.trim());
          } else {
            console.log("No text in clipboard");
          }
        })
        .catch(err => {
          console.error('Failed to read clipboard contents: ', err);
        });
    });
  }
}

function initFindBar() {
  const findBar = document.getElementById('find-bar');
  const findInput = document.getElementById('find-input');
  const findMatches = document.getElementById('find-matches');
  const findPrev = document.getElementById('find-prev');
  const findNext = document.getElementById('find-next');
  const findClose = document.getElementById('find-close');

  if (!findBar || !findInput) return;

  let isOpen = false;

  function openFindBar() {
    findBar.classList.add('visible');
    window.electronAPI.findBarOpened();
    findInput.focus();
    findInput.select();
    isOpen = true;
  }

  function closeFindBar() {
    findBar.classList.remove('visible');
    findInput.value = '';
    findMatches.textContent = '0 / 0';
    window.electronAPI.stopFindInPage('clearSelection');
    window.electronAPI.findBarClosed();
    isOpen = false;
  }

  // Listen for toggle from main process (Ctrl+F menu accelerator)
  window.electronAPI.onToggleFindBar(() => {
    if (isOpen) {
      closeFindBar();
    } else {
      openFindBar();
    }
  });

  // Live search as user types
  findInput.addEventListener('input', () => {
    const text = findInput.value;
    if (text) {
      window.electronAPI.findInPage(text, { forward: true });
    } else {
      window.electronAPI.stopFindInPage('clearSelection');
      findMatches.textContent = '0 / 0';
    }
  });

  // Keyboard navigation
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFindBar();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        window.electronAPI.findInPage(findInput.value, { forward: false });
      } else {
        window.electronAPI.findInPage(findInput.value, { forward: true });
      }
    }
  });

  findPrev.addEventListener('click', () => {
    if (findInput.value) {
      window.electronAPI.findInPage(findInput.value, { forward: false });
    }
  });

  findNext.addEventListener('click', () => {
    if (findInput.value) {
      window.electronAPI.findInPage(findInput.value, { forward: true });
    }
  });

  findClose.addEventListener('click', closeFindBar);

  // Update match count from search results
  window.electronAPI.onFindResult((result) => {
    findMatches.textContent = `${result.activeMatchOrdinal} / ${result.matches}`;
  });
}