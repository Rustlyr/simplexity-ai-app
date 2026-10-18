const { ipcRenderer, contextBridge } = require('electron');

// A question asked from Finance is filed in the "Finance" project, and one
// asked from Discover in "News", without picking the project each time.
// Perplexity files a question in a project when the ask request carries
// target_collection_uuid, which is what a project page sends. The page's own
// fetch lives in its main world, so the wrapper is installed there, before
// the page's scripts run. Only questions sent while on a Finance or Discover
// page are touched: those always start a new thread (a Discover question
// forks the article, so it carries last_backend_uuid too). Follow-ups happen
// on the thread's own /search page and are left alone, as is anything
// already headed for a project. If the project is missing or
// the lookup fails, the question goes out unchanged.
// The answer stream carries no collection_info, and the thread header's
// project pill reads it from the streamed result, so the pill would stay
// hidden until the thread is reopened. The stream of a filed question
// therefore gets the project's collection_info added to each answer event.
const ROUTE_PROJECTS = [['^/finance(/|$)', 'finance'], ['^/discover(/|$)', 'news']];
if (location.hostname === 'www.perplexity.ai') {
    contextBridge.executeInMainWorld({
        args: [ROUTE_PROJECTS],
        func: (routes) => {
            const send = window.fetch;
            let projects = null; // promise of { lowercased title: project }
            const lookup = () => (projects = projects || send('/rest/spaces/landing/v2?limit=100&ordered=true&version=2.18&source=default')
                .then((r) => r.json())
                .then((j) => Object.fromEntries(Object.values(j.sections || {})
                    .flatMap((s) => s.items || [])
                    .map((p) => [String(p.title).trim().toLowerCase(), p]))));
            // SSE lines are "data: {json}"; events split across chunks are joined first.
            const withCollection = (res, project) => {
                if (!res.ok || !res.body) return res;
                const enc = new TextEncoder();
                const dec = new TextDecoder();
                let rest = '';
                const fix = (line) => {
                    if (!line.startsWith('data: {')) return line;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (!('backend_uuid' in event) || event.collection_info) return line;
                        event.collection_info = project;
                        return 'data: ' + JSON.stringify(event) + (line.endsWith('\r') ? '\r' : '');
                    } catch {
                        return line;
                    }
                };
                const body = res.body.pipeThrough(new TransformStream({
                    transform(chunk, out) {
                        rest += dec.decode(chunk, { stream: true });
                        const lines = rest.split('\n');
                        rest = lines.pop();
                        if (lines.length) out.enqueue(enc.encode(lines.map(fix).join('\n') + '\n'));
                    },
                    flush(out) {
                        rest += dec.decode();
                        if (rest) out.enqueue(enc.encode(fix(rest)));
                    },
                }));
                return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
            };
            window.fetch = async function (input, init) {
                // The ask call passes a URL object; a Request carries .url.
                const url = input instanceof Request ? input.url : String(input);
                const route = routes.find(([re]) => new RegExp(re).test(location.pathname));
                let project = null;
                if (route && url.includes('/rest/sse/perplexity_ask') && init && typeof init.body === 'string') {
                    try {
                        const body = JSON.parse(init.body);
                        const p = body.params;
                        if (p && !p.target_collection_uuid) {
                            project = (await lookup())[route[1]] || null;
                            if (project) {
                                p.target_collection_uuid = project.uuid;
                                p.target_thread_access_level = 1; // "Only you can view", as a project page sends
                                init = { ...init, body: JSON.stringify(body) };
                            }
                        }
                    } catch (err) {
                        projects = null; // try the lookup again next time
                        project = null;
                        console.warn('[simplex] could not file the question in a project:', err.message);
                    }
                }
                const res = await send.call(this, input, init);
                return project ? withCollection(res, project) : res;
            };
        },
    });
}

