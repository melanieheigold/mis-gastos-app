// mis-gastos iPhone app. Reads the engine's JSON API and renders four screens
// (Inicio, Movimientos, Presupuesto, Recurrentes) like design/mockup/Main.dc.html.
// No framework, no build step: this file is what the phone runs.

import { API_URL, FIREBASE, FIRESTORE_BASE } from './config.js?v=14';

// Shown at the bottom of Inicio so we can tell which version a phone is running.
const VERSION = '2026-11-17 · v14';

const TOKEN_KEY = 'mg-token';
const SPACE_KEY = 'mg-space'; // where this person's fast copy lives in Firebase; learned from the engine, or their whole access code (family)
const CACHE_KEY = 'mg-cache-v1:'; // + cycle → last good response, for offline
const TABS = ['inicio', 'movimientos', 'presupuesto', 'recurrentes'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const state = { open: new Set(), tab: 'inicio', cycle: null, current: null, data: null, error: null, loading: false, offline: false, edit: null, saving: false, toast: '', pending: 0, filter: '', catFilter: null, picking: false, form: null };
const $screen = document.getElementById('screen');

// ---------- storage (Safari private mode can throw) ----------

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* keep working without storage */ }
}

// ---------- formatting ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function crc(minor, { decimals = false } = {}) {
  const abs = Math.abs(minor) / 100;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: decimals && abs % 1 ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 });
  return `${minor < 0 ? '−' : ''}₡${s}`;
}
function usd(minor) {
  return `${minor < 0 ? '−' : ''}$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const money = (e) => (e.currency === 'CRC' ? crc(e.minor, { decimals: true }) : usd(e.minor));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const monthName = (cycle) => MESES[Number(cycle.slice(5, 7)) - 1];
const shortDate = (d) => `${Number(d.slice(8, 10))} ${MESES[Number(d.slice(5, 7)) - 1].slice(0, 3)}`;

function dayLabel(d) {
  const date = new Date(`${d}T12:00:00`);
  return `${DIAS[date.getDay()]} ${shortDate(d)}`;
}

// Names as Melanie says them, for merchants BAC spells like a bank.
const ALIASES = [
  [/^CTRO\.?\s*PROCES\.?\s*MARCHAMOS/i, 'Marchamo'],
  [/^APPLE\.COM/i, 'Apple'],
  [/^CLARO\b/i, 'Claro'],
  [/^MI VIAJE\b/i, 'Mi Viaje'],
  [/^DISNEY\s*PLUS/i, 'Disney+'],
  [/^NETFLIX/i, 'Netflix'],
  [/^PLAYSTATION/i, 'PlayStation'],
  [/^AMAZON PRIME/i, 'Amazon Prime'],
  [/^SEGURO PRF/i, 'Seguro de la tarjeta'],
  [/^RED PUNTOS/i, 'Canje de puntos'],
  [/^INTERESES/i, 'Intereses'],
  [/^UE \*COSTA RICA/i, 'Uber Eats (dólares)'],
];

/** `DLC* UBER EATS` → `Uber Eats`; `IVA -NETFLIX.COM` → `IVA Netflix`. */
function prettyName(s) {
  let t = s.replace(/^(DLC|UBR|ONVO|TST|SQ)\s*\*\s*/i, '');
  const iva = /^IVA\s*-\s*/i.test(t);
  t = t.replace(/^IVA\s*-\s*/i, '').replace(/\s+CUOTA\s*:?\s*\d+\s*\/\s*\d+/i, '').replace(/\s+/g, ' ').trim();
  const alias = ALIASES.find(([re]) => re.test(t));
  const name = alias ? alias[1] : t.toLowerCase().replace(/(^|[\s/.(-])([a-záéíóúñ])/g, (m, p, c) => p + c.toUpperCase());
  return iva ? `IVA ${name}` : name;
}
function cardName(card) {
  if (!card) return '';
  const [brand, last] = card.split(' ');
  return `${brand === 'MASTER' ? 'MasterCard' : brand === 'VISA' ? 'Visa' : cap(brand.toLowerCase())} ··${last}`;
}
function subLabel(e) {
  if (e.kind === 'card-payment') return 'Pago a la tarjeta';
  if (e.kind === 'other-card') return 'Tarjeta adicional · no cuenta';
  if (!e.category) return 'Sin categoría';
  if (e.category === 'SUPER' && e.sub === 'Super Base') return 'Súper';
  return e.sub || cap(e.category.toLowerCase());
}
function cuota(description) {
  const m = /CUOTA\s*:?\s*(\d+)\s*\/\s*(\d+)/i.exec(description);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function addMonths(cycle, n) {
  const [y, m] = cycle.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

/** CRC-equivalent of an entry, using the cycle rate (null rate → USD counts as 0). */
function crcValue(e, rate) {
  return e.currency === 'CRC' ? e.minor : rate ? Math.round((e.minor * rate) / 100) : 0;
}

// ---------- data ----------

function todayCycle() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return d.getDate() >= 16 ? addMonths(`${y}-${String(m).padStart(2, '0')}`, 1) : `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The engine pushes each cycle's finished result to Firestore; reading it takes a fraction
 * of a second. Returns null when there is no usable copy (not set up, old cycle, offline),
 * and the caller falls back to asking the engine itself, which is slow but always right.
 */
async function fetchSnapshot(cycle) {
  const space = load(SPACE_KEY);
  if (!FIREBASE.projectId || !space) return null;
  const url = `${FIRESTORE_BASE}/projects/${FIREBASE.projectId}/databases/(default)/documents/spaces/${space}/cycles/${cycle}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const doc = await res.json();
    const data = JSON.parse(doc.fields.json.stringValue);
    if (!data.ok || data.cycle !== cycle) { save(SPACE_KEY, ''); return null; } // blanked: the code was rotated
    return data;
  } catch {
    return null;
  }
}

/**
 * Two kinds of access. With a token (Melanie's own engine) the app can ask the engine
 * itself. Family members have only a space: their engine has no public address, so the
 * app reads Firebase and leaves its changes in the Firebase inbox (engine/src/inbox.ts).
 */
const signedIn = () => !!(load(TOKEN_KEY) || load(SPACE_KEY));
const familyMode = () => !load(TOKEN_KEY) && !!load(SPACE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Leaves one command in the inbox and waits for the engine's answer (it looks once a minute). */
async function sendToInbox(payload) {
  const base = `${FIRESTORE_BASE}/projects/${FIREBASE.projectId}/databases/(default)/documents/spaces/${load(SPACE_KEY)}/inbox`;
  const made = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(payload) }, at: { stringValue: new Date().toISOString() } } }),
  });
  if (!made.ok) return { ok: false, error: made.status === 403 || made.status === 404 ? 'unauthorized' : `HTTP ${made.status}` };
  const { name } = await made.json();
  for (let waited = 0; waited < INBOX_WAIT_MS; waited += INBOX_POLL_MS) {
    await sleep(INBOX_POLL_MS);
    try {
      const res = await fetch(`${FIRESTORE_BASE}/${name}`, { cache: 'no-store' });
      const result = res.ok ? (await res.json()).fields.result : null;
      if (result) return JSON.parse(result.stringValue);
    } catch { /* keep waiting: the command is already safely in the inbox */ }
  }
  return { ok: true, later: true }; // it is in the inbox and will be applied; we just stopped watching
}
const INBOX_POLL_MS = 4000;
const INBOX_WAIT_MS = 100000;

/** Sends one change (a category, a budget, the salary…) and returns {ok, error?, later?}. */
async function sendCommand(payload) {
  if (familyMode()) return sendToInbox(payload);
  // text/plain keeps this a simple request (no CORS preflight, which Apps Script can't answer)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: load(TOKEN_KEY), ...payload }),
  });
  return res.json();
}

async function fetchCycle(cycle) {
  const token = load(TOKEN_KEY);
  const url = `${API_URL}?token=${encodeURIComponent(token)}&cycle=${encodeURIComponent(cycle)}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  if (!signedIn()) return render();
  const cycle = state.cycle;
  const cached = load(CACHE_KEY + cycle);
  if (cached && (!state.data || state.data.cycle !== cycle)) {
    state.data = JSON.parse(cached);
    state.offline = false;
  }
  state.loading = true;
  render();
  try {
    let data = await fetchSnapshot(cycle);
    if (!data && !load(TOKEN_KEY)) {
      // family: Firebase is the only source. No copy means the code stopped working
      // (space cleared by fetchSnapshot), no connection, or a month with nothing in it.
      if (!load(SPACE_KEY)) data = { ok: false, error: 'unauthorized' };
      else if (!navigator.onLine) throw new Error('offline');
      else data = { ok: false, error: 'nodata' };
    }
    if (!data) data = await fetchCycle(cycle);
    if (cycle !== state.cycle) return; // user moved on
    if (state.pending) return; // a correction is being saved: keep what the screen shows
    if (!data.ok) {
      state.error = data.error === 'unauthorized' ? 'unauthorized' : data.error;
    } else {
      if (data.space) save(SPACE_KEY, data.space);
      delete data.space;
      state.data = data;
      state.error = null;
      state.offline = false;
      data.fetchedAt = new Date().toISOString();
      save(CACHE_KEY + cycle, JSON.stringify(data));
    }
  } catch {
    state.offline = true;
  } finally {
    state.loading = false;
    render();
  }
}

// ---------- screens ----------

function header(title, eyebrow, withNav = true) {
  const next = state.cycle < state.current;
  const nav = withNav ? `
    <div class="cycle-nav">
      <button type="button" class="icon-btn" data-act="prev" aria-label="Ciclo anterior"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
      <button type="button" class="icon-btn" data-act="next" aria-label="Ciclo siguiente" ${next ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>` : '';
  return `<div class="head"><div class="head-text"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div>${nav}</div>`;
}

function statusPill(d) {
  if (d.matchesStatement) {
    return `<span class="pill ok"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Cuadra con el estado de cuenta</span>`;
  }
  const [, end] = d.range;
  return `<span class="pill info">Provisional hasta el estado del ${esc(shortDate(end))}</span>`;
}

function syncLine(d) {
  const bits = [VERSION];
  if (state.offline) bits.push('Sin conexión: datos guardados');
  if (d.lastSync) bits.push(`Correos revisados ${ago(d.lastSync.runAt)}`);
  if (d.lastSync && d.lastSync.error) bits.push('⚠ el último intento falló');
  return bits.length ? `<div class="footer-note">${esc(bits.join(' · '))}</div>` : '';
}

/** A month without its own salary or rate uses the last one entered; say so. */
function carriedNote(s) {
  const notes = [];
  const from = s.incomeFrom || s.rateFrom;
  if (from) {
    const what = s.incomeFrom && s.rateFrom ? 'Mismo salario y tipo de cambio' : s.incomeFrom ? 'Mismo salario' : 'Mismo tipo de cambio';
    notes.push(`${what} que en ${esc(monthName(from))}. Cambialo solo si cambió.`);
  }
  // the rate nobody typed: fetched every day by the engine
  if (s.rateSource === 'auto' && s.rate) notes.push(`Tipo de cambio automático: ${rateText(s.rate)} del ${esc(shortDate(s.rateDate))} (${esc(s.rateName)}).`);
  return notes.map((n) => `<div class="note">${n}</div>`).join('');
}

const rateText = (minor) => `₡${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function inicio(d) {
  const s = d.summary;
  const rate = s.rate;
  let hero;
  if (s.teSobra === null) {
    const falta = s.missing.map((m) => (m === 'income' ? 'el salario' : 'el tipo de cambio')).join(' y ');
    hero = `<div class="hero missing">Falta ${esc(falta)} de ${esc(monthName(d.cycle))}.</div>
      <button type="button" class="btn" data-act="edit-cycle" style="margin-top:12px;width:100%">Agregar</button>`;
  } else {
    hero = `<div class="hero ${s.teSobra < 0 ? 'neg' : ''}">${crc(s.teSobra)}</div>`;
  }
  const rows = [];
  if (s.income !== null) rows.push(`<div class="row"><span>Salario</span><b>${crc(s.income)}</b></div>`);
  rows.push(`<div class="row"><span>Colones</span><b>${crc(-s.spend.CRC)}</b></div>`);
  if (s.spend.USD) {
    rows.push(`<div class="row"><span>Dólares <span class="note">${usd(s.spend.USD)}${rate ? ` × ${(rate / 100).toLocaleString('en-US')}` : ''}</span></span><b>${s.usdInCrc === null ? '—' : crc(-s.usdInCrc)}</b></div>`);
  }

  // where it went: every category (so the rows add up to the total), tap for subcategories
  const groups = new Map();
  for (const e of d.entries) {
    if (e.kind !== 'spend') continue;
    const cat = e.category || '';
    const g = groups.get(cat) || { total: 0, subs: new Map() };
    const v = crcValue(e, rate);
    g.total += v;
    const sub = e.category ? e.sub : '';
    g.subs.set(sub, (g.subs.get(sub) || 0) + v);
    groups.set(cat, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  const total = sorted.reduce((n, [, g]) => n + g.total, 0);
  const max = Math.max(1, ...sorted.map(([, g]) => g.total));
  const pct = (v) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '');
  const topRows = sorted.map(([cat, g]) => {
    const label = cat ? catLabel(cat) : 'Sin categoría';
    const open = state.open.has(cat);
    const subs = [...g.subs.entries()].sort((a, b) => b[1] - a[1]);
    const detail = open ? `<div class="subs">${subs.map(([s, v]) => `<button type="button" class="row sub-row sub-btn" data-act="set-filter" data-category="${esc(cat)}" data-sub="${esc(s)}" aria-label="${esc(`Ver las compras de ${s ? SUB_LABELS[s] || s : 'sin categoría'}`)}"><span>${esc(s ? SUB_LABELS[s] || s : 'Sin categoría')}</span><span>${crc(v)} ›</span></button>`).join('')}</div>` : '';
    return `
    <div class="item">
      <button type="button" class="cat-btn" data-act="toggle" data-cat="${esc(cat)}" aria-expanded="${open}">
        <span class="row"><span class="cat-name ${cat ? '' : 'over-text'}"><svg class="chev ${open ? 'open' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>${esc(label)}</span><b>${crc(g.total)} <span class="note pct">${pct(g.total)}</span></b></span>
        <span class="bar"><i style="width:${Math.max(2, Math.round((Math.max(0, g.total) / max) * 100))}%"></i></span>
      </button>
      ${detail}
    </div>`;
  }).join('');

  return `
    ${header(cap(monthName(d.cycle)), `Ciclo ${shortDate(d.range[0])} – ${shortDate(d.range[1])}`)}
    <section class="card pad" aria-label="Te sobra">
      <div><div class="hero-label">Te sobra este mes</div>${hero}</div>
      ${statusPill(d)}
      <div class="sep"></div>
      <div style="display:flex;flex-direction:column;gap:12px">${rows.join('')}</div>
      <div class="note">Incluye gastos fijos y cuotas. No incluye SINPE ni efectivo.</div>
      ${carriedNote(s)}
      ${s.teSobra === null ? '' : '<button type="button" class="link-btn" data-act="edit-cycle">Cambiar salario o tipo de cambio</button>'}
    </section>
    ${reviewCard(d)}
    <section class="section">
      <div class="section-head"><h2>En qué se fue</h2><span class="note">${crc(total)}</span></div>
      <div class="card">${topRows || '<div class="item note">Todavía no hay gastos en este ciclo.</div>'}</div>
    </section>
    ${syncLine(d)}`;
}

/** Shops with spend but no category, biggest first: the short list worth fixing by hand. */
function uncategorizedShops(d) {
  const shops = new Map();
  for (const e of d.entries) {
    if (e.kind !== 'spend' || e.category || !e.shop) continue;
    const s = shops.get(e.shop) || { shop: e.shop, name: prettyName(e.description), n: 0, crc: 0, usd: 0, value: 0 };
    s.n += 1;
    s[e.currency === 'CRC' ? 'crc' : 'usd'] += e.minor;
    s.value += crcValue(e, d.summary.rate || 50000); // only for ordering when there is no rate yet
    shops.set(e.shop, s);
  }
  return [...shops.values()].sort((a, b) => b.value - a.value);
}

function reviewCard(d) {
  const shops = uncategorizedShops(d);
  if (!shops.length) return '';
  const total = shops.reduce((n, s) => n + s.value, 0);
  return `
    <button type="button" class="card review" data-act="review">
      <span class="review-text"><b>${shops.length} ${shops.length === 1 ? 'comercio' : 'comercios'} sin categoría</b>
      <span class="note">${crc(total)} de este mes. Tocá para ponerles una.</span></span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
}

