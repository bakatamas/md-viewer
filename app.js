'use strict';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const MERMAID_URL = CDN + 'mermaid@12.2.0/dist/mermaid.min.js';
const FOOTNOTE_URL = CDN + 'marked-footnote@1.4.0/dist/index.umd.js';
const KATEX_URL = CDN + 'katex@0.18.11/dist/katex.min.js';
const KATEX_CSS_URL = CDN + 'katex@0.18.11/dist/katex.min.css';
const MARKED_KATEX_URL = CDN + 'marked-katex-extension@5.1.13/lib/index.umd.js'; // needs katex < 0.19
const POLL_MS = 1000;
const RECENT_MAX = 10;
const ABOUT_URL = 'about.md';

const $ = (id) => document.getElementById(id);
const content = $('content');
const toc = $('toc');
const scroller = $('scroller');
const tabsEl = $('tabs');
const noticeEl = $('notice');
const emptyHtml = content.innerHTML;

// Open files. Each tab: { id, name, text, handle, lastModified, size, scrollTop, unavailable, needsPermission }.
// `handle` is a FileSystemFileHandle, only where supported (Chrome/Edge); without it a tab can't auto-refresh.
// `needsPermission`: restored after a reload, the browser wants a click before reading the file again.
const tabs = [];
let active = null;
let tabCounter = 0;
let mermaidCounter = 0;
let renderGen = 0;          // lets an in-flight Mermaid render notice it has been superseded

/* ---------- Theme ---------- */

// The theme list lives in the <select> in index.html; the inline script in <head> applies the
// saved theme before first paint, this keeps it in sync and handles changes.
const themeSelect = $('theme-select');
const THEMES = [...themeSelect.options].map((o) => o.value);
let theme = document.documentElement.dataset.theme;
if (!THEMES.includes(theme)) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark-slate' : 'light-snow';

function isDark() {
  return theme.startsWith('dark');
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
  const dark = isDark();
  $('hljs-light').disabled = dark;
  $('hljs-dark').disabled = !dark;
  $('theme-color').content = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
}

// Picked with the mouse: hand focus back to the document, or the arrow keys would keep changing
// the theme instead of scrolling. Keyboard users browsing themes keep focus on the select.
let themeByPointer = false;
themeSelect.addEventListener('pointerdown', () => { themeByPointer = true; });
themeSelect.addEventListener('keydown', () => { themeByPointer = false; });
themeSelect.addEventListener('change', () => {
  theme = themeSelect.value;
  try { localStorage.setItem('mdv-theme', theme); } catch (e) { /* storage unavailable */ }
  applyTheme();
  if (active) render(active.text, scroller.scrollTop); // Mermaid needs re-rendering for its theme
  if (themeByPointer) focusDocument();
  themeByPointer = false;
});
applyTheme();

/* ---------- Table of contents toggle ---------- */

let tocVisible = true;
try { tocVisible = localStorage.getItem('mdv-toc') !== 'off'; } catch (e) { /* ignore */ }

function applyToc() {
  toc.classList.toggle('hidden', !tocVisible);
  $('toc-btn').setAttribute('aria-pressed', String(tocVisible));
}
$('toc-btn').addEventListener('click', (e) => {
  tocVisible = !tocVisible;
  try { localStorage.setItem('mdv-toc', tocVisible ? 'on' : 'off'); } catch (err) { /* ignore */ }
  applyToc();
  if (e.detail) focusDocument();
});
applyToc();

/* ---------- Full-width toggle ---------- */

let wide = false;
try { wide = localStorage.getItem('mdv-wide') === 'on'; } catch (e) { /* ignore */ }

function applyWide() {
  content.classList.toggle('wide', wide);
  $('wide-btn').setAttribute('aria-pressed', String(wide));
}
$('wide-btn').addEventListener('click', (e) => {
  wide = !wide;
  try { localStorage.setItem('mdv-wide', wide ? 'on' : 'off'); } catch (err) { /* ignore */ }
  applyWide();
  if (e.detail) focusDocument();
});
applyWide();

/* ---------- Toast (zoom level, small errors) ---------- */

const toastEl = $('toast');
let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1200);
}

