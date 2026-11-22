// mis-gastos iPhone app. Reads the engine's JSON API and renders four screens
// (Inicio, Movimientos, Presupuesto, Recurrentes) like design/mockup/Main.dc.html.
// No framework, no build step: this file is what the phone runs.

import { API_URL, FIREBASE, FIRESTORE_BASE } from './config.js?v=21';

// Shown at the bottom of Inicio so we can tell which version a phone is running.
const VERSION = '2026-11-22 · v21';

const TOKEN_KEY = 'mg-token';
const SPACE_KEY = 'mg-space'; // where this person's fast copy lives in Firebase; learned from the engine, or their whole access code (family)
const CACHE_KEY = 'mg-cache-v1:'; // + cycle → last good response, for offline
const TABS = ['inicio', 'movimientos', 'presupuesto', 'viajes', 'recurrentes'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const state = { open: new Set(), tab: 'inicio', cycle: null, current: null, data: null, error: null, loading: false, offline: false, edit: null, saving: false, toast: '', pending: 0, filter: '', catFilter: null, picking: false, form: null, query: '', prev: null, syncing: false, trip: null, tripEdit: null };
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
  if (e.kind === 'income') return 'Ingreso';
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

// The day this person's card statement cuts (1–28, or 31 = last day of the month): their
// months run from the day after it to the next one. Learned from their engine; 15 until then.
const CUT_KEY = 'mg-cut';
const cutDay = () => Number(load(CUT_KEY)) || 15;
const cutLabel = (day) => (day >= 31 ? 'el último día del mes' : `el ${day}`);

function todayCycle() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return d.getDate() > cutDay() ? addMonths(`${y}-${String(m).padStart(2, '0')}`, 1) : `${y}-${String(m).padStart(2, '0')}`;
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

/**
 * The month before the one on screen, for "compared with last month". Loaded quietly
 * after the main month: from the phone's own copy first, then from Firebase. It is never
 * asked from the slow engine, and a month that is not there simply shows no comparison.
 */
async function loadPrevious(cycle) {
  const prev = addMonths(cycle, -1);
  if (state.prev && state.prev.cycle === prev && state.prev.fresh) return;
  const cached = load(CACHE_KEY + prev);
  if (cached && !(state.prev && state.prev.cycle === prev)) { state.prev = JSON.parse(cached); if (state.cycle === cycle) render(); }
  const data = await fetchSnapshot(prev);
  if (!data || !data.ok || state.cycle !== cycle) return;
  data.fresh = true;
  state.prev = data;
  save(CACHE_KEY + prev, JSON.stringify(data));
  render();
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
      if (data.cutDay && data.cutDay !== cutDay()) {
        // the cut day changed (here or on another phone): "this month" may now be another one
        save(CUT_KEY, String(data.cutDay));
        const now = todayCycle();
        const wasCurrent = state.cycle === state.current;
        state.current = now;
        if (wasCurrent && now !== cycle) { state.cycle = now; state.loading = false; return refresh(); }
        if (state.cycle > now) { state.cycle = now; state.loading = false; return refresh(); }
      }
      state.data = data;
      state.error = null;
      state.offline = false;
      data.fetchedAt = new Date().toISOString();
      save(CACHE_KEY + cycle, JSON.stringify(data));
      loadPrevious(cycle);
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
      ${state.offline ? '' : `<button type="button" class="icon-btn ${state.syncing ? 'spinning' : ''}" data-act="sync-now" aria-label="${state.syncing ? 'Buscando compras nuevas' : 'Actualizar ahora'}" ${state.syncing ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg></button>`}
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
  const button = state.offline ? '' : `<button type="button" class="refresh-btn" data-act="sync-now" ${state.syncing ? 'disabled' : ''}>${state.syncing ? 'Buscando compras nuevas…' : 'Actualizar ahora'}</button>`;
  return `${button}${bits.length ? `<div class="footer-note">${esc(bits.join(' · '))}</div>` : ''}`;
}

/** "Actualizar ahora": has the engine read the mailbox right now instead of at its next 15-minute check. */
async function syncNow() {
  if (state.syncing) return;
  state.syncing = true;
  render();
  const cycle = state.cycle;
  const before = state.data && state.data.cycle === cycle ? state.data.entries.length : null;
  showToast(familyMode() ? 'Buscando compras nuevas… puede tardar un minuto' : 'Buscando compras nuevas…', INBOX_WAIT_MS + 10000);
  let failure = '', later = false;
  try {
    const out = await sendCommand({ action: 'sync' });
    if (!out.ok) failure = out.error === 'unauthorized' ? 'el código de acceso ya no es válido' : out.error === 'unknown action' ? 'tu conexión todavía no lo permite' : out.error;
    later = !!out.later;
  } catch {
    failure = 'no hay conexión';
  }
  state.syncing = false;
  if (failure) { showToast(`No se pudo actualizar: ${failure}`, 5000); render(); return; }
  await refresh();
  const after = state.data && state.data.cycle === cycle ? state.data.entries.length : null;
  const added = before !== null && after !== null ? after - before : 0;
  showToast(later ? 'Sigue buscando. Volvé a mirar en un minuto.' : added > 0 ? `${added} ${added === 1 ? 'movimiento nuevo' : 'movimientos nuevos'}` : 'Al día: no hay compras nuevas', 4000);
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

const dayNumber = (iso) => Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000);
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** What is left to spend: te sobra, minus the monthly savings goal when there is one. */
const leftToSpend = (s) => (s.savings && s.toSpend !== null && s.toSpend !== undefined ? s.toSpend : s.teSobra);

/** Under "te sobra": the savings goal and whether this month reaches it. */
function goalBlock(d) {
  const s = d.summary;
  const g = s.savings;
  if (!g || s.teSobra === null) return '';
  const label = g.currency === 'USD' ? usd(g.minor).replace(/\.00$/, '') : crc(g.minor);
  if (g.crc === null) return `<div class="goal"><div class="small"><span>Meta de ahorro: ${label} al mes</span><span>falta el tipo de cambio</span></div></div>`;
  const short = g.crc - s.teSobra; // > 0: the month does not cover the goal
  const running = d.cycle === state.current;
  const covered = Math.max(0, Math.min(100, Math.round((Math.max(0, s.teSobra) / g.crc) * 100)));
  const status = short <= 0
    ? (running ? 'Vas bien' : 'La cumpliste')
    : (running ? `Te faltan ${crc(short)}` : `Te faltaron ${crc(short)}`);
  return `
    <div class="goal">
      <div class="small"><span>Meta de ahorro: <b>${label}</b></span><span class="${short > 0 ? 'over-text' : 'good-text'}">${status}</span></div>
      <div class="bar ${short > 0 ? 'over' : 'good'}" role="img" aria-label="${esc(`Meta de ahorro cubierta al ${covered}%`)}"><i style="width:${Math.max(2, covered)}%"></i></div>
    </div>`;
}

/** Money already spoken for before the month starts: fixed expenses and cuotas. */
const committed = (e) => e.source === 'fixed' || e.source === 'predicted' || e.category === 'Tasa 0';

/**
 * Only for the month we are in: what is left per day until the cut, and a thin bar of how
 * much of the month's free money is gone against how much of the month has passed. "Free"
 * leaves out fixed expenses and cuotas, which are known from day one and would make every
 * month look overspent on its first day.
 */
function paceBlock(d) {
  const s = d.summary;
  if (s.teSobra === null || d.cycle !== state.current) return '';
  const today = todayIso();
  if (today < d.range[0] || today > d.range[1]) return '';
  const total = dayNumber(d.range[1]) - dayNumber(d.range[0]) + 1;
  const left = dayNumber(d.range[1]) - dayNumber(today) + 1; // today counts
  const passed = total - left;
  const variable = d.entries.filter((e) => e.kind === 'spend' && !committed(e)).reduce((n, e) => n + crcValue(e, s.rate), 0);
  const leftNow = leftToSpend(s); // the savings goal is put aside first
  const free = leftNow + variable; // what there was for the month after fixed expenses, cuotas and savings
  const days = `${left === 1 ? 'Te queda 1 día' : `Te quedan ${left} días`}`;
  if (leftNow <= 0 || free <= 0) {
    return `<div class="pace"><div class="pace-line over-text"><b>${days}</b> y ya no queda plata de este mes.</div>
      <div class="bar pace-bar over"><i style="width:100%"></i><span class="pace-now" style="left:${Math.round((passed / total) * 100)}%"></span></div></div>`;
  }
  const used = Math.min(100, Math.round((variable / free) * 100));
  const time = Math.round((passed / total) * 100);
  const fast = used > time + 3;
  return `
    <div class="pace">
      <div class="pace-line"><b>${days}</b> · ${crc(Math.floor(leftNow / left / 100) * 100)} por día</div>
      <div class="bar pace-bar ${fast ? 'over' : 'good'}" role="img" aria-label="${esc(`Gastaste ${used}% de lo disponible y pasó ${time}% del mes`)}"><i style="width:${Math.max(2, used)}%"></i><span class="pace-now" style="left:${time}%"></span></div>
      <div class="small"><span>Gastaste ${used}%</span><span class="${fast ? 'over-text' : ''}">${fast ? 'Vas más rápido que el mes' : 'Vas bien'} · pasó ${time}%</span></div>
    </div>`;
}

/**
 * Spend per category in the month before, counted up to the same day of the month when
 * the month on screen is still running (so 5 days are compared with 5 days), whole
 * otherwise. Fixed expenses and cuotas always count. Null when that month is not loaded.
 */
function previousTotals(d) {
  const p = state.prev;
  if (!p || p.cycle !== addMonths(d.cycle, -1) || !p.entries.some((e) => e.kind === 'spend')) return null;
  const today = todayIso();
  const running = d.cycle === state.current && today >= d.range[0] && today <= d.range[1];
  const upTo = running ? dayNumber(today) - dayNumber(d.range[0]) : Infinity;
  const totals = new Map();
  for (const e of p.entries) {
    if (e.kind !== 'spend') continue;
    if (!committed(e) && dayNumber(e.date) - dayNumber(p.range[0]) > upTo) continue;
    totals.set(e.category || '', (totals.get(e.category || '') || 0) + crcValue(e, p.summary.rate));
  }
  return { totals, running, name: monthName(p.cycle) };
}

/** `↑ ₡42,000` in orange (more than last month) or `↓ ₡12,000` in green; nothing under ₡1,000. */
function deltaTag(now, before) {
  const diff = now - before;
  if (Math.abs(diff) < 100000) return '';
  return `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '↑' : '↓'} ${crc(Math.abs(diff))}</span>`;
}

function inicio(d) {
  const s = d.summary;
  const rate = s.rate;
  let hero;
  if (s.teSobra === null) {
    const falta = s.missing.map((m) => (m === 'income' ? 'el salario' : 'el tipo de cambio')).join(' y ');
    hero = `<div class="hero missing">Falta ${esc(falta)} de ${esc(monthName(d.cycle))}.</div>
      <button type="button" class="btn" data-act="edit-cycle" style="margin-top:12px;width:100%">Agregar</button>`;
  } else {
    hero = `<div class="hero ${leftToSpend(s) < 0 ? 'neg' : ''}">${crc(leftToSpend(s))}</div>`;
  }
  const hasGoal = !!s.savings && s.toSpend !== null && s.toSpend !== undefined && s.teSobra !== null;
  const rows = [];
  if (s.income !== null) rows.push(`<div class="row"><span>Salario</span><b>${crc(s.income)}</b></div>`);
  if (s.extraIncome) rows.push(`<div class="row"><span>Otros ingresos</span><b>+${crc(s.extraIncome)}</b></div>`);
  rows.push(`<div class="row"><span>Colones</span><b>${crc(-s.spend.CRC)}</b></div>`);
  if (s.spend.USD) {
    rows.push(`<div class="row"><span>Dólares <span class="note">${usd(s.spend.USD)}${rate ? ` × ${(rate / 100).toLocaleString('en-US')}` : ''}</span></span><b>${s.usdInCrc === null ? '—' : crc(-s.usdInCrc)}</b></div>`);
  }

  if (hasGoal) rows.push(`<div class="row"><span>Meta de ahorro${s.savings.currency === 'USD' ? ` <span class="note">${usd(s.savings.minor)}</span>` : ''}</span><b>${crc(-s.savings.crc)}</b></div>`);

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
  const before = previousTotals(d);
  const beforeTotal = before ? [...before.totals.values()].reduce((n, v) => n + v, 0) : 0;
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
        ${before && deltaTag(g.total, before.totals.get(cat) || 0) ? `<span class="small delta-row"><span>${before.running ? `Al mismo día de ${esc(before.name)}` : `En ${esc(before.name)}`}: ${crc(before.totals.get(cat) || 0)}</span>${deltaTag(g.total, before.totals.get(cat) || 0)}</span>` : ''}
      </button>
      ${detail}
    </div>`;
  }).join('');

  return `
    ${header(cap(monthName(d.cycle)), `Ciclo ${shortDate(d.range[0])} – ${shortDate(d.range[1])}`)}
    <section class="card pad" aria-label="Te sobra">
      <div><div class="hero-label">${hasGoal ? 'Te sobra para gastar, ya apartado el ahorro' : 'Te sobra este mes'}</div>${hero}</div>
      ${paceBlock(d)}
      ${goalBlock(d)}
      ${statusPill(d)}
      <div class="sep"></div>
      <div style="display:flex;flex-direction:column;gap:12px">${rows.join('')}</div>
      <div class="note">Incluye gastos fijos y cuotas. No incluye SINPE ni efectivo.</div>
      ${carriedNote(s)}
      ${s.teSobra === null ? '' : '<button type="button" class="link-btn" data-act="edit-cycle">Cambiar salario o tipo de cambio</button>'}
      ${s.teSobra === null || s.savings === undefined ? '' : `<button type="button" class="link-btn" data-act="edit-savings">${s.savings ? 'Cambiar meta de ahorro' : 'Poner una meta de ahorro'}</button>`}
      ${familyMode() && d.cutDayChosen ? `<button type="button" class="link-btn" data-act="edit-cut">Cambiar día de corte (ahora ${esc(cutLabel(d.cutDay))}: del ${esc(shortDate(d.range[0]))} al ${esc(shortDate(d.range[1]))})</button>` : ''}
    </section>
    ${cutCard(d)}
    ${reviewCard(d)}
    ${tripCard(d)}
    <section class="section">
      <div class="section-head"><h2>En qué se fue</h2><span class="note">${crc(total)}</span></div>
      ${before ? `<div class="compare-note">${before.running ? `Comparado con ${esc(before.name)} al mismo día del mes` : `Comparado con ${esc(before.name)}`}: ${crc(beforeTotal)} ${deltaTag(total, beforeTotal)}</div>` : ''}
      <div class="card">${topRows || '<div class="item note">Todavía no hay gastos en este ciclo.</div>'}</div>
    </section>
    ${homeScreenHelp()}
    ${syncLine(d)}`;
}

// An iPhone keeps the home-screen app apart from Safari, so the app added there starts
// without the code and asks for it. In Safari, offer to copy it: one tap here, paste there.
const standalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
function homeScreenHelp() {
  if (standalone()) return '';
  return `
    <section class="card pad">
      <div class="note" style="font-size:15px;line-height:21px"><b>Para tenerla como app:</b> tocá Compartir y "Agregar a pantalla de inicio". La primera vez la app te pide un código: copialo aquí y pegalo ahí.</div>
      <button type="button" class="btn" data-act="copy-code" style="margin-top:12px;width:100%">Copiar mi código</button>
    </section>`;
}

async function copyCode() {
  const code = load(TOKEN_KEY) || load(SPACE_KEY) || '';
  try {
    await navigator.clipboard.writeText(code);
    showToast('Código copiado. Abrí la app de la pantalla de inicio y pegalo.', 5000);
  } catch {
    // no clipboard access: show it so it can be copied by hand
    window.prompt('Copiá este código y pegalo en la app:', code);
  }
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

/** Family: until the person says when their card cuts, months run 16th–15th like Melanie's. */
function cutCard(d) {
  if (!familyMode() || d.cutDayChosen !== false) return '';
  return `
    <button type="button" class="card review" data-act="edit-cut">
      <span class="review-text"><b>¿Qué día corta tu tarjeta?</b>
      <span class="note">Así tus meses calzan con tu estado de cuenta. Tocá para elegirlo.</span></span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
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

/** Lowercase, no accents: "Farmácia" is found by "farmacia". */
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Every word typed must appear in the shop's name, its category, or the amount. */
function matchesQuery(e, query) {
  const hay = plain([prettyName(e.description), e.description, e.category ? catLabel(e.category) : 'sin categoria', subLabel(e), money(e).replace(/[,₡$]/g, '')].join(' '));
  return plain(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w.replace(/[,₡$]/g, '')));
}

function movimientos(d) {
  if (state.filter === 'uncat') return sinCategoria(d);
  const f = state.catFilter;
  const shown = f ? d.entries.filter((e) => matchesFilter(e, f)) : d.entries;
  return `
    ${header('Movimientos', `${cap(monthName(d.cycle))} · ${d.entries.length} movimientos`)}
    <label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="mov-search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Buscar un comercio" aria-label="Buscar en los movimientos de este mes" value="${esc(state.query)}"></label>
    ${filterBar(d, shown)}
    <button type="button" class="add-row" data-act="add-manual">+ Agregar un gasto o un ingreso</button>
    <div id="mov-list">${movList(d)}</div>
    ${syncLine(d)}`;
}

/** The list under the search box; redrawn alone while typing so the keyboard stays up. */
function movList(d) {
  const f = state.catFilter;
  const q = state.query.trim();
  const byCat = f ? d.entries.filter((e) => matchesFilter(e, f)) : d.entries;
  const found = q ? byCat.filter((e) => matchesQuery(e, q)) : byCat;
  const shown = found.filter((e) => e.kind !== 'removed');
  // what the person removed: listed apart, greyed, one tap to put back
  const gone = f ? [] : (q ? d.entries.filter((e) => matchesQuery(e, q)) : d.entries).filter((e) => e.kind === 'removed');
  const goneRows = gone.map((e) => {
    const name = prettyName(e.description);
    return `<button type="button" class="item mov tappable removed" data-act="edit" data-id="${esc(e.id)}" data-removed="1" data-shop="" data-name="${esc(name)}" data-category="" data-sub="" aria-label="${esc(`${name}, quitado. Restaurar`)}">
          <div class="avatar" aria-hidden="true">${esc(name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(name)}</span><span class="mov-meta">${esc(dayLabel(e.date))} · no cuenta</span></div>
          <span class="mov-amt muted">${esc(money(e))}</span></button>`;
  }).join('');
  const goneSection = gone.length ? `<div class="section"><div class="group-label"><span>Quitados (${gone.length})</span><span>tocá para restaurar</span></div><div class="card">${goneRows}</div></div>` : '';
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
        : e.original !== undefined ? '<span class="tag">monto cambiado</span>'
        : e.source === 'manual' ? '<span class="tag">a mano</span>'
        : '';
      const name = prettyName(e.description);
      const trip = e.trip && tripsOf(d).find((t) => t.id === e.trip);
      const meta = [trip ? `✈ ${trip.name}` : '', subLabel(e), cardName(e.card)].filter(Boolean).join(' · ');
      const inner = `
          <div class="avatar" aria-hidden="true">${esc(name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(name)}</span><span class="mov-meta ${e.kind === 'spend' && !e.category ? 'over-text' : ''}">${tag ? `${tag.replace('class="tag"', 'class="tag first"')} ` : ''}${esc(meta)}</span></div>
          <span class="mov-amt ${e.kind === 'income' ? 'good-text' : e.kind !== 'spend' ? 'muted' : ''}">${e.kind === 'income' ? '+' : ''}${esc(money(e))}</span>`;
      const removable = !!e.id && (e.kind === 'spend' || e.kind === 'income');
      if (!e.shop && !removable) return `<div class="item mov">${inner}</div>`;
      return `<button type="button" class="item mov tappable" data-act="edit" data-id="${esc(removable ? e.id : '')}" data-trip="${esc(e.trip || '')}" data-income="${e.kind === 'income' ? '1' : ''}" data-shop="${esc(e.shop || '')}" data-name="${esc(name)}" data-category="${esc(e.category)}" data-sub="${esc(e.sub)}" aria-label="${esc(`${name}, ${subLabel(e)}. ${e.shop ? 'Cambiar categoría' : 'Opciones'}`)}">${inner}</button>`;
    }).join('');
    return `<div class="section"><div class="group-label"><span>${esc(dayLabel(date))}</span><span>${esc(total)}</span></div><div class="card">${rows}</div></div>`;
  }).join('');
  if (!groups && goneSection) return goneSection;
  if (!groups) return `<div class="card"><div class="item note">${q ? `Nada coincide con "${esc(q)}" en ${esc(monthName(d.cycle))}.` : f ? 'No hay compras de esa categoría este mes.' : 'Todavía no hay movimientos en este ciclo.'}</div></div>`;
  let foundNote = '';
  if (q) {
    const sum = (cur) => shown.filter((e) => e.kind === 'spend' && e.currency === cur).reduce((n, e) => n + e.minor, 0);
    const total = [sum('CRC') ? crc(sum('CRC')) : '', sum('USD') ? usd(sum('USD')) : ''].filter(Boolean).join(' + ') || '₡0';
    foundNote = `<div class="footer-note">${shown.length} ${shown.length === 1 ? 'movimiento' : 'movimientos'} · ${esc(total)}</div>`;
  }
  return `${foundNote || '<div class="footer-note">Tocá una compra para cambiar su categoría o quitarla.</div>'}${groups}${goneSection}`;
}