function sinCategoria(d) {
  const shops = uncategorizedShops(d);
  const rows = shops.map((s) => {
    const amount = [s.crc ? crc(s.crc) : '', s.usd ? usd(s.usd) : ''].filter(Boolean).join(' + ');
    return `<button type="button" class="item mov tappable" data-act="edit" data-shop="${esc(s.shop)}" data-name="${esc(s.name)}" data-category="" data-sub="" aria-label="${esc(`${s.name}. Elegir categoría`)}">
          <div class="avatar" aria-hidden="true">${esc(s.name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(s.name)}</span><span class="mov-meta">${s.n} ${s.n === 1 ? 'compra' : 'compras'}</span></div>
          <span class="mov-amt">${esc(amount)}</span></button>`;
  }).join('');
  return `
    ${header('Sin categoría', shops.length ? `${cap(monthName(d.cycle))} · ${shops.length} ${shops.length === 1 ? 'comercio' : 'comercios'}` : cap(monthName(d.cycle)))}
    ${shops.length
      ? `<div class="footer-note">Empezá por arriba: son los que más pesan. Cada uno se recuerda para siempre.</div><div class="card">${rows}</div>`
      : '<div class="card"><div class="item note">Listo: todas las compras de este mes tienen categoría.</div></div>'}
    <button type="button" class="btn quiet" data-act="clear-filter">Ver todos los movimientos</button>
    ${syncLine(d)}`;
}