/* ---------- Text zoom: Ctrl +/-/0 and Ctrl+wheel scale the document, not the app ---------- */

const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
let zoom = 1;
try {
  const z = parseFloat(localStorage.getItem('mdv-zoom'));
  if (ZOOM_STEPS.includes(z)) zoom = z;
} catch (e) { /* ignore */ }

function setZoom(z) {
  if (z === zoom) return;
  // Keep the same relative position in the document across the size change
  const range = scroller.scrollHeight - scroller.clientHeight;
  const ratio = range > 0 ? scroller.scrollTop / range : 0;
  zoom = z;
  content.style.setProperty('--zoom', zoom);
  scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
  try { localStorage.setItem('mdv-zoom', String(zoom)); } catch (e) { /* ignore */ }
  toast(Math.round(zoom * 100) + '%');
}

function zoomBy(dir) {
  const i = ZOOM_STEPS.indexOf(zoom);
  setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))]);
}

content.style.setProperty('--zoom', zoom);

// Ctrl+wheel (and touchpad pinch, which arrives as Ctrl+wheel) would zoom the whole app
let wheelZoom = 0;
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  wheelZoom += e.deltaY;
  if (Math.abs(wheelZoom) >= 60) {
    zoomBy(wheelZoom < 0 ? 1 : -1);
    wheelZoom = 0;
  }
}, { passive: false });

/* ---------- Smooth scrolling to in-page links ---------- */

// Done here rather than with CSS scroll-behavior, which would also animate the app's own
// scroll restores (tab switches, re-renders).
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function scrollToAnchor(e) {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  let id;
  try { id = decodeURIComponent(a.getAttribute('href').slice(1)); } catch (err) { return; }
  const target = id && document.getElementById(id);
  if (!target || !content.contains(target)) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  if (e.detail) focusDocument(); // a clicked TOC link would otherwise keep focus in the sidebar
}
toc.addEventListener('click', scrollToAnchor);
content.addEventListener('click', scrollToAnchor);

/* ---------- Rendering ---------- */

function slugify(text) {
  return text.toLowerCase().trim()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-') || 'section';
}

// Headings that belong to the document's own outline (not the footnotes' hidden label)
function docHeadings(selector) {
  return [...content.querySelectorAll(selector)].filter((h) => !h.closest('.footnotes'));
}

// Visible heading text: KaTeX keeps a hidden MathML copy of each formula, and footnote
// references would add their number
function headingText(h) {
  if (!h.querySelector('.katex-mathml, [data-footnote-ref]')) return h.textContent;
  const clone = h.cloneNode(true);
  for (const el of clone.querySelectorAll('.katex-mathml, sup:has([data-footnote-ref])')) el.remove();
  return clone.textContent;
}

function addHeadingIds() {
  const used = new Map();
  for (const h of docHeadings('h1, h2, h3, h4, h5, h6')) {
    const base = slugify(headingText(h));
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

let tocEntries = [];   // [{ a, h }] for highlighting the current section
let currentEntry = null;

function buildToc() {
  toc.textContent = '';
  tocEntries = [];
  currentEntry = null;
  const headings = docHeadings('h1, h2, h3');
  if (headings.length < 2) return; // nothing worth navigating
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = headingText(h);
    a.className = 'l' + h.tagName[1];
    toc.appendChild(a);
    tocEntries.push({ a, h });
  }
}

// The current section is the last heading that has reached the top of the view
// (or the last one, once the document is scrolled to the bottom).
function updateCurrentSection() {
  if (!tocEntries.length) return;
  const top = scroller.getBoundingClientRect().top + 40;
  let current = null;
  for (const entry of tocEntries) {
    if (entry.h.getBoundingClientRect().top <= top) current = entry;
    else break;
  }
  if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    current = tocEntries[tocEntries.length - 1];
  }
  if (current === currentEntry) return;
  if (currentEntry) currentEntry.a.classList.remove('current');
  currentEntry = current;
  if (current) {
    current.a.classList.add('current');
    current.a.scrollIntoView({ block: 'nearest' });
  }
}

let spyFrame = 0;
scroller.addEventListener('scroll', () => {
  if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; updateCurrentSection(); });
}, { passive: true });

