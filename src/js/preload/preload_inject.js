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
            // News in Thai while the interface stays English. Perplexity picks the
            // language of Discover stories from Accept-Language (measured: the
            // feed, an article and its related pages come back translated, the
            // Discover topic names too, so topics are left alone). Finance's story
            // cards ignore it and stay English until opened, so each card's title
            // and summary are swapped for the article's Thai ones, cached by uuid.
            const NEWS_LANG = 'th-TH';
            const TRANSLATED = /\/rest\/(discover\/feed|article\/|page\/get_related_pages)/;
            const CACHE_KEY = 'simplex:news-th';
            const cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; } })();
            const saveCache = () => {
                const keys = Object.keys(cache);
                for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete cache[k]; // oldest first
                try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
            };
            const inFlight = {};
            const thaiCard = (item) => cache[item.uuid] ? Promise.resolve(cache[item.uuid]) : (inFlight[item.uuid] = inFlight[item.uuid]
                || send(`/rest/article/${item.slug || item.uuid}?version=2.18&source=default`, { headers: { 'Accept-Language': NEWS_LANG } })
                    .then((r) => r.json())
                    .then((j) => {
                        const info = j.entries?.[0]?.article_info;
                        if (!info?.title) return null;
                        cache[item.uuid] = { title: info.title, summary: info.summary || '' };
                        saveCache();
                        return cache[item.uuid];
                    })
                    .catch(() => null)
                    .finally(() => delete inFlight[item.uuid]));
            // Wait at most this long for misses; the rest finish in the background
            // and are Thai from the cache on the next visit.
            const CARD_WAIT_MS = 2500;
            const translateCatalog = async (res) => {
                if (!res.ok) return res;
                let items;
                try { items = await res.clone().json(); } catch { return res; }
                if (!Array.isArray(items)) return res;
                const done = Promise.all(items.map(async (item) => {
                    if (item?.item_type !== 'pplx_page' || !item.uuid) return;
                    const th = await thaiCard(item);
                    if (!th) return;
                    item.title = th.title;
                    item.short_title = th.title;
                    if (th.summary) item.summary = th.summary;
                }));
                await Promise.race([done, new Promise((r) => setTimeout(r, CARD_WAIT_MS))]);
                return new Response(JSON.stringify(items), { status: res.status, statusText: res.statusText, headers: res.headers });
            };
            // Perplexity's topic feeds keep stories for months (measured: Sports'
            // newest was 12 days old, Arts' median 100 days, Top's 9.6). Drop
            // anything older than a week; a page with nothing fresh ends the feed,
            // so infinite scroll does not keep fetching pages of old news.
            const MAX_STORY_AGE_MS = 7 * 86400000;
            const freshFeed = async (res) => {
                if (!res.ok) return res;
                let feed;
                try { feed = await res.clone().json(); } catch { return res; }
                if (!Array.isArray(feed.items)) return res;
                // updated_datetime comes without a zone; it is UTC.
                const age = (s) => Date.now() - Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
                const fresh = feed.items.filter((x) => !x.updated_datetime || age(x.updated_datetime) < MAX_STORY_AGE_MS);
                if (fresh.length === feed.items.length) return res;
                feed.items = fresh;
                if (!fresh.length) feed.next_token = null;
                return new Response(JSON.stringify(feed), { status: res.status, statusText: res.statusText, headers: res.headers });
            };
            window.fetch = async function (input, init) {
                // The ask call passes a URL object; a Request carries .url.
                const url = input instanceof Request ? input.url : String(input);
                if (TRANSLATED.test(url)) {
                    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
                    headers.set('Accept-Language', NEWS_LANG);
                    const res = send.call(this, input, { ...init, headers });
                    return url.includes('/rest/discover/feed') ? freshFeed(await res) : res;
                }
                if (url.includes('/rest/finance/discover-catalog/')) return translateCatalog(await send.call(this, input, init));
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

    // The Discover feed's right column (weather, Market Outlook, Trending
    // Companies) is its only <aside>. Mark its grid so the stylesheet can drop
    // the column and give the news the full width. Feed pages only, not articles.
    function markDiscoverFeed() {
        if (!/^\/discover(\/(?!you\/)[^/]*)?$/.test(location.pathname)) return;
        const grid = document.querySelector('main aside')?.parentElement;
        if (grid && !grid.hasAttribute('data-simplex-discover-feed')) grid.setAttribute('data-simplex-discover-feed', '');
    }

    // Discover has no "latest" view and only five broad topics, and its Sports
    // feed is stale (newest story 12 days old when measured) while For You and
    // the other feeds carry fresh F1 and UFC stories. So the filter bar pools
    // every feed Perplexity serves, keeps the past week, and lists it newest
    // first, either all of it (Latest) or one sport. Perplexity's own feed
    // stays underneath; clicking the active chip again goes back to it.
    // Stories are matched on the slug, which stays English when titles are Thai.
    const NEWS_FILTERS = [
        { id: 'latest', label: 'Latest' },
        { id: 'sports', label: 'Sports' },
        { id: 'f1', label: 'F1', re: /\b(f1|formula (1|one)|grand prix|verstappen|hamilton|leclerc|norris|piastri|antonelli|russell|alonso|sainz|gasly|albon|tsunoda|hulkenberg|bortoleto|lawson|hadjar|bearman|colapinto|mclaren|red bull racing|fia)\b/ },
        { id: 'mma', label: 'MMA', re: /\b(ufc|mma|bellator|pfl|octagon|chimaev|pereira|volkanovski|evloev|mcgregor|strickland|makhachev|topuria|ankalaev|du plessis|adesanya|aspinall|o ?malley|dvalishvili|holloway|poirier|gaethje)\b/ },
        { id: 'boxing', label: 'Boxing', re: /\b(boxing|boxer|usyk|tyson fury|anthony joshua|canelo|crawford|inoue|bivol|beterbiev|haney|gervonta|jake paul|wbc|wba|ibf|wbo)\b/ },
    ];
    const OTHER_SPORTS = /\b(nba|nfl|nhl|mlb|wnba|premier league|la liga|serie a|bundesliga|champions league|uefa|fifa|world cup|soccer|football|tennis|atp|wta|wimbledon|golf|pga|liv golf|olympics?|cricket|rugby|motogp|nascar|indycar|super bowl|playoffs?)\b/;
    const storyText = (x) => ((x.slug || '').replace(/-[A-Za-z0-9._]{20,}$/, '') + ' ' + (x.title || '')).replace(/[-_]/g, ' ').toLowerCase();
    function storyMatches(filterId, x) {
        if (filterId === 'latest') return true;
        const text = storyText(x);
        if (filterId === 'sports') return OTHER_SPORTS.test(text) || NEWS_FILTERS.some((f) => f.re && f.re.test(text));
        return NEWS_FILTERS.find((f) => f.id === filterId).re.test(text);
    }
    const storyTime = (s) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');

    const NEWS_FEEDS = ['', 'top', '9be812cb-6120-41b7-bc9e-993200db6cfc', 'e46915e3-9d25-4f85-9e43-e8a9d834729f',
        'c69c15fd-559e-4714-b82c-481a89b82a94', '0130fdd1-4017-43ac-91ae-59ace446130f', 'f00846db-e258-4455-9e9f-74b12cfbf06d'];
    const NEWS_PAGES = 4;            // per feed, 20 stories each; offset paging works for every feed
    const NEWS_POOL_TTL_MS = 5 * 60000;
    const WEEK_MS = 7 * 86400000;
    // All pages go out at once (21 calls take about as long as the slowest one),
    // and a list redraws as each page lands, so the first stories show early.
    let newsPool = null; // { at, stories: Map, pending, listeners: Set }
    function startNewsPool() {
        if (newsPool && (newsPool.pending || Date.now() - newsPool.at < NEWS_POOL_TTL_MS)) return newsPool;
        const pool = newsPool = { at: Date.now(), stories: new Map(), pending: 0, listeners: new Set() };
        for (const topic of NEWS_FEEDS) for (let p = 0; p < NEWS_PAGES; p++) {
            pool.pending++;
            fetch(`/rest/discover/feed?limit=20&offset=${p * 20}${topic ? '&topic=' + topic : ''}&${API}`,
                { headers: { 'Accept-Language': 'th-TH' }, signal: AbortSignal.timeout(15000) })
                .then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
                .then((j) => {
                    for (const x of Array.isArray(j.items) ? j.items : []) {
                        if (x.item_type !== 'pplx_page' || !x.slug || !x.updated_datetime || pool.stories.has(x.uuid)) continue;
                        const t = storyTime(x.updated_datetime);
                        if (Date.now() - t < WEEK_MS) pool.stories.set(x.uuid, { ...x, t });
                    }
                    pool.pending--;
                    // Nothing came back at all: do not keep an empty pool for five minutes.
                    if (!pool.pending && !pool.stories.size && newsPool === pool) newsPool = null;
                    for (const f of pool.listeners) f();
                });
        }
        return pool;
    }

    const ago = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
    function timeAgo(t) {
        const min = Math.round((Date.now() - t) / 60000);
        if (min < 60) return ago.format(-Math.max(1, min), 'minute');
        if (min < 48 * 60) return ago.format(-Math.round(min / 60), 'hour');
        return ago.format(-Math.round(min / 1440), 'day');
    }
    const BREAKING_MS = 3 * 3600000;

    let newsFilter = null;       // chip shown on this page, or null for Perplexity's feed
    let newsFilterPath = null;   // the path the choice was made on
    let newsRender = 0;          // drops a render that a newer click replaced
    let newsPrefetch = null;
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function newsRow(x) {
        const a = el('a', 'simplex-news-row');
        a.href = '/discover/you/' + x.slug;
        a.addEventListener('click', (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigateInApp(a.getAttribute('href'));
        });
        const img = x.featured_images && x.featured_images[0];
        const src = img && (img.thumbnail || img.image);
        if (typeof src === 'string' && src.startsWith('https://')) {
            const pic = el('img', 'simplex-news-img');
            pic.loading = 'lazy';
            pic.referrerPolicy = 'no-referrer';
            pic.alt = '';
            pic.src = src;
            pic.addEventListener('error', () => pic.remove());
            a.append(pic);
        }
        const body = el('div', 'simplex-news-body');
        body.append(el('div', 'simplex-news-title', x.title || x.short_title || ''));
        if (x.summary) body.append(el('div', 'simplex-news-summary', x.summary));
        const meta = el('div', 'simplex-news-meta');
        if (Date.now() - x.t < BREAKING_MS) meta.append(el('span', 'simplex-news-new', 'Breaking'));
        meta.append(timeAgo(x.t));
        body.append(meta);
        a.append(body);
        return a;
    }
    function renderNews(panel, filterId) {
        const token = ++newsRender;
        const pool = startNewsPool();
        const label = NEWS_FILTERS.find((f) => f.id === filterId).label;
        let shown = '';
        let queued = false;
        const draw = () => {
            if (token !== newsRender) { pool.listeners.delete(onUpdate); return; }
            queued = false;
            const list = [...pool.stories.values()].filter((x) => storyMatches(filterId, x)).sort((a, b) => b.t - a.t).slice(0, 60);
            const key = list.map((x) => x.uuid).join() + pool.pending;
            if (key === shown) return;
            shown = key;
            const loading = pool.pending ? ' · loading more…' : '';
            panel.replaceChildren(
                el('div', 'simplex-news-head', `${label} · ${list.length} ${list.length === 1 ? 'story' : 'stories'} from the past week${loading}`),
                ...(list.length ? list.map(newsRow)
                    : [el('div', 'simplex-news-empty', pool.pending ? 'Loading…' : `No ${label} news in the past week.`)]));
        };
        // One redraw per frame however many pages land in it.
        const onUpdate = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
        pool.listeners.add(onUpdate);
        draw();
    }

    const NEWS_CSS = `
        .simplex-news-chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 20px; }
        .simplex-news-chip { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 999px; cursor: pointer;
            color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); opacity: .75; }
        .simplex-news-chip:hover { opacity: 1; }
        .simplex-news-chip[aria-pressed="true"] { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); border-color: color-mix(in srgb, currentColor 30%, transparent); }
        [data-simplex-news-open] { display: none !important; }
        .simplex-news-panel { display: flex; flex-direction: column; }
        .simplex-news-head { font-size: 13px; opacity: .6; margin-bottom: 8px; }
        .simplex-news-row { display: flex; gap: 16px; padding: 16px 0; color: inherit; text-decoration: none;
            border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
        .simplex-news-row:hover .simplex-news-title { text-decoration: underline; text-underline-offset: 3px; }
        .simplex-news-img { width: 168px; height: 104px; object-fit: cover; border-radius: 8px; flex: none; }
        .simplex-news-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .simplex-news-title { font-size: 17px; font-weight: 500; line-height: 1.4; }
        .simplex-news-summary { font-size: 14px; line-height: 1.5; opacity: .7; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .simplex-news-meta { font-size: 12px; opacity: .55; display: flex; gap: 8px; align-items: center; }
        .simplex-news-new { color: var(--decoration-pink-fg-primary, #dc6973); font-weight: 600; }
        .simplex-news-empty { padding: 24px 0; opacity: .6; font-size: 14px; }`;

    // Runs on every sweep: keeps the bar in front of Perplexity's feed grid
    // (React may replace the grid) and the panel in step with the chosen chip.
    function syncDiscoverNews() {
        const grid = document.querySelector('[data-simplex-discover-feed]');
        let bar = document.querySelector('.simplex-news-chips');
        if (!grid || !/^\/discover(\/(?!you\/)[^/]*)?$/.test(location.pathname)) {
            bar?.remove();
            document.querySelector('.simplex-news-panel')?.remove();
            return;
        }
        // Fetch ahead, so a chip shows its list at once (and Sports opens on it).
        if (!newsPrefetch && (!newsPool || !newsPool.pending && Date.now() - newsPool.at > NEWS_POOL_TTL_MS)) newsPrefetch = setTimeout(() => { newsPrefetch = null; startNewsPool(); }, 1000);
        if (newsFilterPath !== location.pathname) {
            newsFilterPath = location.pathname;
            // Perplexity's Sports feed is weeks old; open its tab on the fresh list.
            newsFilter = location.pathname === '/discover/sports' ? 'sports' : null;
        }
        if (!document.getElementById('simplex-news-style')) {
            const style = el('style', null, NEWS_CSS);
            style.id = 'simplex-news-style';
            document.head.append(style);
        }
        if (!bar) {
            bar = el('div', 'simplex-news-chips');
            bar.setAttribute('role', 'toolbar');
            bar.setAttribute('aria-label', 'Filter news');
            for (const f of NEWS_FILTERS) {
                const chip = el('button', 'simplex-news-chip', f.label);
                chip.type = 'button';
                chip.dataset.filter = f.id;
                chip.addEventListener('click', () => {
                    newsFilter = newsFilter === f.id ? null : f.id;
                    syncDiscoverNews();
                });
                bar.append(chip);
            }
        }
        if (bar.nextElementSibling !== grid && grid.previousElementSibling?.className !== 'simplex-news-panel') grid.before(bar);
        for (const chip of bar.children) chip.setAttribute('aria-pressed', String(chip.dataset.filter === newsFilter));

        let panel = document.querySelector('.simplex-news-panel');
        if (!newsFilter) {
            panel?.remove();
            grid.removeAttribute('data-simplex-news-open');
            return;
        }
        if (!panel || panel.dataset.filter !== newsFilter) {
            panel?.remove();
            panel = el('div', 'simplex-news-panel');
            panel.dataset.filter = newsFilter;
            renderNews(panel, newsFilter);
        }
        if (panel.previousElementSibling !== bar) bar.after(panel);
        grid.setAttribute('data-simplex-news-open', '');
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

    // Code in a rich paste (a blog post, a GitHub page, an answer) arrives as
    // bare lines, so the question shows it as prose, with the page's language
    // label ("json") as a line of its own. A question bubble does draw a
    // Markdown fence as a code block with its language, so each <pre> of the
    // pasted HTML is put back into the plain text as a ```lang fence and the
    // label line above it is dropped. Returns null when there is no code.
    const LANG = /^[\w#+.-]{1,20}$/;
    // A bare word above the code counts as its label only if it names a language.
    const LANG_NAMES = /^(json|jsonc?|js|javascript|ts|typescript|jsx|tsx|python|py|bash|sh|shell|zsh|fish|powershell|pwsh|ps1|cmd|bat|batch|c|cpp|c\+\+|cs|csharp|c#|go|golang|rust|rs|java|kotlin|kt|swift|objc|ruby|rb|php|sql|html|css|scss|xml|yaml|yml|toml|ini|conf|md|markdown|diff|patch|dockerfile|docker|lua|r|perl|dart|scala|elixir|haskell|text|txt|plaintext|console|terminal|http|graphql|nginx|makefile|vim|regex|csv|env|hcl|terraform|solidity|asm|nasm)$/i;
    function codeLanguage(pre) {
        for (let el = pre.querySelector('code') || pre, depth = 0; el && depth < 4; el = el.parentElement, depth++) {
            const named = (el.className && String(el.className).match(/(?:language|lang|highlight-source)-([\w#+.-]+)/))
                || [, el.getAttribute && (el.getAttribute('data-language') || el.getAttribute('data-lang'))];
            if (named[1] && LANG.test(named[1])) return named[1].toLowerCase();
        }
        const caption = pre.querySelector('figcaption');
        if (caption && LANG.test(caption.textContent.trim())) return caption.textContent.trim().toLowerCase();
        return '';
    }

    function fenceCode(html, text) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html; // inert: nothing in it loads or runs
        let out = text;
        let from = 0;
        let changed = false;
        for (const pre of tpl.content.querySelectorAll('pre')) {
            const code = (pre.querySelector('code') || pre).textContent.replace(/\n+$/, '');
            if (!code.trim()) continue;
            const at = out.indexOf(code, from);
            if (at < 0) continue; // the plain text differs from the HTML here; leave it as it is
            // The label is the text just before the code: on the line above, or
            // run into the code's first line when the page had no line break.
            const lineStart = out.lastIndexOf('\n', at - 1) + 1;
            const labelStart = at > lineStart ? lineStart : out.lastIndexOf('\n', lineStart - 2) + 1;
            const label = out.slice(labelStart, at > lineStart ? at : lineStart).trim();
            if (/^`{3,}/.test(label)) { from = at + code.length; continue; } // already fenced
            const lang = codeLanguage(pre) || (LANG_NAMES.test(label) ? label.toLowerCase() : '');
            const dropLabel = lang && label.toLowerCase() === lang;
            const keepUpTo = dropLabel ? labelStart : at;
            const lead = keepUpTo > 0 && out[keepUpTo - 1] !== '\n' ? '\n' : '';
            const ticks = '`'.repeat(Math.max(3, ...(code.match(/`+/g) || []).map((run) => run.length + 1)));
            const fenced = `${lead}${ticks}${lang}\n${code}\n${ticks}`;
            out = out.slice(0, keepUpTo) + fenced + out.slice(at + code.length);
            from = keepUpTo + fenced.length;
            changed = true;
        }
        return changed ? out : null;
    }

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

            const html = data.types.includes('text/html') ? data.getData('text/html') : '';
            const fenced = html.includes('<pre') ? fenceCode(html, text) : null;
            if (fenced || (html && text.length >= PLAIN_PASTE_FROM)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const plain = new DataTransfer();
                plain.setData('text/plain', fenced || text);
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
        if (isMain) {
            markMarketSummary();
            markDiscoverFeed();
            syncDiscoverNews();
        }
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
    const ICON_TIMEOUT_MS = 10000;
    let projectIconStyle = null;

    async function paintProjectIcons() {
        // A dead connection would hold these forever; time out and let the retry below try again.
        const list = await fetch('/rest/spaces/landing/v2?limit=100&ordered=true&' + API, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
        if (!list.ok) throw new Error('project list ' + list.status);
        const projects = Object.values((await list.json()).sections || {})
            .flatMap((section) => section.items || [])
            .filter((p) => /^[0-9a-f-]{36}$/.test(p.uuid));

        const iconIds = [...new Set(projects.map((p) => p.appearance && p.appearance.icon)
            .filter((icon) => /^[\w-]+$/.test(icon || '')))].map((icon) => 'pplx-data-' + icon);
        const masks = {};
        if (iconIds.length) {
            const res = await fetch('/rest/spaces/icon?' + API, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: iconIds }),
                signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error('project icons ' + res.status);
            const { icons } = await res.json();
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

    // The icons are fetched once per page, so one lookup lost to a stalled
    // connection left the sidebar grey until a project page was opened. Retry
    // with backoff (2, 4, 8, 16, 32 s), as the page's own calls do.
    function refreshProjectIcons(attempt = 0) {
        paintProjectIcons().catch((err) => {
            console.warn('[simplex] project icons:', err.message);
            if (attempt < 5) setTimeout(() => refreshProjectIcons(attempt + 1), 2000 * 2 ** attempt);
        });
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