// ---------- viajes ----------
// A trip is a second view of purchases that already count in their month: a name, dates
// and a budget split in parts. Purchases made abroad between the dates join by themselves
// (the engine knows the country); anything else is added from the movement.

const TRIP_PARTS = ['Vuelos', 'Hospedaje', 'Comida', 'Transporte', 'Compras', 'Otros'];
// the engine's own first guess (engine/src/trips.ts), repeated here so a purchase added by hand lands in a part at once
const TRIP_GUESSES = [
  ['Vuelos', /\b(COPA|AVIANCA|VOLARIS|JETBLUE|SPIRIT|UNITED|DELTA|IBERIA|LATAM|AEROMEXICO|AMERICAN AIR|SANSA|KLM|LUFTHANSA|WINGO|ARAJET|AIR (FRANCE|CANADA|EUROPA)|AIRLINES?|AEROLINEAS?)\b/],
  ['Hospedaje', /HOTEL|HOSTAL|HOSTEL|AIRBNB|BOOKING|MARRIOTT|HILTON|HYATT|RESORT|LODGE|EXPEDIA|VRBO|\bINN\b/],
  ['Comida', /REST|CAFE|COFFEE|STARBUCKS|PIZZA|BURGER|MCDONALD|KFC|TACO|GRILL|BAKERY|PANADERIA|SUSHI|FOOD|EATS|DELI|KITCHEN|BAGUETTE|SUBWAY|\b(BAR|SODA)\b/],
  ['Transporte', /UBER|LYFT|TAXI|CABIFY|METRO|RENT ?A ?CAR|HERTZ|AVIS|ALAMO|PARKING|PARQUEO|PEAJE|TOLL|GASOLIN|SHELL|TRAIN|RAIL|\bBUS\b/],
  ['Compras', /DUTY|DUTTY|FREE SHOP|STORE|SHOP|MALL|OUTLET|ZARA|NIKE|ADIDAS|TARGET|WALMART|AMAZON|ROSS|MARSHALLS|TIENDA/],
];
const guessPart = (description) => (TRIP_GUESSES.find(([, re]) => re.test(String(description).toUpperCase())) || ['Otros'])[0];
const tripMoney = (minor, currency) => (currency === 'CRC' ? crc(minor) : usd(minor));
const tripsOf = (d) => (d && d.trips) || [];