const scriptPromises = new Map();
function loadScript(url) {
  if (!scriptPromises.has(url)) {
    scriptPromises.set(url, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => { scriptPromises.delete(url); s.remove(); reject(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    }));
  }
  return scriptPromises.get(url);
}

function loadMermaid() {
  return loadScript(MERMAID_URL).then(() => window.mermaid);
}

// marked extensions, loaded the first time a document looks like it needs them. Until then the
// document renders without them and is re-rendered once they're in.
const extensions = [
  {
    test: /\[\^[^\]\s]+\]/, // footnote reference or definition
    load: async () => {
      await loadScript(FOOTNOTE_URL);
      marked.use(window.markedFootnote({ description: 'Footnotes' }));
    },
  },
  {
    test: /\$\$|\$[^\s$][^$\n]*\$/, // $inline$ or $$block$$ math
    load: async () => {
      if (!document.querySelector('link[data-katex]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.crossOrigin = 'anonymous';
        css.href = KATEX_CSS_URL;
        css.dataset.katex = '';
        document.head.appendChild(css);
      }
      await loadScript(KATEX_URL);
      await loadScript(MARKED_KATEX_URL);
      marked.use(window.markedKatex({ throwOnError: false }));
    },
  },
];

function loadNeededExtensions(text) {
  const pending = [];
  for (const x of extensions) {
    if (x.ready || !x.test.test(text)) continue;
    if (!x.promise) {
      x.promise = x.load().then(() => { x.ready = true; }, (e) => { x.promise = null; throw e; });
    }
    pending.push(x.promise);
  }
  return pending.length ? Promise.all(pending) : null;
}

/* Front matter: a leading --- block of "key: value" lines, shown as a collapsed table */

function splitFrontMatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: null, body: text };
  const meta = parseFrontMatter(m[1]);
  // Anything that doesn't look like YAML means it was a horizontal rule followed by text
  return meta ? { meta, body: text.slice(m[0].length) } : { meta: null, body: text };
}

