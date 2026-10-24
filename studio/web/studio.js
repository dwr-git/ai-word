/* AI-Word — помощник и файлы на сервере внутри текстового редактора.
 *
 * Панель в браузере разговаривает с моделью через api/assistant.php, а действия
 * выполняет в самом редакторе через window.aiword (apps/wordcraft-web/src/web/bridge.rs):
 * те же методы, что у десктопного канала управления (crates/ui-egui/src/control.rs).
 * Файлы хранятся на вашем сервере (api/files.php), у каждого пользователя свои.
 * Шрифты: двойники шрифтов Microsoft из папки fonts/ и шрифты организации с сервера.
 *
 * Без сборщиков и зависимостей: один файл, подключается из index.html.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    api: 'api/assistant.php',
    files: 'api/files.php',
    fonts: 'fonts/manifest.json',
    homeUrl: '../',
    labels: 'studio/ru-labels.json',
    autosaveSeconds: 60,       // автосохранение на сервер файла, который там уже лежит (0 — выключить)
    maxSteps: 14,              // сколько шагов подряд помощник может сделать за один запрос
    screenshotMax: 1280,       // длинная сторона снимка экрана для модели, px
    openOnStart: false,
    filesOnStart: true,
    gost: { font: 'Times New Roman', size: 14, lineSpacing: 1.5, indentCm: 1.25, marginsMm: { left: 30, right: 15, top: 20, bottom: 20 }, pageNumbers: 'bottom-center' },
  }, window.STUDIO_CONFIG || {});
  // Страница сборки лежит в b/<номер>/ (studio/build/versioned.sh); адреса из настроек — от папки приложения.
  const fromRoot = (p) => { try { return new URL(p, window.STUDIO_ROOT || document.baseURI).href; } catch { return p; } };
  CFG.api = fromRoot(CFG.api);
  CFG.files = CFG.files ? fromRoot(CFG.files) : CFG.files;
  CFG.homeUrl = fromRoot(CFG.homeUrl || '../');
  // Редактор сам читает адрес домика из настроек.
  window.STUDIO_CONFIG = Object.assign(window.STUDIO_CONFIG || {}, { homeUrl: CFG.homeUrl });

  const READ_TOOLS = new Set(['find_commands', 'get_state', 'read_document', 'paragraph_details', 'look_at_screen']);
  // Никогда: файлы (их делает панель), служебное и интерфейс, печать, макросы, внешние сервисы.
  const DENY = /^(app\.|ui\.|help\.|file\.|print|zotero|tools\.macros|options\.|account\.|document\.setText)/i;
  // Только после подтверждения пользователя.
  const CONFIRM = /^(edit\.replaceAll|review\.(acceptAll|rejectAll)|text\.delete|edit\.cut|edit\.delete)/i;
  const PT_PER_CM = 28.3465;

  // ------------------------------------------------------------------ мост к редактору
  const VC = () => window.aiword;
  const PC = {
    ready: () => !!(VC() && typeof VC().request === 'function'),
    async call(method, params) {
      if (!PC.ready()) throw new Error('Редактор ещё загружается');
      return VC().request(method, params ?? {});
    },
    exec(id, params) {
      const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
      return PC.call('engine.execute', { command: id, params: p });
    },
  };
  // Для своих скриптов и отладки из консоли: await aiwordStudio.exec('text.insert', {text: '…'})
  window.aiwordStudio = { call: PC.call, exec: PC.exec };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ': нет ответа'); })]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…[обрезано]' : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aiword.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aiword.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };
  const round = (n, k = 10) => (typeof n === 'number' ? Math.round(n * k) / k : n);

  // ------------------------------------------------------------------ русские названия
  let L = { text: {}, id: {} };
  const labelsLoaded = fetch(CFG.labels).then((r) => (r.ok ? r.json() : L)).then((j) => { L = j; }).catch(() => {});
  function ru(label) {
    if (!label) return '';
    if (L.text[label]) return L.text[label];
    const bare = label.replace(/…$/, '');
    if (bare !== label && L.text[bare]) return L.text[bare] + '…';
    return label;
  }
  const menuOf = (c) => String(c.location || c.menu || '').split('›').map((x) => x.trim()).filter(Boolean);
  const ruName = (c) => L.id[c.id] || ru(c.label);
  const ruPath = (c) => [...menuOf(c).map(ru), ruName(c)].join(' › ');

  // ------------------------------------------------------------------ поиск команд
  let catalog = null;
  let catalogAt = 0;
  async function commands() {
    if (!catalog || Date.now() - catalogAt > 30000) {
      const r = await PC.call('engine.commands');
      catalog = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
      catalogAt = Date.now();
    }
    return catalog;
  }
  // Частые просьбы → слова, которыми такие команды называются.
  const SYN = [
    [/интервал|межстроч/, 'line spacing para'], [/отступ|красн[аяой]+ строк|абзацн/, 'indent firstLine para'],
    [/выровн|по ширине|по центру|по левому|по правому/, 'align justify center left right para'],
    [/пол[яеи]|поля страниц/, 'margins layout'], [/ориентац|альбомн|книжн/, 'orientation'], [/размер бумаги|формат листа|а4/, 'size layout'],
    [/шрифт|гарнитур/, 'font format'], [/кегль|размер шрифта/, 'size font format'], [/жирн/, 'bold'], [/курсив/, 'italic'], [/подчерк/, 'underline'],
    [/стил/, 'style styles'], [/заголов/, 'heading style'], [/спис|маркир|нумерованн/, 'bullets numbering list'],
    [/таблиц/, 'table insert'], [/колонтитул|верхн|нижн/, 'header footer'], [/номер[а]? страниц|нумерац/, 'page number'],
    [/оглавлен|содержан/, 'toc table of contents references'], [/сноск/, 'footnote'], [/разрыв/, 'break page section'],
    [/найти|поиск/, 'find'], [/замен/, 'replace'], [/рисун|картин|изображен/, 'picture insert'], [/ссылк|гиперссыл/, 'link hyperlink'],
    [/рецензир|исправлен|правк/, 'track changes review'], [/примечан|комментар/, 'comment'], [/орфограф|правопис/, 'spelling proofing'],
    [/колонк/, 'columns'], [/подложк|водян/, 'watermark'], [/регистр|прописн|заглавн/, 'change case'], [/отмен/, 'undo'], [/масштаб/, 'zoom'],
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  async function findCommands(query) {
    const all = await commands();
    await labelsLoaded;
    const q = norm(query).trim();
    if (!q) return { results: [], hint: 'Пустой запрос' };
    const terms = new Set(q.split(/[^\p{L}\p{N}.]+/u).filter((t) => t.length > 1));
    for (const [re, words] of SYN) if (re.test(q)) words.split(' ').forEach((w) => terms.add(w));
    const scored = [];
    for (const c of all) {
      if (DENY.test(c.id)) continue;
      const name = norm(ruName(c));
      const en = norm(c.label);
      const path = norm(menuOf(c).map(ru).join(' ') + ' ' + menuOf(c).join(' '));
      const id = norm(c.id);
      let s = 0;
      if (name === q || en === q) s += 20;
      else if (name.includes(q) || en.includes(q)) s += 10;
      for (const t of terms) {
        if (name.includes(t)) s += name.startsWith(t) ? 7 : 5;
        if (en.includes(t)) s += en.startsWith(t) ? 6 : 4;
        if (id.includes(t)) s += 3;
        if (path.includes(t)) s += 1;
      }
      if (s > 0) scored.push([s + (c.params && c.params !== '{}' ? 1 : 0), c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const results = scored.slice(0, 10).map(([, c]) => ({
      id: c.id,
      name: ruName(c),
      menu: ruPath(c),
      shortcut: c.shortcut || undefined,
      params: c.params && c.params !== '{}' ? clip(String(c.params), 600) : undefined,
    }));
    return results.length ? { results } : { results: [], hint: 'Ничего не найдено. Попробуй другие слова, можно по-английски (например: spacing, indent, margins, style, table).' };
  }

  // ------------------------------------------------------------------ состояние и снимок экрана
  const ALIGN_RU = { left: 'по левому', center: 'по центру', right: 'по правому', justify: 'по ширине', both: 'по ширине', distribute: 'распределённое' };
  function paraSummary(b) {
    const o = { i: b.index, style: b.style };
    if (b.type === 'table') return { i: b.index, table: `${b.rows}×${b.cols}`, text: clip((b.cells || []).map((r) => r.join(' | ')).join(' / '), 120) };
    o.text = clip(String(b.text || ''), 90);
    const p = b.props || {};
    if (p.align) o.align = ALIGN_RU[p.align] || p.align;
    if (p.indentFirst != null) o.firstLineCm = round(p.indentFirst / PT_PER_CM, 100);
    if (p.indentLeft) o.leftCm = round(p.indentLeft / PT_PER_CM, 100);
    if (p.lineSpacing) o.lineSpacing = p.lineSpacing;
    if (p.spaceBefore != null) o.before = p.spaceBefore;
    if (p.spaceAfter != null) o.after = p.spaceAfter;
    const fonts = new Set(), sizes = new Set();
    for (const r of b.runs || []) { if (r.props && r.props.font) fonts.add(r.props.font); if (r.props && r.props.size) sizes.add(r.props.size); }
    if (fonts.size) o.fonts = [...fonts].slice(0, 3);
    if (sizes.size) o.sizes = [...sizes].slice(0, 3);
    if (b.list) o.list = b.list.level;
    return o;
  }
  async function snapshot() {
    const state = {};
    try {
      const ui = await PC.call('ui.inspect');
      state.title = ui.title;
      state.unsaved = !!ui.dirty;
      state.onServer = !!Files.current() && Files.current() === ui.title + Files.ext();
    } catch { /* не важно */ }
    try {
      const d = await PC.call('document.inspect', { text: true });
      state.pages = d.pages;
      state.words = d.words;
      const sec = (d.sections || [])[0];
      if (sec && sec.props) {
        const sp = sec.props;
        const mm = (v) => (typeof v === 'number' ? round(v / 2.83465, 1) : undefined);
        state.pageMm = { width: mm(sp.pageW), height: mm(sp.pageH), top: mm(sp.marginTop), bottom: mm(sp.marginBottom), left: mm(sp.marginLeft), right: mm(sp.marginRight) };
        if ((d.sections || []).length > 1) state.sections = d.sections.length;
      }
      const blocks = Array.isArray(d.blocks) ? d.blocks : [];
      state.paragraphs = blocks.length;
      state.blocks = blocks.slice(0, 40).map(paraSummary);
      if (blocks.length > 40) state.more = `ещё ${blocks.length - 40} абзацев — read_document {from: 40}`;
      if (d.selection && d.selection.text) state.selection = clip(d.selection.text, 300);
      if (d.trackChanges) state.trackChanges = true;
    } catch (e) {
      state.note = 'Документ не открыт (начальный экран). Можно создать новый: Файл › Создать.';
    }
    return state;
  }
  async function readDocument(from, count) {
    const d = await PC.call('document.inspect', { text: true });
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    const start = Math.max(0, parseInt(from, 10) || 0);
    const n = Math.max(1, Math.min(400, parseInt(count, 10) || 400));
    const out = [];
    let size = 0;
    for (const b of blocks.slice(start, start + n)) {
      const line = b.type === 'table'
        ? `[${b.index}] (таблица ${b.rows}×${b.cols}) ` + (b.cells || []).map((r) => r.join(' | ')).join(' / ')
        : `[${b.index}]${b.style && b.style !== 'Normal' ? ' (' + b.style + ')' : ''} ${b.text || ''}`;
      size += line.length;
      if (size > 24000) { out.push(`…дальше — read_document {from: ${b.index}}`); break; }
      out.push(line);
    }
    return { paragraphs: blocks.length, text: out.join('\n') };
  }

  function downscale(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, CFG.screenshotMax / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
      };
      img.onerror = () => reject(new Error('не удалось прочитать снимок'));
      img.src = src;
    });
  }
  async function screenshot() {
    if (!PC.ready()) return null;
    try {
      const r = await withTimeout(VC().screenshot(), 9000, 'снимок');
      const b64 = r && (r.png || r.pngBase64 || r.data);
      if (typeof b64 === 'string' && b64.length > 100) return await downscale('data:image/png;base64,' + b64);
    } catch { /* ниже */ }
    return null;
  }

  // ------------------------------------------------------------------ интерфейс
  const ICON = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-9 9H5v-6z"/><path d="M12.5 5.5l6 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.2a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    // Мозг — контур из набора Tabler Icons (MIT), нарисованный градиентом #st-brain-grad.
    brain: '<svg class="st-brain-svg" viewBox="0 0 24 24" fill="none" stroke="url(#st-brain-grad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8"/><path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8"/><path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5"/><path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0"/><path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5"/><path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3l-8 11h6l-1 7 8-11h-6z"/></svg>',
  };
  // Живой контур: мозг градиентом и три точки на орбите, пока помощник работает.
  const BRAIN = `${ICON.brain}<b class="st-orbit" aria-hidden="true"><i></i><i></i><i></i></b>`;

  const root = document.createElement('div');
  root.id = 'studio-root';
  root.dataset.theme = 'light';
  root.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="st-brain-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fa2ff"/><stop offset=".55" stop-color="#9b7cf0"/><stop offset="1" stop-color="#ff77c6"/></linearGradient></defs></svg>
    <div class="st-veil" aria-hidden="true"></div>
    <div class="st-drop" aria-hidden="true"><span>Отпустите, чтобы открыть в редакторе</span></div>
    <aside class="st-panel" aria-label="Помощник">
      <header class="st-head">
        <div class="st-logo st-brain st-raised-sm" aria-hidden="true">${BRAIN}</div>
        <div class="st-title"><b>Помощник</b><small data-ref="sub">Загрузка редактора…</small></div>
        <button class="st-icon-btn" data-ref="galleryBtn" title="Быстрые задачи: ГОСТ, интервалы, оглавление…" aria-label="Быстрые задачи">${ICON.layout}</button>
        <button class="st-icon-btn" data-ref="filesBtn" title="Мои файлы (на сервере)" aria-label="Мои файлы">${ICON.folder}</button>
        <button class="st-icon-btn" data-ref="barBtn" title="Быстрая строка (Ctrl+Shift+Пробел)" aria-label="Быстрая строка">${ICON.bolt}</button>
        <div class="st-theme-wrap">
          <button class="st-icon-btn" data-ref="theme" title="Тема оформления" aria-label="Тема оформления" aria-haspopup="menu" aria-expanded="false">${ICON.palette}</button>
          <div class="st-theme-menu" data-ref="themeMenu" role="menu" hidden></div>
        </div>
        <button class="st-icon-btn" data-ref="hide" title="Свернуть панель" aria-label="Свернуть панель">${ICON.close}</button>
      </header>
      <div class="st-seg st-pressed" role="group" aria-label="Режим помощника">
        <button data-mode="advice" aria-pressed="true">${ICON.bulb}Совет</button>
        <button data-mode="act" aria-pressed="false">${ICON.hand}Сделай</button>
      </div>
      <div class="st-mode-hint" data-ref="hint"></div>
      <div class="st-log" data-ref="log" role="log" aria-live="polite"></div>
      <div class="st-composer">
        <div class="st-input st-pressed">
          <button class="st-icon-btn" data-ref="eye" aria-pressed="true" title="Показывать помощнику экран" aria-label="Показывать помощнику экран">${ICON.eye}</button>
          <textarea data-ref="input" rows="1" placeholder="Спросите или попросите…" aria-label="Сообщение помощнику"></textarea>
          <button class="st-send" data-ref="send" title="Отправить (Enter)" aria-label="Отправить">${ICON.send}</button>
        </div>
        <div class="st-foot"><span>Ctrl+Z — отменить · Ctrl+Shift+Пробел — строка</span><button data-ref="clear">Новый разговор</button></div>
      </div>
    </aside>
    <div class="st-files" data-ref="files" role="dialog" aria-modal="true" aria-label="Мои файлы" hidden>
      <div class="st-files-box">
        <header class="st-files-head">
          <b>Мои документы</b><small data-ref="filesWho"></small>
          <button class="st-icon-btn" data-ref="filesClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-files-tools">
          <input data-ref="filesSearch" type="search" placeholder="Поиск по имени" aria-label="Поиск по имени">
          <button class="st-mini" data-ref="filesNew">Новый файл</button>
          <button class="st-mini" data-ref="filesUpload" title=".docx, .doc, .odt, .rtf">С компьютера…</button>
        </div>
        <div class="st-files-list" data-ref="filesList"></div>
        <footer class="st-files-foot">
          <span data-ref="filesCurrent"></span>
          <button class="st-mini" data-ref="filesSaveAs">Сохранить как…</button>
          <button class="st-mini primary" data-ref="filesSave">Сохранить</button>
        </footer>
      </div>
    </div>
    <div class="st-files st-gallery" data-ref="gallery" role="dialog" aria-modal="true" aria-label="Быстрые задачи" hidden>
      <div class="st-files-box st-gallery-box">
        <header class="st-files-head">
          <b>Быстрые задачи</b>
          <small>В одно нажатие. Действуют на выделенное, а если ничего не выделено — на весь документ.</small>
          <button class="st-icon-btn" data-ref="galleryClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-gpane"><div class="st-gtasks" data-ref="gTasks"></div></div>
      </div>
    </div>
    <div class="st-ask" data-ref="ask" role="dialog" aria-modal="true" hidden>
      <form class="st-ask-box">
        <b data-ref="askTitle"></b>
        <input data-ref="askInput" type="text" maxlength="120">
        <small data-ref="askNote"></small>
        <div class="st-row"><button type="button" class="st-mini" data-ref="askCancel">Отмена</button><button type="submit" class="st-mini primary" data-ref="askOk">OK</button></div>
      </form>
    </div>
    <button class="st-fab st-brain" data-ref="fab" title="Помощник" aria-label="Открыть помощника">${BRAIN}<span class="st-badge" aria-hidden="true"></span></button>
    <div class="st-bar" data-ref="bar" role="dialog" aria-label="Быстрая строка помощника">
      <div class="st-bar-answer" data-ref="barAnswer"></div>
      <div class="st-bar-row">
        <button class="st-bar-mode" data-ref="barMode" title="Режим: Совет или Сделай"></button>
        <input data-ref="barInput" type="text" placeholder="Что написать или поправить? Enter — отправить, Esc — закрыть" aria-label="Запрос помощнику">
        <button class="st-send" data-ref="barSend" aria-label="Отправить">${ICON.send}</button>
      </div>
    </div>`;
  const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
  const log = $('log');
  const input = $('input');

  // Клавиши, набранные в панели, не должны доходить до редактора (иначе «B» выберет кисть).
  for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  let mode = store.get('mode', 'advice');
  let attachScreen = store.get('eye', true);
  let busy = false;
  let stopRequested = false;
  let convo = [];

  const HINTS = {
    advice: 'Объясняю и подсказываю, ничего не меняю в документе.',
    act: 'Делаю сам: пишу и правлю текст, оформляю по ГОСТ, ставлю интервалы, отступы, стили, оглавление. Всё отменяется Ctrl+Z.',
  };
  // Модель видит всю переписку. Если раньше она писала «я в режиме Совет», то по инерции продолжает
  // так отвечать и после переключения. Поэтому смена режима отмечается прямо в разговоре,
  // а каждое сообщение пользователя несёт текущий режим.
  const MODE_NOTE = {
    act: '[Режим переключён на «Сделай». Теперь ты сам выполняешь просьбы инструментами (read_document, run_command, apply_gost…). Всё, что ты раньше писал про режим «Совет», больше не действует.]',
    advice: '[Режим переключён на «Совет». Теперь только объясняй и подсказывай, ничего не меняй в документе.]',
  };
  const MODE_TAG = {
    act: '[Режим сейчас: «Сделай» — выполни это сам, инструментами]',
    advice: '[Режим сейчас: «Совет» — объясни, как сделать, ничего не меняя]',
  };
  function setMode(m) {
    const next = m === 'act' ? 'act' : 'advice';
    if (next !== mode && convo.length) convo.push({ role: 'user', content: MODE_NOTE[next] });
    mode = next;
    store.set('mode', mode);
    root.querySelectorAll('.st-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('hint').textContent = HINTS[mode];
    const bm = root.querySelector('[data-ref="barMode"]');
    if (bm) bm.textContent = mode === 'act' ? 'Сделай' : 'Совет';
  }
  function setEye(on) {
    attachScreen = !!on;
    store.set('eye', attachScreen);
    $('eye').setAttribute('aria-pressed', String(attachScreen));
    $('eye').title = attachScreen ? 'Помощник видит экран' : 'Помощник не видит экран';
  }
  function setOpen(open) {
    root.classList.toggle('open', open);
    document.body.classList.toggle('studio-open', open);
    setTimeout(syncBackdrop, 60);
    setTimeout(syncBackdrop, 400);
    store.set('open', open);
    // eframe подхватывает новый размер canvas на следующем кадре
    window.dispatchEvent(new Event('resize'));
    if (open) { setTimeout(() => input.focus(), 200); root.classList.remove('has-hints'); }
  }
  function setBusy(on) {
    busy = on;
    root.classList.toggle('busy', on);
    $('send').innerHTML = on ? ICON.stop : ICON.send;
    $('send').title = on ? 'Остановить' : 'Отправить (Enter)';
  }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function format(text) {
    // Строки списка «- …» / «* …» — с точкой; короткая строка, оканчивающаяся двоеточием, — заголовок.
    text = text.trim().split('\n').map((line) => {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (li) return '\u0001' + (/^\s*\d/.test(line) ? line.trim().match(/^\d+[.)]/)[0] + ' ' : '• ') + li[1] + '\u0002';
      const head = line.match(/^\s*(?:#{1,4}\s*)?\**([^*:]{2,60}):\**\s*$/);
      if (head) return '\u0003' + head[1] + ':\u0004';
      return line.replace(/^#{1,4}\s+/, '');
    }).join('\n').replace(/\u0002\n/g, '\u0002');  // пункт списка — блок: перенос после него лишний
    let h = esc(text);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/\((Ctrl|Shift|Alt|Cmd|⌘|⇧|⌥)([^)\n]{0,24})\)/g, '(<kbd>$1$2</kbd>)');
    // «Изображение › Коррекция › Кривые» — путь в меню
    // Сегменты — слова через одиночные пробелы: конечный пробел не должен «съедать» разделитель.
    const C = '[^\\s›«»"():.,!?;<>&]';
    const word = `${C}+`;
    const path = new RegExp(`([А-ЯЁA-Z]${C}*(?: ${word}){0,2}(?: › ${word}(?: ${word}){0,3}){1,4})`, 'g');
    h = h.replace(path, '<span class="st-path">$1</span>');
    h = h.replace(/\u0001/g, '<span class="st-li">').replace(/\u0002/g, '</span>')
      .replace(/\u0003/g, '<span class="st-h">').replace(/\u0004/g, '</span>');
    return h;
  }
  function add(el) { log.querySelector('.st-empty')?.remove(); log.appendChild(el); scroll(); return el; }
  function msg(cls, html) { const d = document.createElement('div'); d.className = 'st-msg ' + cls; d.innerHTML = html; return add(d); }
  function typing(on) {
    log.querySelector('.st-typing')?.remove();
    if (on) { const t = document.createElement('div'); t.className = 'st-typing st-raised-sm'; t.innerHTML = '<i></i><i></i><i></i>'; add(t); }
  }

  const ACTION_TEXT = {
    find_commands: (a) => ['Ищу команду', a.query],
    get_state: () => ['Смотрю документ', ''],
    read_document: (a) => ['Читаю текст', a.from ? 'с абзаца ' + a.from : ''],
    paragraph_details: (a) => ['Смотрю оформление абзаца', String(a.index ?? '')],
    look_at_screen: () => ['Смотрю на экран', ''],
    undo: (a) => ['Отменяю', `${a.steps || 1} шаг(а)`],
  };
  function card(name, args, label) {
    const d = document.createElement('div');
    const [title, detail] = label || (ACTION_TEXT[name] ? ACTION_TEXT[name](args) : [name, '']);
    d.className = 'st-act' + (READ_TOOLS.has(name) ? ' read' : '');
    d.innerHTML = `<span class="st-dot"></span><div class="st-act-text"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
    return add(d);
  }
  function cardResult(d, ok, error, undoable) {
    if (!ok) {
      d.classList.add('fail');
      const s = d.querySelector('small') || d.querySelector('.st-act-text').appendChild(document.createElement('small'));
      s.textContent = error;
      return;
    }
    if (undoable) {
      const b = document.createElement('button');
      b.className = 'st-mini';
      b.textContent = 'Отменить';
      b.onclick = async () => {
        b.disabled = true;
        try { await PC.exec('edit.undo'); b.textContent = 'Отменено'; } catch (e) { b.textContent = 'Не вышло'; b.title = e.message; }
      };
      d.appendChild(b);
    }
  }
  function confirmAction(text) {
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.className = 'st-confirm st-raised';
      d.innerHTML = `<p>${esc(text)}</p><div class="st-row"><button class="st-mini danger" data-a="no">Не надо</button><button class="st-mini" data-a="yes">Разрешить</button></div>`;
      add(d);
      d.querySelectorAll('button').forEach((b) => {
        b.onclick = () => { d.remove(); resolve(b.dataset.a === 'yes'); };
      });
    });
  }

  function showEmpty() {
    log.innerHTML = `<div class="st-empty">
      <h3>Чем помочь?</h3>
      <p>Спросите, где найти функцию в AI-Word, или попросите оформить, проверить или написать текст за вас.</p>
      <button class="st-mini primary st-start-tpl">Быстрые задачи</button>
      <div class="st-chips">
        <button class="st-chip" data-act="1">Оформи документ по ГОСТ: Times New Roman 14, интервал 1,5, отступ 1,25 см, поля 30/15/20/20</button>
        <button class="st-chip" data-act="1">Проверь оформление по методичке и исправь, что не так</button>
        <button class="st-chip">Кратко перескажи документ</button>
        <button class="st-chip">Как сделать автоматическое оглавление?</button>
        <button class="st-chip" data-act="1">Составь служебную записку о переносе совещания</button>
      </div></div>`;
    const st = log.querySelector('.st-start-tpl');
    if (st) st.onclick = () => Gallery.show(true);
    log.querySelectorAll('.st-chip').forEach((c) => {
      c.onclick = () => {
        if (c.dataset.act) setMode('act');
        input.value = c.textContent;
        send();
      };
    });
  }

  // ------------------------------------------------------------------ инструменты для модели
  async function commandById(id) {
    const c = (await commands()).find((x) => x.id === id);
    if (!c) throw new Error(`Нет команды «${id}». Найди нужную через find_commands.`);
    if (DENY.test(id)) throw new Error('Эту команду помощнику выполнять нельзя (файлы, интерфейс и служебное делает панель или сам пользователь).');
    return c;
  }
  const short = (v) => (v === undefined || v === null ? { ok: true } : { ok: true, result: v });

  // Оформление по ГОСТ: стиль «Обычный» (шрифт, кегль, интервал, отступ, по ширине), поля, номера страниц.
  async function applyGost(a) {
    const g = Object.assign({}, CFG.gost, a || {});
    const m = Object.assign({}, CFG.gost.marginsMm, (a && a.marginsMm) || {});
    const mm = (v) => Math.round(Number(v) * 2.83465 * 100) / 100;
    const para = { align: 'justify', indentFirst: Math.round(Number(g.indentCm) * PT_PER_CM * 100) / 100, lineSpacing: { rule: 'multiple', value: Number(g.lineSpacing) }, spaceBefore: 0, spaceAfter: 0 };
    await PC.exec('styles.modify', { style: 'Normal', chr: { font: String(g.font), size: Number(g.size) }, para });
    // Абзацы, у которых интервал, отступ или шрифт заданы вручную, — тоже по ГОСТ (заголовки и подписи не трогаем).
    const d = await PC.call('document.inspect', { text: false });
    const blocks = (d.blocks || []).filter((b) => b.type === 'paragraph' && (!b.style || b.style === 'Normal'));
    if (blocks.length) {
      const first = blocks[0].index, last = blocks[blocks.length - 1].index;
      const lastLen = blocks[blocks.length - 1].len || 0;
      await PC.exec('select.range', { anchor: { story: 'body', path: [first], off: 0 }, focus: { story: 'body', path: [last], off: lastLen } }).catch(() => {});
      await PC.exec('para.set', { props: { lineSpacing: para.lineSpacing, spaceBefore: 0, spaceAfter: 0 } }).catch(() => {});
      await PC.exec('format.font', { name: String(g.font) }).catch(() => {});
      await PC.exec('format.size', { size: Number(g.size) }).catch(() => {});
      await PC.exec('select.range', { anchor: { story: 'body', path: [first], off: 0 }, focus: { story: 'body', path: [first], off: 0 } }).catch(() => {});
    }
    await PC.exec('layout.size', { name: 'A4' }).catch(() => {});
    await PC.exec('layout.margins', { top: mm(m.top), bottom: mm(m.bottom), left: mm(m.left), right: mm(m.right) });
    const pn = String(g.pageNumbers || 'bottom-center');
    if (pn !== 'none') {
      const [position, align] = pn.split('-');
      await PC.exec('insert.pageNumber', { position: position === 'top' ? 'top' : 'bottom', align: ['left', 'center', 'right'].includes(align) ? align : 'center' }).catch(() => {});
    }
    return { ok: true, note: `Шрифт ${g.font} ${g.size}, интервал ${g.lineSpacing}, отступ ${g.indentCm} см, по ширине; поля ${m.left}/${m.right}/${m.top}/${m.bottom} мм.` };
  }

  async function runTool(name, args) {
    if (mode !== 'act' && !READ_TOOLS.has(name)) {
      return { ok: false, error: 'Сейчас режим «Совет»: действия выключены. Объясни пользователю, как сделать это самому, или предложи переключиться в «Сделай».' };
    }
    switch (name) {
      case 'find_commands': {
        const d = card(name, args);
        const r = await findCommands(String(args.query || ''));
        cardResult(d, true);
        return r;
      }
      case 'get_state': {
        card(name, args);
        return await snapshot();
      }
      case 'read_document': {
        const d = card(name, args);
        try { const r = await readDocument(args.from, args.count); cardResult(d, true); return r; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'paragraph_details': {
        const d = card(name, args);
        try {
          const r = await PC.exec('document.paragraph', { path: [Math.max(0, parseInt(args.index, 10) || 0)] });
          cardResult(d, true);
          return short(JSON.parse(clip(JSON.stringify(r), 5000).replace(/…\[обрезано\]$/, '') || 'null'));
        } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'look_at_screen': {
        const d = card(name, args);
        const img = await screenshot();
        cardResult(d, !!img, 'Снимок не получился');
        return img ? { ok: true, note: 'Снимок приложен следующим сообщением.', __image: img } : { ok: false, error: 'Снимок экрана не получился' };
      }
      case 'run_command': {
        const c = await commandById(String(args.id || ''));
        if (CONFIRM.test(c.id) && !(await confirmAction(`Помощник хочет выполнить «${ruPath(c)}». Разрешить?`))) {
          card(name, args, ['Пропущено пользователем', ruPath(c)]).classList.add('fail');
          return { ok: false, error: 'Пользователь не разрешил это действие. Не повторяй его, спроси, как поступить.' };
        }
        const d = card(name, args, ['Выполняю', ruPath(c)]);
        root.classList.add('acting');
        try {
          const r = await PC.exec(c.id, args.params && typeof args.params === 'object' ? args.params : null);
          cardResult(d, true, '', !/^(select\.|document\.|edit\.find|view\.|format\.state)/.test(c.id));
          return short(r && typeof r === 'object' ? JSON.parse(clip(JSON.stringify(r), 3000).replace(/…\[обрезано\]$/, '') || 'null') : r);
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message, params_doc: c.params ? clip(String(c.params), 800) : undefined };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'apply_gost': {
        const d = card(name, args, ['Оформляю по ГОСТ', '']);
        root.classList.add('acting');
        try { const r = await applyGost(args); cardResult(d, true, '', true); return r; }
        catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
        finally { root.classList.remove('acting'); }
      }
      case 'undo': {
        const n = Math.max(1, Math.min(20, parseInt(args.steps, 10) || 1));
        const d = card(name, { steps: n });
        try { for (let i = 0; i < n; i++) await PC.exec('edit.undo'); cardResult(d, true); return { ok: true }; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      default:
        return { ok: false, error: `Инструмента «${name}» нет. Доступны только: ${TOOL_NAMES.join(', ')}. Кликов по координатам нет: найди команду через find_commands и выполни её run_command.` };
    }
  }

  // Модель иногда пишет вызов инструмента текстом вместо tool_calls — подхватываем его.
  const TOOL_NAMES = ['find_commands', 'get_state', 'read_document', 'paragraph_details', 'look_at_screen', 'run_command', 'apply_gost', 'undo'];
  function inlineCalls(text) {
    if (!text || !/[{[]/.test(text)) return [];
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      const o = JSON.parse(m[0]);
      const list = Array.isArray(o) ? o : [o];
      return list
        .filter((x) => x && TOOL_NAMES.includes(x.name))
        .map((x) => ({ function: { name: x.name, arguments: x.arguments || x.parameters || {} } }));
    } catch { return []; }
  }

  // ------------------------------------------------------------------ разговор с моделью
  function outgoing() {
    // Картинки тяжёлые и занимают много контекста: отправляем только последний снимок.
    const out = convo.slice(-60).map((m) => ({ ...m }));
    let images = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].images) continue;
      if (images >= 1) delete out[i].images; else images += out[i].images.length;
    }
    return out;
  }

  // Запрос к серверу помощника. Если сервер не принимает запрос со снимком экрана (nginx по
  // умолчанию берёт не больше 1 МБ и при большем просто обрывает соединение — браузер пишет
  // «Failed to fetch»), запрос повторяется без снимка, и дальше снимки не отправляются.
  const BODY_LIMIT = 900 * 1024;
  let imagesBlocked = false;
  const withoutImages = (payload) => ({ ...payload, messages: payload.messages.map((m) => { const { images, ...rest } = m; void images; return rest; }) });
  const hasImages = (payload) => payload.messages.some((m) => m.images && m.images.length);
  function tellImagesBlocked() {
    if (imagesBlocked) return;
    imagesBlocked = true;
    msg('note', 'Сервер не принял запрос со снимком экрана, поэтому помощник отвечает без него. ' +
      'Чтобы он видел экран, добавьте в nginx для api/assistant.php строку <code>client_max_body_size 20m;</code> (готовый блок — в nginx.conf.example).');
  }
  async function explainNoAnswer(seconds) {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const when = seconds >= 1 ? ` через ${Math.round(seconds)} с` : ' сразу';
        const why = seconds >= 45
          ? 'Похоже, сервер не дождался модели: для api/assistant.php нужна строка fastcgi_read_timeout 200s; (и такой же таймаут у прокси перед сервером, если он есть).'
          : 'Обычно так бывает, когда запрос больше, чем разрешает сервер (client_max_body_size 20m; для api/assistant.php), или его блокирует защита сервера.';
        return `Сервер оборвал соединение${when} и ничего не ответил, хотя сам помощник доступен. ${why} Готовый блок — в nginx.conf.example.`;
      }
      return `Сервер помощника ответил «${r.status}». Проверьте, что PHP обрабатывает файлы в папке api/.`;
    } catch {
      return 'Нет связи с сервером помощника: страница не может достучаться до api/assistant.php. Проверьте подключение и обновите страницу.';
    }
  }
  async function postApi(payload) {
    const post = (p) => fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (imagesBlocked && hasImages(payload)) payload = withoutImages(payload);
    if (hasImages(payload) && JSON.stringify(payload).length > BODY_LIMIT) payload = withoutImages(payload);
    let r;
    const t0 = performance.now();
    const took = () => (performance.now() - t0) / 1000;
    try {
      r = await post(payload);
    } catch (e) {
      console.warn('AI-Word: запрос к помощнику оборвался', e);
      if (!hasImages(payload)) throw new Error(await explainNoAnswer(took()));
      try { r = await post(withoutImages(payload)); } catch { throw new Error(await explainNoAnswer(took())); }
      tellImagesBlocked();
      return r;
    }
    if (r.status === 413 && hasImages(payload)) {
      r = await post(withoutImages(payload));
      tellImagesBlocked();
    }
    return r;
  }
  async function readAnswer(r) {
    let j;
    try { j = await r.json(); } catch {
      if (r.status === 413) throw new Error('Сервер не принял такой большой запрос (413). Нужна строка client_max_body_size 20m; в nginx — см. nginx.conf.example.');
      if (r.status === 502 || r.status === 504) throw new Error(`Сервер не дождался ответа модели (${r.status}). Нужна строка fastcgi_read_timeout 200s; в nginx — см. nginx.conf.example.`);
      throw new Error(`Сервер помощника ответил не JSON (HTTP ${r.status}). Проверьте, что PHP работает в папке api/.`);
    }
    return j;
  }
  // Шлюз модели не передаёт инструменты штатно (вызовы приходят текстом) — запоминаем это.
  let textTools = store.get('textTools', false);
  async function ask() {
    const r = await postApi({ mode, messages: outgoing(), textTools });
    const j = await readAnswer(r);
    if (j && j.ok && j.textTools && !textTools) { textTools = true; store.set('textTools', true); }
    if (!j.ok) {
      const e = new Error(j.error || 'Ошибка помощника');
      e.noVision = !!j.noVision;
      throw e;
    }
    return j;
  }

  async function send(fromBar) {
    if (busy) { stopRequested = true; return; }
    const field = typeof fromBar === 'string' ? null : input;
    const text = (typeof fromBar === 'string' ? fromBar : input.value).trim();
    if (!text) return;
    if (field) { field.value = ''; autosize(); }
    setBusy(true);
    stopRequested = false;
    msg('user', esc(text));
    try {
      let state = null;
      let image = null;
      if (PC.ready()) {
        state = await snapshot().catch((e) => ({ error: e.message }));
        if (attachScreen) image = await screenshot();
      }
      convo.push({
        role: 'user',
        content: MODE_TAG[mode] + '\n' + text + '\n\n[Состояние редактора — автоматически]\n' + clip(JSON.stringify(state ?? { note: 'Редактор ещё загружается' }), 4000),
        ...(image ? { images: [image] } : {}),
      });
      for (let step = 0; step < CFG.maxSteps; step++) {
        if (stopRequested) { msg('bot', 'Остановлено.'); break; }
        typing(true);
        const j = await ask();
        typing(false);
        const m = j.message || {};
        let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        let content = (m.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
        if (!calls.length) {
          calls = inlineCalls(content);
          if (calls.length) content = content.replace(/\{[\s\S]*\}/, '').trim();
        }
        // «Сделай», а модель всё равно ответила как в «Совете» — одна попытка её поправить.
        if (mode === 'act' && !calls.length && step === 0 && /режим\S*\s*«?Совет/i.test(content)) {
          convo.push({ role: 'assistant', content: m.content || '' });
          convo.push({ role: 'user', content: MODE_NOTE.act + ' Выполни просьбу сейчас.' });
          continue;
        }
        convo.push({ role: 'assistant', content: m.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (content) msg('bot', format(content));
        if (!calls.length) break;
        let pendingImage = null;
        for (const c of calls) {
          if (stopRequested) break;
          const fname = c.function && c.function.name;
          let a = (c.function && c.function.arguments) || {};
          if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { a = {}; } }
          let result;
          try { result = await runTool(fname, a || {}); } catch (e) { result = { ok: false, error: e.message || String(e) }; }
          if (result && result.__image) { pendingImage = result.__image; delete result.__image; }
          convo.push({ role: 'tool', tool_name: fname, content: clip(JSON.stringify(result ?? { ok: true }), 6000) });
        }
        if (pendingImage) convo.push({ role: 'user', content: '[Снимок экрана после действий — прислан автоматически]', images: [pendingImage] });
        if (step === CFG.maxSteps - 1) msg('bot', `Сделал ${CFG.maxSteps} шагов подряд и остановился. Напишите «продолжай», если нужно дальше.`);
      }
    } catch (e) {
      typing(false);
      if (e.noVision) setEye(false);
      msg('err', esc(e.message || String(e)));
    } finally {
      typing(false);
      setBusy(false);
      root.classList.remove('acting');
      updateBarAnswer();
    }
  }

  // ------------------------------------------------------------------ быстрая строка
  // Ctrl+Shift+Пробел: поле внизу над холстом. Ответ всплывает над ним; вся история — в панели.
  const bar = $('bar');
  const barInput = $('barInput');
  const barAnswer = $('barAnswer');
  function setBar(open) {
    root.classList.toggle('bar-open', open);
    if (open) { setTimeout(() => barInput.focus(), 30); updateBarAnswer(); }
  }
  function updateBarAnswer() {
    if (!root.classList.contains('bar-open')) return;
    if (busy) { barAnswer.innerHTML = '<div class="st-typing"><i></i><i></i><i></i></div>'; barAnswer.hidden = false; return; }
    const last = [...log.querySelectorAll('.st-msg.bot, .st-msg.err')].pop();
    if (!last || !barSent) { barAnswer.hidden = true; return; }
    barAnswer.hidden = false;
    barAnswer.innerHTML = `<div class="st-bar-text ${last.classList.contains('err') ? 'err' : ''}">${last.innerHTML}</div><button class="st-link" data-a="panel">Открыть в панели</button>`;
    barAnswer.querySelector('[data-a="panel"]').onclick = () => { setBar(false); setOpen(true); };
  }
  let barSent = false;
  async function sendFromBar() {
    const text = barInput.value.trim();
    if (!text || busy) return;
    barInput.value = '';
    barSent = true;
    const done = send(text);
    updateBarAnswer();
    await done;
    updateBarAnswer();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setBar(!root.classList.contains('bar-open'));
    }
  }, true);

  // ------------------------------------------------------------------ сообщения и перетаскивание
  function setBadge(on) { root.classList.toggle('has-hints', on); }
  function toast(text, error) {
    let t = root.querySelector('.st-toast');
    if (!t) { t = document.createElement('div'); t.className = 'st-toast'; root.appendChild(t); }
    t.textContent = text;
    t.classList.toggle('err', !!error);
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Файлы, брошенные на документ, редактор принимает сам. Брошенные на панель помощника или край
  // страницы браузер открыл бы вместо редактора — передаём их редактору.
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropHideTimer = 0;
  function showDrop(on) {
    root.classList.toggle('dropping', on);
    clearTimeout(dropHideTimer);
    if (on) dropHideTimer = setTimeout(() => root.classList.remove('dropping'), 400);
  }
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('wordcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    showDrop(true);
  });
  window.addEventListener('drop', async (e) => {
    showDrop(false);
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('wordcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f || !PC.ready()) return;
    try { VC().open(f.name, new Uint8Array(await f.arrayBuffer())); Files.forget(); toast('Открываю ' + f.name); }
    catch (err) { toast('Не удалось открыть ' + f.name + ': ' + (err.message || err), true); }
  });

  // ------------------------------------------------------------------ файлы на сервере
  // Новый пустой документ — и сразу к нему (закрыть «Файл › Главная»).
  async function newDocument() {
    await PC.exec('file.new');
    await PC.call('ui.backstage', { value: false }).catch(() => {});
  }
  const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fmtDate = (t) => {
    if (!t) return '';
    const d = new Date(t * 1000), now = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'сегодня, ' + time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
  };
  const DOC_EXT = /\.(docx|docm|dotx|dotm|doc|dot|odt|rtf|txt|md|html?)$/i;

  // Окно с одним полем: имя файла.
  function askName(title, value, note) {
    return new Promise((resolve) => {
      const box = $('ask');
      $('askTitle').textContent = title;
      $('askNote').textContent = note || '';
      const field = $('askInput');
      field.value = value || '';
      box.hidden = false;
      setTimeout(() => { field.focus(); const dot = field.value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : field.value.length); }, 30);
      const done = (v) => { box.hidden = true; form.onsubmit = null; $('askCancel').onclick = null; box.onkeydown = null; resolve(v); };
      const form = box.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); done(field.value.trim() || null); };
      $('askCancel').onclick = () => done(null);
      box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    });
  }

  // Копия в браузере, если сохранить на сервер не вышло (нет связи, сервер не принял файл).
  const Recovery = (() => {
    const open = () => new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('нет IndexedDB')); return; }
      const r = indexedDB.open('aiword', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recovery');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('recovery', mode);
        const req = fn(tx.objectStore('recovery'));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    };
    return {
      put: (v) => run('readwrite', (s) => s.put(v, 'last')).catch(() => {}),
      get: () => run('readonly', (s) => s.get('last')).catch(() => null),
      clear: () => run('readwrite', (s) => s.delete('last')).catch(() => {}),
    };
  })();

  const Files = (() => {
    let list = [];
    let server = null;        // имя открытого документа на сервере (с расширением), если он оттуда
    let dirty = false;
    let saveAsNext = false;   // «Сохранить как» из панели
    let quietNext = false;    // автосохранение
    let saving = false;
    const api = (q) => CFG.files + (q ? '?' + q : '');
    async function json(r) {
      let j = null;
      try { j = await r.json(); } catch { /* ниже */ }
      if (!j) throw new Error(r.status === 413 ? 'Файл слишком большой для сервера: увеличьте client_max_body_size в nginx и post_max_size в PHP.' : `Сервер ответил ${r.status}: проверьте, что PHP обрабатывает api/files.php.`);
      if (!j.ok) { const e = new Error(j.error || 'Ошибка сервера'); e.exists = !!j.exists; e.login = !!j.login; throw e; }
      return j;
    }
    async function refresh() {
      const j = await json(await fetch(api(''), { credentials: 'same-origin', cache: 'no-store' }));
      list = Array.isArray(j.files) ? j.files : [];
      $('filesWho').textContent = j.user && j.user !== 'local' ? 'на сервере · пользователь ' + j.user : 'на сервере';
      return list;
    }
    const stem = (n) => String(n || '').replace(DOC_EXT, '');
    const extOf = (n) => { const m = String(n || '').match(DOC_EXT); return m ? m[0].toLowerCase() : '.docx'; };
    function render() {
      const q = norm($('filesSearch').value).trim();
      const rows = list.filter((f) => !q || norm(f.name).includes(q));
      const box = $('filesList');
      if (!list.length) { box.innerHTML = '<p class="st-files-empty">Здесь будут ваши документы. Сохраните открытый документ кнопкой «Сохранить» или Ctrl+S.</p>'; return; }
      if (!rows.length) { box.innerHTML = '<p class="st-files-empty">Ничего не найдено.</p>'; return; }
      box.innerHTML = rows.map((f, i) => `<div class="st-file" data-i="${i}" tabindex="0">
          <span class="st-file-icon">${ICON.file}</span>
          <span class="st-file-name">${esc(f.name)}</span>
          <span class="st-file-meta">${esc(fmtDate(f.modified))} · ${esc(fmtSize(f.size))}</span>
          <span class="st-file-acts"><button class="st-link" data-a="rename">Переименовать</button><button class="st-link danger" data-a="delete">Удалить</button></span>
        </div>`).join('');
      box.querySelectorAll('.st-file').forEach((row) => {
        const f = rows[+row.dataset.i];
        row.onclick = (e) => { if (!e.target.closest('button')) load(f.name); };
        row.onkeydown = (e) => { if (e.key === 'Enter') load(f.name); };
        row.querySelector('[data-a="rename"]').onclick = () => rename(f.name);
        row.querySelector('[data-a="delete"]').onclick = () => remove(f.name);
      });
    }
    function updateFoot() {
      $('filesCurrent').textContent = server ? `Открыт «${server}»` + (dirty ? ' · есть изменения' : '') : (dirty ? 'Документ ещё не сохранён на сервере' : '');
    }
    async function show(on = true) {
      $('files').hidden = !on;
      if (!on) return;
      $('filesList').innerHTML = '<p class="st-files-empty">Загружаю список…</p>';
      updateFoot();
      try { await refresh(); render(); } catch (e) { $('filesList').innerHTML = `<p class="st-files-empty err">${esc(e.message)}</p>`; }
      setTimeout(() => $('filesSearch').focus(), 30);
    }
    async function load(name) {
      try {
        toast('Открываю «' + name + '»…');
        const r = await fetch(api('action=load&name=' + encodeURIComponent(name)), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) await json(r);
        const bytes = new Uint8Array(await r.arrayBuffer());
        VC().open(name, bytes);
        server = name;
        show(false);
        PC.call('ui.backstage', { value: false }).catch(() => {});
      } catch (e) { toast('Не удалось открыть: ' + e.message, true); }
    }
    async function upload(name, bytes, overwrite) {
      const r = await fetch(api('action=save&name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : '')), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
      return json(r);
    }
    // Сохранение из редактора (Ctrl+S, Файл › Сохранить, «Сохранить как»): документ приходит сюда.
    async function onSave(detail) {
      const quiet = quietNext;
      const asked = saveAsNext || !!detail.saveAs;
      quietNext = false;
      saveAsNext = false;
      const bytes = detail.bytes;
      const path = String(detail.path || '');
      let name = server && (path === server || stem(path) === stem(server)) && !asked ? server : null;
      let overwrite = !!name;
      try {
        saving = true;
        if (!name) {
          if (quiet) return;
          const suggest = stem(server || detail.name || 'Документ') + extOf(detail.name);
          name = await askName(asked ? 'Сохранить как' : 'Сохранить на сервере', suggest, 'Документ появится в «Моих файлах».');
          if (!name) { dirty = true; return; }
          if (!DOC_EXT.test(name)) name += extOf(detail.name);
          if (!list.length) await refresh().catch(() => {});
          if (list.some((f) => f.name === name) && name !== server && !window.confirm(`Документ «${name}» уже есть. Заменить его?`)) { dirty = true; return; }
          overwrite = true;
        }
        const r = await upload(name, bytes, overwrite);
        if (server !== r.name || stem(path) !== stem(r.name)) await PC.exec('file.rename', { name: stem(r.name) }).catch(() => {});
        server = r.name;
        Recovery.clear();
        if (!quiet) toast('Сохранено: «' + r.name + '»');
        if (!$('files').hidden) { await refresh().catch(() => {}); render(); updateFoot(); }
      } catch (e) {
        Recovery.put({ name: name || detail.name, data: bytes, time: Date.now() });
        if (e.login) toast('Войдите в систему, чтобы сохранять документы на сервере. Копия осталась в браузере.', true);
        else toast((quiet ? 'Автосохранение не удалось: ' : 'Не удалось сохранить: ') + e.message + '. Копия осталась в браузере.', true);
      } finally { saving = false; }
    }
    async function save(saveAs) {
      if (!PC.ready()) return;
      saveAsNext = !!saveAs;
      try { await PC.exec('file.save'); } catch (e) { saveAsNext = false; toast('Не удалось сохранить: ' + e.message, true); }
    }
    async function rename(name) {
      const to0 = await askName('Переименовать', name);
      if (!to0 || to0 === name) return;
      const to = DOC_EXT.test(to0) ? to0 : to0 + extOf(name);
      try {
        await json(await fetch(api('action=rename'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, to }) }));
        if (server === name) { server = to; await PC.exec('file.rename', { name: stem(to) }).catch(() => {}); }
        await refresh(); render(); updateFoot();
      } catch (e) { toast('Не удалось переименовать: ' + e.message, true); }
    }
    async function remove(name) {
      if (!window.confirm(`Удалить «${name}»? Файл уйдёт в корзину на сервере.`)) return;
      try {
        await json(await fetch(api('action=delete'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
        if (server === name) server = null;
        await refresh(); render();
      } catch (e) { toast('Не удалось удалить: ' + e.message, true); }
    }
    function pickLocal() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.docx,.docm,.dotx,.dotm,.doc,.dot,.odt,.rtf,.txt,.md,.html,.htm';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try { VC().open(f.name, new Uint8Array(await f.arrayBuffer())); server = null; show(false); toast('Открыт «' + f.name + '». Сохраните его (Ctrl+S), чтобы он появился в «Моих файлах».'); }
        catch (e) { toast('Не удалось открыть ' + f.name + ': ' + e.message, true); }
      };
      input.click();
    }
    async function offerRecovery() {
      const r = await Recovery.get();
      if (!r || !r.data) return;
      const when = new Date(r.time).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const d = msg('note', `Документ «${esc(r.name)}» от ${esc(when)} не удалось сохранить на сервер — его копия осталась в браузере. ` +
        '<span class="st-row"><button class="st-mini" data-a="open">Открыть копию</button><button class="st-mini danger" data-a="drop">Удалить копию</button></span>');
      d.querySelector('[data-a="open"]').onclick = () => {
        try { VC().open(r.name, r.data); server = null; d.remove(); toast('Копия открыта. Сохраните её (Ctrl+S).'); }
        catch (e) { toast('Не удалось открыть копию: ' + e.message, true); }
      };
      d.querySelector('[data-a="drop"]').onclick = () => { Recovery.clear(); d.remove(); };
      setOpen(true);
    }
    // Раз в autosaveSeconds: документ, который уже лежит на сервере, сохраняется туда сам.
    async function tick() {
      for (;;) {
        await sleep(Math.max(15, CFG.autosaveSeconds || 60) * 1000);
        if (!CFG.autosaveSeconds || document.hidden || !PC.ready() || saving || !server || !dirty) continue;
        if (VC().wantsKeyboard && VC().wantsKeyboard() === false) { /* ок */ }
        quietNext = true;
        await PC.exec('file.save').catch(() => { quietNext = false; });
      }
    }
    function start() {
      VC().takesSaves = true;
      window.addEventListener('aiword:save', (e) => onSave(e.detail || {}));
      window.addEventListener('aiword:dirty', (e) => { dirty = !!(e.detail && e.detail.dirty); if (!$('files').hidden) updateFoot(); });
      $('filesBtn').onclick = () => show(true);
      $('filesClose').onclick = () => show(false);
      $('files').addEventListener('pointerdown', (e) => { if (e.target === $('files')) show(false); });
      $('files').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ask').hidden) { e.preventDefault(); show(false); } });
      $('filesSearch').addEventListener('input', render);
      $('filesNew').onclick = async () => { try { await newDocument(); server = null; show(false); } catch (e) { toast(e.message, true); } };
      $('filesUpload').onclick = pickLocal;
      $('filesSave').onclick = () => save(false);
      $('filesSaveAs').onclick = () => save(true);
      // Браузер не должен предлагать «Сохранить страницу как…».
      window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) e.preventDefault(); }, true);
      offerRecovery();
      tick();
      if (CFG.filesOnStart) refresh().then((l) => { if (l.length) show(true); }).catch(() => {});
    }
    return { start, show, save, current: () => server, ext: () => extOf(server), forget: () => { server = null; } };
  })();

  // ------------------------------------------------------------------ шрифты
  // Двойники шрифтов Microsoft (fonts/manifest.json) и шрифты организации с сервера (api/files.php?action=fonts):
  // строки и страницы верстаются по тем же размерам букв, что в Word.
  const Fonts = (() => {
    let loaded = [];
    async function add(name, url) {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = VC().addFont(name, new Uint8Array(await r.arrayBuffer()));
      if (res && Array.isArray(res.families)) loaded.push(...res.families);
    }
    async function start() {
      // Сначала шрифты организации (настоящие Times New Roman, Arial…), потом двойники.
      try {
        const j = await (await fetch(CFG.files + '?action=fonts', { credentials: 'same-origin', cache: 'no-store' })).json();
        for (const f of (j && j.ok && j.fonts) || []) {
          await add(f.name, CFG.files + '?action=font&name=' + encodeURIComponent(f.name)).catch((e) => console.warn('AI-Word: шрифт ' + f.name, e));
        }
      } catch { /* нет входа или сервера — только двойники */ }
      try {
        const m = await (await fetch(CFG.fonts, { cache: 'no-cache' })).json();
        for (const f of (m && m.fonts) || []) {
          await add(f.file, 'fonts/' + encodeURIComponent(f.file)).catch((e) => console.warn('AI-Word: шрифт ' + f.file, e));
        }
      } catch { /* сборка без шрифтов */ }
      // Русская орфография: словарь Hunspell из папки dictionaries/ (в браузере системных словарей нет).
      try {
        const [aff, dic] = await Promise.all(['ru_RU.aff', 'ru_RU.dic'].map((f) => fetch('dictionaries/' + f).then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))));
        VC().addDictionary('ru', aff, dic);
      } catch (e) { console.warn('AI-Word: русский словарь не загрузился', e); }
      return loaded;
    }
    return { start, families: () => loaded.slice() };
  })();

  // ------------------------------------------------------------------ быстрые задачи и новые документы
  const cm = (v) => Math.round(v * PT_PER_CM * 100) / 100;
  const needDoc = async () => {
    try { await PC.call('document.inspect', { text: false }); } catch { throw new Error('Сначала откройте или создайте документ.'); }
  };
  // Весь текст или выделенное: команды абзаца действуют на выделение.
  const onAll = async (fn) => {
    await needDoc();
    const d = await PC.call('document.inspect', { text: false });
    const hadSelection = !!(d.selection && d.selection.text);
    if (!hadSelection) await PC.exec('select.all');
    try { await fn(); } finally { if (!hadSelection) await PC.exec('select.range', { anchor: { story: 'body', path: [0], off: 0 }, focus: { story: 'body', path: [0], off: 0 } }).catch(() => {}); }
  };
  // Быстрые задачи: те, что делаются командами, — сразу; остальные — через помощника (! — сделать, ? — объяснить).
  const TASKS = [
    ['Оформление', [
      ['Оформить по ГОСТ', 'Поля 30/15/20/20 мм, Times New Roman 14, интервал 1,5, отступ 1,25 см, по ширине, номера страниц', async () => { await needDoc(); await applyGost({}); }],
      ['Межстрочный 1,5', 'Для выделенного или всего текста', () => onAll(() => PC.exec('para.set', { props: { lineSpacing: { rule: 'multiple', value: 1.5 } } }))],
      ['Одинарный интервал', 'Для выделенного или всего текста', () => onAll(() => PC.exec('para.set', { props: { lineSpacing: { rule: 'multiple', value: 1 } } }))],
      ['Абзацный отступ 1,25 см', 'Красная строка у выделенного или всего текста', () => onAll(() => PC.exec('para.set', { props: { indentFirst: cm(1.25) } }))],
      ['Выровнять по ширине', 'Выделенное или весь текст', () => onAll(() => PC.exec('para.set', { props: { align: 'justify' } }))],
      ['Times New Roman 14', 'Шрифт и кегль выделенного или всего текста', () => onAll(async () => { await PC.exec('format.font', { name: 'Times New Roman' }); await PC.exec('format.size', { size: 14 }); })],
      ['Убрать интервалы между абзацами', 'Перед и после — 0 пт', () => onAll(() => PC.exec('para.set', { props: { spaceBefore: 0, spaceAfter: 0 } }))],
      ['Поля по ГОСТ', 'Левое 30, правое 15, верхнее и нижнее 20 мм', async () => { await needDoc(); await PC.exec('layout.margins', { left: 85.04, right: 42.52, top: 56.69, bottom: 56.69 }); }],
    ]],
    ['Вставка', [
      ['Номера страниц', 'Внизу по центру', async () => { await needDoc(); await PC.exec('insert.pageNumber', { position: 'bottom', align: 'center' }); }],
      ['Оглавление', 'По заголовкам документа, в место курсора', async () => { await needDoc(); await PC.exec('references.toc', {}); }],
      ['Обновить оглавление', 'Номера страниц и пункты', async () => { await needDoc(); await PC.exec('references.updateToc', {}); }],
      ['Таблица 3×3', 'В место курсора', async () => { await needDoc(); await PC.exec('insert.table', { rows: 3, cols: 3 }); }],
      ['Разрыв страницы', 'Следующий текст — с новой страницы', async () => { await needDoc(); await PC.exec('text.pageBreak'); }],
    ]],
    ['Файл', [
      ['Сохранить на сервер', 'Ctrl+S', async () => { await Files.save(false); }],
      ['Сохранить как…', 'Под другим именем в «Моих файлах»', async () => { await Files.save(true); }],
      ['Скачать PDF', 'Как будет напечатано', async () => { await needDoc(); await PC.exec('file.exportPdf'); }],
      ['Новый документ', 'Пустой лист', async () => { await newDocument(); Files.forget(); }],
    ]],
    ['Попросить помощника', [
      ['Проверить по методичке', 'Найти отступы, интервалы и шрифты не по ГОСТ и исправить', '!Проверь оформление документа по ГОСТ (поля, шрифт, кегль, интервалы, отступы, выравнивание, заголовки) и исправь всё, что не так. Перечисли, что поправил.'],
      ['Проверить текст', 'Опечатки, ошибки, повторы', '?Проверь текст документа на опечатки, грамматические ошибки и повторы. Перечисли найденное с номерами абзацев.'],
      ['Кратко пересказать', 'О чём документ, главное', '?Кратко перескажи документ: о чём он, ключевые сроки, суммы и ответственные.'],
      ['Деловой стиль', 'Переписать выделенное официально', '!Перепиши выделенный текст официально-деловым стилем, сохранив смысл.'],
      ['Служебная записка', 'Новый документ по образцу', '!Составь служебную записку на тему: '],
      ['Приказ', 'Новый документ по образцу', '!Составь проект приказа о: '],
      ['Письмо', 'Деловое письмо', '!Составь деловое письмо: '],
      ['Перевести на английский', 'Выделенное или весь документ', '!Переведи выделенный текст на английский (если ничего не выделено — весь документ) и замени им исходный.'],
    ]],
  ];
  const Gallery = (() => {
    function show(on = true) {
      $('gallery').hidden = !on;
      if (on) renderTasks();
    }
    function renderTasks() {
      $('gTasks').innerHTML = TASKS.map(([group, items], gi) => `<section><h4>${esc(group)}</h4><div>${items.map(([n, d], i) => `<button class="st-task" data-g="${gi}" data-i="${i}"><b>${esc(n)}</b><small>${esc(d)}</small></button>`).join('')}</div></section>`).join('');
      $('gTasks').querySelectorAll('.st-task').forEach((b) => {
        const [, , run] = TASKS[+b.dataset.g][1][+b.dataset.i];
        b.onclick = async () => {
          if (typeof run === 'string') {
            show(false);
            setOpen(true);
            setMode(run.startsWith('?') ? 'advice' : 'act');
            const text = run.replace(/^[!?]/, '');
            input.value = text;
            if (/[.:]\s*$/.test(text) && text.endsWith(': ')) { autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }
            else send();
            return;
          }
          b.disabled = true;
          try { await run(); show(false); toast('Готово: ' + b.querySelector('b').textContent + '. Ctrl+Z — отменить.'); }
          catch (e) { toast(e.message, true); }
          finally { b.disabled = false; }
        };
      });
    }
    function start() {
      $('galleryBtn').onclick = () => show(true);
      $('galleryClose').onclick = () => show(false);
      $('gallery').addEventListener('pointerdown', (e) => { if (e.target === $('gallery')) show(false); });
      $('gallery').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(false); } });
    }
    return { start, show };
  })();

  // ------------------------------------------------------------------ тема
  // Тема редактора: светлая (как Word), тёмная или как в системе. Панель — в тон.
  const THEMES = [['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Как в системе']];
  const systemDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyPanelTheme(themeId) {
    root.dataset.theme = themeId === 'dark' || (themeId === 'system' && systemDark()) ? 'dark' : 'light';
    renderThemeMenu(themeId);
  }
  const syncBackdrop = () => {};
  function renderThemeMenu(current) {
    const menu = $('themeMenu');
    if (!menu) return;
    menu.innerHTML = THEMES.map((t) => `<button role="menuitemradio" aria-checked="${t[0] === current}" data-theme-id="${t[0]}">${esc(t[1])}</button>`).join('');
    menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { toggleThemeMenu(false); setTheme(b.dataset.themeId); }; });
  }
  function toggleThemeMenu(open) {
    const menu = $('themeMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    menu.hidden = !show;
    $('theme').setAttribute('aria-expanded', String(show));
  }
  async function setTheme(themeId) {
    applyPanelTheme(themeId);
    if (PC.ready()) await PC.call('ui.theme', { value: themeId }).catch(() => {});
  }
  // Тема, которая сейчас в редакторе, как бы её ни выбрали (Файл › Параметры, список в панели).
  async function watchTheme() {
    for (;;) {
      if (!document.hidden && PC.ready()) {
        try {
          const ui = await PC.call('ui.inspect');
          const id = ui && ui.ui && ui.ui.theme;
          if (typeof id === 'string') applyPanelTheme(id.toLowerCase());
          // Заголовок вкладки браузера — имя документа (окно браузера редактор сам не переименует).
          if (ui && typeof ui.title === 'string') document.title = ui.title ? `${ui.title}${ui.dirty ? ' •' : ''} — AI-Word` : 'AI-Word';
        } catch { /* не важно */ }
      }
      await sleep(2000);
    }
  }

  async function status() {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin' });
      const j = await r.json();
      if (j.ok) {
        $('sub').textContent = 'Модель: ' + j.model;
        fetch('studio/version.json', { cache: 'no-store' }).then((v) => (v.ok ? v.json() : null)).then((v) => {
          if (!v || !v.build) return;
          const d = String(v.date || '').split('-').reverse().join('.');
          $('sub').textContent = 'Модель: ' + j.model + ' · сборка ' + v.build + (d ? ' от ' + d : '');
          const pageBuild = document.documentElement.dataset.build;
          if (pageBuild && pageBuild !== String(v.build)) {
            const page = +pageBuild, server = +v.build;
            if (page > server) {
              msg('note', `Страница — от сборки ${esc(pageBuild)}, а файлы на сервере частично остались от сборки ${esc(String(v.build))}: ` +
                'программа заливки, похоже, пропустила файлы того же размера. Удалите старую папку на сервере целиком и залейте новую ' +
                '(или включите в программе «перезаписывать всегда»).');
            } else {
              msg('note', `Открыта старая копия страницы из кэша браузера (сборка ${esc(pageBuild)}), а на сервере уже сборка ${esc(String(v.build))}. Нажмите <b>Ctrl+F5</b>, чтобы загрузить новую.`);
            }
          }
        }).catch(() => {});
      }
      else $('sub').textContent = j.login ? 'Нужно войти в систему' : (j.error || 'Нет связи с помощником');
    } catch {
      $('sub').textContent = 'Нет связи с сервером помощника';
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }

  function mount() {
    document.body.appendChild(root);
    root.querySelectorAll('.st-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $('eye').onclick = () => setEye(!attachScreen);
    $('hide').onclick = () => setOpen(false);
    $('fab').onclick = () => { setOpen(true); setBadge(false); };
    $('send').onclick = () => send();
    $('barBtn').onclick = () => setBar(!root.classList.contains('bar-open'));
    $('barSend').onclick = () => (busy ? send() : sendFromBar());
    $('barMode').onclick = () => setMode(mode === 'act' ? 'advice' : 'act');
    barInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFromBar(); }
      if (e.key === 'Escape') { e.preventDefault(); setBar(false); }
    });
    $('clear').onclick = () => { if (!busy) { convo = []; showEmpty(); } };
    // Луна/солнце — между светлой и тёмной неоморфными; из фирменной — в светлую.
    $('theme').onclick = (e) => { e.stopPropagation(); toggleThemeMenu(); };
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('.st-theme-wrap')) toggleThemeMenu(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleThemeMenu(false); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    setMode(mode);
    setEye(attachScreen);
    applyPanelTheme('light');
    showEmpty();
    status();
  }

  async function boot() {
    mount();
    // Ждём, пока WebAssembly загрузится и поставит window.aiword.
    while (!PC.ready()) await sleep(200);
    Files.start();
    // Шрифты — до того, как пользователь откроет документ (потом перевёрстка тоже сработает).
    const fonts = Fonts.start();
    await sleep(300);
    root.classList.add('ready');
    if (store.get('open', CFG.openOnStart)) setOpen(true);
    commands().catch(() => {});
    watchTheme();
    Gallery.start();
    fonts.then((f) => { if (f.length) console.info('AI-Word: шрифты', f.join(', ')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