const matchesFilter = (e, f) => e.kind === 'spend' && e.category === f.category && (!f.sub || e.sub === f.sub);
const filterLabel = (f) => (f.sub ? SUB_LABELS[f.sub] || f.sub : `Todo ${catLabel(f.category)}`);

/** The bar above Movimientos: a button to pick a category, or the active filter with its total. */
function filterBar(d, shown) {
  const f = state.catFilter;
  if (!f) return '<button type="button" class="filter-btn" data-act="open-filter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filtrar por categoría</button>';
  const sum = (cur) => shown.filter((e) => e.currency === cur).reduce((n, e) => n + e.minor, 0);
  const total = [sum('CRC') ? crc(sum('CRC')) : '', sum('USD') ? usd(sum('USD')) : ''].filter(Boolean).join(' + ') || '₡0';
  return `
    <div class="card filter-card">
      <div class="filter-text"><b>${esc(filterLabel(f))}</b><span class="note">${shown.length} ${shown.length === 1 ? 'compra' : 'compras'} · ${esc(total)}</span></div>
      <button type="button" class="link-btn" data-act="clear-filter">Quitar filtro</button>
    </div>`;
}

/** Sheet listing only the categories that have spend this month. */
function filterSheetHtml() {
  const d = state.data;
  const present = new Map();
  let uncategorized = false;
  for (const e of d.entries) {
    if (e.kind !== 'spend') continue;
    if (!e.category) { uncategorized = true; continue; }
    if (!present.has(e.category)) present.set(e.category, new Set());
    present.get(e.category).add(e.sub);
  }
  const f = state.catFilter;
  const pill = (cat, sub, label) => {
    const on = !!f && f.category === cat && (f.sub || '') === sub;
    return `<button type="button" class="pick ${on ? 'current' : ''}" data-act="set-filter" data-category="${esc(cat)}" data-sub="${esc(sub)}" aria-pressed="${on}">${esc(label)}</button>`;
  };
  const groups = [...present.entries()].sort((a, b) => catLabel(a[0]).localeCompare(catLabel(b[0]))).map(([cat, subs]) => `
    <div class="pick-group">
      <div class="pick-label">${esc(catLabel(cat))}</div>
      <div class="pick-row">${subs.size > 1 ? pill(cat, '', 'Todo') : ''}${[...subs].sort().map((s) => pill(cat, s, SUB_LABELS[s] || s)).join('')}</div>
    </div>`).join('');
  return `
    <div class="backdrop" data-act="close-filter"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="filter-title">
      <div class="sheet-head">
        <div class="sheet-title">
          <h2 id="filter-title">Filtrar</h2>
          <p class="note">Categorías con compras en ${esc(monthName(state.cycle))}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close-filter" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <div class="sheet-body">
        ${uncategorized ? '<button type="button" class="add-row warn-row" data-act="set-filter" data-category="" data-sub="">Sin categoría</button>' : ''}
        ${groups || '<p class="note">Todavía no hay compras este mes.</p>'}
      </div>
    </section>`;
}