// Deliberately tiny YAML subset: top-level keys, with indented lines and "- item" lines (list
// items, block scalars, nested maps) folded into the previous key's value. Returns null unless
// every line fits, so ordinary text between two --- lines is never hidden.
function parseFrontMatter(src) {
  const rows = [];
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([^\s#:-][^:]*?):(?:[ \t]+(.*))?$/.exec(line);
    if (kv) {
      rows.push({ key: kv[1].trim(), value: (kv[2] || '').trim(), block: false });
    } else if (rows.length && /^(\s+\S|-(\s|$))/.test(line)) {
      const row = rows[rows.length - 1];
      const item = line.trim().replace(/^-\s*/, '');
      if (/^[|>][-+]?$/.test(row.value)) { row.value = ''; row.block = true; }
      row.value = row.value ? row.value + (row.block ? ' ' : ', ') + item : item;
    } else {
      return null;
    }
  }
  if (!rows.length) return null;
  return rows.map((r) => [r.key, r.value.replace(/^(['"])(.*)\1$/, '$2').replace(/^\[(.*)\]$/, '$1')]);
}

let frontMatterOpen = false;
try { frontMatterOpen = localStorage.getItem('mdv-fm') === 'open'; } catch (e) { /* ignore */ }

function frontMatterElement(meta) {
  const details = document.createElement('details');
  details.className = 'front-matter';
  details.open = frontMatterOpen;
  details.addEventListener('toggle', () => {
    frontMatterOpen = details.open;
    try { localStorage.setItem('mdv-fm', frontMatterOpen ? 'open' : 'closed'); } catch (e) { /* ignore */ }
  });
  const summary = document.createElement('summary');
  summary.textContent = 'Properties';
  const table = document.createElement('table');
  for (const [key, value] of meta) {
    const tr = table.insertRow();
    const th = document.createElement('th');
    th.textContent = key;
    tr.appendChild(th);
    tr.insertCell().textContent = value;
  }
  details.append(summary, table);
  return details;
}

/* GitHub-style callouts: a blockquote starting with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION] */

const ALERT_TITLES = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

function styleAlerts() {
  for (const bq of content.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    const first = p && p.tagName === 'P' ? p.firstChild : null;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i.exec(first.data);
    if (!m) continue;
    first.data = first.data.slice(m[0].length);
    if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent.trim() && !p.children.length) p.remove();
    const type = m[1].toLowerCase();
    bq.classList.add('alert', 'alert-' + type);
    const title = document.createElement('p');
    title.className = 'alert-title';
    title.textContent = ALERT_TITLES[type];
    bq.prepend(title);
  }
}

/* Copy button on code blocks. The pre is wrapped so the button doesn't scroll away with wide code. */

function addCopyButton(pre) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';
  pre.replaceWith(wrap);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.setAttribute('aria-label', 'Copy code');
  let reset = null;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      btn.textContent = 'Copied';
    } catch (e) {
      btn.textContent = 'Copy failed';
    }
    clearTimeout(reset);
    reset = setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
  wrap.append(pre, btn);
}

async function renderMermaid(blocks, scrollTop, gen) {
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (e) {
    for (const el of blocks) el.classList.add('mermaid-error');
    return;
  }
  mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict' });
  for (const el of blocks) {
    if (gen !== renderGen) return;
    const src = el.dataset.source;
    try {
      const { svg } = await mermaid.render('mmd-' + (++mermaidCounter), src);
      el.innerHTML = svg;
    } catch (e) {
      el.classList.add('mermaid-error');
      el.textContent = 'Mermaid error: ' + (e && e.message ? e.message : e) + '\n\n' + src;
    }
  }
  // Diagrams change the page height, so restore the position once they're in
  if (gen === renderGen) {
    scroller.scrollTop = scrollTop;
    updateCurrentSection();
  }
}

function render(text, scrollTop) {
  const gen = ++renderGen;
  const { meta, body } = splitFrontMatter(text);
  const loading = loadNeededExtensions(body);
  if (loading) loading.then(() => { if (gen === renderGen) render(text, scroller.scrollTop); }, (e) => console.warn(e));

  const html = marked.parse(body, { gfm: true });
  content.innerHTML = DOMPurify.sanitize(html);
  if (meta) content.prepend(frontMatterElement(meta));

  styleAlerts();
  addHeadingIds();
  buildToc();

  const mermaidBlocks = [];
  for (const code of content.querySelectorAll('pre > code')) {
    if (code.classList.contains('language-mermaid')) {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.dataset.source = code.textContent;
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
      mermaidBlocks.push(div);
    } else {
      // Only highlight a known, named language: without one hljs guesses, and colours plain text randomly
      const lang = (/\blanguage-(\S+)/.exec(code.className) || [])[1];
      if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
      addCopyButton(code.parentElement);
    }
  }

  for (const a of content.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href'))) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }

  scroller.scrollTop = scrollTop;
  updateCurrentSection();
  if (mermaidBlocks.length) renderMermaid(mermaidBlocks, scrollTop, gen);
}

// After a mouse action in the header, hand keyboard focus to the document so PageDown, Space and
// the arrow keys scroll it (a focused tab or button would swallow them). Keyboard use of the tabs
// keeps focus in the strip instead.
function focusDocument() {
  if (active) scroller.focus({ preventScroll: true });
}

function showEmpty() {
  ++renderGen;
  content.innerHTML = emptyHtml;
  toc.textContent = '';
  tocEntries = [];
  currentEntry = null;
  scroller.scrollTop = 0;
  renderRecent();
}

/* ---------- Tabs ---------- */

function renderTabs() {
  // The strip is rebuilt, so remember which tab had keyboard focus (a close button counts as its tab)
  const hadFocus = tabsEl.contains(document.activeElement);
  const focusedId = hadFocus ? document.activeElement.closest('.tab')?.dataset.id : null;
  tabsEl.textContent = '';
  if (!tabs.length) {
    const span = document.createElement('span');
    span.className = 'no-file';
    span.textContent = 'No file open';
    tabsEl.appendChild(span);
  }
  for (const t of tabs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t === active ? ' active' : '') + (t.unavailable ? ' unavailable' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(t === active));
    tab.title = t.unavailable ? t.name + ' (file unavailable, showing the last version)' : t.name;
    tab.tabIndex = 0;
    tab.dataset.id = t.id;
    tab.addEventListener('click', (e) => {
      activate(t);
      if (e.detail) focusDocument(); // detail is 0 for clicks synthesized from the keyboard
    });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
    tab.addEventListener('keydown', (e) => {
      if (e.target !== tab || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(t); }
      else if (e.key === 'Delete') { e.preventDefault(); closeTab(t); }
    });
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      dragTab = t;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TAB_DRAG_TYPE, String(t.id));
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => {
      dragTab = null;
      tab.classList.remove('dragging');
      clearDropMarker();
    });

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = 'Close (Ctrl+W)';
    close.setAttribute('aria-label', 'Close ' + t.name);
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t);
      if (e.detail) focusDocument();
    });

    tab.append(name, close);
    tabsEl.appendChild(tab);
    if (t === active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  if (hadFocus) {
    // The same tab if it still exists (switching, background re-render), else the active one (after closing)
    const target = tabsEl.querySelector(`.tab[data-id="${focusedId}"]`) || tabsEl.querySelector('.tab.active');
    (target || $('open-btn')).focus({ preventScroll: true });
  }
}