function tripDates(t) {
  const y = t.end.slice(0, 4);
  return t.start.slice(0, 7) === t.end.slice(0, 7)
    ? `${Number(t.start.slice(8, 10))} – ${shortDate(t.end)} ${y}`
    : `${shortDate(t.start)} – ${shortDate(t.end)} ${y}`;
}

/** Where today falls: before ('Faltan 13 días'), during ('Día 3 de 8') or after the trip. */
function tripWhen(t) {
  const today = dayNumber(todayIso());
  const start = dayNumber(t.start);
  const end = dayNumber(t.end);
  if (today < start) return { phase: 'before', text: start - today === 1 ? 'Es mañana' : `Faltan ${start - today} días`, daysLeft: 0 };
  if (today > end) return { phase: 'after', text: 'Ya pasó', daysLeft: 0 };
  return { phase: 'during', text: `Día ${today - start + 1} de ${end - start + 1}`, daysLeft: end - today + 1 };
}

/** Adds a trip's purchases up again on the phone, the way the engine does. */
function tripTotals(t) {
  for (const p of t.parts) p.spent = 0;
  t.unconverted = 0;
  for (const e of t.entries) {
    const part = t.parts.find((p) => p.name === e.part);
    if (e.value === null || e.value === undefined) t.unconverted += 1;
    else if (part) part.spent += e.value;
  }
  t.spent = t.parts.reduce((n, p) => n + p.spent, 0);
  t.budget = t.parts.reduce((n, p) => n + p.budget, 0);
}