function movimientos(d) {
  if (state.filter === 'uncat') return sinCategoria(d);
  const f = state.catFilter;
  const shown = f ? d.entries.filter((e) => matchesFilter(e, f)) : d.entries;
  const list = [...shown].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const days = new Map();
  for (const e of list) {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  }
  const groups = [...days.entries()].map(([date, items]) => {
    const crcSum = items.filter((e) => e.kind === 'spend' && e.currency === 'CRC').reduce((n, e) => n + e.minor, 0);
    const usdSum = items.filter((e) => e.kind === 'spend' && e.currency === 'USD').reduce((n, e) => n + e.minor, 0);
    const total = [crcSum ? crc(crcSum) : '', usdSum ? usd(usdSum) : ''].filter(Boolean).join(' + ');
    const rows = items.map((e) => {
      const tag = e.source === 'predicted' ? '<span class="tag">estimado</span>'
        : e.source === 'fixed' ? '<span class="tag">fijo</span>'
        : '';
      const name = prettyName(e.description);
      const meta = [subLabel(e), cardName(e.card)].filter(Boolean).join(' · ');
      const inner = `
          <div class="avatar" aria-hidden="true">${esc(name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(name)}</span><span class="mov-meta ${e.kind === 'spend' && !e.category ? 'over-text' : ''}">${tag ? `${tag.replace('class="tag"', 'class="tag first"')} ` : ''}${esc(meta)}</span></div>
          <span class="mov-amt ${e.kind !== 'spend' ? 'muted' : ''}">${esc(money(e))}</span>`;
      if (!e.shop) return `<div class="item mov">${inner}</div>`;
      return `<button type="button" class="item mov tappable" data-act="edit" data-shop="${esc(e.shop)}" data-name="${esc(name)}" data-category="${esc(e.category)}" data-sub="${esc(e.sub)}" aria-label="${esc(`${name}, ${subLabel(e)}. Cambiar categoría`)}">${inner}</button>`;
    }).join('');
    return `<div class="section"><div class="group-label"><span>${esc(dayLabel(date))}</span><span>${esc(total)}</span></div><div class="card">${rows}</div></div>`;
  }).join('');
  return `
    ${header('Movimientos', `${cap(monthName(d.cycle))} · ${d.entries.length} movimientos`)}
    ${filterBar(d, shown)}
    ${groups ? '<div class="footer-note">Tocá una compra para cambiar su categoría.</div>' + groups
      : `<div class="card"><div class="item note">${f ? 'No hay compras de esa categoría este mes.' : 'Todavía no hay movimientos en este ciclo.'}</div></div>`}
    ${syncLine(d)}`;
}

function presupuesto(d) {
  const budgets = d.budgets || [];
  const rows = budgets.map((b) => {
    const over = b.spent > b.limit;
    const pct = b.limit > 0 ? Math.min(100, Math.round((b.spent / b.limit) * 100)) : 100;
    const note = over ? `Te pasaste ${crc(b.spent - b.limit)}` : `Quedan ${crc(b.limit - b.spent)}`;
    return `
      <button type="button" class="item tappable" data-act="edit-budget" data-match="${esc(b.match)}" aria-label="${esc(`${b.name}: ${note}. Cambiar`)}">
        <span class="row"><b style="font-weight:600">${esc(b.name)}</b><span class="note ${over ? 'over-text' : ''}" style="font-weight:600">${esc(note)}</span></span>
        <span class="bar thick ${over ? 'over' : ''}"><i style="width:${Math.max(2, pct)}%"></i></span>
        <span class="small"><span>${crc(b.spent)} gastado</span><span>de ${crc(b.limit)}</span></span>
      </button>`;
  }).join('');
  return `
    ${header('Presupuesto', `${cap(monthName(d.cycle))} · tocá para cambiar`)}
    <button type="button" class="add-row" data-act="edit-budget" data-match="">+ Nuevo presupuesto</button>
    ${rows ? `<div class="card">${rows}</div>` : '<div class="card"><div class="item note">Todavía no hay presupuestos. Creá el primero con el botón de arriba.</div></div>'}
    <div class="footer-note">Los dólares cuentan al tipo de cambio del mes.</div>
    ${syncLine(d)}`;
}

function recurrentes(d) {
  const cycle = d.cycle;
  const cuotas = d.entries.filter((e) => e.category === 'Tasa 0').map((e) => {
    const c = cuota(e.description);
    const end = c ? addMonths(cycle, c[1] - c[0]) : null;
    const meta = c ? `Cuota ${c[0]} de ${c[1]} · ${c[0] === c[1] ? 'es la última' : `termina en ${monthName(end)}`}` : 'Cuota';
    return { name: prettyName(e.description), meta, amount: money(e), pct: c ? Math.round((c[0] / c[1]) * 100) : null };
  });
  const fixedRows = d.entries.filter((e) => e.source === 'fixed').map((e) => `
        <button type="button" class="item tappable" style="gap:6px" data-act="edit-fixed" data-desc="${esc(e.description)}" aria-label="${esc(`${e.description}, ${money(e)}. Cambiar`)}">
          <span class="row"><span style="font-weight:500">${esc(e.description)}</span><b>${esc(money(e))}</b></span>
          <span class="note">${esc(subLabel(e))} · cada mes</span>
        </button>`).join('');
  const fixedSection = `
    <div class="section">
      <div class="group-label"><span>Fijos</span></div>
      ${fixedRows ? `<div class="card">${fixedRows}</div>` : ''}
      <button type="button" class="add-row" data-act="edit-fixed" data-desc="">+ Gasto fijo</button>
    </div>`;

  // subscriptions and services: merge each IVA line into its subscription
  const SUBS = ['Suscripciones', 'Telefono', 'Seguro', 'Indoor'];
  const subs = new Map();
  for (const e of d.entries) {
    if (e.kind !== 'spend' || !SUBS.includes(e.sub) || e.source === 'fixed') continue;
    const base = prettyName(e.description).replace(/^IVA /, '').replace(/\s+(Prfcd\d+|Plan A.*)$/i, '');
    const key = `${base}|${e.currency}`;
    const cur = subs.get(key) || { name: base, currency: e.currency, minor: 0, iva: 0, card: e.card, sub: e.sub, n: 0 };
    if (/^IVA /i.test(prettyName(e.description))) cur.iva += e.minor; else { cur.minor += e.minor; cur.n += 1; }
    subs.set(key, cur);
  }
  const subRows = [...subs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
    const fmt = (m) => (s.currency === 'CRC' ? crc(m, { decimals: true }) : usd(m));
    const meta = [s.iva ? `${fmt(s.minor)} + IVA ${fmt(s.iva)}` : s.n > 1 ? `${s.n} cobros este mes` : '', s.sub === 'Telefono' ? 'Teléfono' : '', cardName(s.card)].filter(Boolean).join(' · ');
    return { name: s.name, meta, amount: fmt(s.minor + s.iva), pct: null };
  });

  const group = (title, items) => !items.length ? '' : `
    <div class="section">
      <div class="group-label"><span>${esc(title)}</span></div>
      <div class="card">${items.map((r) => `
        <div class="item" style="gap:6px">
          <div class="row"><span style="font-weight:500">${esc(r.name)}</span><b>${esc(r.amount)}</b></div>
          <span class="note">${esc(r.meta)}</span>
          ${r.pct === null ? '' : `<div class="bar"><i style="width:${r.pct}%"></i></div>`}
        </div>`).join('')}</div>
    </div>`;
  return `
    ${header('Recurrentes', `${cap(monthName(cycle))} · cada mes`)}
    ${group('Tasa 0', cuotas)}${fixedSection}${group('Suscripciones y servicios', subRows)}
    ${syncLine(d)}`;
}