/* Reordering tabs by dragging. A custom data type keeps these drags apart from file drops. */

const TAB_DRAG_TYPE = 'application/x-mdv-tab';
let dragTab = null;
let dropIndex = -1;

// Checked on the drag itself, not just `dragTab`: if the strip is re-rendered mid-drag, the
// dragged element is gone and its dragend never fires, which would leave `dragTab` stale.
function isTabDrag(e) {
  return dragTab && e.dataTransfer.types.includes(TAB_DRAG_TYPE);
}

function clearDropMarker() {
  for (const el of tabsEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  dropIndex = -1;
}

tabsEl.addEventListener('dragover', (e) => {
  if (!isTabDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const els = [...tabsEl.querySelectorAll('.tab')];
  let index = els.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
  if (index < 0) index = els.length;
  if (index === dropIndex) return;
  clearDropMarker();
  dropIndex = index;
  if (index < els.length) els[index].classList.add('drop-before');
  else els[els.length - 1].classList.add('drop-after');
});

tabsEl.addEventListener('drop', (e) => {
  if (!isTabDrag(e)) {
    dragTab = null;
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const from = tabs.indexOf(dragTab);
  let to = dropIndex;
  clearDropMarker();
  if (from < 0 || to < 0) return;
  if (to > from) to--;
  if (to !== from) {
    tabs.splice(from, 1);
    tabs.splice(to, 0, dragTab);
    renderTabs();
    saveSession();
  }
});

// Let a vertical mouse wheel scroll the (scrollbar-less) tab strip sideways
tabsEl.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && tabsEl.scrollWidth > tabsEl.clientWidth) {
    tabsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

function updateNotice() {
  noticeEl.hidden = !(active && active.needsPermission);
}

function activate(tab) {
  if (active === tab) return;
  if (active) active.scrollTop = scroller.scrollTop;
  active = tab;
  render(tab.text, tab.scrollTop);
  document.title = tab.name + ' – Markdown Viewer';
  renderTabs();
  updateNotice();
  saveSession();
  // Nothing focused (startup restore, a file opened from the OS): the page itself doesn't scroll,
  // so keyboard scrolling would do nothing until the user clicked into the document
  if (document.activeElement === document.body) focusDocument();
  checkForChanges(); // background tabs aren't polled, so catch up on switching
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab === active) {
    active = null;
    if (tabs.length) {
      activate(tabs[Math.min(i, tabs.length - 1)]);
      return;
    }
    showEmpty();
    document.title = 'Markdown Viewer';
  }
  renderTabs();
  updateNotice();
  saveSession();
}

async function findTab(file, handle) {
  for (const t of tabs) {
    if (handle && t.handle) {
      try { if (await t.handle.isSameEntry(handle)) return t; } catch (e) { /* ignore */ }
    } else if (!handle && !t.handle && t.name === file.name && t.size === file.size && t.lastModified === file.lastModified) {
      return t;
    }
  }
  return null;
}

/* ---------- Opening files ---------- */

async function openFile(file, handle) {
  const text = await file.text();
  let tab = await findTab(file, handle);
  if (tab) {
    tab.text = text;
    tab.lastModified = file.lastModified;
    tab.size = file.size;
    tab.unavailable = false;
    if (handle) { tab.handle = handle; tab.needsPermission = false; }
    if (tab === active) render(text, scroller.scrollTop);
  } else {
    tab = { id: ++tabCounter, name: file.name, text, handle: handle || null,
      lastModified: file.lastModified, size: file.size, scrollTop: 0, unavailable: false, needsPermission: false };
    tabs.push(tab);
  }
  if (handle) addRecent(handle);
  activate(tab);
  renderTabs();
  updateNotice();
  saveSession();
}

async function openWithHandle(handle) {
  await openFile(await handle.getFile(), handle);
}

// fromPointer: opened by a mouse click on the folder button, so a cancelled picker also hands
// focus back to the document (Ctrl+O already returns focus to where it was).
async function openPicker(fromPointer) {
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'], 'text/plain': ['.txt'] } }],
        excludeAcceptAllOption: false,
      });
      for (const h of handles) await openWithHandle(h);
      focusDocument();
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
      else if (fromPointer) focusDocument();
    }
  } else {
    $('file-input').click();
  }
}
$('open-btn').addEventListener('click', (e) => openPicker(e.detail > 0));