function tripRow(t) {
  const over = t.budget > 0 && t.spent > t.budget;
  const pct = t.budget > 0 ? Math.min(100, Math.round((t.spent / t.budget) * 100)) : 0;
  const when = tripWhen(t);
  return `
      <button type="button" class="item tappable" data-act="open-trip" data-id="${esc(t.id)}" aria-label="${esc(`${t.name}, ${tripDates(t)}. Abrir`)}">
        <span class="row"><b style="font-weight:600">${esc(t.name)}</b><span class="note" style="font-weight:600">${esc(when.text)}</span></span>
        <span class="small"><span>${esc(tripDates(t))}</span></span>
        ${t.budget > 0 ? `<span class="bar thick ${over ? 'over' : ''}"><i style="width:${Math.max(2, pct)}%"></i></span>` : ''}
        <span class="small"><span>${esc(tripMoney(t.spent, t.currency))} gastado</span><span>${t.budget > 0 ? `de ${esc(tripMoney(t.budget, t.currency))}` : 'sin presupuesto'}</span></span>
      </button>`;
}

/** On Inicio: the trip that is running, or the next one within a month. */
function tripCard(d) {
  const today = dayNumber(todayIso());
  const near = tripsOf(d).filter((t) => dayNumber(t.end) >= today && dayNumber(t.start) - today <= 30).sort((a, b) => (a.start < b.start ? -1 : 1))[0];
  if (!near) return '';
  return `<section class="section"><div class="section-head"><h2>Viaje</h2></div><div class="card">${tripRow(near)}</div></section>`;
}

function viajes(d) {
  const trips = tripsOf(d);
  const open = state.trip && trips.find((t) => t.id === state.trip);
  if (open) return tripDetail(d, open);
  const today = dayNumber(todayIso());
  const coming = trips.filter((t) => dayNumber(t.end) >= today).sort((a, b) => (a.start < b.start ? -1 : 1));
  const past = trips.filter((t) => dayNumber(t.end) < today);
  return `
    ${header('Viajes', 'Planear y llevar la cuenta', false)}
    <button type="button" class="add-row" data-act="edit-trip" data-id="">+ Nuevo viaje</button>
    ${coming.length ? `<div class="card">${coming.map(tripRow).join('')}</div>` : ''}
    ${past.length ? `<div class="section"><div class="group-label"><span>Anteriores</span></div><div class="card">${past.map(tripRow).join('')}</div></div>` : ''}
    ${trips.length ? '' : '<div class="card"><div class="item note" style="line-height:20px">Poné el nombre, las fechas y cuánto pensás gastar en vuelos, hospedaje, comida y lo demás. Las compras que hagás fuera de Costa Rica en esas fechas entran solas al viaje.</div></div>'}
    <div class="footer-note">Un viaje no cambia tu mes: las mismas compras siguen contando en "te sobra" y en tus presupuestos.</div>
    ${syncLine(d)}`;
}

function tripDetail(d, t) {
  const when = tripWhen(t);
  const left = t.budget - t.spent;
  const hero = t.budget > 0
    ? `<div class="hero-label">${left < 0 ? 'Te pasaste del presupuesto del viaje' : 'Te queda para el viaje'}</div><div class="hero ${left < 0 ? 'neg' : ''}">${esc(tripMoney(Math.abs(left), t.currency))}</div>`
    : `<div class="hero-label">Llevás gastado en el viaje</div><div class="hero">${esc(tripMoney(t.spent, t.currency))}</div>`;
  let pace = '';
  if (when.phase === 'during' && t.budget > 0 && left > 0) {
    pace = `<div class="pace-line">${when.daysLeft === 1 ? 'Es el último día' : `Te quedan ${when.daysLeft} días`} · <b>${esc(tripMoney(Math.round(left / when.daysLeft), t.currency))}</b> por día</div>`;
  }
  const parts = t.parts.filter((p) => p.budget > 0 || p.spent > 0).map((p) => {
    const over = p.budget > 0 && p.spent > p.budget;
    const pct = p.budget > 0 ? Math.min(100, Math.round((p.spent / p.budget) * 100)) : 0;
    const note = p.budget === 0 ? 'Sin presupuesto' : over ? `Te pasaste ${tripMoney(p.spent - p.budget, t.currency)}` : `Quedan ${tripMoney(p.budget - p.spent, t.currency)}`;
    return `
      <div class="item">
        <span class="row"><b style="font-weight:600">${esc(p.name)}</b><span class="note ${over ? 'over-text' : ''}" style="font-weight:600">${esc(note)}</span></span>
        ${p.budget > 0 ? `<span class="bar thick ${over ? 'over' : ''}"><i style="width:${Math.max(2, pct)}%"></i></span>` : ''}
        <span class="small"><span>${esc(tripMoney(p.spent, t.currency))} gastado</span><span>${p.budget > 0 ? `de ${esc(tripMoney(p.budget, t.currency))}` : ''}</span></span>
      </div>`;
  }).join('');
  const rows = t.entries.map((e) => {
    const name = prettyName(e.description);
    return `<button type="button" class="item mov tappable" data-act="trip-entry" data-id="${esc(e.id)}" data-name="${esc(name)}" data-part="${esc(e.part)}" aria-label="${esc(`${name}, ${e.part}. Cambiar`)}">
          <div class="avatar" aria-hidden="true">${esc(name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(name)}</span><span class="mov-meta">${esc(shortDate(e.date))} · ${esc(e.part)}${e.auto ? '' : ' · agregada a mano'}</span></div>
          <span class="mov-amt">${esc(money(e))}</span></button>`;
  }).join('');
  return `
    <div class="head"><div class="head-text">
      <button type="button" class="back-link" data-act="close-trip">‹ Viajes</button>
      <h1>${esc(t.name)}</h1>
    </div></div>
    <section class="card pad" aria-label="Presupuesto del viaje">
      <div>${hero}</div>
      ${pace}
      <span class="pill info">${esc(tripDates(t))} · ${esc(when.text)}</span>
      <div class="sep"></div>
      <div style="display:flex;flex-direction:column;gap:12px">
        ${t.budget > 0 ? `<div class="row"><span>Presupuesto</span><b>${esc(tripMoney(t.budget, t.currency))}</b></div>` : ''}
        <div class="row"><span>Gastado</span><b>${esc(tripMoney(t.spent, t.currency))}</b></div>
      </div>
      ${t.unconverted ? `<div class="note">${t.unconverted === 1 ? 'Falta sumar 1 compra' : `Faltan sumar ${t.unconverted} compras`} en otra moneda: ese mes no tiene tipo de cambio.</div>` : ''}
      <button type="button" class="link-btn" data-act="edit-trip" data-id="${esc(t.id)}">Cambiar fechas o presupuesto</button>
    </section>
    ${parts ? `<section class="section"><div class="section-head"><h2>Por parte</h2></div><div class="card">${parts}</div></section>` : ''}
    <section class="section">
      <div class="section-head"><h2>Compras del viaje</h2><span class="note">${t.entries.length}</span></div>
      <div class="card">${rows || '<div class="item note" style="line-height:20px">Todavía no hay compras. Las que hagás fuera de Costa Rica en esas fechas entran solas.</div>'}</div>
    </section>
    <div class="footer-note">Para agregar algo comprado antes (vuelos, hotel) o en Costa Rica: en Movimientos, tocá la compra y elegí el viaje. Tocá una compra de aquí para cambiarle la parte o sacarla.</div>
    ${syncLine(d)}`;
}