window.addEventListener('DOMContentLoaded', () => {
    const isMain = window.location.hostname.includes('perplexity.ai');

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

    // Perplexity's router follows history.pushState once it hears popstate, so
    // this is an in-app navigation (measured: same document, Back still works).
    function navigateInApp(path) {
        if (location.pathname + location.search === path) return;
        history.pushState(history.state, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }

    // Finance opens on the tab that was open last, across restarts, instead
    // of always on US Markets. Each tab is its own path.
    const FINANCE_TAB_PATH = /^\/finance(\/(crypto|earnings|predictions|screener|politicians|watchlist|workflows|gallery))?$/;
    const FINANCE_KEY = 'simplex:finance-path';
    function lastFinancePath() {
        const saved = localStorage.getItem(FINANCE_KEY);
        return saved && FINANCE_TAB_PATH.test(saved) ? saved : '/finance';
    }

    // Finance's Market Summary block has no stable hook, only its heading.
    // Mark the block so the app's stylesheet can hide it (a Settings switch).
    function markMarketSummary() {
        if (!location.pathname.startsWith('/finance')) return;
        for (const heading of document.querySelectorAll('main h2')) {
            const block = heading.parentElement && heading.parentElement.parentElement;
            if (block && !block.hasAttribute('data-simplex-market-summary') && heading.textContent.trim() === 'Market Summary') block.setAttribute('data-simplex-market-summary', '');
        }
    }

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
                // A cloned row is not wired to Perplexity's router, so a plain
                // click reloaded the whole page (the jank on opening Finance).
                // Route it in-app instead; modified clicks keep the browser's.
                anchor.addEventListener('click', (event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    navigateInApp(link.id === 'finance' ? lastFinancePath() : link.path);
                });

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

    if (isMain) syncSidebarLinks();


    // Perplexity mutates the DOM on every streamed token and every keystroke,
    // and each pass below runs several whole-document queries (about 2 ms on the
    // home page, more on a long thread). Running one per mutation batch stacked
    // that cost onto every token, so batch them: at most one pass per 250 ms,
    // still prompt for the sidebar and route checks.
    let sweepPending = false;
    const observer = new MutationObserver(() => {
        // Unbatched, so the block is hidden before it is ever painted (in the
        // 250 ms pass it showed for ~13 frames). A few h2 lookups, Finance only.
        if (isMain) markMarketSummary();
        if (sweepPending) return;
        sweepPending = true;
        setTimeout(() => {
            sweepPending = false;
            if (isMain) {
                syncSidebarLinks();
                watchRoute();
                addClearUnpinned();
                paintShellCode();
                checkThreadError();
                tidyNewThreadTitle();
                if (!projectsWarmed && performance.now() > WARM_AFTER_MS) warmProjects();
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
        if (FINANCE_TAB_PATH.test(path)) localStorage.setItem(FINANCE_KEY, path);
        setTimeout(() => { if (location.pathname === path && projectsLookBroken()) reloadOnce('project page did not render'); }, RECHECK_AFTER_MS);
    }

    // A thread sometimes drops to a blank page with Perplexity's "Sorry,
    // something went wrong" while chatting (seen by the user; not reproduced
    // here, where forced 500s and dropped connections on the thread and answer
    // calls were all retried by Perplexity itself). The answer is safe on the
    // server and reopening the thread showed it, so reload the thread once the
    // error has stayed up 1.5 s (Perplexity's own retries clear it sooner).
    // Each one goes to page-errors.log with the API calls that failed around it,
    // so the cause can be traced. /search/new/ pages are left alone: they have
    // no thread address yet, and reloading one lands on the home page.
    const THREAD_ERROR_GRACE_MS = 1500;
    let threadErrorTimer = null;
    function threadError() {
        if (!/^\/search\/(?!new\/)./.test(location.pathname)) return '';
        const alert = document.querySelector('main [role="alert"].bg-negative-strong');
        return alert ? alert.innerText.replace(/\s+/g, ' ').trim() : '';
    }
    function checkThreadError() {
        if (threadErrorTimer || !threadError()) return;
        threadErrorTimer = setTimeout(() => {
            threadErrorTimer = null;
            const text = threadError();
            if (!text) return; // Perplexity recovered by itself
            ipcRenderer.send('page-error', `${location.pathname}  ${text}`);
            reloadOnce('thread error: ' + text);
        }, THREAD_ERROR_GRACE_MS);
    }

    function projectsLookBroken() {
        if (!/^\/(projects|spaces)(\/|$)/.test(location.pathname)) return false;
        const main = document.querySelector('main');
        if (!main || !main.textContent.trim()) return true;
        const nav = document.querySelector('nav');
        return !!(nav && /No projects/.test(nav.textContent) && main.querySelector('a[href^="/spaces/"]'));
    }

    function reloadOnce(reason) {
        try {
            const last = Number(sessionStorage.getItem('simplex-auto-reload') || 0);
            if (Date.now() - last < 60000) return;
            sessionStorage.setItem('simplex-auto-reload', String(Date.now()));
        } catch {
            return; // without the guard a reload could repeat; leave the page as it is
        }
        console.warn(`[simplex] ${reason}; reloading`);
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

    // A project page waits on Perplexity's SpaceProjectThreadsRelayQuery, which
    // its server answers in anything from 0.4 s to over 20 s (the same query
    // replayed: 0.4-74 s; the user's slow-requests.log had one at 20 s). That
    // wait is what the skeleton rows are. Perplexity prefetches a project's
    // data when its sidebar link is hovered and keeps it for the page's life,
    // so a click after that is instant. Hover every project once, a few
    // seconds after load, so the wait happens before the click instead of on it.
    const WARM_AFTER_MS = 5000;
    let projectsWarmed = false;
    function warmProjects() {
        const links = document.querySelectorAll('nav [data-sidebar-session-row] > a[href^="/projects/"]');
        if (projectsWarmed || !links.length) return;
        projectsWarmed = true;
        for (const a of links) {
            for (const type of ['pointerover', 'mouseover', 'pointerout', 'mouseout']) {
                const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                a.dispatchEvent(new Ctor(type, { bubbles: true, pointerType: 'mouse' }));
            }
        }
    }
    // end warmProjects

    function refreshProjectIcons() {
        paintProjectIcons().catch((err) => console.warn('[simplex] project icons:', err.message));
    }

    // PowerShell, cmd and plain shell blocks came out one grey: Perplexity's
    // Prism grammar marks almost nothing in a line like `.\tool.exe --help`, and
    // its theme does not colour what it does mark. Such blocks are coloured
    // with the CSS Custom Highlight API, which paints text ranges without
    // adding elements, so React's tree and copied text stay untouched. Blocks
    // Prism already coloured (inline colour styles) are left alone.
    const SHELL_LANGS = /^(powershell|pwsh|ps1?|cmd|bat|batch|dos|shell|sh|bash|zsh|console|shellsession|terminal)$/;
    const SHELL_TOKENS = [
        ['simplex-com', /(?<=^|\s)(?:#|REM\s|::).*$/],
        ['simplex-str', /"(?:[^"\\`]|[\\`].)*"|'[^'\n]*'/],
        ['simplex-var', /\$\{[^}\n]*\}|\$(?:env:)?[A-Za-z_][\w:]*|\$[?_$]|%[A-Za-z_]\w*%/],
        ['simplex-param', /(?<=^|\s)--?[A-Za-z][\w-]*/],
        ['simplex-kw', /\b(?:if|elseif|else|foreach|for|while|do|until|switch|function|param|return|try|catch|finally|throw|begin|process|end|in|then|fi|done|case|esac|export|local)\b/],
        ['simplex-num', /\b\d+(?:\.\d+)?\b/],
        // The command: the first word of a line or of a pipeline step.
        ['simplex-cmd', /(?<=^[ \t]*|[|;&{(][ \t]*)(?:\.{1,2}[\\/])?[\w.:\\/-]*[\w-]/],
    ];
    const SHELL_RE = new RegExp(SHELL_TOKENS.map(([, re]) => `(${re.source})`).join('|'), 'gm');
    let shellSignature = '';

    function paintShellCode() {
        if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return;
        const blocks = [];
        for (const pre of document.querySelectorAll('pre')) {
            const label = pre.querySelector('figcaption > span');
            const code = pre.querySelector('code');
            if (!label || !code || !SHELL_LANGS.test(label.textContent.trim().toLowerCase())) continue;
            if (code.querySelector('span[style*="color"]')) continue;
            blocks.push(code);
        }
        const signature = blocks.map((code) => code.textContent.length).join(',');
        if (signature === shellSignature) return;
        shellSignature = signature;

        const ranges = Object.fromEntries(SHELL_TOKENS.map(([name]) => [name, []]));
        for (const code of blocks) {
            const nodes = [];
            let text = '';
            const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                nodes.push({ node, start: text.length });
                text += node.data;
            }
            const at = (offset) => {
                let i = nodes.length - 1;
                while (i > 0 && nodes[i].start > offset) i--;
                return [nodes[i].node, offset - nodes[i].start];
            };
            for (const match of text.matchAll(SHELL_RE)) {
                if (!match[0]) continue;
                const group = match.slice(1).findIndex((g) => g !== undefined);
                const range = new Range();
                range.setStart(...at(match.index));
                range.setEnd(...at(match.index + match[0].length));
                ranges[SHELL_TOKENS[group][0]].push(range);
            }
        }
        for (const [name, list] of Object.entries(ranges)) CSS.highlights.set(name, new Highlight(...list));
    }

    // Library: "Clear unpinned" deletes every session except pinned ones, so
    // old chats can be cleared without ticking each row. Pinned means pinned
    // in the sidebar or pinned inside any project. It fails closed: if any pin
    // list cannot be read in full, nothing is deleted. Deletion uses the same
    // request as the Library's own Delete (context_uuids, 64 per call).
    const CLEAR_ATTR = 'data-simplex-clear-unpinned';
    const JSON_HEADERS = { 'content-type': 'application/json', 'x-app-apiclient': 'default', 'x-app-apiversion': '2.18' };

    async function getJson(url, init) {
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`${url.split('?')[0]} answered ${res.status}`);
        return res.json();
    }

    async function listUnpinnedSessions(progress) {
        // Each page of 100 takes the server 1-4 s and the response carries no
        // usable total, so ask for 4 pages at a time. A short page is NOT the
        // end (measured: offset 1800 gave 99 with 400 more after it); the end
        // is an empty page or a last item with has_next_page false.
        const PAGE = 100;
        const WAVE = 4;
        const byContext = new Map();
        const listPage = (offset) => getJson('/rest/thread/list_ask_threads?' + API, {
            method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ limit: PAGE, offset, ascending: false, search_term: '' }),
        });
        for (let offset = 0, done = false; !done; offset += PAGE * WAVE) {
            if (offset >= 100000) throw new Error('the session list did not end');
            const pages = await Promise.all(Array.from({ length: WAVE }, (_, i) => listPage(offset + i * PAGE)));
            for (const page of pages) {
                if (!Array.isArray(page)) throw new Error('unexpected session list');
                page.forEach((t) => byContext.set(t.context_uuid, t));
                if (!page.length || page[page.length - 1].has_next_page === false) done = true;
            }
            progress(byContext.size);
        }
        const threads = [...byContext.values()];

        const pinned = new Set();
        const keep = (t) => { if (t && t.context_uuid) pinned.add(t.context_uuid); if (t && t.uuid) pinned.add(t.uuid); };
        // The pin list caps at 50 and has no next page, so a full one cannot be trusted.
        const PIN_LIMIT = 50;
        const pins = await getJson(`/rest/pins?limit=${PIN_LIMIT}&` + API);
        if (!Array.isArray(pins.items) || pins.items.length >= PIN_LIMIT) throw new Error('could not read every sidebar pin');
        pins.items.forEach((item) => keep(item.thread));

        const sections = Object.values((await getJson('/rest/spaces/landing/v2?limit=100&ordered=true&' + API)).sections || {});
        if (sections.some((section) => section.next_cursor)) throw new Error('could not read every project');
        for (const project of sections.flatMap((section) => section.items || [])) {
            const projectPins = await getJson(`/rest/spaces/${project.uuid}/pins/threads?` + API);
            if (!Array.isArray(projectPins)) throw new Error('could not read pins of ' + project.title);
            projectPins.forEach(keep);
        }

        const unpinned = threads.filter((t) => t.context_uuid && !pinned.has(t.context_uuid) && !pinned.has(t.uuid));
        return { unpinned, keptCount: threads.length - unpinned.length };
    }

    async function clearUnpinned(button) {
        const label = button.querySelector('span') || button;
        const idle = label.textContent;
        button.disabled = true;
        label.textContent = 'Checking…';
        let deleted = 0;
        try {
            const { unpinned, keptCount } = await listUnpinnedSessions((n) => { label.textContent = `Checking ${n.toLocaleString()}…`; });
            if (!unpinned.length) {
                alert('There are no unpinned sessions to delete.');
                return;
            }
            const sure = confirm(`Delete ${unpinned.length.toLocaleString()} unpinned sessions?\n\n`
                + `${keptCount.toLocaleString()} pinned sessions (sidebar and project pins) are kept. This cannot be undone.`);
            if (!sure) return;
            for (let i = 0; i < unpinned.length; i += 64) {
                const contextUuids = unpinned.slice(i, i + 64).map((t) => t.context_uuid);
                label.textContent = `Deleting ${deleted.toLocaleString()} / ${unpinned.length.toLocaleString()}…`;
                await getJson('/rest/thread?' + API, {
                    method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ entry_uuids: [], context_uuids: contextUuids, read_write_token: '' }),
                });
                deleted += contextUuids.length;
            }
            location.reload(); // the list and the sidebar both come back without the deleted sessions
        } catch (err) {
            console.warn('[simplex] clear unpinned:', err.message);
            alert(`Stopped: ${err.message}.\n\n${deleted.toLocaleString()} sessions were deleted before it stopped; nothing else was touched.`);
        } finally {
            button.disabled = false;
            label.textContent = idle;
        }
    }

    // Perplexity names a chat after its whole first question, so a pasted post
    // or web page becomes a title like "Skip to content SUBMIT A JOB Home…".
    // When a chat started in this window has its first answer, it gets a short
    // title cut from that question: no leading emoji or markers ("BREAKING:",
    // "Skip to content"), no GitHub page chrome, first sentence only, at most
    // TITLE_MAX characters ending on a whole word. It is renamed the way
    // Perplexity's own Rename does it, and only while the title is still the
    // question itself, so a name the user picked is never touched.
    // ponytail: a cut, not a summary; a real summary needs a language model
    // the app does not have (Apple's on-device one has no Thai).
    const TITLE_MAX = 60;
    const TITLE_WAIT_MS = 5 * 60 * 1000;
    let newThreadSeen = false;
    const titledSlugs = new Set();

    function shortTitle(question) {
        let t = (question.split('\n').map((line) => line.trim()).find(Boolean) || '')
            .replace(/^\W*skip to (main )?content\s*/iu, '')
            .replace(/\s+(Repository navigation|Navigation Menu)\b.*$/iu, '')
            .replace(/^[^\p{L}\p{N}]+/u, '')
            .replace(/^(breaking( news)?|just in|update|alert)\s*[:\-–—]\s*/iu, '')
            .replace(/^[^\p{L}\p{N}]+/u, '');
        const sentence = t.match(/^(.{12,}?[.!?。])(\s|$)/u);
        if (sentence) t = sentence[1];
        t = t.replace(/[.。]$/u, '').trim();
        if (t.length <= TITLE_MAX) return t;
        // Cut on a word boundary; Intl.Segmenter also finds Thai word breaks.
        let cut = '';
        for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(t)) {
            if ((cut + segment).length > TITLE_MAX - 1) break;
            cut += segment;
        }
        return cut.replace(/[^\p{L}\p{N}\p{M})]+$/u, '') + '…';
    }

    function tidyNewThreadTitle() {
        const path = location.pathname;
        if (path.startsWith('/search/new/')) { newThreadSeen = true; return; }
        const slug = (path.match(/^\/search\/([^/]+)$/) || [])[1];
        if (!slug || !newThreadSeen || titledSlugs.has(slug)) return;
        newThreadSeen = false;
        titledSlugs.add(slug);
        renameWhenAnswered(slug, Date.now()).catch((err) => console.warn('[simplex] chat title:', err.message));
    }

    async function renameWhenAnswered(slug, since) {
        const thread = await getJson(`/rest/thread/${slug}?${API}&limit=1&offset=0&from_first=true`);
        const entry = (thread.entries || [])[0];
        if (!entry) return;
        if (entry.status !== 'completed') {
            if (Date.now() - since < TITLE_WAIT_MS) setTimeout(() => renameWhenAnswered(slug, since).catch(() => {}), 4000);
            return;
        }
        const current = (entry.thread_title || '').trim();
        if (current !== (entry.query_str || '').trim()) return; // already renamed
        const title = shortTitle(current);
        if (!title || title === current) return;
        await getJson('/rest/thread/set_thread_title?' + API, {
            method: 'POST', headers: JSON_HEADERS,
            body: JSON.stringify({ context_uuid: entry.context_uuid, title, read_write_token: entry.read_write_token }),
        });
    }

    function addClearUnpinned() {
        if (location.pathname !== '/library' || document.querySelector('[' + CLEAR_ATTR + ']')) return;
        const newLink = [...document.querySelectorAll('main a[href]')].find((a) => a.textContent.trim() === 'New');
        if (!newLink || !newLink.parentElement) return;
        // Same look as the "New" button next to it.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = newLink.className;
        button.innerHTML = newLink.innerHTML;
        button.setAttribute(CLEAR_ATTR, '');
        button.title = 'Delete every session that is not pinned';
        const use = button.querySelector('use');
        if (use) use.setAttribute('xlink:href', '#pplx-icon-trash');
        const text = button.querySelector('span');
        if (!text) return;
        text.textContent = 'Clear unpinned';
        button.addEventListener('click', () => clearUnpinned(button));
        newLink.parentElement.before(button);
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