/* Keyboard shortcuts. Chrome only lets a page take over Ctrl+W, Ctrl+Tab and Ctrl+1…9 in an
   installed app's window; in a normal browser tab they keep their browser meaning. */

function switchTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i + step + tabs.length) % tabs.length]);
}

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();

  // Zoom keys come first: '+' needs Shift on many layouts
  if (key === '+' || key === '=' || e.code === 'NumpadAdd') { e.preventDefault(); zoomBy(1); return; }
  if (key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomBy(-1); return; }
  if (key === '0' || e.code === 'Numpad0') { e.preventDefault(); setZoom(1); return; }

  if (key === 'tab' || key === 'pagedown' || key === 'pageup') {
    if (!tabs.length) return;
    e.preventDefault();
    switchTab(key === 'pageup' || (key === 'tab' && e.shiftKey) ? -1 : 1);
    return;
  }
  if (e.shiftKey) return;
  if (/^[1-9]$/.test(key)) {
    // Ctrl+9 is always the last tab; Ctrl+N past the last tab does nothing, as in Chrome
    const target = key === '9' ? tabs[tabs.length - 1] : tabs[+key - 1];
    if (!tabs.length) return;
    e.preventDefault();
    if (target) activate(target);
    return;
  }
  if (e.repeat) return;
  if (key === 'o') {
    e.preventDefault();
    openPicker();
  } else if (key === 'w' && active) {
    // With no document open the default runs and the window closes
    e.preventDefault();
    closeTab(active);
  }
});

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await openFile(f, null);
  focusDocument();
});

/* Drag and drop anywhere on the window */
const dropEl = $('drop');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropEl.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropEl.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  // getAsFileSystemHandle and getAsFile must be called synchronously, before any await
  const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => ({
    handlePromise: i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null,
    file: i.getAsFile(),
  }));
  for (const { handlePromise, file } of items) {
    try {
      const handle = handlePromise ? await handlePromise : null;
      if (handle && handle.kind === 'file') await openWithHandle(handle);
      else if (file && !handle) await openFile(file, null); // a dropped folder has a handle of kind 'directory'
    } catch (err) {
      if (file) await openFile(file, null);
    }
  }
  focusDocument();
});

/* ---------- Auto-reload ---------- */

// Read permission for a handle. Handles restored from IndexedDB start out as 'prompt', and
// requestPermission only works from a user gesture, hence the notice with a button.
async function hasPermission(handle, request) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'read' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return !!request && await handle.requestPermission(opts) === 'granted';
}