/** The sheet for one purchase of a trip: its part, or out of the trip. */
function tripEntrySheetHtml() {
  const te = state.tripEdit;
  return `
    <div class="backdrop" data-act="close-trip-entry"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-head">
        <div class="sheet-title"><h2 id="sheet-title">${esc(te.name)}</h2><p class="note">¿En qué parte del viaje va?</p></div>
        <button type="button" class="icon-btn" data-act="close-trip-entry" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <div class="sheet-body">
        <div class="pick-row">${TRIP_PARTS.map((p) => `<button type="button" class="pick ${p === te.part ? 'current' : ''}" data-act="trip-part" data-part="${esc(p)}" aria-pressed="${p === te.part}">${esc(p)}</button>`).join('')}</div>
        <div class="remove-box">
          <button type="button" class="link-btn danger" data-act="trip-out">Sacar del viaje</button>
          <p class="note">Sigue contando en tu mes; solo deja de contar en este viaje.</p>
        </div>
      </div>
    </section>`;
}

/** In a movement's sheet: the trip it is in, or the trips it can be added to. */
function tripBox(ed) {
  const trips = tripsOf(state.data);
  if (!ed.id || !trips.length || ed.income) return '';
  const inTrip = ed.trip && trips.find((t) => t.id === ed.trip);
  if (inTrip) {
    return `
        <div class="trip-box">
          <p class="note">Está en el viaje <b>${esc(inTrip.name)}</b>.</p>
          <button type="button" class="link-btn" data-act="trip-out">Sacar del viaje</button>
        </div>`;
  }
  return `
        <div class="trip-box">
          <div class="pick-label">Agregar a un viaje</div>
          <div class="pick-row">${trips.slice(0, 6).map((t) => `<button type="button" class="pick" data-act="trip-in" data-trip="${esc(t.id)}">${esc(t.name)}</button>`).join('')}</div>
        </div>`;
}

