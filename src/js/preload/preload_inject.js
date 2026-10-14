const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    const isLabs = window.location.hostname.includes('labs.perplexity.ai');
    const isMain = window.location.hostname.includes('perplexity.ai') && !isLabs;

    const mainSelectors = [
        'div.items-stretch.md\\:items-center.fill-mode-both.fixed.bottom-0.left-0.right-0.top-0.bg-backdrop\\/70.backdrop-blur-sm.animate-in.fade-in.ease-outExpo.duration-200',
        'div.max-w-\\[400px\\].overflow-hidden.rounded-xl.md\\:flex.md\\:max-w-\\[960px\\].border-borderMain\\/50',
        'relative.flex.flex-col.p-lg.md\\:w-\\[45\\%\\].md\\:p-xl',
        'md\\:h-\\[55\\%\\].md\\:w-\\[55\\%\\]',
        'rounded-lg.p-md.duration-300.ease-out.animate-in.fade-in.\\!p-lg.border-borderMain\\/50.ring-borderMain\\/50.divide-borderMain\\/50.dark\\:divide-borderMainDark\\/50.dark\\:ring-borderMainDark\\/50.dark\\:border-borderMainDark\\/50.bg-offset.dark\\:bg-offsetDark',
        
    ];

    const labsSelectors = [
        'div.flex.items-center.gap-sm'
    ];


    // Perplexity keeps Discover, Finance, Personal CFO, Health, Academic and
    // Patents behind the top-right menu, two clicks away. A user can promote
    // any of them into its left sidebar from Settings; nothing is added unless
    // they ask for it, so the default install leaves Perplexity's UI alone.
    //
    // The menu entries do not exist in the DOM until that menu is opened, so
    // they cannot be moved -- each one is rebuilt by cloning a real sidebar
    // row, which inherits Perplexity's markup, spacing and theming. Icons come
    // from their own sprite.
    const AVAILABLE_SHORTCUTS = [
        { id: 'discover', label: 'Discover',     path: '/discover', icon: 'pplx-icon-compass' },
        { id: 'finance',  label: 'Finance',      path: '/finance',  icon: 'pplx-icon-chart-area-line' },
        { id: 'cfo',      label: 'Personal CFO', path: '/cfo',      icon: 'pplx-icon-wallet' },
        { id: 'health',   label: 'Health',       path: '/health',   icon: 'pplx-icon-heart' },
        { id: 'academic', label: 'Academic',     path: '/academic', icon: 'pplx-icon-school' },
        { id: 'patents',  label: 'Patents',      path: '/patents',  icon: 'pplx-icon-gavel' },
    ];

    const INJECTED_ATTR = 'data-simplexity-shortcut';
    let enabledIds = [];
    let injecting = false;

    function setLabel(clone, text) {
        // The label is the truncating text node in the cloned row. Matching on
        // the class is far more reliable than walking for "the last leaf with
        // text", which picked the wrong node and left every row reading "New".
        const el = clone.querySelector('[class*="truncate"]')
            || [...clone.querySelectorAll('div, span')]
                .reverse()
                .find((d) => d.children.length === 0 && d.textContent.trim().length > 0);
        if (el) el.textContent = text;
        return !!el;
    }

    function syncSidebarLinks() {
        if (injecting) return;

        const nav = document.querySelector('nav[class*="group/sidebar"]');
        if (!nav) return;

        injecting = true;
        try {
            // Drop anything the user has since unticked.
            nav.querySelectorAll('[' + INJECTED_ATTR + ']').forEach((el) => {
                if (!enabledIds.includes(el.getAttribute(INJECTED_ATTR))) el.remove();
            });

            const wanted = AVAILABLE_SHORTCUTS.filter((s) => enabledIds.includes(s.id));
            if (!wanted.length) return;

            // Never clone one of our own rows, or the edits compound.
            const templateAnchor = [...nav.querySelectorAll('a[href^="/"][class*="absolute"]')]
                .find((a) => !a.closest('[' + INJECTED_ATTR + ']'));
            if (!templateAnchor) return;

            const template = templateAnchor.closest('[class*="collapsible-sidebar-section"]');
            if (!template || !template.parentElement) return;

            let after = template;
            const existing = nav.querySelectorAll('[' + INJECTED_ATTR + ']');
            if (existing.length) after = existing[existing.length - 1];

            for (const link of wanted) {
                if (nav.querySelector('[' + INJECTED_ATTR + '="' + link.id + '"]')) continue;

                const clone = template.cloneNode(true);
                clone.setAttribute(INJECTED_ATTR, link.id);

                const anchor = clone.querySelector('a[href]');
                if (!anchor) continue;
                anchor.setAttribute('href', link.path);
                anchor.setAttribute('aria-label', link.label);

                const use = clone.querySelector('svg use');
                if (use) {
                    use.setAttribute('xlink:href', '#' + link.icon);
                    use.setAttribute('href', '#' + link.icon);
                }

                // If the label cannot be set the row would read as a copy of
                // whatever was cloned, which is worse than not adding it.
                if (!setLabel(clone, link.label)) continue;

                after.parentElement.insertBefore(clone, after.nextSibling);
                after = clone;
            }
        } finally {
            injecting = false;
        }
    }

    // querySelectorAll throws a SyntaxError on a malformed selector, and this
    // runs inside a DOMContentLoaded listener, so one bad entry took the whole
    // script down with it -- including the MutationObserver registration below.
    // That is why nag screens were never actually being removed. Isolate each
    // selector so a future typo degrades instead of disabling everything.
    function removeNagScreens(selectors) {
        selectors.forEach((selector) => {
            try {
                document.querySelectorAll(selector).forEach((el) => {
                    el.remove();
                });
            } catch (err) {
                console.warn('[simplexity] skipping invalid nag-screen selector:', selector, err.message);
            }
        });
    }

    // Perplexity refuses a query over 40,000 characters (measured: 64,000 typed
    // gives "24,000 characters over the limit"). A paste that would push the
    // composer past that is attached as a Markdown file instead -- the upload
    // input accepts .md and the model reads the whole file. Shorter pastes are
    // left to the editor untouched.
    const QUERY_CHAR_LIMIT = 40000;

    function attachAsFile(editor, text) {
        // The upload input nearest the composer: the home page and a thread
        // page each render their own.
        let scope = editor;
        while (scope && !scope.querySelector('input[type="file"]')) scope = scope.parentElement;
        const input = scope && scope.querySelector('input[type="file"]');
        if (!input) return false;

        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const files = new DataTransfer();
        files.items.add(new File([text], `pasted-text-${stamp}.md`, { type: 'text/markdown' }));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // Says why the text became a file instead of landing in the box. Lives in
    // a shadow root so Perplexity's styles cannot reach it, and vice versa.
    let noticeHost = null;
    function showPasteNotice() {
        if (noticeHost) noticeHost.remove();
        noticeHost = document.createElement('div');
        const root = noticeHost.attachShadow({ mode: 'closed' });
        root.innerHTML = `
            <style>
                .notice { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647;
                    display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-radius: 14px;
                    background: rgba(44,44,48,0.92); border: 1px solid rgba(255,255,255,0.10); box-shadow: 0 12px 32px rgba(0,0,0,0.45);
                    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
                    color: #f2f2f7; font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: calc(100vw - 48px);
                    animation: in 180ms cubic-bezier(0.16, 1, 0.3, 1); }
                svg { flex: none; }
                button { height: 28px; padding: 0 12px; border: 0; border-radius: 8px; background: rgba(255,255,255,0.14);
                    color: inherit; font: 500 13px/1 -apple-system, system-ui, sans-serif; cursor: pointer; }
                button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
                @keyframes in { from { opacity: 0; transform: translate(-50%, 8px); } }
                @media (prefers-reduced-motion: reduce) { .notice { animation: none; } }
            </style>
            <div class="notice" role="status">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="#0a84ff" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="#0a84ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>Long paste attached as a Markdown file. Perplexity allows ${QUERY_CHAR_LIMIT.toLocaleString('en-US')} characters in the box.</span>
                <button type="button">OK</button>
            </div>`;
        const host = noticeHost;
        const dismiss = () => { host.remove(); if (noticeHost === host) noticeHost = null; };
        root.querySelector('button').addEventListener('click', dismiss);
        setTimeout(dismiss, 6000);
        document.body.appendChild(host);
    }

    // A long rich paste (a copied web page) is counted by Perplexity with every
    // link URL in it -- 400 links of 17,089 visible characters measured as
    // 45,379 -- and importing that HTML blocks the page for seconds. From this
    // size on, a rich paste goes in as plain text, so what the limit counts is
    // what you see, and the editor skips the HTML import.
    const PLAIN_PASTE_FROM = 5000;
    const replayed = new WeakSet();

    if (isMain) {
        // Capture phase, so this runs before the editor's own paste handler.
        document.addEventListener('paste', (event) => {
            if (replayed.has(event)) return;
            // The home, thread and project composers are all Lexical editors.
            const editor = event.target instanceof Element && event.target.closest('#ask-input, [data-lexical-editor="true"]');
            if (!editor) return;
            const data = event.clipboardData;
            const text = data && data.getData('text/plain');
            if (!text) return;

            // trim(): an empty editor's innerText is "\n".
            if (text.length + editor.innerText.trim().length > QUERY_CHAR_LIMIT) {
                // No upload input means no way to attach; let Perplexity show its own limit message.
                if (!attachAsFile(editor, text)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                showPasteNotice();
                return;
            }

            if (text.length >= PLAIN_PASTE_FROM && data.types.includes('text/html')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const plain = new DataTransfer();
                plain.setData('text/plain', text);
                const again = new ClipboardEvent('paste', { clipboardData: plain, bubbles: true, cancelable: true });
                replayed.add(again);
                event.target.dispatchEvent(again);
            }
        }, true);

        // Copying an answer into a Markdown editor such as Obsidian lost every
        // code block's fence and language, and brought the source chips along
        // as text ("elastic+1"). Perplexity draws a code block as pre > figure,
        // with the language in a figcaption; HTML-to-Markdown converters (Obsidian
        // uses Turndown) only fence pre > code.language-x. So the copied HTML
        // is rewritten into that shape and the citation chips are dropped.
        // Dragging the selection into another app carries the same data.
        //
        // Perplexity's own copy handler fills the clipboard first (its plain
        // text already leaves the chips out), so this runs last, on window in
        // the bubble phase, and reworks the HTML it produced. That HTML is
        // parsed in an inert <template>, so nothing in it loads or runs.
        const cleanSelection = (event) => {
            const data = event.clipboardData || event.dataTransfer;
            const sel = document.getSelection();
            if (!data || !sel || sel.isCollapsed || !sel.rangeCount) return;
            // A dragged link or image is not the selection; leave its data alone.
            if (event.type === 'dragstart' && !sel.containsNode(event.target, true)) return;
            const range = sel.getRangeAt(0);
            const theirs = data.getData('text/html');
            const tpl = document.createElement('template');
            if (theirs) tpl.innerHTML = theirs; else tpl.content.append(range.cloneContents());
            const frag = tpl.content;
            const pres = frag.querySelectorAll('pre');
            const chips = frag.querySelectorAll('[data-pplx-citation], .citation-nbsp');
            if (!pres.length && !chips.length) return; // plain prose, or inside one code block

            chips.forEach((el) => el.remove());
            // The figcaption may sit outside a partial selection, so each
            // language is read from the page's own block, matched by order.
            const scope = range.commonAncestorContainer;
            const source = [...(scope.nodeType === 1 ? scope : scope.parentElement).querySelectorAll('pre')]
                .filter((pre) => range.intersectsNode(pre));
            pres.forEach((pre, i) => {
                const code = document.createElement('code');
                const lang = pre.querySelector('figcaption > span') || (source[i] && source[i].querySelector('figcaption > span'));
                if (lang && /^[\w#+.-]+$/.test(lang.textContent.trim())) code.className = 'language-' + lang.textContent.trim().toLowerCase();
                code.textContent = (pre.querySelector('code') || pre).textContent;
                const clean = document.createElement('pre');
                clean.append(code);
                pre.replaceWith(clean);
            });

            const box = document.createElement('div');
            box.append(frag);
            if (!theirs) {
                // innerText needs layout to turn blocks into line breaks.
                box.style.cssText = 'position:fixed;left:-99999px;top:0;';
                document.body.append(box);
                data.setData('text/plain', box.innerText);
                box.remove();
            }
            data.setData('text/html', box.innerHTML);
            if (event.type === 'copy') event.preventDefault(); // keep ours; cancelling a dragstart would cancel the drag
        };
        window.addEventListener('copy', cleanSelection);
        window.addEventListener('dragstart', cleanSelection);
    }

    // Two-finger swipe on a trackpad goes back and forward, as in Safari. A
    // horizontal swipe arrives as wheel events with deltaX; a gesture ends after
    // a short pause, and each gesture navigates at most once. Content that can
    // still scroll sideways in the swipe's direction (a wide table, a code
    // block) keeps the swipe, and pinch-zoom (ctrlKey) is left alone.
    const SWIPE_DISTANCE = 120;
    const GESTURE_GAP_MS = 180;
    let swipeTravel = 0;
    let swipeUsed = false;
    let swipeTimer = null;

    function canScrollSideways(target, dx) {
        for (let el = target instanceof Element ? target : null; el && el !== document.documentElement; el = el.parentElement) {
            if (el.scrollWidth <= el.clientWidth) continue;
            const overflow = getComputedStyle(el).overflowX;
            if (overflow !== 'auto' && overflow !== 'scroll') continue;
            if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
        }
        return false;
    }

    window.addEventListener('wheel', (event) => {
        clearTimeout(swipeTimer);
        swipeTimer = setTimeout(() => { swipeTravel = 0; swipeUsed = false; }, GESTURE_GAP_MS);
        if (swipeUsed || event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5) return;
        if (canScrollSideways(event.target, event.deltaX)) { swipeTravel = 0; return; }
        swipeTravel += event.deltaX;
        if (Math.abs(swipeTravel) < SWIPE_DISTANCE) return;
        swipeUsed = true;
        // Fingers moving right scroll content left (negative deltaX): back.
        if (swipeTravel < 0) history.back(); else history.forward();
    }, { passive: true, capture: true });

    if (isLabs) {
        removeNagScreens(labsSelectors);
    } else if (isMain) {
        removeNagScreens(mainSelectors);
        syncSidebarLinks();
    }


    // Perplexity mutates the DOM on every streamed token and every keystroke,
    // and each pass below runs several whole-document queries (about 2 ms on the
    // home page, more on a long thread). Running one per mutation batch stacked
    // that cost onto every token, so batch them: at most one pass per 250 ms,
    // still fast enough to catch a nag modal.
    let sweepPending = false;
    const observer = new MutationObserver(() => {
        if (sweepPending) return;
        sweepPending = true;
        setTimeout(() => {
            sweepPending = false;
            if (isLabs) {
                removeNagScreens(labsSelectors);
            } else if (isMain) {
                removeNagScreens(mainSelectors);
                syncSidebarLinks();
                watchRoute();
            }
        }, 250);
    });

    // Projects sometimes came up broken: an empty project page, or "No projects"
    // in the sidebar while the Projects page lists them, until the app was
    // restarted. A reload clears it, so do that once the page has had time to
    // render. At most one automatic reload a minute, so a project that really is
    // empty, or a page that keeps failing, cannot loop.
    const RECHECK_AFTER_MS = 6000;
    let watchedPath = null; // null: the first sweep checks the page it loaded on
    function watchRoute() {
        if (location.pathname === watchedPath) return;
        watchedPath = location.pathname;
        const path = watchedPath;
        // Project pages are where an icon gets changed.
        if (/^\/(projects|spaces)\//.test(path)) refreshProjectIcons();
        setTimeout(() => { if (location.pathname === path && projectsLookBroken()) reloadOnce(); }, RECHECK_AFTER_MS);
    }

    function projectsLookBroken() {
        if (!/^\/(projects|spaces)(\/|$)/.test(location.pathname)) return false;
        const main = document.querySelector('main');
        if (!main || !main.textContent.trim()) return true;
        const nav = document.querySelector('nav');
        return !!(nav && /No projects/.test(nav.textContent) && main.querySelector('a[href^="/spaces/"]'));
    }

    function reloadOnce() {
        try {
            const last = Number(sessionStorage.getItem('simplex-auto-reload') || 0);
            if (Date.now() - last < 60000) return;
            sessionStorage.setItem('simplex-auto-reload', String(Date.now()));
        } catch {
            return; // without the guard a reload could repeat; leave the page as it is
        }
        console.warn('[simplex] project page did not render; reloading');
        location.reload();
    }

    // Perplexity's sidebar draws every project with the same grey folder; the
    // icon and colour picked for a project only show on the Projects page. A
    // stylesheet paints them on from Perplexity's own data: the project list
    // names each project's icon and colour (or emoji), and the icon endpoint
    // returns those icons' SVG. Styling only, so React's tree is never edited.
    // Colour names map to theme tokens the way Perplexity's own picker does.
    const PROJECT_COLOR_TOKEN = { red: 'pink', amber: 'gold', pink: 'magenta', gray: 'neutral' };
    const API = 'version=2.18&source=default';
    let projectIconStyle = null;

    async function paintProjectIcons() {
        const list = await fetch('/rest/spaces/landing/v2?limit=100&ordered=true&' + API);
        if (!list.ok) return;
        const projects = Object.values((await list.json()).sections || {})
            .flatMap((section) => section.items || [])
            .filter((p) => /^[0-9a-f-]{36}$/.test(p.uuid));

        const iconIds = [...new Set(projects.map((p) => p.appearance && p.appearance.icon)
            .filter((icon) => /^[\w-]+$/.test(icon || '')))].map((icon) => 'pplx-data-' + icon);
        const masks = {};
        if (iconIds.length) {
            const res = await fetch('/rest/spaces/icon?' + API, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: iconIds }),
            });
            const { icons } = res.ok ? await res.json() : {};
            for (const { id, symbol } of Array.isArray(icons) ? icons : []) {
                if (typeof symbol !== 'string' || !/^<symbol id="[^"]*"/.test(symbol) || !symbol.endsWith('</symbol>')) continue;
                const svg = symbol.replace(/^<symbol id="[^"]*"/, '<svg xmlns="http://www.w3.org/2000/svg"').replace(/<\/symbol>$/, '</svg>');
                masks[id] = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
            }
        }

        const folder = 'svg:has(> use[*|href="#pplx-icon-folder"])';
        let css = '';
        for (const p of projects) {
            const row = `nav [data-sidebar-session-row]:has(> a[href="/projects/${p.uuid}"])`;
            const look = p.appearance || {};
            const mask = masks['pplx-data-' + look.icon];
            const emoji = look.emoji || (!look.icon && p.emoji);
            const points = /^[0-9a-f]{1,6}(-[0-9a-f]{1,6})*$/i.test(emoji || '') ? emoji.split('-').map((hex) => parseInt(hex, 16)) : [];
            if (mask) {
                const color = /^[a-z]+$/.test(look.color || '') ? PROJECT_COLOR_TOKEN[look.color] || look.color : null;
                css += `${row} ${folder} { background: currentColor; -webkit-mask: ${mask} center / 16px no-repeat;${color ? ` color: var(--decoration-${color}-fg-primary);` : ''} }
                    ${row} ${folder} > use { visibility: hidden; }\n`;
            } else if (points.length && points.every((cp) => cp <= 0x10ffff)) {
                const char = String.fromCodePoint(...points);
                css += `${row} *:has(> svg > use[*|href="#pplx-icon-folder"])::before { content: "${char}"; font-size: 12px; line-height: 1; }
                    ${row} ${folder} { display: none; }\n`;
            }
        }
        if (!projectIconStyle) {
            projectIconStyle = document.createElement('style');
            document.head.append(projectIconStyle);
        }
        projectIconStyle.textContent = css;
    }

    function refreshProjectIcons() {
        paintProjectIcons().catch((err) => console.warn('[simplex] project icons:', err.message));
    }

    observer.observe(document.body, { childList: true, subtree: true });
    if (isMain) refreshProjectIcons();

    ipcRenderer.invoke('get-sidebar-shortcuts').then((ids) => {
        enabledIds = Array.isArray(ids) ? ids : [];
        syncSidebarLinks();
    }).catch(() => {});

    // Applying changes without a reload keeps Settings feeling immediate.
    ipcRenderer.on('sidebar-shortcuts-changed', (_event, ids) => {
        enabledIds = Array.isArray(ids) ? ids : [];
        syncSidebarLinks();
    });
});