// Only the active tab is polled; others are checked when they're switched to.
let checking = false;
async function checkForChanges() {
  const tab = active;
  if (!tab || !tab.handle || tab.needsPermission || checking || document.hidden) return;
  checking = true;
  try {
    if (!(await hasPermission(tab.handle))) {
      tab.needsPermission = true;
      return;
    }
    const file = await tab.handle.getFile();
    if (file.lastModified !== tab.lastModified) {
      tab.lastModified = file.lastModified;
      tab.size = file.size;
      tab.text = await file.text();
      if (tab === active) render(tab.text, scroller.scrollTop);
      saveSession();
    }
    if (tab.unavailable) { tab.unavailable = false; renderTabs(); }
  } catch (e) {
    // File moved, deleted or permission lost: keep showing the last version
    if (!tab.unavailable) { tab.unavailable = true; renderTabs(); }
  } finally {
    checking = false;
    updateNotice();
  }
}

$('reconnect-btn').addEventListener('click', async () => {
  const tab = active;
  if (!tab || !tab.handle) return;
  try {
    if (!(await hasPermission(tab.handle, true))) return;
  } catch (e) {
    return;
  }
  tab.needsPermission = false;
  updateNotice();
  focusDocument(); // the button just disappeared with the notice, taking focus with it
  checkForChanges();
});
setInterval(checkForChanges, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForChanges(); });

/* ---------- Session: reopen the tabs after the page is closed ---------- */