// ---------- category corrections ----------

const SUB_LABELS = { 'Super Base': 'Súper', Telefono: 'Teléfono', 'Carro Mantenimiento': 'Mantenimiento' };
// Inicio groups by category; Tasa 0 has its own name.
const CAT_LABELS = { 'Tasa 0': 'Tasa 0', SUPER: 'Súper', DIVERSION: 'Diversión' };
/** Categories are stored in capitals (`TRANSPORTE`) and shown as words (`Transporte`). */
const catLabel = (cat) => CAT_LABELS[cat] || cap(cat.toLowerCase());

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';

/** The category sheet has two screens: pick one, or (from the button at the top) make one. */
function sheetHtml() {
  const ed = state.edit;
  const taxonomy = (state.data && state.data.taxonomy) || {};
  return `
    <div class="backdrop" data-act="close"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      ${ed.adding ? newCategoryScreen(ed, taxonomy) : pickScreen(ed, taxonomy)}
    </section>`;
}

function pickScreen(ed, taxonomy) {
  const groups = Object.entries(taxonomy).map(([cat, subs]) => `
    <div class="pick-group">
      <div class="pick-label">${esc(catLabel(cat))}</div>
      <div class="pick-row">${subs.map((sub) => {
        const current = ed.category === cat && ed.sub === sub;
        return `<button type="button" class="pick ${current ? 'current' : ''}" data-act="pick" data-category="${esc(cat)}" data-sub="${esc(sub)}" aria-pressed="${current}">${esc(SUB_LABELS[sub] || sub)}</button>`;
      }).join('')}</div>
    </div>`).join('');
  return `
      <div class="sheet-head">
        <div class="sheet-title">
          <h2 id="sheet-title">${esc(ed.name)}</h2>
          <p class="note">Vale para todas las compras en este comercio.</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      ${ed.error ? `<p class="pill warn">${esc(ed.error)}</p>` : ''}
      <div class="sheet-body">
        <button type="button" class="add-row" data-act="add-cat">+ Nueva categoría</button>
        ${groups}
      </div>`;
}

/** Its own screen, with the fields at the top so the iPhone keyboard never covers them. */
function newCategoryScreen(ed, taxonomy) {
  const cats = Object.keys(taxonomy);
  const chosen = cats.includes(ed.category) ? ed.category : cats[0] || '';
  const chips = cats.map((cat) => `<button type="button" class="pick ${cat === chosen ? 'current' : ''}" data-act="group" data-category="${esc(cat)}" aria-pressed="${cat === chosen}">${esc(catLabel(cat))}</button>`).join('');
  return `
      <div class="sheet-head">
        <button type="button" class="icon-btn" data-act="back" aria-label="Volver a las categorías">${ICON_BACK}</button>
        <div class="sheet-title center-title">
          <h2 id="sheet-title">Nueva categoría</h2>
          <p class="note">Para ${esc(ed.name)}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <form id="newcat-form" class="newcat">
        ${ed.error ? `<p class="pill warn">${esc(ed.error)}</p>` : ''}
        <label class="lbl" for="nc-sub">Nombre</label>
        <input id="nc-sub" class="field" name="sub" maxlength="40" required autocomplete="off" enterkeyhint="done" placeholder="Por ejemplo: Cerámica" value="${esc(ed.newSub || '')}">
        <div class="lbl" id="nc-group-label">Grupo</div>
        <div class="pick-row" role="group" aria-labelledby="nc-group-label">
          ${chips}
          <button type="button" class="pick add ${chosen ? '' : 'current'}" data-act="group" data-category="" aria-pressed="${!chosen}">+ Grupo nuevo</button>
        </div>
        <input type="hidden" id="nc-cat" name="category" value="${esc(chosen)}">
        <input id="nc-new" class="field" name="newcat" maxlength="40" autocomplete="off" placeholder="Nombre del grupo nuevo" aria-label="Nombre del grupo nuevo" ${chosen ? 'hidden' : ''}>
        <button class="btn" type="submit">Crear y usar</button>
      </form>`;
}

/** Same checks as the engine (core newCategory), so the person hears about a problem at once. */
function checkNewCategory(taxonomy, category, sub) {
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const cat = clean(category).toUpperCase();
  const s = clean(sub);
  const NAME = /^[^,;/|]{1,40}$/;
  if (!NAME.test(cat) || !NAME.test(s)) return { error: 'El nombre debe tener entre 1 y 40 letras, sin comas ni barras.' };
  if (cat === 'TASA 0') return { error: 'Tasa 0 la asigna el estado de cuenta.' };
  if ((taxonomy[cat] || []).some((e) => e.toLowerCase() === s.toLowerCase())) return { error: 'Esa categoría ya existe.' };
  return { category: cat, sub: s };
}

// ---------- settings: salary and rate, budgets, fixed expenses ----------