/** Moves a purchase in or out of a trip on the phone's own copy (the engine's answer replaces it a moment later). */
function applyTripChoice(d, id, tripId, part) {
  const e = d.entries.find((x) => x.id === id);
  let moved = null;
  for (const t of tripsOf(d)) {
    const i = t.entries.findIndex((x) => x.id === id);
    if (i >= 0) moved = t.entries.splice(i, 1)[0];
  }
  if (e) e.trip = tripId || null;
  const t = tripId && tripsOf(d).find((x) => x.id === tripId);
  const src = moved || (e && { id, date: e.date, description: e.description, card: e.card, currency: e.currency, minor: e.minor });
  if (t && src) {
    const rate = d.summary.rate;
    const value = src.currency === t.currency ? src.minor : !rate ? null : src.currency === 'USD' ? Math.round((src.minor * rate) / 100) : Math.round((src.minor * 100) / rate);
    t.entries.push({ ...src, value: moved && moved.value !== undefined && src.currency !== t.currency ? moved.value : value, part: part || (moved && moved.part) || guessPart(src.description), auto: false });
    t.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  tripsOf(d).forEach(tripTotals);
}

/** Puts a purchase in a trip, in another part, or out of it. Shown at once; undone with a message if saving fails. */
async function saveTripChoice(id, name, tripId, part) {
  const cycle = state.cycle;
  const before = JSON.stringify(state.data);
  const trip = tripsOf(state.data).find((t) => t.id === tripId);
  applyTripChoice(state.data, id, tripId, part);
  state.edit = null;
  state.tripEdit = null;
  state.pending += 1;
  showToast(!tripId ? `${name}: fuera del viaje` : part ? `${name}: ${part}` : `${name}: en ${trip ? trip.name : 'el viaje'}`);
  render();
  let failure = '';
  try {
    const out = await sendCommand({ action: 'tripEntry', id, trip: tripId, part: part || '' });
    if (!out.ok) failure = out.error === 'unauthorized' ? 'el código de acceso ya no es válido' : out.error === 'unknown action' ? 'tu conexión todavía no lo permite' : out.error;
  } catch {
    failure = 'no hay conexión';
  }
  state.pending -= 1;
  if (failure) {
    if (state.cycle === cycle) state.data = JSON.parse(before);
    showToast(`No se pudo guardar ${name}: ${failure}`, 5000);
    render();
  } else {
    refresh();
  }
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
      ${ed.amounting ? amountScreen(ed) : ed.adding ? newCategoryScreen(ed, taxonomy) : pickScreen(ed, taxonomy)}
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
  const head = (note) => `
      <div class="sheet-head">
        <div class="sheet-title">
          <h2 id="sheet-title">${esc(ed.name)}</h2>
          <p class="note">${note}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>`;
  if (ed.removed) {
    return `${head('Lo quitaste: no cuenta en tus gastos.')}
      <div class="sheet-body">
        <button type="button" class="btn" data-act="restore-entry" style="width:100%">Restaurar este movimiento</button>
      </div>`;
  }
  // one movement, not the whole shop: for a charge that is not yours, a test charge, something paid back to you
  const remove = ed.id ? `
        <div class="remove-box">
          <button type="button" class="link-btn" data-act="edit-amount">Cambiar el monto</button>
          <button type="button" class="link-btn danger" data-act="remove-entry">Quitar este movimiento</button>
          <p class="note">Solo este, no todo el comercio. Deja de contar en tus gastos y lo podés restaurar desde "Quitados".</p>
        </div>` : '';
  return `${head(ed.shop ? 'La categoría vale para todas las compras en este comercio.' : ed.income ? 'Un ingreso que agregaste a mano.' : 'Este movimiento no cambia de categoría aquí.')}
      ${ed.error ? `<p class="pill warn">${esc(ed.error)}</p>` : ''}
      <div class="sheet-body">
        ${tripBox(ed)}
        ${ed.shop ? `<button type="button" class="add-row" data-act="add-cat">+ Nueva categoría</button>${groups}` : ''}
        ${remove}
      </div>`;
}

/** The amount of one movement: her part of a shared bill, or a charge that came wrong. Its own screen, field at the top. */
function amountScreen(ed) {
  const e = state.data.entries.find((x) => x.id === ed.id);
  if (!e) return pickScreen(ed, state.data.taxonomy || {});
  const changed = e.original !== undefined;
  return `
      <div class="sheet-head">
        <button type="button" class="icon-btn" data-act="back" aria-label="Volver">${ICON_BACK}</button>
        <div class="sheet-title center-title">
          <h2 id="sheet-title">Cambiar el monto</h2>
          <p class="note">${esc(ed.name)}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <form id="amount-form" class="newcat">
        ${ed.error ? `<p class="pill warn">${esc(ed.error)}</p>` : ''}
        <label class="lbl" for="am-amount">Monto, en ${e.currency === 'CRC' ? 'colones' : 'dólares'}</label>
        <input id="am-amount" class="field" name="amount" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${esc(ed.amount !== undefined ? ed.amount : typedAmount(e.minor))}">
        <p class="note">Solo cambia esta compra, por ejemplo para dejar tu parte de una cuenta compartida. ${changed ? `BAC cobró ${esc(money({ currency: e.currency, minor: e.original }))}.` : 'El monto que cobró BAC queda guardado y lo podés recuperar.'}</p>
        <button class="btn" type="submit">Guardar</button>
        ${changed ? '<button type="button" class="link-btn danger" data-act="amount-reset">Volver al monto original</button>' : ''}
      </form>`;
}

/** Changes one movement's amount (null = back to what BAC charged). Shown at once; undone with a message if saving fails. */
async function saveAmount(minor, typed) {
  const ed = state.edit;
  const cycle = state.cycle;
  const before = JSON.stringify(state.data);
  const e = state.data.entries.find((x) => x.id === ed.id);
  state.edit = null;
  if (!e) { renderOverlay(); return; }
  const charged = e.original !== undefined ? e.original : e.minor;
  const was = e.minor;
  e.minor = minor === null ? charged : minor;
  if (e.minor === charged) delete e.original; else e.original = charged;
  for (const t of tripsOf(state.data)) {
    for (const x of t.entries) {
      if (x.id !== e.id) continue;
      if (x.value !== null && x.value !== undefined) x.value = x.currency === t.currency ? e.minor : Math.round((x.value * e.minor) / (was || 1));
      x.minor = e.minor;
    }
    tripTotals(t);
  }
  recompute(state.data);
  state.pending += 1;
  showToast(`${ed.name}: ${money(e)}`);
  render();
  let failure = '';
  try {
    const out = await sendCommand({ action: 'editEntry', id: ed.id, amount: minor === null ? '' : typed });
    if (!out.ok) failure = out.error === 'unauthorized' ? 'el código de acceso ya no es válido' : out.error === 'unknown action' ? 'tu conexión todavía no lo permite' : out.error;
  } catch {
    failure = 'no hay conexión';
  }
  state.pending -= 1;
  if (failure) {
    if (state.cycle === cycle) state.data = JSON.parse(before);
    showToast(`No se pudo cambiar el monto de ${ed.name}: ${failure}`, 5000);
    render();
  } else {
    refresh();
  }
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
  if (f.kind === 'manual') {
    title = 'Agregar';
    sub = 'Algo que no pasó por tu tarjeta';
    const isIncome = f.type === 'ingreso';
    fields = `
        <div class="pick-row seg-row" role="group" aria-label="Tipo">
          <button type="button" class="pick ${isIncome ? '' : 'current'}" data-act="manual-kind" data-value="gasto" aria-pressed="${!isIncome}">Gasto</button>
          <button type="button" class="pick ${isIncome ? 'current' : ''}" data-act="manual-kind" data-value="ingreso" aria-pressed="${isIncome}">Ingreso</button>
          <input type="hidden" name="type" value="${esc(f.type)}">
        </div>
        <label class="lbl" for="f-desc">Qué fue</label>
        <input id="f-desc" class="field" name="description" maxlength="40" autocomplete="off" placeholder="${isIncome ? 'Por ejemplo: Me pagó Ana' : 'Por ejemplo: Cena que pagó Ana'}" value="${esc(f.description)}">
        <label class="lbl" for="f-amount">Monto</label>
        <div class="amount-row">
          <input id="f-amount" class="field" name="amount" inputmode="decimal" autocomplete="off" placeholder="Por ejemplo: 12,500" value="${esc(f.amount)}">
          <div class="pick-row" role="group" aria-label="Moneda">
            <button type="button" class="pick ${f.currency === 'CRC' ? 'current' : ''}" data-act="seg" data-value="CRC" aria-pressed="${f.currency === 'CRC'}">₡</button>
            <button type="button" class="pick ${f.currency === 'USD' ? 'current' : ''}" data-act="seg" data-value="USD" aria-pressed="${f.currency === 'USD'}">$</button>
          </div>
          <input type="hidden" name="currency" value="${esc(f.currency)}">
        </div>
        <label class="lbl" for="f-date">Fecha</label>
        <input id="f-date" class="field" type="date" name="date" value="${esc(f.date)}">
        <div id="f-cat-box" ${isIncome ? 'hidden' : ''} style="display:${isIncome ? 'none' : 'flex'};flex-direction:column;gap:10px">
          <label class="lbl" for="f-cat">Categoría</label>
          <select id="f-cat" class="field" name="category"><option value="">Sin categoría</option>${categoryOptions(d.taxonomy || {}, f.category)}</select>
        </div>
        <p class="note" id="f-manual-note">${isIncome ? 'Se suma a lo que te sobra en el mes de esa fecha.' : 'Cuenta como cualquier otra compra, en el mes de esa fecha.'}</p>`;
  } else if (f.kind === 'trip') {
    title = f.id ? 'Cambiar viaje' : 'Nuevo viaje';
    sub = 'Nombre, fechas y cuánto pensás gastar';
    fields = `
        <label class="lbl" for="f-name">Nombre</label>
        <input id="f-name" class="field" name="name" maxlength="40" autocomplete="off" placeholder="Por ejemplo: Panamá" value="${esc(f.name)}">
        <div class="two-col">
          <div><label class="lbl" for="f-start">Ida</label><input id="f-start" class="field" type="date" name="start" value="${esc(f.start)}"></div>
          <div><label class="lbl" for="f-end">Vuelta</label><input id="f-end" class="field" type="date" name="end" value="${esc(f.end)}"></div>
        </div>
        <label class="lbl" for="f-currency">Presupuesto en</label>
        <select id="f-currency" class="field" name="currency">
          <option value="USD" ${f.currency === 'USD' ? 'selected' : ''}>Dólares</option>
          <option value="CRC" ${f.currency === 'CRC' ? 'selected' : ''}>Colones</option>
        </select>
        <div class="two-col">
          ${TRIP_PARTS.map((p, i) => `<div><label class="lbl" for="f-part-${i}">${esc(p)}</label><input id="f-part-${i}" class="field" name="part-${i}" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.parts[i])}"></div>`).join('')}
        </div>
        <p class="note">Dejá vacío lo que no vayás a usar. El presupuesto del viaje es la suma de las partes.</p>`;
    extra = f.id ? '<button type="button" class="link-btn danger" data-act="remove-setting">Borrar este viaje</button>' : '';
  } else if (f.kind === 'savings') {
    title = 'Meta de ahorro';
    sub = 'Lo que querés apartar cada mes';
    fields = `
        <label class="lbl" for="f-amount">Cuánto por mes</label>
        <input id="f-amount" class="field" name="amount" inputmode="decimal" autocomplete="off" placeholder="Por ejemplo: 100" value="${esc(f.amount)}">
        <label class="lbl" for="f-currency">En</label>
        <select id="f-currency" class="field" name="currency">
          <option value="USD" ${f.currency === 'USD' ? 'selected' : ''}>Dólares</option>
          <option value="CRC" ${f.currency === 'CRC' ? 'selected' : ''}>Colones</option>
        </select>
        <p class="note">Se aparta primero: "te sobra" y lo que podés gastar por día ya lo descuentan. Si un mes no alcanza, la app te dice cuánto falta.</p>`;
    extra = f.original ? '<button type="button" class="link-btn danger" data-act="remove-setting">Quitar la meta</button>' : '';
  } else if (f.kind === 'cut') {
    title = 'Día de corte';
    sub = 'El día en que cierra tu estado de cuenta';
    const days = [...Array(28).keys()].map((i) => i + 1);
    fields = `
        <label class="lbl" for="f-day">Mi tarjeta corta</label>
        <select id="f-day" class="field" name="day">
          ${days.map((n) => `<option value="${n}" ${n === f.day ? 'selected' : ''}>El ${n} · mi mes va del ${n + 1} al ${n}</option>`).join('')}
          <option value="31" ${f.day === 31 ? 'selected' : ''}>No sé / meses normales · del 1 al último día</option>
        </select>
        <p class="note">El día de corte es el <b>último</b> día que entra en el estado de cuenta ("fecha de corte"); lo que comprás ese día todavía cuenta en ese mes, y el mes nuevo empieza al día siguiente. Si querés que tu mes <b>empiece</b> el 12, elegí el 11. Si lo cambiás, tus compras se reacomodan solas; no se pierde nada.</p>`;
  } else if (f.kind === 'cycle') {
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
  if (kind === 'manual') {
    // today when the month on screen is the running one; otherwise that month's last day
    const today = todayIso();
    state.form = { kind, type: 'gasto', description: '', amount: '', currency: 'CRC', date: today >= d.range[0] && today <= d.range[1] ? today : d.range[1], category: '', error: '' };
    renderOverlay();
    document.getElementById('f-desc')?.focus();
    return;
  }
  if (kind === 'trip') {
    const t = tripsOf(d).find((x) => x.id === key);
    state.form = t ? { kind, id: t.id, name: t.name, start: t.start, end: t.end, currency: t.currency, parts: t.parts.map((p) => (p.budget ? typedAmount(p.budget) : '')), error: '' }
      : { kind, id: '', name: '', start: '', end: '', currency: 'USD', parts: TRIP_PARTS.map(() => ''), error: '' };
    renderOverlay();
    if (!t) document.getElementById('f-name')?.focus();
    return;
  }
  if (kind === 'savings') {
    const g = d.summary.savings;
    state.form = { kind, original: !!g, amount: g ? typedAmount(g.minor) : '', currency: g ? g.currency : 'USD', error: '' };
  } else if (kind === 'cut') {
    state.form = { kind, day: d.cutDay || 15, error: '' };
  } else if (kind === 'cycle') {
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
  if (f.kind === 'manual') {
    Object.assign(f, { type: v('type'), description: v('description'), amount: v('amount'), currency: v('currency'), date: v('date'), category: v('category') });
    if (!f.description) return { error: 'Escribí qué fue.' };
    if (!amountOk(f.amount)) return { error: 'Escribí el monto solo con números, por ejemplo 12,500.' };
    if (!f.date) return { error: 'Elegí la fecha.' };
    const [category = '', sub = ''] = f.type === 'gasto' && f.category ? f.category.split('/') : [];
    return { payload: { action: 'addManual', kind: f.type, description: f.description, date: f.date, currency: f.currency, amount: f.amount, category, sub }, done: f.type === 'ingreso' ? 'Ingreso agregado' : 'Gasto agregado' };
  }
  if (f.kind === 'trip') {
    Object.assign(f, { name: v('name'), start: v('start'), end: v('end'), currency: v('currency'), parts: TRIP_PARTS.map((_, i) => v(`part-${i}`)) });
    if (!f.name) return { error: 'Ponele un nombre al viaje.' };
    if (!f.start || !f.end) return { error: 'Elegí la fecha de ida y la de vuelta.' };
    if (f.end < f.start) return { error: 'La vuelta no puede ser antes de la ida.' };
    const bad = f.parts.findIndex((p) => p !== '' && (parseTyped(p) === null || parseTyped(p) < 0));
    if (bad >= 0) return { error: `No entendí el monto de ${TRIP_PARTS[bad]}. Escribilo solo con números, por ejemplo 300.` };
    return { payload: { action: 'setTrip', id: f.id, name: f.name, start: f.start, end: f.end, currency: f.currency, budgets: Object.fromEntries(TRIP_PARTS.map((p, i) => [p, f.parts[i]])) }, done: 'Viaje guardado' };
  }
  if (f.kind === 'savings') {
    Object.assign(f, { amount: v('amount'), currency: v('currency') });
    if (!amountOk(f.amount)) return { error: 'Escribí cuánto querés ahorrar por mes, solo con números, por ejemplo 100.' };
    return { payload: { action: 'setSavings', currency: f.currency, amount: f.amount }, done: 'Meta guardada' };
  }
  if (f.kind === 'cut') {
    f.day = Number(v('day'));
    return { payload: { action: 'setCutDay', day: f.day }, done: 'Día de corte guardado' };
  }
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
  if (f.kind === 'trip') return { payload: { action: 'removeTrip', id: f.id }, done: 'Viaje borrado' };
  if (f.kind === 'savings') return { payload: { action: 'setSavings', amount: '' }, done: 'Meta quitada' };
  return f.kind === 'budget' ? { payload: { action: 'setBudget', match: f.match, limit: '' }, done: 'Presupuesto quitado' }
    : { payload: { action: 'removeFixed', cycle: state.cycle, description: f.original }, done: 'Gasto fijo quitado' };
}

/** Closes the form, saves in the background, then reloads; on failure the form comes back with the reason. */
/** Totals of a month recomputed on the phone from its own entries, the way the engine does. */
function recompute(d) {
  const s = d.summary;
  const spend = { CRC: 0, USD: 0 };
  for (const e of d.entries) if (e.kind === 'spend') spend[e.currency] += e.minor;
  s.spend = spend;
  s.missing = [...(s.income === null ? ['income'] : []), ...(s.rate === null ? ['rate'] : [])];
  s.usdInCrc = s.rate === null ? null : Math.round((spend.USD * s.rate) / 100);
  s.extraIncome = d.entries.filter((e) => e.kind === 'income').reduce((n, e) => n + crcValue(e, s.rate), 0);
  s.teSobra = s.missing.length ? null : s.income + s.extraIncome - spend.CRC - s.usdInCrc;
  if (s.savings) s.savings.crc = s.savings.currency === 'CRC' ? s.savings.minor : s.rate === null ? null : Math.round((s.savings.minor * s.rate) / 100);
  s.toSpend = s.savings && s.savings.crc !== null && s.teSobra !== null ? s.teSobra - s.savings.crc : null;
  for (const b of d.budgets || []) {
    const keys = b.match.split(';').map((k) => k.trim()).filter(Boolean);
    b.spent = d.entries.filter((e) => e.kind === 'spend' && keys.some((k) => k === e.category || k === `${e.category}/${e.sub}`)).reduce((n, e) => n + crcValue(e, s.rate), 0);
  }
}

/**
 * Shows a setting on the screen before the engine confirms it, so saving feels instant.
 * Returns false for changes the phone cannot work out by itself (the cut day regroups
 * every month). The engine's answer replaces all of this a moment later.
 */
function applyLocally(d, p) {
  const s = d.summary;
  if (p.action === 'setCycle') {
    if (p.cycle !== d.cycle) return false;
    if (p.income === '' && s.income !== null && !s.incomeFrom) return false; // cleared: only the engine knows what carries over
    if (p.income !== '') { s.income = parseTyped(p.income); s.incomeFrom = null; }
    if (p.rate !== '') { s.rate = parseTyped(p.rate); s.rateSource = 'typed'; s.rateFrom = null; }
    else if (s.rateSource === 'typed' && s.autoRate) { s.rate = s.autoRate; s.rateSource = null; } // back to the automatic one; its date comes with the engine's answer
  } else if (p.action === 'addManual') {
    // in another month than the one on screen: nothing to show here
    if (p.date < d.range[0] || p.date > d.range[1]) return false;
    const income = p.kind === 'ingreso';
    d.entries.push({ id: null, date: p.date, description: p.description, card: '', source: 'manual', kind: income ? 'income' : 'spend', currency: p.currency, minor: parseTyped(p.amount), category: p.category, sub: p.sub, shop: null, trip: null, ...(income ? { income: true } : {}) });
  } else if (p.action === 'setTrip') {
    // a new trip shows empty until the engine answers with the purchases that fall in it
    if (!d.trips) return false;
    const old = d.trips.find((t) => t.id === p.id);
    const t = old || { id: '', entries: [], spent: 0, unconverted: 0 };
    if (old && old.currency !== p.currency) return false; // every purchase changes value: the engine's job
    Object.assign(t, { name: p.name, start: p.start, end: p.end, currency: p.currency, parts: TRIP_PARTS.map((name) => ({ name, budget: parseTyped(p.budgets[name] || '') || 0, spent: 0 })) });
    if (!old) d.trips.push(t);
    tripTotals(t);
  } else if (p.action === 'removeTrip') {
    if (!d.trips) return false;
    d.trips = d.trips.filter((t) => t.id !== p.id);
    for (const e of d.entries) if (e.trip === p.id) e.trip = null;
  } else if (p.action === 'setSavings') {
    s.savings = p.amount === '' ? null : { currency: p.currency, minor: parseTyped(p.amount), crc: null };
  } else if (p.action === 'setBudget') {
    d.budgets = (d.budgets || []).filter((b) => b.match !== p.match);
    if (p.limit !== '') d.budgets.push({ name: p.name || p.match, match: p.match, limit: parseTyped(p.limit), spent: 0 });
  } else if (p.action === 'setFixed' || p.action === 'removeFixed') {
    const old = (p.original || p.description).trim().toLowerCase();
    d.entries = d.entries.filter((e) => !(e.source === 'fixed' && e.description.trim().toLowerCase() === old));
    if (p.action === 'setFixed') d.entries.push({ date: d.range[1], description: p.description, card: '', source: 'fixed', kind: 'spend', currency: p.currency, minor: parseTyped(p.amount), category: p.category, sub: p.sub, shop: null });
  } else {
    return false;
  }
  recompute(d);
  return true;
}

async function saveSetting({ payload, done }) {
  const form = state.form;
  state.form = null;
  state.pending += 1;
  // shown at once when the phone can work the change out itself; put back if saving fails
  const cycle = state.cycle;
  const before = state.data && state.data.cycle === cycle ? JSON.stringify(state.data) : null;
  const instant = !!before && applyLocally(state.data, payload);
  if (instant) { showToast(done); render(); }
  else showToast(familyMode() ? 'Guardando… puede tardar un minuto' : 'Guardando…', familyMode() ? INBOX_WAIT_MS + 10000 : 15000);
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
    if (instant && state.cycle === cycle) { state.data = JSON.parse(before); render(); }
    state.toast = '';
    state.form = { ...form, error: instant ? `No se guardó: ${failure}` : failure };
    renderOverlay();
  } else {
    if (!instant) showToast(done);
    refresh();
  }
}

function renderOverlay() {
  let $o = document.getElementById('overlay');
  if (!$o) { $o = document.createElement('div'); $o.id = 'overlay'; document.body.appendChild($o); }
  $o.innerHTML = (state.edit ? sheetHtml() : state.tripEdit ? tripEntrySheetHtml() : state.form ? formSheetHtml() : state.picking ? filterSheetHtml() : '') + (state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : '');
  document.body.classList.toggle('locked', !!(state.edit || state.tripEdit || state.form || state.picking));
}

/**
 * Shows the change at once and saves in the background (the engine takes a few seconds).
 * If saving fails, the screen goes back to how it was and says so.
 */
/** Removes one movement from the month's count, or puts it back. Shown at once; undone with a message if saving fails. */
async function saveRemoval(remove) {
  const ed = state.edit;
  const cycle = state.cycle;
  const before = JSON.stringify(state.data);
  const entry = state.data.entries.find((e) => e.id === ed.id);
  state.edit = null;
  if (!entry) { renderOverlay(); return; }
  entry.kind = remove ? 'removed' : entry.income ? 'income' : 'spend';
  recompute(state.data);
  state.pending += 1;
  showToast(remove ? `${ed.name}: quitado` : `${ed.name}: restaurado`);
  render();
  let failure = '';
  try {
    const out = await sendCommand({ action: remove ? 'removeEntry' : 'restoreEntry', id: ed.id });
    if (!out.ok) failure = out.error === 'unauthorized' ? 'el código de acceso ya no es válido' : out.error === 'unknown action' ? 'tu conexión todavía no lo permite' : out.error;
  } catch {
    failure = 'no hay conexión';
  }
  state.pending -= 1;
  if (failure) {
    if (state.cycle === cycle) state.data = JSON.parse(before);
    showToast(`No se pudo ${remove ? 'quitar' : 'restaurar'} ${ed.name}: ${failure}`, 5000);
    render();
  } else {
    refresh();
  }
}

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
  const view = { inicio, movimientos, presupuesto, viajes, recurrentes }[state.tab];
  const searching = document.activeElement && document.activeElement.id === 'mov-search' && state.tab === 'movimientos' && state.filter !== 'uncat';
  if (searching && document.getElementById('mov-list')) {
    // she is typing in the search box: rebuilding it would drop the keyboard
    document.getElementById('mov-list').innerHTML = movList(d);
    return;
  }
  $screen.innerHTML = view(d);
  // a background refresh must not rebuild the form she is typing in (it would drop her text and the keyboard)
  if (!(state.edit && (state.edit.adding || state.edit.amounting)) && !state.form) renderOverlay();
}

// ---------- events ----------

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    state.filter = '';
    state.catFilter = null;
    state.query = '';
    state.trip = null;
    save('mg-tab', state.tab);
    window.scrollTo(0, 0);
    // trips are not of one month: always shown from this month's copy, the freshest one
    if (state.tab === 'viajes' && state.cycle !== state.current) { state.cycle = state.current; refresh(); return; }
    render();
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (!act || act.disabled) return;
  const a = act.dataset.act;
  if (a === 'copy-code') { copyCode(); return; }
  if (a === 'sync-now') { syncNow(); return; }
  if (a === 'edit') {
    state.edit = { shop: act.dataset.shop, id: act.dataset.id || '', trip: act.dataset.trip || '', income: act.dataset.income === '1', removed: act.dataset.removed === '1', name: act.dataset.name, category: act.dataset.category, sub: act.dataset.sub, error: '' };
    renderOverlay();
    return;
  }
  if (a === 'remove-entry' || a === 'restore-entry') { saveRemoval(a === 'remove-entry'); return; }
  if (a === 'close') { if (!state.saving) { state.edit = null; renderOverlay(); } return; }
  if (a === 'add-cat') { state.edit.adding = true; state.edit.error = ''; renderOverlay(); document.getElementById('nc-sub')?.focus(); return; }
  if (a === 'back') { state.edit.adding = false; state.edit.amounting = false; state.edit.error = ''; renderOverlay(); return; }
  if (a === 'edit-amount') { state.edit.amounting = true; state.edit.error = ''; state.edit.amount = undefined; renderOverlay(); document.getElementById('am-amount')?.select(); return; }
  if (a === 'amount-reset') { saveAmount(null, ''); return; }
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
  if (a === 'open-trip') {
    state.tab = 'viajes'; state.trip = act.dataset.id; save('mg-tab', state.tab); window.scrollTo(0, 0);
    if (state.cycle !== state.current) { state.cycle = state.current; refresh(); return; }
    render();
    return;
  }
  if (a === 'close-trip') { state.trip = null; render(); window.scrollTo(0, 0); return; }
  if (a === 'edit-trip') { openForm('trip', act.dataset.id); return; }
  if (a === 'trip-entry') { state.tripEdit = { id: act.dataset.id, name: act.dataset.name, part: act.dataset.part }; renderOverlay(); return; }
  if (a === 'close-trip-entry') { state.tripEdit = null; renderOverlay(); return; }
  if (a === 'trip-part') {
    const te = state.tripEdit;
    if (act.dataset.part === te.part) { state.tripEdit = null; renderOverlay(); return; }
    saveTripChoice(te.id, te.name, state.trip, act.dataset.part);
    return;
  }
  if (a === 'trip-in') { saveTripChoice(state.edit.id, state.edit.name, act.dataset.trip, ''); return; }
  if (a === 'trip-out') { const x = state.tripEdit || state.edit; saveTripChoice(x.id, x.name, '', ''); return; }
  if (a === 'add-manual') { openForm('manual'); return; }
  if (a === 'manual-kind') {
    // switched in place so what she typed and the keyboard stay
    const income = act.dataset.value === 'ingreso';
    for (const b of act.parentElement.querySelectorAll('.pick')) { b.classList.toggle('current', b === act); b.setAttribute('aria-pressed', String(b === act)); }
    act.parentElement.querySelector('input[type=hidden]').value = act.dataset.value;
    const box = document.getElementById('f-cat-box');
    box.hidden = income; box.style.display = income ? 'none' : 'flex';
    document.getElementById('f-desc').placeholder = income ? 'Por ejemplo: Me pagó Ana' : 'Por ejemplo: Cena que pagó Ana';
    document.getElementById('f-manual-note').textContent = income ? 'Se suma a lo que te sobra en el mes de esa fecha.' : 'Cuenta como cualquier otra compra, en el mes de esa fecha.';
    return;
  }
  if (a === 'edit-cycle') { openForm('cycle'); return; }
  if (a === 'edit-cut') { openForm('cut'); return; }
  if (a === 'edit-savings') { openForm('savings'); return; }
  if (a === 'edit-budget') { openForm('budget', act.dataset.match); return; }
  if (a === 'edit-fixed') { openForm('fixed', act.dataset.desc); return; }
  if (a === 'close-form') { state.form = null; renderOverlay(); return; }
  if (a === 'remove-setting') { if (state.form.kind === 'trip') state.trip = null; saveSetting(removalOf(state.form)); return; }
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
  if (ev.target.id === 'amount-form') {
    ev.preventDefault();
    const text = String(new FormData(ev.target).get('amount') || '').trim();
    const minor = parseTyped(text);
    if (minor === null || minor <= 0) {
      state.edit.amount = text;
      state.edit.error = minor === 0 ? 'El monto debe ser mayor que cero. Si no querés que cuente, quitá el movimiento.' : 'No entendí el monto. Escribilo solo con números, por ejemplo 12,500.';
      renderOverlay();
      document.getElementById('am-amount')?.focus();
      return;
    }
    saveAmount(minor, text);
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
  if (el.id === 'mov-search') {
    state.query = el.value;
    const list = document.getElementById('mov-list');
    if (list && state.data) list.innerHTML = movList(state.data);
    return;
  }
  if (!el.matches || !el.matches('input[data-whole]')) return;
  const digits = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  el.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.edit && !state.saving) { state.edit = null; renderOverlay(); }
  if (ev.key === 'Escape' && state.tripEdit) { state.tripEdit = null; renderOverlay(); }
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
