// mis-gastos iPhone app. Reads the engine's JSON API and renders four screens
// (Inicio, Movimientos, Presupuesto, Recurrentes) like design/mockup/Main.dc.html.
// No framework, no build step: this file is what the phone runs.

import { API_URL } from './config.js';

const TOKEN_KEY = 'mg-token';
const CACHE_KEY = 'mg-cache-v1:'; // + cycle → last good response, for offline
const TABS = ['inicio', 'movimientos', 'presupuesto', 'recurrentes'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const state = { tab: 'inicio', cycle: null, current: null, data: null, error: null, loading: false, offline: false };
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

async function fetchCycle(cycle) {
  const token = load(TOKEN_KEY);
  const url = `${API_URL}?token=${encodeURIComponent(token)}&cycle=${encodeURIComponent(cycle)}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  if (!load(TOKEN_KEY)) return render();
  const cycle = state.cycle;
  const cached = load(CACHE_KEY + cycle);
  if (cached && (!state.data || state.data.cycle !== cycle)) {
    state.data = JSON.parse(cached);
    state.offline = false;
  }
  state.loading = true;
  render();
  try {
    const data = await fetchCycle(cycle);
    if (cycle !== state.cycle) return; // user moved on
    if (!data.ok) {
      state.error = data.error === 'unauthorized' ? 'unauthorized' : data.error;
    } else {
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
  const bits = [];
  if (state.offline) bits.push('Sin conexión: datos guardados');
  if (d.lastSync) bits.push(`Correos revisados ${ago(d.lastSync.runAt)}`);
  if (d.lastSync && d.lastSync.error) bits.push('⚠ el último intento falló');
  return bits.length ? `<div class="footer-note">${esc(bits.join(' · '))}</div>` : '';
}

function inicio(d) {
  const s = d.summary;
  const rate = s.rate;
  let hero;
  if (s.teSobra === null) {
    const falta = s.missing.map((m) => (m === 'income' ? 'el salario' : 'el tipo de cambio')).join(' y ');
    hero = `<div class="hero missing">Falta ${esc(falta)} de ${esc(monthName(d.cycle))} en la hoja (pestaña Cycles).</div>`;
  } else {
    hero = `<div class="hero ${s.teSobra < 0 ? 'neg' : ''}">${crc(s.teSobra)}</div>`;
  }
  const rows = [];
  if (s.income !== null) rows.push(`<div class="row"><span>Salario</span><b>${crc(s.income)}</b></div>`);
  rows.push(`<div class="row"><span>Colones</span><b>${crc(-s.spend.CRC)}</b></div>`);
  if (s.spend.USD) {
    rows.push(`<div class="row"><span>Dólares <span class="note">${usd(s.spend.USD)}${rate ? ` × ${(rate / 100).toLocaleString('en-US')}` : ''}</span></span><b>${s.usdInCrc === null ? '—' : crc(-s.usdInCrc)}</b></div>`);
  }

  // where it went: by subcategory, CRC-equivalent
  const by = new Map();
  for (const e of d.entries) {
    if (e.kind !== 'spend') continue;
    const k = subLabel(e);
    by.set(k, (by.get(k) || 0) + crcValue(e, rate));
  }
  const top = [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = top.reduce((n, [, v]) => n + v, 0);
  const max = top.length ? top[0][1] : 1;
  const topRows = top.slice(0, 6).map(([k, v]) => `
    <div class="item">
      <div class="row"><span>${esc(k)}</span><b>${crc(v)}</b></div>
      <div class="bar"><i style="width:${Math.max(2, Math.round((v / max) * 100))}%"></i></div>
    </div>`).join('');

  return `
    ${header(cap(monthName(d.cycle)), `Ciclo ${shortDate(d.range[0])} – ${shortDate(d.range[1])}`)}
    <section class="card pad" aria-label="Te sobra">
      <div><div class="hero-label">Te sobra este mes</div>${hero}</div>
      ${statusPill(d)}
      <div class="sep"></div>
      <div style="display:flex;flex-direction:column;gap:12px">${rows.join('')}</div>
      <div class="note">Incluye el préstamo del carro y las cuotas. No incluye SINPE.</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>En qué se fue</h2><span class="note">${crc(total)}</span></div>
      <div class="card">${topRows || '<div class="item note">Todavía no hay gastos en este ciclo.</div>'}</div>
    </section>
    ${syncLine(d)}`;
}

function movimientos(d) {
  const list = [...d.entries].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
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
      return `
        <div class="item mov">
          <div class="avatar" aria-hidden="true">${esc(name.charAt(0) || '·')}</div>
          <div class="mov-text"><span class="mov-name">${esc(name)}</span><span class="mov-meta">${tag ? `${tag.replace('class="tag"', 'class="tag first"')} ` : ''}${esc(meta)}</span></div>
          <span class="mov-amt ${e.kind === 'card-payment' ? 'muted' : ''}">${esc(money(e))}</span>
        </div>`;
    }).join('');
    return `<div class="section"><div class="group-label"><span>${esc(dayLabel(date))}</span><span>${esc(total)}</span></div><div class="card">${rows}</div></div>`;
  }).join('');
  return `
    ${header('Movimientos', `${cap(monthName(d.cycle))} · ${d.entries.length} movimientos`)}
    ${groups || '<div class="card"><div class="item note">Todavía no hay movimientos en este ciclo.</div></div>'}
    ${syncLine(d)}`;
}

function presupuesto(d) {
  const budgets = d.budgets || [];
  const rows = budgets.map((b) => {
    const over = b.spent > b.limit;
    const pct = b.limit > 0 ? Math.min(100, Math.round((b.spent / b.limit) * 100)) : 100;
    const note = over ? `Te pasaste ${crc(b.spent - b.limit)}` : `Quedan ${crc(b.limit - b.spent)}`;
    return `
      <div class="item">
        <div class="row"><b style="font-weight:600">${esc(b.name)}</b><span class="note ${over ? 'over-text' : ''}" style="font-weight:600">${esc(note)}</span></div>
        <div class="bar thick ${over ? 'over' : ''}"><i style="width:${Math.max(2, pct)}%"></i></div>
        <div class="small"><span>${crc(b.spent)} gastado</span><span>de ${crc(b.limit)}</span></div>
      </div>`;
  }).join('');
  return `
    ${header('Presupuesto', `${cap(monthName(d.cycle))} · límites de tu hoja`)}
    <div class="card">${rows || '<div class="item note">No hay presupuestos todavía (pestaña Budgets).</div>'}</div>
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
  const fixed = d.entries.filter((e) => e.source === 'fixed').map((e) => ({ name: prettyName(e.description), meta: 'Fijo, cada mes', amount: money(e), pct: null }));

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
  const body = group('Tasa 0', cuotas) + group('Fijos', fixed) + group('Suscripciones y servicios', subRows);
  return `
    ${header('Recurrentes', `${cap(monthName(cycle))} · cada mes`)}
    ${body || '<div class="card"><div class="item note">Nada recurrente en este ciclo todavía.</div></div>'}
    ${syncLine(d)}`;
}

function setupScreen(message) {
  return `
    <div class="center">
      <h1>mis-gastos</h1>
      <p class="note" style="font-size:15px;line-height:21px">${esc(message || 'Para ver tus datos, pegá tu código de acceso. Lo encontrás en el correo de configuración o corriendo showToken en el script.')}</p>
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
  document.querySelector('.tabbar').hidden = !load(TOKEN_KEY) || state.error === 'unauthorized';
  if (!load(TOKEN_KEY)) { $screen.innerHTML = setupScreen(); return; }
  if (state.error === 'unauthorized') { $screen.innerHTML = setupScreen('Ese código no funcionó o ya no es válido. Pegá el código actual.'); return; }
  const d = state.data && state.data.cycle === state.cycle ? state.data : null;
  if (!d) {
    $screen.innerHTML = state.offline || state.error
      ? `<div class="center"><h1>Sin datos</h1><p class="note">${esc(state.error ? `Error: ${state.error}` : 'No hay conexión y todavía no hay datos guardados de este ciclo.')}</p><button class="btn" type="button" data-act="retry">Reintentar</button></div>`
      : `${header(cap(monthName(state.cycle)), 'Cargando…')}<div class="skeleton"></div><div class="skeleton" style="height:300px"></div>`;
    return;
  }
  const view = { inicio, movimientos, presupuesto, recurrentes }[state.tab];
  $screen.innerHTML = view(d);
}

// ---------- events ----------

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    save('mg-tab', state.tab);
    render();
    window.scrollTo(0, 0);
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (!act || act.disabled) return;
  if (act.dataset.act === 'prev') state.cycle = addMonths(state.cycle, -1);
  if (act.dataset.act === 'next' && state.cycle < state.current) state.cycle = addMonths(state.cycle, 1);
  refresh();
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'token-form') return;
  ev.preventDefault();
  const token = new FormData(ev.target).get('token').toString().trim();
  if (!token) return;
  save(TOKEN_KEY, token);
  state.error = null;
  refresh();
});

window.addEventListener('hashchange', () => takeTokenFromLink() && refresh());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = todayCycle();
    if (now !== state.current) { state.current = now; state.cycle = now; }
    refresh();
  }
});

// ---------- start ----------

/** A setup link carries the token in the fragment (#t=…), which is never sent to any server. */
function takeTokenFromLink() {
  const m = /[#&]t=([A-Za-z0-9_-]{16,})/.exec(location.hash);
  if (!m) return false;
  save(TOKEN_KEY, m[1]);
  state.error = null;
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

(function start() {
  takeTokenFromLink();
  const savedTab = load('mg-tab');
  if (TABS.includes(savedTab)) state.tab = savedTab;
  state.current = todayCycle();
  state.cycle = state.current;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  refresh();
})();