// Tabs are kept in IndexedDB (which, unlike localStorage, can hold file handles) with their
// text, so a restored tab shows its last version even before the file can be read again.
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('mdv', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('session');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('session', mode);
    const req = fn(tx.objectStore('session'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

let saveTimer = null;
let restoring = true;   // don't overwrite the saved session before it has been read

function saveSession() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (restoring) return;
  if (active) active.scrollTop = scroller.scrollTop;
  const data = {
    active: tabs.indexOf(active),
    tabs: tabs.map((t) => ({ name: t.name, text: t.text, handle: t.handle, lastModified: t.lastModified, size: t.size, scrollTop: t.scrollTop, builtin: t.builtin })),
  };
  idb('readwrite', (s) => s.put(data, 'tabs')).catch((e) => console.warn('Could not save open tabs:', e));
}

async function restoreSession() {
  let data = null;
  try { data = await idb('readonly', (s) => s.get('tabs')); } catch (e) { /* IndexedDB unavailable */ }
  await recentLoaded;
  restoring = false;
  if (!data || !data.tabs || !data.tabs.length) {
    if (!active && isFirstVisit(data)) aboutTab = await openAbout();
    if (!active) renderRecent();
    return;
  }
  const restored = data.tabs.map((t) => ({ ...t, id: ++tabCounter, handle: t.handle || null, unavailable: false, needsPermission: false }));
  tabs.unshift(...restored); // in case files were opened while this was loading
  if (!active) activate(restored[data.active] || restored[0]);
  else { renderTabs(); saveSession(); }
}

/* First visit in this browser: open the about document, once */

let aboutTab = null;   // the auto-opened about.md, closed again if the first launch brings a file

// New means nothing was ever stored: no saved session (not even an empty one), no recent files,
// no settings. `mdv-seen` makes sure it happens only once, even if about.md is closed right away.
function isFirstVisit(session) {
  try {
    if (localStorage.getItem('mdv-seen')) return false;
    localStorage.setItem('mdv-seen', '1');
    if (['mdv-theme', 'mdv-toc', 'mdv-wide', 'mdv-zoom'].some((k) => localStorage.getItem(k) !== null)) return false;
  } catch (e) {
    return false; // without storage it would reappear on every visit
  }
  return session === undefined && !recent.length;
}

// Opens about.md, or switches to its tab if it's already open. The text is always fetched fresh,
// so a tab restored from an old session picks up an updated about.md too. The tab is marked
// `builtin` (and saved that way), so a user's own file called about.md is never mistaken for it.
const isAboutTab = (t) => t.builtin === 'about';

async function openAbout() {
  try {
    const res = await fetch(ABOUT_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const tab = tabs.find(isAboutTab);
    if (tab) {
      if (tab.text !== text) {
        tab.text = text;
        tab.size = text.length;
        if (tab === active) render(text, scroller.scrollTop);
      }
      activate(tab);
      saveSession();
    } else {
      const created = { id: ++tabCounter, name: 'about.md', text, handle: null, builtin: 'about',
        lastModified: 0, size: text.length, scrollTop: 0, unavailable: false, needsPermission: false };
      tabs.push(created);
      activate(created);
    }
    return tabs.find(isAboutTab) || null;
  } catch (e) {
    console.warn('Could not load about.md:', e);
    return null;
  }
}

$('about-btn').addEventListener('click', async (e) => {
  const tab = await openAbout();
  if (!tab) toast('Could not load the about page');
  else if (e.detail) focusDocument();
});

scroller.addEventListener('scroll', saveSession, { passive: true });
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ---------- Recent files (handles only), listed on the empty screen ---------- */

let recent = [];   // [{ name, handle, opened }], newest first

const recentLoaded = idb('readonly', (s) => s.get('recent'))
  .then((r) => { recent = Array.isArray(r) ? r : []; })
  .catch(() => { recent = []; });

function saveRecent() {
  idb('readwrite', (s) => s.put(recent, 'recent')).catch((e) => console.warn('Could not save recent files:', e));
}

// Serialized: opening several files at once would otherwise race on `recent` and drop entries
let recentQueue = recentLoaded;
function addRecent(handle) {
  recentQueue = recentQueue.then(() => addRecentNow(handle)).catch((e) => console.warn(e));
  return recentQueue;
}

async function addRecentNow(handle) {
  const kept = [];
  for (const r of recent) {
    let same = false;
    try { same = await r.handle.isSameEntry(handle); } catch (e) { /* ignore */ }
    if (!same) kept.push(r);
  }
  recent = [{ name: handle.name, handle, opened: Date.now() }, ...kept].slice(0, RECENT_MAX);
  saveRecent();
  renderRecent(); // in case the empty screen is already showing
}

function removeRecent(entry) {
  recent = recent.filter((r) => r !== entry);
  saveRecent();
  renderRecent();
}

function formatOpened(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

function renderRecent() {
  const empty = content.querySelector('.empty');
  if (!empty) return;
  const old = empty.querySelector('.recent');
  if (old) old.remove();
  if (!recent.length) return;

  const box = document.createElement('div');
  box.className = 'recent';
  const title = document.createElement('p');
  title.className = 'recent-title';
  title.textContent = 'Recent';
  const list = document.createElement('ul');
  for (const r of recent) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    open.title = r.name;
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.name;
    const when = document.createElement('span');
    when.className = 'recent-when';
    when.textContent = formatOpened(r.opened);
    open.append(name, when);
    open.addEventListener('click', async () => {
      try {
        if (!(await hasPermission(r.handle, true))) return;
        await openWithHandle(r.handle);
        focusDocument();
      } catch (e) {
        if (e.name === 'NotFoundError') {
          toast('File not found');
          removeRecent(r);
        } else {
          toast('Could not open ' + r.name);
          console.warn(e);
        }
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.title = 'Remove from list';
    remove.setAttribute('aria-label', 'Remove ' + r.name + ' from recent files');
    remove.textContent = '×';
    remove.addEventListener('click', () => removeRecent(r));
    li.append(open, remove);
    list.appendChild(li);
  }
  box.append(title, list);
  empty.appendChild(box);
}

renderTabs();
const sessionRestored = restoreSession();

/* ---------- Files opened from the OS (installed PWA as the .md handler) ---------- */

// Needs "file_handlers" in the manifest. With launch_handler focus-existing, opening another
// file while the app is running calls this again in the same window, so it becomes a new tab.
// Waiting for the session first lets a file that was already open focus its restored tab.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    await sessionRestored;
    let opened = false;
    for (const handle of params.files || []) {
      if (handle.kind !== 'file') continue;
      try { await openWithHandle(handle); opened = true; } catch (e) { console.error('Could not open launched file:', e); }
    }
    // A first launch straight from the file manager: show just that file, not about.md too
    if (opened && aboutTab && tabs.includes(aboutTab)) closeTab(aboutTab);
    aboutTab = null;
  });
}

/* ---------- Service worker ---------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered:', e));
}