/** Minor units as a person would type them back: 180000000 → `1,800,000`, 50650 → `506.5`. */
const typedAmount = (minor) => (minor === null || minor === undefined ? '' : (minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** Same rules as the engine's parseTyped (core/src/money.ts): dots and commas mean the same (1,800,000 · 1.800.000 · 1,800.000 · 506,5). */
function parseTyped(text) {
  const s = String(text).replace(/[₡$\s]/g, '');
  if (!/^\d*([.,]\d+)*$/.test(s) || !/\d/.test(s)) return null;
  const parts = s.split(/[.,]/);
  const rest = parts.slice(1);
  let units = parts[0];
  let cents = '';
  if (rest.length && rest.every((p) => p.length === 3) && units !== '') {
    units += rest.join('');
  } else if (rest.length) {
    cents = rest[rest.length - 1];
    const middle = rest.slice(0, -1);
    if (cents.length > 2 || middle.some((p) => p.length !== 3)) return null;
    units += middle.join('');
  }
  const minor = Number(units || 0) * 100 + Number(cents.padEnd(2, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

function categoryOptions(taxonomy, selected, { groups = false, taken = [] } = {}) {
  return Object.entries(taxonomy).map(([cat, subs]) => {
    const opt = (value, label) => (taken.includes(value) && value !== selected ? '' : `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`);
    return `<optgroup label="${esc(catLabel(cat))}">${groups ? opt(cat, `Todo ${catLabel(cat)}`) : ''}${subs.map((s) => opt(`${cat}/${s}`, SUB_LABELS[s] || s)).join('')}</optgroup>`;
  }).join('');
}

function formSheetHtml() {
  const f = state.form;
  const d = state.data;
  const month = cap(monthName(state.cycle));
  let title = '', sub = '', fields = '', extra = '';
  if (f.kind === 'cycle') {
    title = month;
    sub = 'Salario y tipo de cambio';
    fields = `
        <label class="lbl" for="f-income">Salario del mes, en colones</label>
        <input id="f-income" class="field" name="income" inputmode="numeric" data-whole autocomplete="off" placeholder="Por ejemplo: 1,800,000" value="${esc(f.income)}">
        <label class="lbl" for="f-rate">Tipo de cambio, colones por dólar</label>
        <input id="f-rate" class="field" name="rate" inputmode="decimal" autocomplete="off" placeholder="${d.summary.autoRate ? `Automático: ${(d.summary.autoRate / 100).toFixed(2)}` : 'Por ejemplo: 506'}" value="${esc(f.rate)}">
        <p class="note">${d.summary.autoRate
          ? `Dejalo vacío y se usa el tipo de cambio automático (${rateText(d.summary.autoRate)}), que se actualiza cada día. Escribí uno solo si querés fijarlo para este mes.`
          : 'El tipo de cambio es el que usás para pagar los dólares de la tarjeta.'}</p>`;
  } else if (f.kind === 'budget') {
    const isNew = !f.original;
    title = isNew ? 'Nuevo presupuesto' : f.name;
    sub = isNew ? 'Un límite por mes' : 'Límite por mes';
    const taken = (d.budgets || []).map((b) => b.match);
    fields = `${isNew ? `
        <label class="lbl" for="f-match">Para</label>
        <select id="f-match" class="field" name="match">${categoryOptions(d.taxonomy || {}, f.match, { groups: true, taken })}${taken.includes('Tasa 0') ? '' : '<option value="Tasa 0">Tasa 0 (cuotas)</option>'}</select>` : `<input type="hidden" name="match" value="${esc(f.match)}">`}
        <label class="lbl" for="f-limit">Límite, en colones</label>
        <input id="f-limit" class="field" name="limit" inputmode="numeric" data-whole autocomplete="off" placeholder="Por ejemplo: 100,000" value="${esc(f.limit)}">`;
    extra = isNew ? '' : '<button type="button" class="link-btn danger" data-act="remove-setting">Quitar este presupuesto</button>';
  } else {
    const isNew = !f.original;
    title = isNew ? 'Nuevo gasto fijo' : 'Gasto fijo';
    sub = `Vale desde ${monthName(state.cycle)} en adelante`;
    fields = `
        <label class="lbl" for="f-desc">Nombre</label>
        <input id="f-desc" class="field" name="description" maxlength="40" autocomplete="off" placeholder="Por ejemplo: Alquiler" value="${esc(f.description)}">
        <label class="lbl" for="f-amount">Monto por mes</label>
        <div class="amount-row">
          <input id="f-amount" class="field" name="amount" inputmode="decimal" autocomplete="off" placeholder="Por ejemplo: 250,000" value="${esc(f.amount)}">
          <div class="pick-row" role="group" aria-label="Moneda">
            <button type="button" class="pick ${f.currency === 'CRC' ? 'current' : ''}" data-act="seg" data-value="CRC" aria-pressed="${f.currency === 'CRC'}">₡</button>
            <button type="button" class="pick ${f.currency === 'USD' ? 'current' : ''}" data-act="seg" data-value="USD" aria-pressed="${f.currency === 'USD'}">$</button>
          </div>
          <input type="hidden" name="currency" value="${esc(f.currency)}">
        </div>
        <label class="lbl" for="f-cat">Categoría</label>
        <select id="f-cat" class="field" name="category">${categoryOptions(d.taxonomy || {}, f.category)}</select>`;
    extra = isNew ? '' : `<button type="button" class="link-btn danger" data-act="remove-setting">Quitar desde ${esc(monthName(state.cycle))}</button>`;
  }
  return `
    <div class="backdrop" data-act="close-form"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="form-title">
      <div class="sheet-head">
        <div class="sheet-title">
          <h2 id="form-title">${esc(title)}</h2>
          <p class="note">${esc(sub)}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close-form" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <form id="setting-form" class="newcat">
        ${f.error ? `<p class="pill warn">${esc(f.error)}</p>` : ''}
        ${fields}
        <button class="btn" type="submit">Guardar</button>
        ${extra}
      </form>
    </section>`;
}

function openForm(kind, key) {
  const d = state.data;
  if (kind === 'cycle') {
    // whole colones for the salary (the field takes digits only); the rate may have decimals
    state.form = { kind, income: d.summary.income === null ? '' : Math.round(d.summary.income / 100).toLocaleString('en-US'), // only a rate typed for this very month is shown: an automatic or carried one must not be saved as typed
      rate: (d.summary.rateSource ? d.summary.rateSource === 'typed' : !d.summary.rateFrom) ? typedAmount(d.summary.rate) : '', error: '' };
  } else if (kind === 'budget') {
    const b = (d.budgets || []).find((x) => x.match === key);
    state.form = b ? { kind, original: b.match, match: b.match, name: b.name, limit: Math.round(b.limit / 100).toLocaleString('en-US'), error: '' }
      : { kind, original: '', match: '', name: '', limit: '', error: '' };
  } else {
    const e = d.entries.find((x) => x.source === 'fixed' && x.description === key);
    state.form = e ? { kind, original: e.description, description: e.description, amount: typedAmount(e.minor), currency: e.currency, category: `${e.category}/${e.sub}`, error: '' }
      : { kind, original: '', description: '', amount: '', currency: 'CRC', category: '', error: '' };
  }
  renderOverlay();
  document.querySelector('#setting-form .field:not([type=hidden])')?.focus();
}

/** What the form holds now, as the command the engine expects, or an error to show. */
function readForm(form) {
  const f = state.form;
  const v = (k) => String(form.get(k) || '').trim();
  const amountOk = (s) => s !== '' && parseTyped(s) !== null && parseTyped(s) > 0;
  if (f.kind === 'cycle') {
    Object.assign(f, { income: v('income'), rate: v('rate') });
    if (f.income !== '' && parseTyped(f.income) === null) return { error: 'No entendí el salario. Escribilo solo con números, por ejemplo 1,800,000.' };
    const rate = f.rate === '' ? null : parseTyped(f.rate);
    if (f.rate !== '' && (rate === null || rate < 10000 || rate > 200000)) return { error: 'El tipo de cambio debe estar entre 100 y 2,000 colones por dólar.' };
    return { payload: { action: 'setCycle', cycle: state.cycle, income: f.income, rate: f.rate }, done: 'Guardado' };
  }
  if (f.kind === 'budget') {
    Object.assign(f, { match: v('match'), limit: v('limit') });
    if (!f.match) return { error: 'Elegí para qué es el presupuesto.' };
    if (!amountOk(f.limit)) return { error: 'Escribí el límite solo con números, por ejemplo 100,000.' };
    const name = f.name || (f.match.includes('/') ? f.match.split('/')[1] : catLabel(f.match));
    return { payload: { action: 'setBudget', match: f.match, name: SUB_LABELS[name] || name, limit: f.limit }, done: 'Presupuesto guardado' };
  }
  Object.assign(f, { description: v('description'), amount: v('amount'), currency: v('currency'), category: v('category') });
  if (!f.description) return { error: 'Ponele un nombre.' };
  if (!amountOk(f.amount)) return { error: 'Escribí el monto solo con números, por ejemplo 250,000.' };
  if (!f.category) return { error: 'Elegí una categoría.' };
  const [category, sub] = f.category.split('/');
  return { payload: { action: 'setFixed', cycle: state.cycle, description: f.description, original: f.original || f.description, currency: f.currency, amount: f.amount, category, sub }, done: 'Gasto fijo guardado' };
}

function removalOf(f) {
  return f.kind === 'budget' ? { payload: { action: 'setBudget', match: f.match, limit: '' }, done: 'Presupuesto quitado' }
    : { payload: { action: 'removeFixed', cycle: state.cycle, description: f.original }, done: 'Gasto fijo quitado' };
}

/** Closes the form, saves in the background, then reloads; on failure the form comes back with the reason. */
async function saveSetting({ payload, done }) {
  const form = state.form;
  state.form = null;
  state.pending += 1;
  showToast(familyMode() ? 'Guardando… puede tardar un minuto' : 'Guardando…', familyMode() ? INBOX_WAIT_MS + 10000 : 15000);
  let failure = '';
  try {
    const out = await sendCommand(payload);
    if (!out.ok) failure = out.error === 'unauthorized' ? 'El código de acceso ya no es válido.' : out.error;
    else if (out.later) done = 'Guardado. Se va a ver en unos minutos.';
  } catch {
    failure = 'No hay conexión. Probá de nuevo.';
  }
  state.pending -= 1;
  if (failure) {
    state.toast = '';
    state.form = { ...form, error: failure };
    renderOverlay();
  } else {
    showToast(done);
    refresh();
  }
}

function renderOverlay() {
  let $o = document.getElementById('overlay');
  if (!$o) { $o = document.createElement('div'); $o.id = 'overlay'; document.body.appendChild($o); }
  $o.innerHTML = (state.edit ? sheetHtml() : state.form ? formSheetHtml() : state.picking ? filterSheetHtml() : '') + (state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : '');
  document.body.classList.toggle('locked', !!(state.edit || state.form || state.picking));
}

/**
 * Shows the change at once and saves in the background (the engine takes a few seconds).
 * If saving fails, the screen goes back to how it was and says so.
 */
async function saveCorrection(category, sub, create = false) {
  const ed = state.edit;
  const cycle = state.cycle;
  const before = JSON.stringify(state.data);
  if (create) (state.data.taxonomy[category] = state.data.taxonomy[category] || []).push(sub);
  for (const e of state.data.entries) if (e.shop === ed.shop) { e.category = category; e.sub = sub; }
  state.edit = null;
  state.pending += 1;
  showToast(`${ed.name} → ${SUB_LABELS[sub] || sub}`);
  render();
  let failure = '';
  try {
    const out = await sendCommand({ action: 'correct', shop: ed.shop, category, sub, ...(create ? { create: true } : {}) });
    if (!out.ok) failure = out.error === 'unauthorized' ? 'el código de acceso ya no es válido' : out.error;
  } catch {
    failure = 'no hay conexión';
  }
  state.pending -= 1;
  if (failure) {
    if (state.cycle === cycle) state.data = JSON.parse(before);
    showToast(`No se guardó ${ed.name}: ${failure}`, 5000);
    render();
  } else {
    refresh(); // budgets and totals come back recalculated
  }
}

let toastTimer = 0;
function showToast(text, ms = 2600) {
  state.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; renderOverlay(); }, ms);
  renderOverlay();
}

function setupScreen(message) {
  return `
    <div class="center">
      <h1>mis-gastos</h1>
      <p class="note" style="font-size:15px;line-height:21px">${esc(message || 'Para ver tus datos, pegá tu código de acceso. Está en la página donde conectaste tu correo, o en el correo de configuración.')}</p>
      <form id="token-form" style="display:flex;flex-direction:column;gap:10px">
        <label class="lbl" for="token">Código de acceso</label>
        <input id="token" class="field" name="token" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" required>
        <button class="btn" type="submit">Entrar</button>
      </form>
    </div>`;
}

function render() {
  for (const b of document.querySelectorAll('.tab')) {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  document.querySelector('.tabbar').hidden = !signedIn() || state.error === 'unauthorized';
  if (!signedIn()) { $screen.innerHTML = setupScreen(); return; }
  if (state.error === 'unauthorized') { $screen.innerHTML = setupScreen('Ese código no funcionó o ya no es válido. Pegá el código actual.'); return; }
  const d = state.data && state.data.cycle === state.cycle ? state.data : null;
  if (!d && state.error === 'nodata') {
    // keeps the month arrows, so a month with nothing in it is not a dead end
    $screen.innerHTML = `${header(cap(monthName(state.cycle)), 'Sin datos')}<section class="card pad"><p class="note" style="font-size:15px;line-height:21px">Todavía no hay nada de este mes. Si acabás de conectar tu correo, esperá un par de minutos.</p><button class="btn" type="button" data-act="retry">Reintentar</button></section>`;
    return;
  }
  if (!d) {
    $screen.innerHTML = state.offline || state.error
      ? `<div class="center"><h1>Sin datos</h1><p class="note">${esc(state.error ? `Error: ${state.error}` : 'No hay conexión y todavía no hay datos guardados de este ciclo.')}</p><button class="btn" type="button" data-act="retry">Reintentar</button></div>`
      : `${header(cap(monthName(state.cycle)), 'Cargando…')}<div class="skeleton"></div><div class="skeleton" style="height:300px"></div>`;
    return;
  }
  const view = { inicio, movimientos, presupuesto, recurrentes }[state.tab];
  $screen.innerHTML = view(d);
  // a background refresh must not rebuild the form she is typing in (it would drop her text and the keyboard)
  if (!(state.edit && state.edit.adding) && !state.form) renderOverlay();
}

// ---------- events ----------

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    state.filter = '';
    state.catFilter = null;
    save('mg-tab', state.tab);
    render();
    window.scrollTo(0, 0);
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (!act || act.disabled) return;
  const a = act.dataset.act;
  if (a === 'edit') {
    state.edit = { shop: act.dataset.shop, name: act.dataset.name, category: act.dataset.category, sub: act.dataset.sub, error: '' };
    renderOverlay();
    return;
  }
  if (a === 'close') { if (!state.saving) { state.edit = null; renderOverlay(); } return; }
  if (a === 'add-cat') { state.edit.adding = true; state.edit.error = ''; renderOverlay(); document.getElementById('nc-sub')?.focus(); return; }
  if (a === 'back') { state.edit.adding = false; state.edit.error = ''; renderOverlay(); return; }
  if (a === 'group') {
    // updated in place, not re-rendered, so what she has typed and the keyboard stay put
    for (const chip of document.querySelectorAll('[data-act="group"]')) {
      const on = chip === act;
      chip.classList.toggle('current', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    document.getElementById('nc-cat').value = act.dataset.category;
    const fresh = document.getElementById('nc-new');
    fresh.hidden = act.dataset.category !== '';
    if (!fresh.hidden) fresh.focus();
    return;
  }
  if (a === 'edit-cycle') { openForm('cycle'); return; }
  if (a === 'edit-budget') { openForm('budget', act.dataset.match); return; }
  if (a === 'edit-fixed') { openForm('fixed', act.dataset.desc); return; }
  if (a === 'close-form') { state.form = null; renderOverlay(); return; }
  if (a === 'remove-setting') { saveSetting(removalOf(state.form)); return; }
  if (a === 'seg') {
    // currency switch, updated in place so the typed amount and the keyboard stay
    for (const b of act.parentElement.children) { b.classList.toggle('current', b === act); b.setAttribute('aria-pressed', String(b === act)); }
    act.closest('.amount-row').querySelector('input[type=hidden]').value = act.dataset.value;
    return;
  }
  if (a === 'review') { state.tab = 'movimientos'; state.filter = 'uncat'; render(); window.scrollTo(0, 0); return; }
  if (a === 'clear-filter') { state.filter = ''; state.catFilter = null; render(); window.scrollTo(0, 0); return; }
  if (a === 'open-filter') { state.picking = true; renderOverlay(); return; }
  if (a === 'close-filter') { state.picking = false; renderOverlay(); return; }
  if (a === 'set-filter') {
    const category = act.dataset.category;
    state.picking = false;
    state.tab = 'movimientos';
    state.filter = category ? '' : 'uncat';
    state.catFilter = category ? { category, sub: act.dataset.sub || null } : null;
    save('mg-tab', state.tab);
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (a === 'pick') {
    if (act.dataset.category === state.edit.category && act.dataset.sub === state.edit.sub) { state.edit = null; renderOverlay(); return; }
    saveCorrection(act.dataset.category, act.dataset.sub);
    return;
  }
  if (a === 'toggle') {
    const cat = act.dataset.cat;
    if (state.open.has(cat)) state.open.delete(cat); else state.open.add(cat);
    render();
    return;
  }
  if (a === 'prev') state.cycle = addMonths(state.cycle, -1);
  if (a === 'next' && state.cycle < state.current) state.cycle = addMonths(state.cycle, 1);
  refresh();
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id === 'newcat-form') {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const checked = checkNewCategory(state.data.taxonomy || {}, String(f.get('category') || f.get('newcat') || ''), String(f.get('sub') || ''));
    if (checked.error) {
      state.edit.error = checked.error;
      state.edit.newSub = String(f.get('sub') || '');
      state.edit.category = String(f.get('category') || '');
      renderOverlay();
      document.getElementById('nc-sub')?.focus();
      return;
    }
    saveCorrection(checked.category, checked.sub, true);
    return;
  }
  if (ev.target.id === 'setting-form') {
    ev.preventDefault();
    const read = readForm(new FormData(ev.target));
    if (read.error) { state.form.error = read.error; renderOverlay(); return; }
    saveSetting(read);
    return;
  }
  if (ev.target.id !== 'token-form') return;
  ev.preventDefault();
  const token = new FormData(ev.target).get('token').toString().replace(/\s+/g, '');
  if (!token) return;
  takeCode(token);
  state.error = null;
  refresh();
});

window.addEventListener('hashchange', () => takeTokenFromLink() && refresh());

// Whole-colón amounts (salary, budget limit): she types digits only and the commas appear.
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.matches || !el.matches('input[data-whole]')) return;
  const digits = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  el.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.edit && !state.saving) { state.edit = null; renderOverlay(); }
  if (ev.key === 'Escape' && state.form) { state.form = null; renderOverlay(); }
  if (ev.key === 'Escape' && state.picking) { state.picking = false; renderOverlay(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = todayCycle();
    if (now !== state.current) { state.current = now; state.cycle = now; }
    refresh();
  }
});

// ---------- start ----------

/** A setup link carries the token in the fragment (#t=…), which is never sent to any server. */
/**
 * A code is either an engine token (64 characters, Melanie's own engine) or a family
 * member's Firebase space (twice as long): with a space alone the app talks only to Firebase.
 */
function takeCode(code) {
  const isSpace = code.length >= 100;
  save(TOKEN_KEY, isSpace ? '' : code);
  save(SPACE_KEY, isSpace ? code : ''); // a token may come with a new space; the engine will say
  state.error = null;
}

function takeTokenFromLink() {
  const m = /[#&][ts]=([A-Za-z0-9_-]{16,})/.exec(location.hash);
  if (!m) return false;
  takeCode(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

(function start() {
  takeTokenFromLink();
  const savedTab = load('mg-tab');
  if (TABS.includes(savedTab)) state.tab = savedTab;
  state.current = todayCycle();
  state.cycle = state.current;
  if ('serviceWorker' in navigator) {
    // updateViaCache 'none': check sw.js on GitHub itself, never a cached copy. When a new
    // version takes over, reload once so the new files show without a second reopen.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); }))
      .catch(() => {});
  }
  refresh();
})();
