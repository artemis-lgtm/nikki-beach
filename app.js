// Nikki Beach Leads: single-page app, no build step.
// Served two ways: from the Mini itself (same origin), or as a static page on GitHub Pages that talks to the
// Mini's API cross-origin (Austin 10/5). window.NB_API is set only in the Pages copy; then auth rides a bearer
// token in localStorage instead of the cookie, and /api + /media links get the API host and ?t= token.
const NB_API = window.NB_API || '';
const nbToken = () => { try { return localStorage.getItem('nb_token') || ''; } catch { return ''; } };
const apiUrl = (p) => {
  if (!NB_API || typeof p !== 'string' || !/^\/(api|media)\//.test(p)) return p;
  return `${NB_API}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(nbToken())}`;
};
if (NB_API) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = (path, opts = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) return rawFetch(path, opts);
    return rawFetch(NB_API + path, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${nbToken()}` } });
  };
}
const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : (k === 'href' || k === 'src') ? apiUrl(v) : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const state = { user: null, config: null, leads: [], orgs: [], contacts: [], footprint: [], route: '/', filters: { temps: new Set(), grades: new Set(), q: '', stage: '', region: '', format: '', status: 'active', tier: '' }, sort: { key: 'priority', dir: -1 } };

// ---------- API
async function api(path, opts = {}) {
  const isObj = opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob);
  const res = await fetch(path, { ...opts, headers: isObj ? { 'content-type': 'application/json' } : {}, body: isObj ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 401) { state.user = null; renderLogin(); throw new Error('Not signed in'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
const toast = (msg, err = false) => { const t = h('div', { class: `toast${err ? ' err' : ''}` }, msg); document.body.append(t); setTimeout(() => t.remove(), err ? 5000 : 2600); };

// ---------- Helpers
const fmt = {
  money: (n) => n == null || n === '' ? '' : (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`),
  date: (s) => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '',
  dt: (s) => s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
  ago: (s) => { if (!s) return ''; const d = Math.floor((Date.now() - Date.parse(s)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`; },
  label: (s) => String(s || '').replace(/_/g, ' '),
  title: (s) => fmt.label(s).replace(/\b\w/g, c => c.toUpperCase()),
};
const stageObj = (k) => state.config?.stages.find(s => s.key === k);
const stageLabel = (k) => stageObj(k)?.label || fmt.title(k);
const formatLabel = (k) => state.config?.formats.find(f => f.key === k)?.label || fmt.title(k);
const regionLabel = (k) => state.config?.markets[k]?.label || (k ? fmt.title(k) : 'Unassigned');
const tempColor = { hot: 'var(--hot)', warm: 'var(--warm)', cold: 'var(--cold)', dead: 'var(--dead)' };
const gradeColor = { A: 'var(--ok)', B: 'var(--warm)', C: 'var(--dead)' };
const ring = (lead, lg = false) => h('div', { class: `ring${lg ? ' lg' : ''}`, style: { '--p': lead.composite, '--c': gradeColor[lead.grade?.[0]] || 'var(--cold)' }, title: `Composite ${lead.composite}/100 · fit letter ${lead.grade?.[0]} · ${lead.temperature}` }, h('span', {}, Math.round(lead.composite ?? 0)));
const temp = (t) => h('span', { class: `temp ${t}` }, t);
const gradeChip = (l) => h('span', { class: 'grade', style: { '--g': gradeColor[l.grade?.[0]] || 'var(--dead)', '--t': tempColor[l.temperature] }, title: `Fit letter ${l.grade?.[0]} (${l.fit_score}%) · heat digit ${l.grade?.[1]} (${l.heat_score}) · ${l.temperature}${l.temperature_reason ? `: ${l.temperature_reason}` : ''}` }, h('b', {}, l.grade?.[0]), h('i', {}, l.grade?.[1]));
const heatBar = (l) => h('div', { class: 'heat', title: `Heat ${l.heat_score}/100: ${l.temperature}` }, h('i', { style: { width: `${Math.min(100, l.heat_score)}%`, background: tempColor[l.temperature] } }));
const navigate = (path) => { location.hash = path; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Boot
async function boot() {
  try {
    const me = await fetch('/api/me').then(r => r.ok ? r.json() : null);
    if (!me) return renderLogin();
    state.user = me.user;
    await loadAll();
    start();
  } catch (e) { console.error(e); renderLogin(); }
}
function start() { window.addEventListener('hashchange', render); document.addEventListener('keydown', onKey); render(); }
async function loadAll() {
  [state.config, state.leads, state.orgs, state.contacts, state.footprint] = await Promise.all([api('/api/config'), api('/api/leads'), api('/api/orgs'), api('/api/contacts'), api('/api/footprint')]);
}
async function refreshLeads() { state.leads = await api('/api/leads'); }

function renderLogin() {
  const app = $('#app');
  app.className = 'login';
  app.replaceChildren(h('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault();
    const name = $('#ln').value.trim(), password = $('#lp').value;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (d.token) try { localStorage.setItem('nb_token', d.token); } catch {}
      state.user = d.user; await loadAll(); start();
    } catch (err) { $('#lerr').textContent = err.message; }
  } },
    h('div', { class: 'eyebrow' }, 'Higney International'),
    h('img', { src: 'logo.png', alt: 'Nikki Beach', style: { height: '120px', display: 'block', margin: '0 0 16px' } }),
    h('p', {}, 'The Nikki Beach deal-sourcing pipeline. Sign in with the team password.'),
    h('div', { class: 'field' }, h('label', { for: 'ln' }, 'Your name'), h('input', { id: 'ln', required: true, autocomplete: 'name', placeholder: 'Peter' })),
    h('div', { class: 'field' }, h('label', { for: 'lp' }, 'Team password'), h('input', { id: 'lp', type: 'password', required: true })),
    h('div', { id: 'lerr', class: 'error' }),
    h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center', marginTop: '8px' } }, 'Enter'),
  ));
}

// ---------- Read-only by default (Austin 9/30: Nikki Beach gets access). Everything on the property pages and in
// the detail pop-ups is locked; "+ New lead" still works, and "Edit lead" in the rail unlocks everything until Done.
const KEEP = '.tabs button, [data-keep], .leaflet-container *';
function fitText(el) {
  if (!el._fit) { el._fit = true; el.style.overflow = 'hidden'; el.style.resize = 'none'; el.addEventListener('input', () => fitText(el)); }
  requestAnimationFrame(() => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; });
}
function applyLock() {
  const roots = [$('.main'), ...document.querySelectorAll('.overlay:not([data-unlocked])')].filter(Boolean);
  for (const root of roots) {
    root.classList.toggle('locked', !state.editing);
    for (const el of root.querySelectorAll('input, select, textarea, button')) {
      if (el.tagName === 'TEXTAREA') fitText(el);   // 9/30 Austin: descriptions show in full, no inner scrollbar
      if (el.matches(KEEP)) continue;
      if (!state.editing) { if (!el.disabled) { el.disabled = true; el.dataset.lockDisabled = '1'; } }
      else if (el.dataset.lockDisabled) { el.disabled = false; delete el.dataset.lockDisabled; }
    }
  }
}
new MutationObserver(() => applyLock()).observe(document.body, { childList: true, subtree: true });

// ---------- Shell + router
const NAV = [
  ['/', 'Overview'], ['/map', 'Map'],
  ['sep'], ['/people', 'People'], ['/review', 'Weekly review'], ['/playbook', 'Playbook'], ['/markets', 'Markets'],
];
function render() {
  state.route = location.hash.replace(/^#/, '') || '/';
  const app = $('#app');
  app.className = 'app';
  const active = state.leads.filter(l => l.status === 'active');
  const counts = { '/': active.length };
  const rail = h('aside', { class: 'rail' },
    // 9/30 Austin: the logo alone, no "Nikki Beach Leads" text (logo from Peter, cleaned by scripts/install-logo.py)
    h('div', { class: 'brand' }, h('img', { class: 'brand-logo', src: 'logo.png', alt: 'Nikki Beach' })),
    h('nav', { class: 'nav' }, NAV.map(([p, label]) => p === 'sep' ? h('div', { class: 'sep' }) : h('a', { href: `#${p}`, class: (p === '/' ? state.route === '/' : state.route.startsWith(p)) ? 'active' : '' }, label, counts[p] ? h('span', { class: 'n' }, counts[p]) : null))),
    h('div', { class: 'rail-foot' },
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn primary', style: { justifyContent: 'center', flex: 1 }, onclick: () => newLeadModal() }, '+ New lead'),
        h('button', { class: `btn${state.editing ? ' hot' : ''}`, style: { justifyContent: 'center', flex: 1 }, title: 'Unlock every field on the property pages', onclick: () => { state.editing = !state.editing; render(); toast(state.editing ? 'Editing on. Click Done when finished.' : 'Locked'); } }, state.editing ? 'Done' : 'Edit lead')),
      h('button', { class: 'btn ghost sm', onclick: () => openCmdk() }, 'Search  ⌘K'),
      h('div', {}, `Signed in as ${state.user}`, ' · ', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await fetch('/api/logout'); try { localStorage.removeItem('nb_token'); } catch {} location.reload(); } }, 'sign out')),
    ),
  );
  const main = h('main', { class: 'main' });
  app.replaceChildren(h('div', { class: 'shell' }, rail, main));
  const r = state.route;
  let m;
  // 9/30 Austin: old Overview, Triage and Board pages removed; the ranked Pipeline list is now Overview
  if (r === '/' || /^\/(pipeline|triage|board)/.test(r)) viewPipeline(main);
  else if (r.startsWith('/map')) viewMap(main);
  else if (r.startsWith('/markets')) viewMarkets(main);
  else if (r.startsWith('/people')) viewPeople(main);
  else if (r.startsWith('/footprint')) navigate('/map');   // 9/30: Footprint now lives under the map
  else if (r.startsWith('/review')) viewReview(main);
  else if (r.startsWith('/playbook')) viewPlaybook(main);
  else if ((m = /^\/lead\/(\d+)(?:\/(\w+))?/.exec(r))) viewLead(main, Number(m[1]), m[2] || 'overview');
  else main.append(h('div', { class: 'empty' }, 'Nothing here.'));
}
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); return; }
  if (e.key === 'Escape') { $('.cmdk')?.remove(); $('.overlay')?.remove(); return; }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing || $('.overlay') || $('.cmdk')) return;
  if (e.key === 'n' && !e.metaKey) { e.preventDefault(); newLeadModal(); }
  if (e.key === '/') { e.preventDefault(); openCmdk(); }
  if (e.key === 'g') { state._g = Date.now(); return; }
  if (state._g && Date.now() - state._g < 800) { const map = { o: '/', m: '/map', r: '/review' }; if (map[e.key]) navigate(map[e.key]); state._g = 0; }
}
function topbar(title, sub, ...actions) {
  return h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'btn-row' }, ...actions));
}
const leadRow = (l, extra) => h('tr', { onclick: () => navigate(`/lead/${l.id}`) },
  h('td', { style: { width: '56px' } }, ring(l)),
  h('td', {}, h('div', { class: 'lead-name' }, l.name), h('div', { class: 'lead-loc' }, [l.country, formatLabel(l.format), stageLabel(l.stage)].filter(Boolean).join(' · '))),
  h('td', {}, gradeChip(l)),
  h('td', { class: 'small', style: { textAlign: 'right' } }, extra ?? ''));

// ---------- Overview: Peter's Monday Properties board, same groups and columns left to right, plus hot/cold (Austin 9/30)
const MONDAY_COLS = ['Address', 'Listing status', 'Property Type', 'Type', 'SQFT', 'Price per sqft', 'Price', 'Images', 'Rent $/SF/yr', 'Building SF (RBA)', 'Interior SF', 'Exterior SF', 'Notes', 'Zoning', 'Broker', 'Listing'];   // Rating dropped 9/30 (Austin)
function mondayCell(l, title) {
  const c = (l.monday?.columns || []).find(x => x.title === title);
  const t = (c?.text || '').trim();
  if (!t) return h('td', { class: 'muted' }, '');
  const num = (v) => Number(String(v).replace(/[^0-9.]/g, ''));
  if (title === 'Price' || title === 'Price per sqft' || title === 'Rent $/SF/yr') return h('td', { class: 'mono', style: { textAlign: 'right' } }, '$' + num(t).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  if (c.type === 'numbers') return h('td', { class: 'mono', style: { textAlign: 'right' } }, num(t).toLocaleString('en-US'));
  if (title === 'Rating') return h('td', { style: { color: 'var(--warm)', whiteSpace: 'nowrap' } }, '★'.repeat(num(t)) + '☆'.repeat(Math.max(0, 5 - num(t))));
  if (title === 'Images') { const n = t.split(', ').length; return h('td', {}, h('a', { href: l.monday.url, target: '_blank', class: 'pill', onclick: (e) => e.stopPropagation() }, `${n} file${n > 1 ? 's' : ''}`)); }
  if (title === 'Listing') { const url = (t.match(/https?:\/\/\S+/) || [])[0]; const label = t.includes(' - ') ? t.split(' - ')[0] : (url ? url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : t); return h('td', {}, url ? h('a', { href: url, target: '_blank', onclick: (e) => e.stopPropagation() }, label) : label); }
  if (title === 'Listing status' || title === 'Property Type' || title === 'Type') return h('td', {}, h('span', { class: 'pill', style: { whiteSpace: 'nowrap' } }, t));
  if (title === 'Notes') return h('td', { class: 'small', title: t, style: { minWidth: '260px', maxWidth: '360px' } }, t.length > 140 ? t.slice(0, 140) + '…' : t);
  return h('td', { class: 'small', style: { whiteSpace: title === 'Address' ? 'normal' : 'nowrap', minWidth: title === 'Address' ? '200px' : '' } }, t);
}
// 9/30 Austin: a small square map above each Overview group showing that area; click it to open the Map page zoomed there.
function groupMap(leads, color) {
  const pts = leads.filter(l => l.lat && l.lng).map(l => [l.lat, l.lng]);
  if (!pts.length || typeof L === 'undefined') return null;
  const el = h('div', { class: 'group-map', title: 'Open on the map', 'data-keep': '1', onclick: () => { state.mapFocus = pts; navigate('/map'); } });
  const wrap = h('div', { class: 'group-map-wrap', onclick: () => { state.mapFocus = pts; navigate('/map'); } }, el,
    h('span', { class: 'show-on-map' }, h('span', { style: { display: 'inline-flex' }, html: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>' }), 'Show on map'));
  setTimeout(() => {
    const m = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(m);
    for (const l of leads) if (l.lat && l.lng) L.circleMarker([l.lat, l.lng], { radius: 5, color: '#fff', weight: 2, fillColor: color.startsWith('#') ? color : '#2f8596', fillOpacity: 1, interactive: false }).addTo(m);
    pts.length > 1 ? m.fitBounds(pts, { padding: [18, 18], maxZoom: 14 }) : m.setView(pts[0], 13);
  }, 30);
  return wrap;
}
// Date a property went on the board (Monday's own timestamp), and the 10-day "New listing" badge (Austin 9/30)
const dateAdded = (l) => l.monday?.created_at || l.created_at;
const isNewListing = (l) => !l.handed_off_at && !l.declined_at && (Date.now() - Date.parse(dateAdded(l))) < 10 * 86400000;
function viewPipeline(main) {
  const f = state.filters;
  const search = h('input', { 'data-keep': '1', class: 'input', style: { maxWidth: '420px' }, placeholder: 'Search properties, addresses, brokers, notes…', value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } });
  const wrap = h('div', {});
  main.append(topbar('Overview', 'Same groups and columns as the Monday Properties board, plus how hot or cold each lead is.', h('a', { class: 'btn', href: '/api/export/pipeline.csv' }, 'Export CSV'), h('button', { class: 'btn primary', 'data-keep': '1', onclick: () => newLeadModal() }, '+ New lead')), h('div', { class: 'filters' }, search), wrap);
  function draw() {
    let ls = state.leads;
    if (f.q) { const s = f.q.toLowerCase(); ls = ls.filter(l => [l.name, l.ref, l.address, ...(l.monday?.columns || []).map(c => c.text)].join(' ').toLowerCase().includes(s)); }
    const groups = new Map();
    // 9/30 Austin: handed-off and declined properties drop out of their area group into two groups at the bottom
    const bucket = (l) => l.declined_at ? ['Declined', '#e5532e', 2000] : l.handed_off_at ? ['Handed Off', '#7d7a8c', 1000] : [l.monday?.group || 'Not on Monday yet', l.monday?.group_color || 'var(--muted)', l.monday?.group_order ?? 99];
    for (const l of [...ls].sort((a, b) => (bucket(a)[2] - bucket(b)[2]) || ((a.monday?.item_order ?? 999) - (b.monday?.item_order ?? 999)))) {
      const [g, gc] = bucket(l);
      if (!groups.has(g)) groups.set(g, { color: gc, leads: [] });
      groups.get(g).leads.push(l);
    }
    wrap.replaceChildren(...(groups.size ? [...groups].map(([g, { color, leads }]) => { const box = h('div', { class: 'card wide-scroll', style: { borderLeft: `4px solid ${color}` } }); const slide = (d) => box.scrollBy({ left: d * box.clientWidth * 0.7, behavior: 'smooth' }); return h('div', { style: { marginBottom: '28px' } },
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '14px', margin: '0 0 10px' } }, h('h3', { style: { color, margin: 0 } }, g), h('span', { class: 'small muted' }, `${leads.length} propert${leads.length > 1 ? 'ies' : 'y'}`),
        h('span', { style: { marginLeft: 'auto' } }, groupMap(leads, color))),   // area map on the right; More columns buttons removed 9/30 (the scrollbar stays)
      (box.append(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Property'), h('th', { style: { whiteSpace: 'nowrap' } }, 'Date added'), h('th', {}, 'Hot / cold'), MONDAY_COLS.map(c => h('th', { style: { whiteSpace: 'nowrap' } }, c)))),
        h('tbody', {}, leads.map(l => h('tr', { class: l.declined_at ? 'handed-off-row declined-row' : l.handed_off_at ? 'handed-off-row' : '', onclick: () => navigate(`/lead/${l.id}`) },
          h('td', { style: { minWidth: '200px' } }, h('div', { class: 'lead-name' }, l.name, isNewListing(l) ? h('span', { class: 'new-listing' }, 'New listing') : null), h('div', { class: 'lead-loc' }, l.ref)),
          h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, fmt.date(dateAdded(l))),
          h('td', { style: { minWidth: '110px' } }, h('span', { class: `temp ${l.temperature}` }, l.temperature), h('div', { style: { marginTop: '6px' } }, heatBar(l))),
          MONDAY_COLS.map(c => mondayCell(l, c)),
        ))))), box)); })
      : [h('div', { class: 'empty' }, h('h3', {}, 'No matches'), 'Clear the search or add a lead.')]));
  }
  draw();
}


// ---------- Stage moves (used by the lead page; the Board page that also used them was removed 9/30)
async function moveStage(lead, stageKey, extra = {}) {
  try { await api(`/api/leads/${lead.id}`, { method: 'PATCH', body: { stage: stageKey, ...extra } }); await refreshLeads(); toast(`${lead.name} → ${stageLabel(stageKey)}`); render(); }
  catch (err) {
    if (err.status === 409 && err.data?.missing) {
      gateModal(lead, stageKey, err.data);
    } else if (err.status === 409 && err.data?.needs_registration) {
      const f = { why: '' };
      modal('Register before advancing', err.message, h('div', {}, h('p', { class: 'small' }, 'HI is paid only on registered deals. Register now, or record why this one is not being registered.'), h('div', { class: 'field' }, h('label', {}, 'Not registering because'), h('input', { onchange: (e) => f.why = e.target.value }))), (close) => [
        h('button', { class: 'btn', onclick: async () => { if (!f.why) return toast('Give a reason or register', true); close(); await moveStage(lead, stageKey, { gates: { ...(lead.gates || {}), not_registering_because: f.why } }); } }, 'Record reason and move'),
        h('button', { class: 'btn hot', onclick: () => { close(); registerModal(lead); } }, 'Register deal'),
      ]);
    } else if (err.status === 409) toast(err.message, true);
    else toast(err.message, true);
  }
}
function gateModal(lead, stageKey, info) {
  const gates = { ...(lead.gates || {}) };
  const missing = info.missing.map(k => stageObj(k));
  const body = h('div', {}, h('p', { class: 'small' }, 'A lead moves forward on what the counterparty did, not on our optimism. Tick what has actually happened:'), missing.map(s => h('label', { class: 'gate-row' }, h('input', { type: 'checkbox', onchange: (e) => gates[s.key] = e.target.checked }), h('span', {}, h('b', {}, s.label, ': '), s.gate))));
  modal(`Move to ${stageLabel(stageKey)}?`, info.error, body, (close) => [
    h('button', { class: 'btn ghost', onclick: async () => { close(); await moveStage(lead, stageKey, { override_gate: true, gates }); } }, 'Override anyway'),
    h('button', { class: 'btn primary', onclick: async () => { close(); await moveStage(lead, stageKey, { gates }); } }, 'Save gates and move'),
  ]);
}

// ---------- Map
function viewMap(main) {
  // 9/30 Austin: every legend item toggles its markers on and off (remembered while the app is open)
  const on = state.mapLayers || (state.mapLayers = { areas: true, hot: true, warm: true, cold: true, open: true, closed: true, lucia: true, concepts: true });
  if (on.areas === undefined) on.areas = true;
  const items = [['areas', 'Search areas', { background: 'rgba(233,77,140,.25)', border: '2px dashed #e94d8c' }], ['hot', 'hot', { background: tempColor.hot }], ['warm', 'warm', { background: tempColor.warm }], ['cold', 'cold', { background: tempColor.cold }],
    ['open', 'Nikki Beach open / announced', { background: '#16151f', borderRadius: '2px' }], ['closed', 'Nikki Beach closed', { background: '#fff', border: '2px solid #16151f', borderRadius: '2px' }], ['lucia', 'Lucia', { background: '#e9a23b', borderRadius: '2px' }], ['concepts', 'Cocktail Club / Maison Mer', { background: '#2f8596', borderRadius: '2px' }]];
  const layers = {};
  const legend = h('div', { class: 'map-legend', style: { justifyContent: 'center' } }, items.map(([k, label, sw]) => h('button', { class: `legend-toggle${on[k] ? ' on' : ''}`, 'data-keep': '1', 'aria-pressed': String(on[k]), onclick: (e) => {
    on[k] = !on[k]; e.currentTarget.classList.toggle('on', on[k]); e.currentTarget.setAttribute('aria-pressed', String(on[k]));
    if (map) on[k] ? layers[k].addTo(map) : layers[k].remove();
  } }, h('i', { style: sw }), label)));
  let dropping = false;
  const dropBtn = h('button', { class: 'btn primary', 'data-keep': '1', onclick: () => setDropping(!dropping) }, '+ Drop a pin');
  const hint = h('div', { class: 'map-hint', style: { display: 'none' } }, 'Click the map where you want someone to look. Then drag the white dot on the edge to make the circle bigger or smaller.');
  main.append(topbar('Map', 'Candidate sites against the existing Nikki Beach footprint. Drop a pin to mark an area to search. Click a legend item to show or hide it.', dropBtn), legend, hint);
  const el = h('div', { class: 'map' });
  main.append(el);
  if (typeof L === 'undefined') { el.append(h('div', { class: 'empty' }, 'Map library did not load.')); return; }
  const map = L.map(el, { worldCopyJump: true }).setView([25, 5], 2);
  if (state.mapFocus) { const f = state.mapFocus; state.mapFocus = null; setTimeout(() => { map.invalidateSize(); f.length > 1 ? map.fitBounds(f, { padding: [60, 60], maxZoom: 15 }) : map.setView(f[0], 14); }, 80); }
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18 }).addTo(map);
  for (const [k] of items) layers[k] = L.layerGroup();
  const icon = (cls) => L.divIcon({ className: '', html: `<div class="marker ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  for (const f of state.footprint) if (f.lat && f.lng) { const k = /^Lucia\b/.test(f.name) ? 'lucia' : /Cocktail Club|Maison Mer/.test(f.name) ? 'concepts' : f.status === 'closed' ? 'closed' : 'open'; L.marker([f.lat, f.lng], { icon: icon(`fp ${k === 'open' ? '' : k}`), zIndexOffset: k === 'lucia' || k === 'concepts' ? 300 : 0 }).addTo(layers[k]).bindPopup(`<b>${escapeHtml(f.name)}</b><br>${escapeHtml(f.country || '')} · ${escapeHtml(fmt.title(f.format))} · ${escapeHtml(f.status)}${f.opened ? ` · ${f.opened}${f.closed ? `–${f.closed}` : ''}` : ''}${f.outcome ? `<br><span style="color:#6a6a6a">${escapeHtml(f.outcome)}</span>` : ''}`) }

  for (const l of state.leads) if (l.lat && l.lng && l.status === 'active' && layers[l.temperature]) L.marker([l.lat, l.lng], { icon: icon(l.temperature), zIndexOffset: 500 }).addTo(layers[l.temperature]).bindPopup(`<b>${escapeHtml(l.name)}</b><br>${escapeHtml(l.address || l.country || '')}<br><a href="#/lead/${l.id}">Open lead →</a>`);
  for (const [k] of items) if (on[k]) layers[k].addTo(map);
  setTimeout(() => map.invalidateSize(), 50);

  // ---- Search areas (Austin 10/5): drop a pin, drag the edge dot to set the radius, name it and assign it.
  function setDropping(v) {
    dropping = v; dropBtn.textContent = v ? 'Cancel' : '+ Drop a pin'; dropBtn.classList.toggle('primary', !v);
    hint.style.display = v ? '' : 'none'; el.classList.toggle('dropping', v);
    if (v && !on.areas) { on.areas = true; layers.areas.addTo(map); legend.querySelector('.legend-toggle').classList.add('on'); }
  }
  map.on('click', async (e) => {
    if (!dropping) return;
    setDropping(false);
    const zoomedOut = map.getZoom() < 9;   // dropped from the world view: zoom in to the pin and start with a 3 km circle
    const b = map.getBounds(); const radius = zoomedOut ? 3000 : Math.round(Math.max(150, Math.min(50000, b.getNorthEast().distanceTo(b.getSouthWest()) / 12)));
    if (zoomedOut) map.setView(e.latlng, 12);
    try { const a = await api('/api/areas', { method: 'POST', body: { lat: e.latlng.lat, lng: e.latlng.lng, radius_m: radius } }); state.areas.push(a); const d = drawArea(a); d.pin.openPopup(); renderAreaList(); }
    catch (err) { toast(err.message, true); }
  });
  const kmLabel = (m) => m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km (${(m / 1609.34).toFixed(m >= 16093 ? 0 : 1)} mi)` : `${Math.round(m)} m`;
  const drawn = new Map();
  const pinIcon = L.divIcon({ className: '', html: '<div class="area-pin"></div>', iconSize: [22, 30], iconAnchor: [11, 29], popupAnchor: [0, -26] });
  const handleIcon = L.divIcon({ className: '', html: '<div class="area-handle" title="Drag to resize"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  const edgeOf = (c, r) => { const lat = c.lat * Math.PI / 180; return L.latLng(c.lat, c.lng + (r / (111320 * Math.cos(lat)))); };
  function drawArea(a) {
    const center = L.latLng(a.lat, a.lng);
    const circle = L.circle(center, { radius: a.radius_m, color: '#e94d8c', weight: 2, dashArray: '6 6', fillColor: '#e94d8c', fillOpacity: 0.12, interactive: false }).addTo(layers.areas);
    const pin = L.marker(center, { icon: pinIcon, draggable: true, zIndexOffset: 800, autoPan: true }).addTo(layers.areas);
    const handle = L.marker(edgeOf(center, a.radius_m), { icon: handleIcon, draggable: true, zIndexOffset: 900 }).addTo(layers.areas);
    const tip = () => handle.bindTooltip(kmLabel(a.radius_m), { permanent: false, direction: 'right' });
    tip();
    pin.on('drag', () => { const c = pin.getLatLng(); circle.setLatLng(c); handle.setLatLng(edgeOf(c, a.radius_m)); });
    pin.on('dragend', () => { const c = pin.getLatLng(); a.lat = c.lat; a.lng = c.lng; save(a, { lat: a.lat, lng: a.lng }); pin.openPopup(); });   // Austin 10/5: details pop back up once the pin lands
    handle.on('drag', () => { a.radius_m = Math.min(200000, Math.max(50, pin.getLatLng().distanceTo(handle.getLatLng()))); circle.setRadius(a.radius_m); handle.setTooltipContent(kmLabel(a.radius_m)); handle.openTooltip(); });
    handle.on('dragend', () => { handle.setLatLng(edgeOf(pin.getLatLng(), a.radius_m)); save(a, { radius_m: Math.round(a.radius_m) }); });
    pin.bindPopup(() => areaPopup(a), { minWidth: 260 });
    const d = { circle, pin, handle }; drawn.set(a.id, d); return d;
  }
  async function save(a, patch) { try { Object.assign(a, await api(`/api/areas/${a.id}`, { method: 'PATCH', body: patch })); renderAreaList(); } catch (err) { toast(err.message, true); } }
  function areaPopup(a) {
    const f = { name: a.name || '', assigned_to: a.assigned_to || '', notes: a.notes || '' };
    const users = state.config?.users || [];
    return h('div', { class: 'area-pop' },
      h('div', { class: 'field' }, h('label', {}, 'Name'), h('input', { value: f.name, oninput: (e) => f.name = e.target.value, placeholder: 'e.g. Sunny Isles beachfront' })),
      h('div', { class: 'field' }, h('label', {}, 'Who should look'), h('input', { value: f.assigned_to, list: 'area-users', oninput: (e) => f.assigned_to = e.target.value, placeholder: 'employee or broker' }), h('datalist', { id: 'area-users' }, users.map(u => h('option', { value: u })))),
      h('div', { class: 'field' }, h('label', {}, 'What to look for'), h('textarea', { rows: 3, oninput: (e) => f.notes = e.target.value }, f.notes)),
      h('div', { class: 'small muted', style: { margin: '2px 0 10px' } }, `Radius ${kmLabel(a.radius_m)} · drag the white dot to change it`),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', onclick: async () => { await save(a, f); drawn.get(a.id)?.pin.closePopup(); toast('Saved'); } }, 'Save'),
        h('button', { class: 'btn sm', onclick: async () => { try { await save(a, f); const lead = await api('/api/leads', { method: 'POST', body: { name: f.name || 'New site', lat: a.lat, lng: a.lng, summary: f.notes || '' } }); await refreshLeads(); toast('Lead created'); navigate(`/lead/${lead.id}`); } catch (err) { toast(err.message, true); } } }, 'Make it a lead'),
        h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!confirm('Delete this search area?')) return; await api(`/api/areas/${a.id}`, { method: 'DELETE' }); const d = drawn.get(a.id); if (d) { layers.areas.removeLayer(d.circle); layers.areas.removeLayer(d.pin); layers.areas.removeLayer(d.handle); drawn.delete(a.id); } state.areas = state.areas.filter(x => x.id !== a.id); renderAreaList(); } }, 'Delete')));
  }
  const areaList = h('div', { class: 'card pad area-list' });
  function renderAreaList() {
    const list = state.areas || [];
    areaList.replaceChildren(h('div', { class: 'eyebrow', style: { marginBottom: '8px' } }, list.length ? `Search areas · ${list.length}` : 'Search areas'),
      list.length ? h('table', { class: 'table' }, h('tbody', {}, list.map(a => h('tr', { onclick: () => { const d = drawn.get(a.id); map.fitBounds(d.circle.getBounds(), { padding: [40, 40] }); d.pin.openPopup(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
        h('td', {}, h('div', { class: 'lead-name' }, a.name || 'New search area'), h('div', { class: 'lead-loc' }, a.notes || '')), h('td', {}, a.assigned_to || h('span', { class: 'muted' }, 'nobody yet')), h('td', { style: { whiteSpace: 'nowrap' } }, kmLabel(a.radius_m)))))) : h('div', { class: 'small muted' }, 'None yet. Press "+ Drop a pin" above the map, then click where you want someone to look.'));
  }
  main.append(areaList);
  (async () => { try { state.areas = await api('/api/areas'); } catch { state.areas = []; } for (const a of state.areas) drawArea(a); renderAreaList(); })();
  footprintBelowMap(main);
}

// 9/30 Austin: the Footprint page folded in under the map. Counts first, then every location, earliest first.
function footprintBelowMap(main) {
  const fp = state.footprint;
  const opened = fp.filter(f => f.status !== 'announced'), closed = fp.filter(f => f.status === 'closed'), coming = fp.filter(f => f.status === 'announced');
  const stat = (n, label) => h('div', { class: 'fp-stat' }, h('div', { class: 'v' }, n), h('div', { class: 'small muted' }, label));
  main.append(h('div', { class: 'fp-stats' }, stat(opened.length, 'Opened Since 1998 (All Time)'), stat(closed.length, 'Closed'), stat(opened.length - closed.length, 'Operating'), stat(coming.length, 'Announced, Not Open Yet')));
  // 9/30 Austin: sortable by any column (click a header); Status sorts Operating, then Announced, then Closed
  const sort = state.fpSort || (state.fpSort = { key: 'opened', dir: 1 });
  const years = (f) => f.opened ? `${f.opened}–${f.closed ?? (f.status === 'closed' ? '?' : 'now')}` : (f.status === 'announced' ? 'announced' : f.status === 'closed' ? 'closed, dates unknown' : '');
  const cols = [['name', 'Location', f => f.name], ['opened', 'Years', f => f.opened ?? 9999], ['status', 'Status', f => ({ open: 0, pop_up: 0, seasonal: 0, announced: 1, closed: 2 }[f.status] ?? 3)], ['country', 'Country', f => f.country || ''], ['format', 'Format', f => formatLabel(f.format)], ['structure', 'Structure', f => f.structure || ''], ['outcome', 'What happened', f => f.outcome || f.notes || '']];
  const wrap = h('div', { class: 'card fp-table' });
  const draw = () => {
    const get = cols.find(c => c[0] === sort.key)[2];
    const rows = [...fp].sort((a, b) => { const va = get(a), vb = get(b); if (sort.key === 'opened' && (va === 9999) !== (vb === 9999)) return va === 9999 ? 1 : -1; return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir || (a.opened ?? 9999) - (b.opened ?? 9999); });
    wrap.replaceChildren(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, cols.map(([k, label]) => h('th', { class: sort.key === k ? 'sorted' : '', 'data-keep': '1', onclick: () => { sort.dir = sort.key === k ? -sort.dir : 1; sort.key = k; draw(); } }, label, sort.key === k ? (sort.dir > 0 ? ' ↑' : ' ↓') : '')))),
      h('tbody', {}, rows.map(f => h('tr', { style: { cursor: 'default' } },
        h('td', {}, h('div', { class: 'lead-name' }, f.name)),
        h('td', { style: { whiteSpace: 'nowrap' } }, years(f)), h('td', {}, h('span', { class: `pill ${f.status === 'closed' ? 'bad' : f.status === 'announced' ? 'warn' : 'ok'}`, style: { whiteSpace: 'nowrap' } }, f.status === 'closed' ? 'Closed' : f.status === 'announced' ? 'Announced' : 'Operating')), h('td', {}, f.country || ''),
        h('td', {}, formatLabel(f.format)), h('td', {}, f.structure || ''), h('td', {}, f.outcome || f.notes || ''))))));
  };
  draw();
  main.append(wrap);
}

// ---------- Markets
function viewMarkets(main) {
  const markets = Object.entries(state.config.markets).sort((a, b) => (b[1].fit ?? 0) - (a[1].fit ?? 0));
  main.append(topbar('Markets', 'Where Nikki Beach is best suited, ranked by fit with the survivor profile. Each market seeds the "Market & season" criterion.'));
  const byRegion = {};
  for (const l of state.leads.filter(l => l.status === 'active')) (byRegion[l.region] = byRegion[l.region] || []).push(l);
  main.append(h('div', { class: 'card pad' }, markets.map(([k, m]) => h('div', { class: 'market' },
    h('div', {}, h('span', { class: 'name' }, m.label), h('span', { class: 'muted small' }, ` · ${(m.preferred_format || []).map(formatLabel).join(' / ')}${m.season ? ` · ${m.season}` : ''}`)),
    h('div', { class: 'fitbar', title: `Fit ${m.fit}/5` }, [1, 2, 3, 4, 5].map(i => h('i', { class: i <= (m.fit ?? 0) ? 'on' : '' }))),
    h('div', { class: 'why' }, m.why || ''),
    h('div', { class: 'tags' }, (m.watch || []).map(t => h('span', { class: 'pill' }, t)), byRegion[k]?.length ? h('a', { class: 'pill ok', href: '#/', onclick: () => { state.filters.region = k; } }, `${byRegion[k].length} in pipeline`) : h('span', { class: 'pill warn' }, 'no leads yet')),
  ))));
}

// ---------- People
function viewPeople(main) {
  // 9/30 Austin: laid out like the Overview, one full-width list per group; click a row for the detail card (Edit bottom left)
  main.append(topbar('People', 'Everyone tied to the properties, and the companies behind them.', h('button', { class: 'btn', 'data-keep': '1', onclick: () => orgModal() }, '+ Organisation'), h('button', { class: 'btn primary', 'data-keep': '1', onclick: () => contactModal() }, '+ Contact')));
  const propsFor = (pred) => state.leads.filter(pred).map(l => h('a', { href: `#/lead/${l.id}`, class: 'pill', style: { marginRight: '4px', whiteSpace: 'nowrap' }, onclick: (e) => e.stopPropagation() }, l.name));
  const linkOrMuted = (v, href) => v ? h('a', { href, onclick: (e) => e.stopPropagation() }, v) : '';
  const clip = (t, n = 120) => t && t.length > n ? t.slice(0, n) + '…' : (t || '');
  const section = (title, count, color, head, rows) => h('div', { style: { marginBottom: '28px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 10px' } }, h('h3', { style: { color, margin: 0 } }, title), h('span', { class: 'small muted' }, `${count}`)),
    h('div', { class: 'card wide-scroll', style: { borderLeft: `4px solid ${color}` } }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, head.map(x => h('th', { style: { whiteSpace: 'nowrap' } }, x)))), h('tbody', {}, rows))));
  const people = [...state.contacts].sort((a, b) => a.name.localeCompare(b.name));
  const orgs = [...state.orgs].sort((a, b) => a.name.localeCompare(b.name));
  main.append(
    section('People', people.length, 'var(--link)', ['Name', 'Title', 'Company', 'Phone', 'Email', 'Properties', 'Notes'], people.map(c => h('tr', { onclick: () => contactModal(c) },
      h('td', { style: { minWidth: '180px' } }, h('div', { class: 'lead-name' }, c.name)),
      h('td', { class: 'small' }, c.title || ''), h('td', { class: 'small', style: { minWidth: '160px' } }, c.org_name || ''),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, linkOrMuted(c.phone, `tel:${c.phone}`)), h('td', { class: 'small' }, linkOrMuted(c.email, `mailto:${c.email}`)),
      h('td', {}, propsFor(l => (l.contact_ids || []).includes(c.id))),
      h('td', { class: 'small', style: { minWidth: '260px', maxWidth: '380px' }, title: c.notes || '' }, clip((c.notes || '').split('\nMonday:')[0]))))),
    section('Organisations', orgs.length, 'var(--warm)', ['Name', 'Type', 'Country', 'Website', 'Properties', 'Portfolio'], orgs.map(o => h('tr', { onclick: () => orgModal(o) },
      h('td', { style: { minWidth: '180px' } }, h('div', { class: 'lead-name' }, o.name)),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, fmt.title(o.kind)), h('td', { class: 'small' }, o.country || ''),
      h('td', { class: 'small' }, o.website ? h('a', { href: /^https?:/.test(o.website) ? o.website : `https://${o.website}`, target: '_blank', onclick: (e) => e.stopPropagation() }, o.website.replace(/^https?:\/\//, '')) : ''),
      h('td', {}, propsFor(l => (l.orgs || []).some(x => x.id === o.id))),
      h('td', { class: 'small', style: { minWidth: '260px', maxWidth: '380px' }, title: o.portfolio || '' }, clip(o.portfolio))))));
}

// ---------- Footprint
function viewFootprint(main) {
  const open = state.footprint.filter(f => f.status !== 'closed'), closed = state.footprint.filter(f => f.status === 'closed');
  main.append(topbar('Footprint', `${open.length} Nikki Beach locations open, announced or recurring · ${closed.length} closed. The closures are the scorecard.`));
  const tbl = (rows) => h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Location', 'Format', 'Years', 'Structure', 'Outcome'].map(x => h('th', {}, x)))), h('tbody', {}, rows.map(f => h('tr', { style: { cursor: 'default' } }, h('td', {}, h('div', { class: 'lead-name' }, f.name), h('div', { class: 'lead-loc' }, f.country)), h('td', { class: 'small' }, formatLabel(f.format)), h('td', { class: 'small mono' }, f.opened ? `${f.opened}${f.closed ? `–${f.closed}` : '–'}` : (f.status === 'announced' ? 'announced' : '')), h('td', { class: 'small' }, f.structure || ''), h('td', { class: 'small' }, f.outcome || f.notes || '')))));
  main.append(h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-head' }, h('h3', {}, 'Open, announced, recurring')), tbl(open)), h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Closed, exited, never opened')), tbl(closed)));
}

// ---------- Weekly review
async function viewReview(main) {
  const d = await api('/api/dashboard');
  const active = state.leads.filter(l => l.status === 'active');
  const week = Date.now() - 7 * 86400000;
  const moved = active.filter(l => Date.parse(l.updated_at) > week);
  const hot = active.filter(l => l.temperature === 'hot').sort((a, b) => b.priority - a.priority);
  const tier1 = active.filter(l => l.tier === 1).sort((a, b) => b.priority - a.priority);
  const rotting = active.filter(l => l.score.rotten).sort((a, b) => b.score.idleDays - a.score.idleDays);
  const unreg = active.filter(l => ['A', 'B'].includes(l.grade[0]) && l.stage !== 'identified' && !l.registered);
  const deep = [...new Set([...rotting.slice(0, 2), ...active.filter(l => !l.next_action).slice(0, 2), ...tier1.slice(0, 2)])].slice(0, 5);
  main.append(topbar('Weekly review', `Week ending ${fmt.date(new Date())}. Thirty minutes, fixed agenda. Print it for the Monday call.`, h('button', { class: 'btn', onclick: () => window.print() }, 'Print'), h('a', { class: 'btn', href: '/api/export/pipeline.csv' }, 'CSV')));
  const block = (title, rows, extra) => h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-head' }, h('h3', {}, title), h('span', { class: 'pill' }, rows.length)), rows.length ? h('table', { class: 'table' }, h('tbody', {}, rows.map(l => leadRow(l, extra(l))))) : h('div', { class: 'empty small' }, 'Nothing.'));
  main.append(
    h('div', { class: 'grid cols-4', style: { marginBottom: '16px' } }, stat('Active', active.length, 'opportunities'), stat('Tier 1', tier1.length, 'bespoke pursuit'), stat('Moved this week', moved.length, 'touched in 7 days'), stat('Weighted HI fee', fmt.money(d.totals.weighted) || '$0', 'expected fee × probability')),
    block('1. Deep dives (auto-picked: rotting, no next step, Tier 1)', deep, l => l.score.rotten ? `${l.score.idleDays}d without inbound` : (l.next_action || h('span', { class: 'pill warn' }, 'no next action'))),
    block('2. Hot: they are engaging', hot, l => l.next_action ? `${l.next_action}${l.next_action_due ? ` · ${fmt.date(l.next_action_due)}` : ''}` : h('span', { class: 'pill warn' }, 'no next action')),
    block('3. Commission risk: A/B fit past Identified and not registered with Penrod', unreg, () => h('span', { class: 'pill bad' }, 'register now')),
    block('4. Rotting', rotting, l => `${l.score.idleDays}d idle · limit ${l.score.heat.rotDays}d`),
    block('5. Moved this week', moved, l => fmt.ago(l.updated_at)),
  );
}

// ---------- Playbook
function viewPlaybook(main) {
  const card = state.config.scorecard, heat = state.config.heat, eco = state.config.economics;
  main.append(topbar('Playbook', 'How a lead is scored, what kills it, what each stage demands, and how HI gets paid.'));
  main.append(h('div', { class: 'grid cols-2' },
    h('div', {},
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h2', {}, 'Knock-outs'), h('p', { class: 'muted small' }, 'Fail any one and the site is cold whatever else it scores. Fixable (a written fix the counterparty must agree to) caps it at warm. Unverified caps the fit at B and blocks Qualified. Each one is a Nikki Beach property that died of it.'), card.knockouts.map(k => h('div', { class: 'ko-card' }, h('b', {}, k.label), h('div', { class: 'small' }, k.test), h('div', { class: 'small muted' }, 'Precedent: ', k.precedent)))),
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h2', {}, 'Scorecard (composite 0–100)'), h('p', { class: 'muted small' }, `Sixteen criteria, each 0–5, in three groups: brand fit (50), deal readiness (35), relationship (15). The fit letter comes from brand fit + deal readiness: A ≥ ${card.fit_grades.A}%, B ≥ ${card.fit_grades.B}%, else C. HOT needs every knock-out passed, composite ≥ ${card.temperature.hot.composite_min}, heat ≥ ${card.temperature.hot.heat_min} and a reply from the counterparty. Untouched ${card.temperature.decay.drop_band_after_days} days drops a band; ${card.temperature.decay.cold_after_days} days is cold; ${card.temperature.decay.dead_after_days_early_stage} days at an early stage is dead. Calibrated against the record: every survivor lands hot or warm, every casualty cold or knocked out.`),
        Object.entries(card.groups).map(([gk, g]) => h('div', { class: 'section' }, h('h3', {}, g.label, h('span', { class: 'mono muted' }, `${g.max} pts`)),
          card.criteria.filter(c => c.group === gk).map(c => h('div', { class: 'crit' }, h('div', {}, h('div', { class: 'l' }, c.label), h('div', { class: 'small muted' }, c.why || '')), h('div', { class: 'w' }, `${c.weight}`), h('div', { class: 'r' }, Object.entries(c.rubric || {}).sort((a, b) => b[0] - a[0]).map(([k, v]) => h('div', {}, h('b', {}, `${k}: `), v)))))))),
      h('div', { class: 'card pad' }, h('h2', {}, 'HI economics and registration'), h('p', { class: 'small' }, `Expected fee per deal = ${fmt.money(eco.closing_fee_usd)} closing fee + ${eco.trailing_pct_of_gross * 100}% of property gross revenue for ${eco.trailing_months} months. Weighted pipeline = expected fee × stage probability. Registration protection runs ${eco.protection_months} months from submission, renewable in ${eco.protection_renewal_months}-month increments on evidence of activity, with a ${eco.tail_months}-month tail. A lead with fit A or B cannot leave Researched until it is registered or a reason is recorded.`), h('p', { class: 'small muted' }, eco.note)),
    ),
    h('div', {},
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h2', {}, 'Heat (0–100)'), h('p', { class: 'muted small' }, `Engagement with a ${heat.half_life_days}-day half-life. Their reply warms a lead; our email barely does (outbound capped at ${heat.outbound_cap}). Hot ≥ ${card.heat_bands.hot}, warm ≥ ${card.heat_bands.warm}, cooling ≥ ${card.heat_bands.cooling}. A scheduled next action suspends rotting; only inbound resets it.`),
        h('table', { class: 'table' }, h('tbody', {}, Object.entries(heat.events).filter(([, e]) => e.points > 0).sort((a, b) => b[1].points - a[1].points).map(([k, e]) => h('tr', { style: { cursor: 'default' } }, h('td', {}, e.label), h('td', { class: 'small muted' }, e.direction), h('td', { class: 'mono', style: { textAlign: 'right' } }, `+${e.points}`)))))),
      h('div', { class: 'card pad' }, h('h2', {}, 'Stages and gates'), h('p', { class: 'muted small' }, 'A lead advances on what the counterparty did. The gate is a checkbox on the lead; the board refuses to move a card past an unticked gate unless you override. Nothing passes Qualified with a red qualification light; IC approval allows at most two yellows.'),
        state.config.stages.map(s => h('div', { class: 'section' }, h('h3', {}, s.label, h('span', { class: 'mono muted' }, `${Math.round(s.probability * 100)}% · rots after ${heat.rot_days[s.key] ?? 30}d`)), h('dl', { class: 'kv' }, h('dt', {}, 'Enter when'), h('dd', {}, s.entry), h('dt', {}, 'Gate to leave'), h('dd', {}, s.gate), h('dt', {}, 'Default next action'), h('dd', {}, s.next))))),
    ),
  ));
}

// ---------- Lead detail
// Property photos from the Monday Images column (Austin 9/30): small carousel above the map, click for a big flip-through.
function photoCard(lead) {
  const imgs = (lead.monday?.images || []).map(apiUrl);
  const card = h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, imgs.length > 1 ? `Images · ${imgs.length}` : 'Images'));
  if (!imgs.length) { card.append(h('div', { class: 'small muted' }, 'No photos on the Monday board yet.')); return card; }
  let i = 0;
  imgs.forEach(src => { const p = new Image(); p.decoding = 'async'; p.src = src; });   // warm every photo so the arrows are instant
  const img = h('img', { src: imgs[0], alt: lead.name, style: { width: '100%', height: '200px', objectFit: 'cover', display: 'block', cursor: 'zoom-in' }, onclick: () => lightbox(imgs, i, lead.name) });
  const count = h('div', { class: 'photo-count' }, `1 / ${imgs.length}`);
  const go = (d) => { i = (i + d + imgs.length) % imgs.length; img.src = imgs[i]; count.textContent = `${i + 1} / ${imgs.length}`; };
  card.append(h('div', { class: 'photo-box' }, img,
    imgs.length > 1 ? [h('button', { class: 'photo-arrow left', 'data-keep': '1', 'aria-label': 'Previous photo', onclick: () => go(-1) }, '‹'), h('button', { class: 'photo-arrow right', 'data-keep': '1', 'aria-label': 'Next photo', onclick: () => go(1) }, '›'), count] : null));
  return card;
}
function lightbox(imgs, start, title) {
  let i = start;
  const img = h('img', { src: imgs[i], alt: title });
  const count = h('div', { class: 'lb-count' }, `${i + 1} / ${imgs.length}`);
  const go = (d) => { i = (i + d + imgs.length) % imgs.length; img.src = imgs[i]; count.textContent = `${i + 1} / ${imgs.length}`; };
  const close = () => { lb.remove(); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  const lb = h('div', { class: 'lightbox', onclick: (e) => { if (e.target === lb) close(); } }, img,
    h('button', { class: 'lb-close', 'aria-label': 'Close', onclick: close }, '×'),
    imgs.length > 1 ? [h('button', { class: 'lb-arrow left', 'aria-label': 'Previous photo', onclick: () => go(-1) }, '‹'), h('button', { class: 'lb-arrow right', 'aria-label': 'Next photo', onclick: () => go(1) }, '›'), count] : null);
  document.addEventListener('keydown', key);
  document.body.append(lb);
}
// Client documents on every property page (Peter 10/1): view, download, upload more. Uploads respect the edit lock.
const DOC_KINDS = [['teaser', 'Teaser / IM'], ['nda', 'NDA'], ['loi', 'LOI / term sheet'], ['hma_draft', 'HMA draft'], ['feasibility', 'Feasibility / market study'], ['site_plan', 'Site plan / survey'], ['photos', 'Photos / drone'], ['title', 'Title / tenure'], ['licence', 'Licences'], ['ic_memo', 'IC memo'], ['other', 'Other']];
function docActions(d) {
  if (!d.url) return [];
  const uploaded = d.url.startsWith('/api/uploads/');
  return [h('a', { class: 'btn sm', href: d.url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, uploaded ? 'View' : 'Open'),
    uploaded ? h('a', { class: 'btn sm', href: `${d.url}?download=1`, download: d.title, onclick: (e) => e.stopPropagation() }, 'Download') : null];
}
function uploadDoc(lead, kind, reload) {
  const file = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      for (const f of files) { const r = await fetch(`/api/leads/${lead.id}/documents/upload?filename=${encodeURIComponent(f.name)}&kind=${kind()}`, { method: 'PUT', body: f }); if (!r.ok) throw new Error(`Upload failed: ${f.name}`); }
      toast(files.length > 1 ? `Uploaded ${files.length} documents` : 'Uploaded'); reload();
    } catch (err) { toast(err.message, true); }
  } });
  return file;
}
function docsCard(lead, reload) {
  const file = uploadDoc(lead, () => 'other', reload);
  const card = h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, lead.documents.length ? `Documents · ${lead.documents.length}` : 'Documents'));
  if (lead.documents.length) card.append(...lead.documents.map(d => h('div', { class: 'doc-row' },
    h('div', { class: 'doc-name' }, h('div', { class: 'lead-name', title: d.title }, d.title), h('div', { class: 'small muted' }, `${fmt.title(d.kind)}${d.size ? ` · ${(d.size / 1e6).toFixed(1)} MB` : ''} · ${fmt.date(d.at)}`)),
    h('div', { class: 'btn-row' }, docActions(d)))));
  else card.append(h('div', { class: 'small muted' }, 'No documents yet.'));
  card.append(h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: () => file.click() }, 'Upload document'), file,
    state.editing ? null : h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Click Edit lead to upload.')));
  return card;
}
// Small location map on the lead page (Austin 9/30). Pin comes from Peter's Monday Address column.
function miniMap(lead) {
  const card = h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Location'));
  if (!lead.lat || !lead.lng || typeof L === 'undefined') { card.append(h('div', { class: 'small muted' }, lead.address ? `No map pin yet for ${lead.address}` : 'No address yet. Add it on the Monday board.')); return card; }
  const el = h('div', { style: { height: '200px', borderRadius: '10px', overflow: 'hidden' } });
  card.append(el, lead.address ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, h('a', { href: `https://www.google.com/maps/search/?api=1&query=${lead.lat},${lead.lng}`, target: '_blank' }, lead.address)) : null);
  setTimeout(() => {
    const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([lead.lat, lead.lng], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    L.marker([lead.lat, lead.lng], { icon: L.divIcon({ className: '', html: `<div class="marker ${lead.temperature}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
    map.invalidateSize();
  }, 60);
  return card;
}

async function viewLead(main, id, tab) {
  let lead;
  try { lead = await api(`/api/leads/${id}`); } catch { main.append(h('div', { class: 'empty' }, 'Lead not found.')); return; }
  const reload = () => { const y = window.scrollY; main.replaceChildren(); viewLead(main, id, tab).then(() => window.scrollTo(0, y)); };
  const save = async (patch, quiet = false) => {
    try { lead = await api(`/api/leads/${id}`, { method: 'PATCH', body: patch }); await refreshLeads(); if (!quiet) toast('Saved'); return lead; }
    catch (e) { if (e.status === 409 && e.data?.missing) gateModal(lead, patch.stage, e.data); else toast(e.message, true); throw e; }
  };
  const st = stageObj(lead.stage);
  const head = h('div', { class: 'detail-head' }, ring(lead, true), h('div', { style: { flex: 1 } },
    h('div', { class: 'eyebrow' }, `${lead.ref} · ${formatLabel(lead.format)} · ${[lead.city, lead.country].filter(Boolean).join(', ')} · Tier ${lead.tier}`),
    h('h1', {}, lead.name),
    h('div', { class: 'meta' }, gradeChip(lead), h('span', { class: `temp ${lead.temperature}`, title: lead.temperature_reason }, lead.temperature), h('span', { class: 'pill' }, `${stageLabel(lead.stage)} · ${lead.days_in_stage}d`), lead.registered ? h('span', { class: 'pill ok' }, `Registered ${fmt.date(lead.registered_at)}`)  : null, lead.status !== 'active' ? h('span', { class: 'pill bad' }, lead.status) : null, lead.score.knockouts.map(k => h('span', { class: 'pill bad', title: k.precedent }, `KO: ${k.label}`)), lead.score.fit.unknown_knockouts.length ? h('span', { class: 'pill warn', title: lead.score.fit.unknown_knockouts.map(k => k.label).join('; ') }, `${lead.score.fit.unknown_knockouts.length} knock-outs unverified`) : null, lead.score.rotten ? h('span', { class: 'pill bad' }, `rotting: ${lead.score.idleDays}d without inbound`) : null,
      h('button', { class: 'btn sm', 'data-keep': '1', onclick: () => { document.body.append(onePager(lead)); window.print(); setTimeout(() => $('.onepager')?.remove(), 500); } }, 'Download report'),
      h('button', { class: `btn sm${lead.handed_off_at ? '' : ' primary'}`, 'data-keep': '1', title: lead.handed_off_at ? 'Bring this property back into play' : 'Nikki Beach takes it from here; the page greys out', onclick: async () => {
        if (lead.handed_off_at) { await save({ handed_off_at: null, handed_off_to: null, touch: false }, true); return render(); }
        // 9/30 Austin: centred pop-up asking who it is handed off to, then Done
        const who = h('input', { placeholder: 'Name or company', value: '' });
        modal(`Hand off ${lead.name}`, 'Who is this being handed off to?', h('div', { class: 'field' }, h('label', {}, 'Handed off to'), who), (close) => [
          h('button', { class: 'btn primary', onclick: async () => {
            const name = who.value.trim(); if (!name) { who.focus(); return toast('Type who it is handed off to', true); }
            await save({ handed_off_at: new Date().toISOString(), handed_off_to: name, declined_at: null, touch: false }, true); close(); render();
          } }, 'Done')]);
        who.addEventListener('keydown', (e) => { if (e.key === 'Enter') who.closest('.modal').querySelector('.btn.primary').click(); });
      } }, lead.handed_off_at ? 'Undo handoff' : 'Handoff'),
      h('button', { class: `btn sm${lead.declined_at ? '' : ' decline'}`, 'data-keep': '1', title: lead.declined_at ? 'Bring this property back into play' : 'Pass on this property; it moves to Declined', onclick: async () => {
        if (!lead.declined_at && !confirm(`Decline ${lead.name}? It moves to Declined at the bottom of the Overview and the page greys out.`)) return;
        await save({ declined_at: lead.declined_at ? null : new Date().toISOString(), handed_off_at: null, touch: false }, true); render();
      } }, lead.declined_at ? 'Undo decline' : 'Decline')),
  ), h('div', { class: 'btn-row' },
    h('select', { class: 'input', style: { width: 'auto', borderRadius: '999px' }, onchange: (e) => moveStage(lead, e.target.value) }, state.config.stages.map(s => h('option', { value: s.key, selected: s.key === lead.stage }, s.label))),
    h('button', { class: 'btn ghost', onclick: () => statusModal(lead, save) }, lead.status === 'active' ? 'Park / lose / win' : 'Reactivate'),
  ));
  const tabs = [['overview', 'Overview'], ['score', 'Scorecard'], ['checklist', 'Winner / loser'], ['sitepack', 'Site pack'], ['qualify', 'Qualification'], ['people', `People (${lead.contacts.length + lead.orgs.length})`], ['activity', `Activity (${lead.activities.length})`], ['documents', `Documents (${lead.documents.length})`], ['registration', `Registration (${lead.registrations.length})`], ['terms', 'Terms']];
  const tabsEl = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => navigate(`/lead/${id}/${k}`) }, l)));
  if (lead.handed_off_at) setTimeout(() => { main.classList.add('handed-off'); main.querySelector('.detail-head')?.after(h('div', { class: 'handoff-banner' }, `Handed off to ${lead.handed_off_to || 'Nikki Beach'} on ${fmt.date(lead.handed_off_at)}.`)); }, 0);
  else if (lead.declined_at) setTimeout(() => { main.classList.add('handed-off'); main.querySelector('.detail-head')?.after(h('div', { class: 'handoff-banner declined' }, `Declined on ${fmt.date(lead.declined_at)}. This property was passed on and is no longer being pursued.`)); }, 0);
  const body = h('div', {});
  const gateBox = h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Gate to leave this stage'),
    h('label', { class: 'gate-row' }, h('input', { type: 'checkbox', checked: !!lead.gates[lead.stage], onchange: (e) => save({ gates: { ...lead.gates, [lead.stage]: e.target.checked }, touch: false }) }), h('span', {}, st?.gate || '')),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Default next action: ', st?.next || ''));
  const side = h('div', { class: 'side' },
    photoCard(lead),
    miniMap(lead),
    docsCard(lead, reload),
    gateBox,
    h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Score'),
      h('div', { class: 'group-row' }, h('span', {}, 'Composite'), h('div', { class: 'bar' }, h('i', { style: { width: `${lead.composite}%`, background: gradeColor[lead.grade[0]] } })), h('span', { class: 'mono', style: { textAlign: 'right' } }, Math.round(lead.composite))),
      h('div', { class: 'group-row' }, h('span', {}, 'Heat'), h('div', { class: 'bar' }, h('i', { style: { width: `${lead.heat_score}%`, background: tempColor[lead.temperature] } })), h('span', { class: 'mono', style: { textAlign: 'right' } }, Math.round(lead.heat_score))),
      h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${fmt.title(lead.temperature)}: ${lead.temperature_reason}. ${lead.rank ? `Rank ${lead.rank}, Tier ${lead.tier}.` : ''} ${lead.score.answered}/${state.config.scorecard.criteria.filter(c => !c.computed).length} criteria scored.`),
      h('div', { style: { marginTop: '10px' } }, Object.entries(lead.score.groups).map(([g, v]) => h('div', { class: 'group-row' }, h('span', { class: 'small' }, state.config.scorecard.groups[g]?.label || g), h('div', { class: 'bar' }, h('i', { style: { width: `${v}%` } })), h('span', { class: 'mono small', style: { textAlign: 'right' } }, Math.round(v)))))),
    h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'HI economics'), h('dl', { class: 'kv' }, h('dt', {}, 'Expected fee'), h('dd', {}, fmt.money(lead.expected_fee_usd_calc)), h('dt', {}, 'Weighted'), h('dd', {}, `${fmt.money(lead.weighted_fee_usd)} at ${Math.round((st?.probability ?? 0) * 100)}%`), h('dt', {}, 'Gross revenue'), h('dd', {}, fmt.money(lead.est_revenue_usd) || h('span', { class: 'muted' }, 'set in Overview')))),
    h('div', { class: 'card pad' }, h('div', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Market'), lead.region && state.config.markets[lead.region] ? h('div', {}, h('div', { class: 'lead-name' }, regionLabel(lead.region)), h('div', { class: 'fitbar', style: { margin: '6px 0' } }, [1, 2, 3, 4, 5].map(i => h('i', { class: i <= (state.config.markets[lead.region].fit ?? 0) ? 'on' : '' }))), h('div', { class: 'small muted' }, state.config.markets[lead.region].why)) : h('div', { class: 'small muted' }, 'Assign a market in Overview to pull in the fit suggestion.')),
  );
  main.append(head, tabsEl, h('div', { class: 'detail' }, body, side));

  if (tab === 'overview') body.append(leadForm(lead, save));
  else if (tab === 'score') body.append(scoreTab(lead, save));
  else if (tab === 'checklist') body.append(checklistTab(lead, save));
  else if (tab === 'sitepack') body.append(sitepackTab(lead, save));
  else if (tab === 'qualify') body.append(qualifyTab(lead, save));
  else if (tab === 'people') body.append(peopleTab(lead, save, reload));
  else if (tab === 'activity') body.append(activityTab(lead, reload));
  else if (tab === 'documents') body.append(documentsTab(lead, reload));
  else if (tab === 'terms') body.append(termsTab(lead, save));
  else if (tab === 'registration') body.append(registrationTab(lead, reload));
}
const REG_EVENTS = [['acknowledged', 'Penrod acknowledged'], ['disputed', 'Disputed by Penrod'], ['renewed', 'Renewed (+12 months on evidence of activity)'], ['converted', 'Converted (agreement signed)'], ['commission', 'Commission event (closing fee / trailing)'], ['released', 'Released'], ['expired', 'Expired'], ['note', 'Note']];
function registrationTab(lead, reload) {
  const f = { event: 'acknowledged', reference: '', evidence_url: '', amount_usd: '', notes: '', at: today() };
  const composer = lead.registered ? h('div', { class: 'card pad composer' }, h('div', { class: 'row' },
    h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => f.event = e.target.value }, REG_EVENTS.map(([v, l]) => h('option', { value: v }, l))),
    h('input', { class: 'input', type: 'date', value: f.at, style: { width: 'auto' }, onchange: (e) => f.at = e.target.value }),
    h('input', { class: 'input', placeholder: 'reference (email subject, statement no.)', style: { flex: 1 }, onchange: (e) => f.reference = e.target.value })),
    h('div', { class: 'row' }, h('input', { class: 'input', placeholder: 'evidence link (the email or PDF)', style: { flex: 2 }, onchange: (e) => f.evidence_url = e.target.value }), h('input', { class: 'input', type: 'number', placeholder: 'USD (commission events)', style: { width: '180px' }, onchange: (e) => f.amount_usd = e.target.value })),
    h('div', { class: 'row' }, h('input', { class: 'input', placeholder: 'notes', style: { flex: 1 }, onchange: (e) => f.notes = e.target.value }), h('button', { class: 'btn primary', onclick: async () => { await api(`/api/leads/${lead.id}/registrations`, { method: 'POST', body: f }); toast('Logged'); reload(); } }, 'Append to ledger')))
    : h('div', { class: 'card pad' }, h('h3', {}, 'Not registered'), h('p', { class: 'small muted' }, 'Registration is the evidence chain HI is paid on. Register before Nikki Beach hears the name from anyone else.'), h('button', { class: 'btn hot', onclick: () => registerModal(lead) }, 'Register deal with Nikki Beach'));
  const gates = Object.entries(lead.gates).filter(([k, v]) => v === true);
  return h('div', {}, composer,
    h('div', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'card-head' }, h('h3', {}, 'Ledger (append-only)'), h('div', { class: 'btn-row' }, lead.protection_expires_at ? h('span', { class: `pill ${Date.parse(lead.protection_expires_at) - Date.now() < 60 * 86400000 ? 'bad' : 'ok'}` }, `protection to ${fmt.date(lead.protection_expires_at)}`) : null, h('button', { class: 'btn sm', onclick: () => { document.body.append(procuringPack(lead)); window.print(); setTimeout(() => $('.onepager')?.remove(), 500); } }, 'Procuring-cause pack'))),
      lead.registrations.length ? h('table', { class: 'table' }, h('tbody', {}, lead.registrations.map(r => h('tr', { style: { cursor: 'default' } }, h('td', {}, h('div', { class: 'lead-name' }, fmt.title(r.event)), h('div', { class: 'lead-loc' }, [r.submitted_to, r.via, r.reference, r.counterparties].filter(Boolean).join(' · '))), h('td', { class: 'small' }, r.notes || '', r.amount_usd ? h('div', { class: 'mono' }, `$${Number(r.amount_usd).toLocaleString()}`) : null, r.protection_expires_at ? h('div', { class: 'small muted' }, `protection to ${fmt.date(r.protection_expires_at)}`) : null), h('td', { class: 'small muted', style: { textAlign: 'right', whiteSpace: 'nowrap' } }, `${fmt.dt(r.at)}`, h('div', {}, r.by_user || ''), r.evidence_url ? h('a', { href: r.evidence_url, target: '_blank' }, 'evidence') : null))))) : h('div', { class: 'empty small' }, 'No registration events yet.')),
    h('div', { class: 'card pad', style: { marginTop: '16px' } }, h('h3', {}, 'Gates ticked (counterparty actions)'), gates.length ? h('ul', { class: 'small' }, gates.map(([k]) => h('li', {}, `${stageLabel(k)}: ${stageObj(k)?.gate || ''}`))) : h('div', { class: 'small muted' }, 'None yet. Gates are ticked on the lead as the counterparty acts.')));
}
function procuringPack(lead) {
  return h('div', { class: 'onepager' },
    h('div', { class: 'eyebrow' }, `Higney International · Procuring-cause pack · ${lead.ref} · generated ${fmt.dt(new Date())} by ${state.user}`),
    h('h1', {}, lead.name), h('p', {}, `${formatLabel(lead.format)} · ${[lead.city, lead.country].filter(Boolean).join(', ')} · stage ${stageLabel(lead.stage)} · created ${fmt.date(lead.created_at)} by ${lead.created_by || ''}`),
    h('h3', {}, 'Counterparties'), h('ul', {}, lead.orgs.map(o => h('li', {}, `${o.name}: ${fmt.title(o.role)} (${o.confidence})${o.source_url ? ` · ${o.source_url}` : ''}`)), lead.contacts.map(c => h('li', {}, `${c.name}${c.title ? `, ${c.title}` : ''}${c.org_name ? ` (${c.org_name})` : ''}: ${fmt.title(c.lead_role || c.role || 'contact')}`))),
    h('h3', {}, 'Registration ledger'), h('table', { class: 'table' }, h('tbody', {}, lead.registrations.map(r => h('tr', {}, h('td', {}, fmt.dt(r.at)), h('td', {}, fmt.title(r.event)), h('td', {}, [r.submitted_to, r.via, r.reference, r.counterparties, r.notes].filter(Boolean).join(' · ')), h('td', {}, r.first_contact_at ? `first contact ${fmt.date(r.first_contact_at)}` : ''), h('td', {}, r.protection_expires_at ? `protection to ${fmt.date(r.protection_expires_at)}` : ''), h('td', {}, r.by_user || ''))))),
    h('h3', {}, 'Stage gates (counterparty actions, with who ticked them)'), h('ul', {}, Object.entries(lead.gates).filter(([, v]) => v === true).map(([k]) => h('li', {}, `${stageLabel(k)}: ${stageObj(k)?.gate || ''}`))),
    h('h3', {}, 'Activity timeline'), h('table', { class: 'table' }, h('tbody', {}, [...lead.activities].reverse().map(a => h('tr', {}, h('td', { style: { whiteSpace: 'nowrap' } }, fmt.dt(a.at)), h('td', {}, `${fmt.title(a.kind)}${a.direction ? ` (${a.direction})` : ''}`), h('td', {}, a.body || ''), h('td', {}, a.by_user || ''))))),
    h('h3', {}, 'Documents'), h('ul', {}, lead.documents.map(d => h('li', {}, `${fmt.title(d.kind)}: ${d.title} · ${fmt.dt(d.at)} · ${d.by_user || ''}${d.url ? ` · ${d.url}` : ''}`))),
  );
}

const SEL = {
  format: () => state.config.formats.map(f => [f.key, f.label]),
  site_type: () => [['greenfield', 'Greenfield land'], ['existing_operation', 'Existing beach club / venue'], ['closed_venue', 'Closed or distressed venue'], ['repositioning', 'Hotel or resort repositioning'], ['concession', 'Beach concession'], ['masterplan_component', 'Component of a masterplan']],
  counterparty_type: () => [['developer', 'Master developer / landowner with residential upside'], ['sovereign', 'Sovereign fund / tourism authority developer'], ['family_office', 'Family office / private owner'], ['investor', 'Investor-owner using a third-party manager'], ['government', 'Government body'], ['hotel_operator', 'Hotel operator with its own F&B'], ['restaurant_group', 'Restaurant / beach club group'], ['casino', 'Casino / gaming operator']],
  land_control: () => [['owned', 'Freehold owned'], ['long_lease', 'Long lease (20y+)'], ['option', 'Option / under offer'], ['under_contract', 'Under contract'], ['concession', 'Public concession'], ['unknown', 'Unknown'], ['none', 'No control of land']],
  capital_status: () => [['funded', 'Fully funded'], ['partially_funded', 'Partially funded'], ['seeking', 'Seeking capital'], ['unknown', 'Unknown']],
  deal_structure: () => [['management_agreement', 'Management agreement (HMA)'], ['lease', 'Lease'], ['licence', 'Licence'], ['jv', 'Joint venture'], ['unknown', 'Unknown']],
  orientation: () => [['W', 'West (sunset)'], ['SW', 'South-west'], ['S', 'South'], ['SE', 'South-east'], ['E', 'East (sunrise)'], ['N', 'North'], ['none', 'No sea view']],
  alcohol_licence: () => [['in_place', 'In place'], ['obtainable', 'Obtainable'], ['restricted', 'Restricted / dry'], ['unknown', 'Unknown']],
  region: () => Object.entries(state.config.markets).map(([k, m]) => [k, m.label]),
  source: () => [['hi_network', 'HI network / introduction'], ['penrod_network', 'Nikki Beach / Penrod network'], ['broker', 'Broker (JLL, CBRE, C&W, HVS, local)'], ['owner_inbound', 'Owner inbound'], ['thp_alert', 'TOPHOTELPROJECTS / pipeline data'], ['research', 'Desk research'], ['conference', 'Conference (IHIF, FHS, ALIS, HICAP)'], ['rfp', 'RFP / tender'], ['press', 'Press / announcement'], ['other', 'Other']],
};
function fld(lead, key, label, type = 'text', opts = {}) {
  const val = lead[key] ?? '';
  let input;
  if (type === 'select') input = h('select', { onchange: (e) => opts.save({ [key]: e.target.value }) }, h('option', { value: '' }, '—'), SEL[opts.options || key]().map(([v, l]) => h('option', { value: v, selected: String(val) === v }, l)));
  else if (type === 'textarea') input = h('textarea', { onchange: (e) => opts.save({ [key]: e.target.value }) }, val);
  else if (type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!val, style: { width: 'auto' }, onchange: (e) => opts.save({ [key]: e.target.checked ? 1 : 0 }) });
  else input = h('input', { type, value: val, placeholder: opts.placeholder || '', step: type === 'number' ? 'any' : null, onchange: (e) => opts.save({ [key]: e.target.value }) });
  return h('div', { class: `field${opts.full ? ' full' : ''}` }, h('label', {}, label), input);
}
// Primary contact, right under Format (Austin 9/30). People linked to this property on Monday come first.
function primaryContactField(lead, save) {
  const linked = new Set(lead.contacts.map(c => c.id));
  const all = [...state.contacts].sort((a, b) => (linked.has(b.id) - linked.has(a.id)) || a.name.localeCompare(b.name));
  const cur = state.contacts.find(c => c.id === lead.primary_contact_id);
  const opt = (c) => h('option', { value: c.id, selected: c.id === lead.primary_contact_id }, c.name + (c.org_name ? ` (${c.org_name})` : ''));
  return h('div', { class: 'field' }, h('label', {}, 'Primary contact'),
    h('select', { onchange: (e) => save({ primary_contact_id: e.target.value ? Number(e.target.value) : null }).then(() => render()) },
      h('option', { value: '' }, 'Not set'),
      linked.size ? h('optgroup', { label: 'Linked to this property' }, all.filter(c => linked.has(c.id)).map(opt)) : null,
      h('optgroup', { label: linked.size ? 'Everyone else' : 'All contacts' }, all.filter(c => !linked.has(c.id)).map(opt))),
    cur ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, [cur.phone, cur.email].filter(Boolean).map((v, k) => h('a', { href: v.includes('@') ? `mailto:${v}` : `tel:${v}`, style: { marginRight: '12px' } }, v))) : null);
}
function leadForm(lead, save) {
  const s = (patch) => save({ ...patch, touch: false }, true).then(() => { if ('region' in patch || 'status' in patch || 'format' in patch || 'counterparty_type' in patch || 'land_control' in patch || 'alcohol_licence' in patch) render(); });
  const o = { save: s };
  return h('div', {},
    h('div', { class: 'section' }, h('h3', {}, 'The opportunity'), h('div', { class: 'form-grid' },
      fld(lead, 'name', 'Site / property name', 'text', o), fld(lead, 'format', 'Format', 'select', o),
      fld(lead, 'site_type', 'Site type', 'select', o), primaryContactField(lead, s),
      fld(lead, 'counterparty_type', 'Counterparty type (drives the #2 criterion)', 'select', o),
      fld(lead, 'source', 'Source', 'select', o), fld(lead, 'source_detail', 'Source detail (who told us, link)', 'text', o),
      fld(lead, 'summary', 'Summary: what is it, why now, why Nikki', 'textarea', { ...o, full: true }))),
    h('div', { class: 'section' }, h('h3', {}, 'Where'), h('div', { class: 'form-grid' },
      fld(lead, 'country', 'Country', 'text', o), fld(lead, 'region', 'Market (seeds the fit score)', 'select', o),
      fld(lead, 'city', 'City / area', 'text', o), fld(lead, 'address', 'Address / parcel', 'text', o),
      fld(lead, 'lat', 'Latitude', 'number', o), fld(lead, 'lng', 'Longitude', 'number', o))),
    h('div', { class: 'section' }, h('h3', {}, 'Land, capital, structure'), h('div', { class: 'form-grid' },
      fld(lead, 'land_control', 'Land control (concession = tenure knock-out)', 'select', o), fld(lead, 'tenure_years', 'Tenure remaining (years)', 'number', o),
      fld(lead, 'capital_status', 'Capital status', 'select', o), fld(lead, 'deal_structure', 'Likely structure', 'select', o),
      fld(lead, 'est_capex_usd', 'Est. project capex (USD)', 'number', o), fld(lead, 'est_revenue_usd', 'Est. annual gross revenue once open (USD)', 'number', { ...o, placeholder: 'drives HI trailing commission' }),
      fld(lead, 'expected_fee_usd', 'Expected HI fee override (USD)', 'number', { ...o, placeholder: 'leave blank to compute' }))),
    h('div', { class: 'section' }, h('h3', {}, 'The site'), h('div', { class: 'form-grid' },
      fld(lead, 'beach_frontage_m', 'Beach frontage (m)', 'number', o), fld(lead, 'orientation', 'Orientation', 'select', o),
      fld(lead, 'seating_capacity', 'Club capacity (covers + beds)', 'number', o), fld(lead, 'hotel_keys', 'Hotel keys', 'number', o),
      fld(lead, 'residences_units', 'Branded residences (units)', 'number', o), fld(lead, 'land_area_sqm', 'Land area (sqm)', 'number', o),
      fld(lead, 'airport_minutes', 'Minutes from international airport', 'number', o), fld(lead, 'season_months', 'Operating season (months)', 'number', o),
      fld(lead, 'marina_access', 'Marina berths or tender dock at the site', 'checkbox', o))),
    h('div', { class: 'section' }, h('h3', {}, 'Licensing and timing'), h('div', { class: 'form-grid' },
      fld(lead, 'alcohol_licence', 'Alcohol licence', 'select', o), fld(lead, 'music_curfew', 'Outdoor music curfew', 'text', { ...o, placeholder: 'e.g. amplified until 23:00' }),
      fld(lead, 'target_open', 'Target opening', 'month', o), fld(lead, 'timeline_months', 'Months to opening (est.)', 'number', o),
      fld(lead, 'regulatory_notes', 'Regulatory notes', 'textarea', { ...o, full: true }))),
    h('div', { class: 'section' }, h('h3', {}, 'Competition and tags'), h('div', { class: 'form-grid' },
      h('div', { class: 'field full' }, h('label', {}, 'Brands circling this site or destination'), h('div', { class: 'btn-row' }, state.config.competitors.map(c => h('button', { class: `chip${lead.competitors.includes(c.name) ? ' on' : ''}`, title: c.note, onclick: (e) => { const set = new Set(lead.competitors); set.has(c.name) ? set.delete(c.name) : set.add(c.name); e.target.classList.toggle('on'); s({ competitors: [...set] }); } }, c.name)))),
      h('div', { class: 'field full' }, h('label', {}, 'Tags (comma separated)'), h('input', { value: lead.tags.join(', '), onchange: (e) => s({ tags: e.target.value.split(',').map(x => x.trim()).filter(Boolean) }) })))),
  );
}
function scoreTab(lead, save) {
  const card = state.config.scorecard;
  const scores = { ...lead.scores };
  const auto = lead.auto_scores || {};
  const wrap = h('div', {});
  const draw = () => {
    const y = window.scrollY;
    wrap.replaceChildren(...[
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('div', { class: 'btn-row', style: { justifyContent: 'space-between' } }, h('div', {}, h('h2', {}, `Composite ${Math.round(lead.composite)} / 100 · fit ${Math.round(lead.fit_score)} (${lead.grade[0]})`), h('div', { class: 'small muted' }, `Fit letter from brand fit + deal readiness (85 pts): A ≥ ${card.fit_grades.A}%, B ≥ ${card.fit_grades.B}%. Temperature: ${lead.temperature} (${lead.temperature_reason}). Blue numbers are suggested from the fields you filled in; click to accept or override. Knock-outs are answered on the Winner / loser tab.`)), h('button', { class: 'btn sm', onclick: async () => { for (const [k, v] of Object.entries(auto)) if (scores[k] == null) scores[k] = v; lead = await save({ scores, touch: false }); draw(); } }, 'Accept all suggestions')), lead.score.knockouts.map(k => h('div', { class: 'ko', style: { marginTop: '10px' } }, `Knock-out: ${k.label}`)), lead.score.fit.unknown_knockouts.length ? h('div', { class: 'small', style: { marginTop: '10px', color: '#8a6512' } }, `Grade capped at B until verified: ${lead.score.fit.unknown_knockouts.map(k => k.label).join(', ')}`) : null, lead.score.fit.fixable_knockouts.length ? h('div', { class: 'small', style: { marginTop: '6px', color: '#8a6512' } }, `Capped at warm until the fix is agreed in writing: ${lead.score.fit.fixable_knockouts.map(k => k.label).join(', ')}`) : null),
      ...Object.entries(card.groups).map(([gk, g]) => h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('div', { class: 'group-row', style: { marginBottom: '14px' } }, h('h3', {}, `${g.label} (${g.max} pts)`), h('div', { class: 'bar' }, h('i', { style: { width: `${lead.score.groups[gk] || 0}%` } })), h('span', { class: 'mono', style: { textAlign: 'right' } }, Math.round(lead.score.groups[gk] || 0))),
        card.criteria.filter(c => c.group === gk).map(c => h('div', { class: 'crit' },
          h('div', {}, h('div', { class: 'l' }, c.label, ' ', h('span', { class: 'w' }, `${c.weight} pts`)), h('div', { class: 'small muted' }, c.why || '')),
          c.computed ? h('div', { class: 'pill' }, `${lead.score.per[c.key].value} from heat ${Math.round(lead.heat_score)}`) : h('div', { class: 'seg' }, [0, 1, 2, 3, 4, 5].map(v => h('button', { class: `${scores[c.key] === v ? 'on' : ''}${scores[c.key] == null && auto[c.key] === v ? ' auto' : ''}`, title: c.rubric?.[v] || '', onclick: async () => { if (scores[c.key] === v) delete scores[c.key]; else scores[c.key] = v; lead = await save({ scores, touch: false }); draw(); } }, v))),
          h('div', { class: 'r' }, (c.computed ? lead.score.per[c.key].value : scores[c.key]) != null ? h('span', {}, h('b', {}, `${c.computed ? lead.score.per[c.key].value : scores[c.key]}: `), c.rubric?.[c.computed ? lead.score.per[c.key].value : scores[c.key]] || '') : h('span', {}, Object.entries(c.rubric || {}).sort((a, b) => b[0] - a[0]).map(([k, v]) => h('div', {}, h('b', {}, `${k} `), v)))),
        )))),
    ]);
    window.scrollTo(0, y);
  };
  draw();
  return wrap;
}
// 10/7 (Peter): Nikki Beach's standard site questions (Celia Serra), answered per lead so we hand them a full pack up front.
function sitepackTab(lead, save) {
  const sp = state.config.sitepack;
  const answers = { ...((lead.checklist || {}).sitepack || {}) };
  const done = () => sp.items.filter(i => (answers[i.key] || '').trim()).length;
  const head = h('h2', {}, `${done()} of ${sp.items.length} answered`);
  const persist = async () => { const cl = { ...(lead.checklist || {}), sitepack: answers }; lead = await save({ checklist: cl, touch: false }, true); head.textContent = `${done()} of ${sp.items.length} answered`; };
  const copy = h('button', { class: 'btn', onclick: async () => {
    const txt = `${lead.name}: site information\n\n` + sp.items.map(i => `${i.label}\n${(answers[i.key] || '').trim() || '(still to confirm)'}`).join('\n\n');
    try { await navigator.clipboard.writeText(txt); toast('Copied, ready to paste into an email'); } catch { toast('Copy failed'); }
  } }, 'Copy as email text');
  return h('div', {},
    h('div', { class: 'card pad', style: { marginBottom: '16px' } }, head, h('div', { class: 'small muted' }, sp.intro), h('div', { class: 'btn-row', style: { marginTop: '10px' } }, copy)),
    ...sp.items.map(i => h('div', { class: 'card pad', style: { marginBottom: '12px' } },
      h('h3', { style: { marginBottom: '4px' } }, i.label), h('div', { class: 'small muted', style: { marginBottom: '8px' } }, i.ask),
      h('textarea', { class: 'input', rows: 3, placeholder: 'Answer from the owner, with the source (plan, permit, email)', onchange: async (e) => { answers[i.key] = e.target.value; await persist(); } }, answers[i.key] || ''))));
}
function checklistTab(lead, save) {
  const cl = state.config.checklist;
  const answers = { ...lead.checklist };
  const wrap = h('div', {});
  const draw = () => {
    const all = cl.sections.flatMap(s => s.items);
    const yes = all.filter(i => answers[i.key] === 'yes').length, no = all.filter(i => answers[i.key] === 'no').length;
    const fatal = all.filter(i => i.fatal && answers[i.key] === 'no');
    const fixable = all.filter(i => i.fatal && answers[i.key] === 'fixable');
    const unk = all.filter(i => i.fatal && !answers[i.key]);
    const y = window.scrollY;
    const verdict = fatal.length ? 'Loser: a knock-out failed' : fixable.length ? `Conditional: ${fixable.length} knock-out(s) fixable, capped at warm` : unk.length ? `${yes} winner traits, ${unk.length} knock-outs still to verify` : (yes >= all.length * 0.7 && no <= 2 ? 'Looks like a winner' : `${yes} of ${all.length} winner traits confirmed`);
    wrap.replaceChildren(...[
      h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h2', {}, verdict), h('div', { class: 'small muted' }, cl.intro || ''), fatal.map(i => h('div', { class: 'ko', style: { marginTop: '10px' } }, `Fatal: ${i.label}`))),
      ...cl.sections.map(sec => h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h3', { style: { marginBottom: '6px' } }, sec.label), sec.items.map(i => h('div', { class: 'chk-item' },
        h('div', {}, i.label, i.fatal ? h('span', { class: 'pill bad', style: { marginLeft: '8px' } }, 'knock-out') : null),
        h('div', { class: 'tri' }, (i.fatal ? [['yes', 'Pass'], ['fixable', 'Fixable'], ['no', 'Fail'], ['unk', '?']] : [['yes', 'Yes'], ['no', 'No'], ['unk', '?']]).map(([v, l]) => h('button', { class: `${v}${(answers[i.key] || 'unk') === v ? ' on' : ''}`, onclick: async () => { if (v === 'unk' || answers[i.key] === v) delete answers[i.key]; else answers[i.key] = v; lead = await save({ checklist: answers, touch: false }, true); draw(); } }, l))),
        i.fatal && answers[i.key] === 'fixable' ? h('input', { class: 'input', style: { gridColumn: '1 / -1' }, placeholder: 'The fix the counterparty must agree to in writing (e.g. floating swim platform in the marina basin)', value: answers[`${i.key}_fix`] || '', onchange: async (e) => { answers[`${i.key}_fix`] = e.target.value; lead = await save({ checklist: answers, touch: false }, true); } }) : null,
        i.hint ? h('div', { class: 'hint' }, i.hint) : null)))),
    ]);
    window.scrollTo(0, y);
  };
  draw();
  return wrap;
}
const QUAL = { economic_buyer: ['Economic buyer', 'The principal who signs: developer owner, landowner, fund IC. Named and met?'], champion: ['Champion', 'Someone inside the counterparty who wants the Nikki flag and will fight for it.'], decision_process: ['Decision process', 'How they decide: board, IC, lender consent, government approval. Do we know the steps and dates?'], paper_process: ['Paper process', 'HMA + TSA + residences licence + any concession or planning consent. Who drafts, who approves.'], why_nikki: ['Why Nikki', 'The residential premium, the day-club F&B, the yacht crowd. Can they say it back to us?'], competition: ['Competition', 'Which brands are circling and where we stand.'], land_control: ['Land control', 'Freehold, long lease or HMA-grade tenure confirmed with documents.'], capital: ['Capital', 'Equity and debt committed or credibly in process.'] };
function qualifyTab(lead, save) {
  const q = { ...lead.qualification };
  const wrap = h('div', {});
  const draw = () => {
    const y = window.scrollY;
    const reds = Object.values(q).filter(v => v === 'red').length, yellows = Object.values(q).filter(v => v === 'yellow').length, greens = Object.values(q).filter(v => v === 'green').length;
    wrap.replaceChildren(h('div', { class: 'card pad' }, h('h2', {}, `${greens} green · ${yellows} yellow · ${reds} red`), h('p', { class: 'small muted' }, 'MEDDPICC adapted for a management-agreement pursuit. Green = validated with the counterparty\'s own words or documents. Yellow = partly known. Red = unknown or guessed. Nothing passes Qualified with a red; IC approval allows at most two yellows.'),
      Object.entries(QUAL).map(([k, [label, hint]]) => h('div', { class: 'chk-item' }, h('div', {}, h('b', {}, label), h('div', { class: 'small muted' }, hint)), h('div', { class: 'tri lights' }, [['green', 'Green'], ['yellow', 'Yellow'], ['red', 'Red']].map(([v, l]) => h('button', { class: `${v}${q[k] === v ? ' on' : ''}`, onclick: async () => { if (q[k] === v) delete q[k]; else q[k] = v; lead = await save({ qualification: q, touch: false }, true); draw(); } }, l)))))));
    window.scrollTo(0, y);
  };
  draw();
  return wrap;
}
const ORG_ROLES = [['true_owner', 'True owner'], ['recorded_owner', 'Recorded owner (SPV)'], ['developer', 'Developer'], ['capital_partner', 'Capital partner / investor'], ['lender', 'Lender'], ['master_planner', 'Master planner'], ['architect', 'Architect'], ['broker', 'Broker / advisor'], ['operator', 'Current operator'], ['government', 'Government / authority']];
const CONTACT_ROLES = [['economic_buyer', 'Economic buyer'], ['champion', 'Champion'], ['blocker', 'Blocker'], ['advisor', 'Advisor'], ['introduced_by', 'Introduced us']];
function peopleTab(lead, save, reload) {
  const orgSel = h('select', { class: 'input', style: { width: '240px' } }, h('option', { value: '' }, 'Organisation…'), state.orgs.map(o => h('option', { value: o.id }, `${o.name} (${fmt.title(o.kind)})`)));
  const roleSel = h('select', { class: 'input', style: { width: 'auto' } }, ORG_ROLES.map(([v, l]) => h('option', { value: v }, l)));
  const confSel = h('select', { class: 'input', style: { width: 'auto' } }, [['confirmed', 'Confirmed'], ['probable', 'Probable'], ['rumoured', 'Rumoured']].map(([v, l]) => h('option', { value: v, selected: v === 'probable' }, l)));
  const srcIn = h('input', { class: 'input', placeholder: 'source URL (registry, press)', style: { flex: 1, minWidth: '160px' } });
  const orgRow = h('div', { class: 'btn-row', style: { marginBottom: '14px' } }, orgSel, roleSel, confSel, srcIn,
    h('button', { class: 'btn', onclick: async () => { if (!orgSel.value) return; await api(`/api/leads/${lead.id}/orgs`, { method: 'POST', body: { org_id: Number(orgSel.value), role: roleSel.value, confidence: confSel.value, source_url: srcIn.value } }); toast('Linked'); await refreshLeads(); reload(); } }, 'Link'),
    h('button', { class: 'btn primary', onclick: () => orgModal(null, async (o) => { await api(`/api/leads/${lead.id}/orgs`, { method: 'POST', body: { org_id: o.id, role: roleSel.value, confidence: confSel.value } }); await refreshLeads(); reload(); }) }, '+ New organisation'));
  const cSel = h('select', { class: 'input', style: { width: '260px' } }, h('option', { value: '' }, 'Link an existing contact…'), state.contacts.filter(c => !lead.contacts.some(x => x.id === c.id)).map(c => h('option', { value: c.id }, `${c.name}${c.org_name ? ` · ${c.org_name}` : ''}`)));
  const cRole = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'role on this deal'), CONTACT_ROLES.map(([v, l]) => h('option', { value: v }, l)));
  const linkRow = h('div', { class: 'btn-row', style: { marginBottom: '14px' } }, cSel, cRole,
    h('button', { class: 'btn', onclick: async () => { if (!cSel.value) return; await api(`/api/leads/${lead.id}/contacts`, { method: 'POST', body: { contact_id: Number(cSel.value), role: cRole.value } }); toast('Linked'); reload(); } }, 'Link'),
    h('button', { class: 'btn primary', onclick: () => contactModal(null, async (c) => { await api(`/api/leads/${lead.id}/contacts`, { method: 'POST', body: { contact_id: c.id, role: cRole.value || c.role } }); reload(); }) }, '+ New contact'));
  return h('div', {},
    h('div', { class: 'card pad', style: { marginBottom: '16px' } }, h('h3', { style: { marginBottom: '10px' } }, 'Ownership chain and partners'), orgRow,
      lead.orgs.length ? h('table', { class: 'table' }, h('tbody', {}, lead.orgs.map(o => h('tr', { onclick: () => orgModal(state.orgs.find(x => x.id === o.id) || o) }, h('td', {}, h('div', { class: 'lead-name' }, o.name), h('div', { class: 'lead-loc' }, [fmt.title(o.kind), o.country].filter(Boolean).join(' · '))), h('td', {}, h('span', { class: 'pill' }, fmt.title(o.role)), ' ', h('span', { class: `pill ${o.confidence === 'confirmed' ? 'ok' : o.confidence === 'rumoured' ? 'warn' : ''}` }, o.confidence)), h('td', { class: 'small' }, o.source_url ? h('a', { href: o.source_url, target: '_blank', onclick: (e) => e.stopPropagation() }, 'source') : h('span', { class: 'muted' }, 'no source')), h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn sm ghost danger', onclick: async (e) => { e.stopPropagation(); await api(`/api/leads/${lead.id}/orgs/${o.id}/${o.role}`, { method: 'DELETE' }); await refreshLeads(); reload(); } }, 'Unlink')))))) : h('div', { class: 'empty small' }, 'Who owns the land, who develops it, who funds it. Each with a confidence and a source.')),
    h('div', { class: 'card pad' }, h('h3', { style: { marginBottom: '10px' } }, 'People on this deal'), linkRow,
      lead.contacts.length ? h('table', { class: 'table' }, h('tbody', {}, lead.contacts.map(c => h('tr', { onclick: () => contactModal(c) }, h('td', {}, h('div', { class: 'lead-name' }, c.name), h('div', { class: 'lead-loc' }, [c.title, c.org_name].filter(Boolean).join(' · '))), h('td', {}, c.lead_role ? h('span', { class: 'pill' }, fmt.title(c.lead_role)) : ''), h('td', { class: 'small' }, c.email ? h('a', { href: `mailto:${c.email}`, onclick: (e) => e.stopPropagation() }, c.email) : '', c.phone ? h('div', {}, c.phone) : ''), h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn sm ghost danger', onclick: async (e) => { e.stopPropagation(); await api(`/api/leads/${lead.id}/contacts/${c.id}`, { method: 'DELETE' }); reload(); } }, 'Unlink')))))) : h('div', { class: 'empty small' }, 'No contacts linked. Who is the economic buyer, who is the champion, who can walk us in?')));
}
function activityTab(lead, reload) {
  const events = state.config.heat.events;
  let kind = 'note';
  const ta = h('textarea', { class: 'input', placeholder: 'What happened? What did they say? What did we promise?', style: { minHeight: '84px' } });
  const na = h('input', { class: 'input', placeholder: 'Next action (optional)', style: { flex: 1 } });
  const nd = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const at = h('input', { class: 'input', type: 'date', value: today(), style: { width: 'auto' }, title: 'When it happened' });
  const chips = h('div', { class: 'row' }, Object.entries(events).map(([k, e]) => h('button', { class: `chip${k === kind ? ' on' : ''}${e.direction === 'inbound' ? ' inbound' : ''}`, title: e.points ? `+${e.points} heat (${e.direction})` : 'no heat', onclick: (ev) => { kind = k; chips.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); ev.target.classList.add('on'); } }, e.label)));
  const composer = h('div', { class: 'card pad composer' }, h('div', { class: 'small muted' }, 'Inbound events (their reply, a meeting, a site visit) heat the lead. Our outbound barely does.'), chips, ta, h('div', { class: 'row' }, at, na, nd, h('button', { class: 'btn primary', onclick: async () => { if (!ta.value.trim() && kind === 'note') return toast('Write something first', true); const body = { kind, body: ta.value.trim(), at: at.value }; if (na.value) body.next_action = na.value; if (nd.value) body.next_action_due = nd.value; await api(`/api/leads/${lead.id}/activities`, { method: 'POST', body }); await refreshLeads(); toast('Logged'); reload(); } }, 'Log')));
  return h('div', {}, composer, h('div', { class: 'card pad', style: { marginTop: '16px' } }, lead.activities.length ? lead.activities.map(a => h('div', { class: `tl ${a.kind} ${a.direction || ''}` }, h('div', { class: 'dot' }), h('div', {}, h('div', { class: 'who' }, `${events[a.kind]?.label || fmt.title(a.kind)}${a.direction && a.direction !== 'none' ? ` · ${a.direction}` : ''} · ${a.by_user || 'system'} · ${fmt.dt(a.at)}`, events[a.kind]?.points ? h('span', { class: 'mono', style: { marginLeft: '8px' } }, `+${events[a.kind].points}`) : null, ['system', 'stage_change', 'score_change'].includes(a.kind) ? null : h('button', { class: 'btn sm ghost danger', style: { marginLeft: '8px' }, onclick: async () => { if (!confirm('Delete this entry?')) return; await api(`/api/leads/${lead.id}/activities/${a.id}`, { method: 'DELETE' }); await refreshLeads(); reload(); } }, 'delete')), h('div', { class: 'body' }, a.body)))) : h('div', { class: 'empty small' }, 'No activity yet.')));
}
function documentsTab(lead, reload) {
  const kindSel = h('select', { class: 'input', style: { width: 'auto' } }, DOC_KINDS.map(([k, l]) => h('option', { value: k }, l)));
  const file = uploadDoc(lead, () => kindSel.value, reload);
  const title = h('input', { class: 'input', placeholder: 'Title', style: { flex: 1 } }), url = h('input', { class: 'input', placeholder: 'https:// link (Drive, Dropbox, listing…)', style: { flex: 2 } });
  return h('div', {},
    h('div', { class: 'card pad composer' }, h('div', { class: 'row' }, kindSel, h('button', { class: 'btn', onclick: () => file.click() }, 'Upload file'), file, h('span', { class: 'muted small' }, 'or link one:')), h('div', { class: 'row' }, title, url, h('button', { class: 'btn primary', onclick: async () => { if (!title.value) return toast('Title required', true); await api(`/api/leads/${lead.id}/documents`, { method: 'POST', body: { title: title.value, url: url.value, kind: kindSel.value } }); toast('Linked'); reload(); } }, 'Add link'))),
    h('div', { class: 'card', style: { marginTop: '16px' } }, lead.documents.length ? h('table', { class: 'table' }, h('tbody', {}, lead.documents.map(d => h('tr', { style: { cursor: 'default' } }, h('td', {}, h('a', { href: d.url || '#', target: '_blank', class: 'lead-name' }, d.title), h('div', { class: 'lead-loc' }, `${fmt.title(d.kind)} · ${d.by_user || ''} · ${fmt.dt(d.at)}${d.size ? ` · ${(d.size / 1e6).toFixed(1)} MB` : ''}`)), h('td', { style: { textAlign: 'right' } }, h('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } }, docActions(d), h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!confirm('Remove this document?')) return; await api(`/api/leads/${lead.id}/documents/${d.id}`, { method: 'DELETE' }); reload(); } }, 'Remove'))))))) : h('div', { class: 'empty small' }, 'Nothing attached. Teaser, NDA, site plan, drone photos, title docs, IC memo all live here.')));
}
const TERMS = [['hma_term_years', 'Initial term (years)', 'number', 'Benchmark: 10-year initial with renewals'], ['base_fee_pct', 'Base fee (% of gross revenue)', 'number', 'Lifestyle brands: 2-4%'], ['incentive_fee_pct', 'Incentive fee (% of GOP)', 'number', 'Typically 8-12% above a hurdle'], ['tsa_fee', 'Technical services fee (USD)', 'number', '1-1.5% of development cost'], ['key_money', 'Key money (USD)', 'number', 'Nil or modest; above 5% of project cost scores 0'], ['residences_licence_pct', 'Residences licence (% of gross sales)', 'number', 'Brand licence on residences: about 4-5%'], ['residences_mgmt_fee_pct', 'Residences management fee (%)', 'number', ''], ['performance_test', 'Performance test', 'text', 'GOP vs budget, RevPAR index; cure rights'], ['area_of_protection', 'Area of protection (radius)', 'text', 'Territorial exclusivity around the site'], ['owner_approvals', 'Owner approval matrix', 'text', 'Budget, GM, capex thresholds'], ['exclusivity', 'Exclusivity / non-compete on exit', 'text', 'The Bodrum / Cabo protection'], ['hi_closing_fee', 'HI closing fee (USD)', 'number', 'Redline: $75,000 flat per signed agreement'], ['hi_trailing_pct', 'HI trailing commission (% of gross)', 'number', 'Redline: 0.5% for 36 months'], ['notes', 'Notes', 'textarea', '']];
function termsTab(lead, save) {
  const t = { ...lead.terms };
  const early = state.config.stages.findIndex(s => s.key === lead.stage) < state.config.stages.findIndex(s => s.key === 'site_visit');
  return h('div', { class: 'card pad' }, h('h3', { style: { marginBottom: '4px' } }, 'Deal terms'), h('p', { class: 'small muted' }, early ? 'Usually filled from Site visit onwards. Benchmarks are in the placeholders.' : 'Benchmarks are in the placeholders. These feed the "Deal economics" criterion and the one-pager.'),
    h('div', { class: 'form-grid' }, TERMS.map(([k, label, type, hint]) => h('div', { class: `field${type === 'textarea' ? ' full' : ''}` }, h('label', {}, label), type === 'textarea' ? h('textarea', { placeholder: hint, onchange: (e) => { t[k] = e.target.value; save({ terms: t, touch: false }); } }, t[k] || '') : h('input', { type, step: 'any', value: t[k] ?? '', placeholder: hint, onchange: (e) => { t[k] = e.target.value; save({ terms: t, touch: false }); } })))));
}
function onePager(lead) {
  const m = state.config.markets[lead.region];
  const owner = lead.orgs.find(o => o.role === 'true_owner' || o.role === 'recorded_owner'), dev = lead.orgs.find(o => o.role === 'developer'), cap = lead.orgs.find(o => o.role === 'capital_partner');
  return h('div', { class: 'onepager' },
    h('div', { class: 'eyebrow' }, `Higney International · Nikki Beach lead ${lead.ref} · ${fmt.date(new Date())} · Confidential`),
    h('h1', {}, lead.name), h('p', {}, `${formatLabel(lead.format)} · ${[lead.city, lead.country].filter(Boolean).join(', ')} · ${stageLabel(lead.stage)} · Fit ${Math.round(lead.fit_score)} (${lead.grade[0]}) · Heat ${Math.round(lead.heat_score)} (${lead.temperature})`),
    h('p', {}, lead.summary || ''),
    h('dl', { class: 'kv' }, ...[['Owner', owner?.name], ['Developer', dev?.name], ['Capital partner', cap?.name], ['Counterparty type', fmt.title(lead.counterparty_type)], ['Land control', fmt.title(lead.land_control)], ['Structure', fmt.title(lead.deal_structure)], ['Capital', fmt.title(lead.capital_status)], ['Frontage', lead.beach_frontage_m ? `${lead.beach_frontage_m} m, ${lead.orientation || ''}` : ''], ['Club capacity', lead.seating_capacity], ['Hotel keys', lead.hotel_keys], ['Residences', lead.residences_units], ['Yacht access', lead.marina_access ? 'marina / tender dock' : ''], ['Airport', lead.airport_minutes ? `${lead.airport_minutes} min` : ''], ['Season', lead.season_months ? `${lead.season_months} months` : ''], ['Alcohol', fmt.title(lead.alcohol_licence)], ['Curfew', lead.music_curfew], ['Target opening', lead.target_open], ['Est. gross revenue', fmt.money(lead.est_revenue_usd)], ['Market', m ? `${m.label} (fit ${m.fit}/5)` : ''], ['Competitors circling', lead.competitors.join(', ')], ['Registered with Penrod', lead.registered ? `${fmt.date(lead.registered_at)} (${lead.registration_ref || 'no ref'})` : 'NOT YET']].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('h3', { style: { marginTop: '16px' } }, 'Brand fit'), h('dl', { class: 'kv' }, Object.entries(lead.score.groups).flatMap(([g, v]) => [h('dt', {}, state.config.scorecard.groups[g]?.label || g), h('dd', {}, `${Math.round(v)} / 100`)])),
    lead.score.knockouts.length ? h('p', {}, h('b', {}, 'Knock-outs failed: '), lead.score.knockouts.map(k => k.label).join('; ')) : null,
    lead.score.fit.unknown_knockouts.length ? h('p', {}, h('b', {}, 'Knock-outs to verify: '), lead.score.fit.unknown_knockouts.map(k => k.label).join('; ')) : null,
    h('h3', { style: { marginTop: '16px' } }, 'Next action'), h('p', {}, lead.next_action ? `${lead.next_action}${lead.next_action_due ? ` (due ${fmt.date(lead.next_action_due)})` : ''}` : 'none set'),
  );
}

// ---------- Modals
function modal(title, sub, bodyEl, actions) {
  const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) ov.remove(); } }, h('div', { class: 'modal' }, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null, bodyEl, h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', 'data-keep': '1', onclick: () => ov.remove() }, 'Cancel'), ...actions(() => ov.remove()))));
  if (/^(New |Hand off )/.test(title)) ov.dataset.unlocked = '1';
  else if (!state.editing) {   // 9/30 Austin: detail pop-ups open read-only with an Edit button bottom left
    const foot = ov.querySelector('.modal-foot');
    const edit = h('button', { class: 'btn', 'data-keep': '1', style: { marginRight: 'auto' }, onclick: () => {
      ov.dataset.unlocked = '1'; ov.classList.remove('locked');
      for (const el of ov.querySelectorAll('[data-lock-disabled]')) { el.disabled = false; delete el.dataset.lockDisabled; }
      edit.remove(); ov.querySelector('input,select,textarea')?.focus();
    } }, 'Edit');
    foot.prepend(edit);
  }
  document.body.append(ov);
  setTimeout(() => ov.querySelector('input,select,textarea')?.focus(), 30);
  return ov;
}
function newLeadModal() {
  const f = {};
  const inp = (key, label, type = 'text', options) => h('div', { class: `field${type === 'textarea' ? ' full' : ''}` }, h('label', {}, label), options ? h('select', { onchange: (e) => f[key] = e.target.value }, h('option', { value: '' }, '—'), options().map(([v, l]) => h('option', { value: v }, l))) : type === 'textarea' ? h('textarea', { onchange: (e) => f[key] = e.target.value }) : h('input', { type, onchange: (e) => f[key] = e.target.value }));
  const body = h('div', { class: 'form-grid' }, inp('name', 'Site / property name'), inp('format', 'Format', 'select', SEL.format), inp('country', 'Country'), inp('region', 'Market', 'select', SEL.region), inp('city', 'City / area'), inp('source', 'How we found it', 'select', SEL.source), inp('counterparty_type', 'Counterparty type (if known)', 'select', SEL.counterparty_type), inp('land_control', 'Land control (if known)', 'select', SEL.land_control), inp('summary', 'Summary: what is it and why now', 'textarea'));
  modal('New lead', 'A name is enough to start. Everything else can wait until you know it.', body, (close) => [h('button', { class: 'btn primary', onclick: async () => { if (!f.name) return toast('Name required', true); try { const lead = await api('/api/leads', { method: 'POST', body: f }); await refreshLeads(); close(); toast('Lead created'); navigate(`/lead/${lead.id}`); } catch (e) { toast(e.message, true); } } }, 'Create lead')]);
}
function registerModal(lead) {
  const f = { registered_with: 'Penrod Management Group', registered_at: today(), registration_ref: '' };
  const body = h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', {}, 'Registered with'), h('input', { value: f.registered_with, onchange: (e) => f.registered_with = e.target.value })), h('div', { class: 'field' }, h('label', {}, 'Date'), h('input', { type: 'date', value: f.registered_at, onchange: (e) => f.registered_at = e.target.value })), h('div', { class: 'field full' }, h('label', {}, 'Reference (email subject, ref number)'), h('input', { onchange: (e) => f.registration_ref = e.target.value })));
  modal('Register deal', 'Registration is what protects the HI closing fee and trailing commission. Register before Nikki Beach hears the name from anyone else.', body, (close) => [h('button', { class: 'btn hot', onclick: async () => { await api(`/api/leads/${lead.id}/register`, { method: 'POST', body: f }); await refreshLeads(); close(); toast('Registered'); render(); } }, 'Register')]);
}
function statusModal(lead, save, preset) {
  const f = { status: preset || (lead.status === 'active' ? 'parked' : 'active'), lost_reason: lead.lost_reason || '', lost_to: lead.lost_to || '', park_until: lead.park_until || '' };
  const body = h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', {}, 'Status'), h('select', { onchange: (e) => f.status = e.target.value }, [['active', 'Active'], ['parked', 'Parked (revisit later)'], ['lost', 'Lost (went elsewhere)'], ['dead', 'Dead (never viable)'], ['won', 'Won (agreement signed)']].map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)))),
    h('div', { class: 'field' }, h('label', {}, 'Revisit on (if parked)'), h('input', { type: 'date', value: f.park_until, onchange: (e) => f.park_until = e.target.value })),
    h('div', { class: 'field' }, h('label', {}, 'Lost to (brand)'), h('input', { value: f.lost_to, list: 'comp-list', onchange: (e) => f.lost_to = e.target.value }), h('datalist', { id: 'comp-list' }, state.config.competitors.map(c => h('option', { value: c.name })))),
    h('div', { class: 'field full' }, h('label', {}, 'Reason'), h('input', { value: f.lost_reason, onchange: (e) => f.lost_reason = e.target.value, placeholder: 'e.g. owner signed with Nammos; concession not renewed; hotel operator wanted its own F&B' })));
  modal('Change status', 'Lost and dead leads keep their history. Reasons feed the footprint lessons.', body, (close) => [h('button', { class: 'btn primary', onclick: async () => { await save(f); close(); render(); } }, 'Save')]);
}
function orgModal(org = null, after) {
  const f = { name: org?.name || '', kind: org?.kind || 'developer', country: org?.country || '', website: org?.website || '', portfolio: org?.portfolio || '', brands_worked_with: org?.brands_worked_with || '', notes: org?.notes || '' };
  const kinds = [['developer', 'Master developer / landowner'], ['sovereign', 'Sovereign fund / tourism authority developer'], ['family_office', 'Family office / private owner'], ['investor', 'Investor / fund'], ['hotel_operator', 'Hotel operator'], ['restaurant_group', 'Restaurant / beach club group'], ['broker', 'Broker / advisor'], ['government', 'Government / authority'], ['lender', 'Lender'], ['architect', 'Architect / master planner'], ['other', 'Other']];
  const t = (k, l) => h('div', { class: 'field' }, h('label', {}, l), h('input', { value: f[k], onchange: (e) => f[k] = e.target.value }));
  const body = h('div', { class: 'form-grid' }, t('name', 'Name'), h('div', { class: 'field' }, h('label', {}, 'Type'), h('select', { onchange: (e) => f.kind = e.target.value }, kinds.map(([v, l]) => h('option', { value: v, selected: v === f.kind }, l)))), t('country', 'Country'), t('website', 'Website'), h('div', { class: 'field full' }, h('label', {}, 'Portfolio (what they own or have built)'), h('textarea', { onchange: (e) => f.portfolio = e.target.value }, f.portfolio)), h('div', { class: 'field full' }, h('label', {}, 'Hospitality brands they have worked with'), h('input', { value: f.brands_worked_with, onchange: (e) => f.brands_worked_with = e.target.value })), h('div', { class: 'field full' }, h('label', {}, 'Notes (reputation, who we know there)'), h('textarea', { onchange: (e) => f.notes = e.target.value }, f.notes)));
  modal(org ? org.name : 'New organisation', org ? `${fmt.title(org.kind)} · added ${fmt.date(org.created_at)}` : 'Developers, landowners, investors, brokers, authorities.', body, (close) => [org ? h('button', { class: 'btn ghost danger', onclick: async () => { if (!confirm('Delete this organisation?')) return; await api(`/api/orgs/${org.id}`, { method: 'DELETE' }); await loadAll(); close(); render(); } }, 'Delete') : null, h('button', { class: 'btn primary', onclick: async () => { if (!f.name) return toast('Name required', true); const saved = org ? await api(`/api/orgs/${org.id}`, { method: 'PATCH', body: f }) : await api('/api/orgs', { method: 'POST', body: f }); await loadAll(); close(); toast('Saved'); if (after) after(saved); else render(); } }, 'Save')]);
}
function contactModal(c = null, after) {
  const f = { name: c?.name || '', title: c?.title || '', org_id: c?.org_id || '', email: c?.email || '', phone: c?.phone || '', linkedin: c?.linkedin || '', role: c?.role || '', introduced_by: c?.introduced_by || '', notes: c?.notes || '', private: !!c?.private_to };
  const t = (k, l, type = 'text') => h('div', { class: 'field' }, h('label', {}, l), h('input', { type, value: f[k], onchange: (e) => f[k] = e.target.value }));
  const body = h('div', { class: 'form-grid' }, t('name', 'Name'), t('title', 'Title'), h('div', { class: 'field' }, h('label', {}, 'Organisation'), h('select', { onchange: (e) => f.org_id = e.target.value }, h('option', { value: '' }, '—'), state.orgs.map(o => h('option', { value: o.id, selected: o.id === Number(f.org_id) }, o.name)))), h('div', { class: 'field' }, h('label', {}, 'Typical role'), h('select', { onchange: (e) => f.role = e.target.value }, h('option', { value: '' }, '—'), CONTACT_ROLES.map(([v, l]) => h('option', { value: v, selected: v === f.role }, l)))), t('email', 'Email', 'email'), t('phone', 'Phone'), t('linkedin', 'LinkedIn'), t('introduced_by', 'Introduced by'), h('div', { class: 'field full' }, h('label', {}, 'Notes'), h('textarea', { onchange: (e) => f.notes = e.target.value }, f.notes)), h('label', { class: 'gate-row full' }, h('input', { type: 'checkbox', checked: f.private, onchange: (e) => f.private = e.target.checked }), h('span', {}, 'Private to me (family network stays private)')));
  modal(c ? c.name : 'New contact', c ? [c.title, c.org_name].filter(Boolean).join(' · ') : 'Who owns the decision, and who can walk us in.', body, (close) => [c ? h('button', { class: 'btn ghost danger', onclick: async () => { if (!confirm('Delete this contact?')) return; await api(`/api/contacts/${c.id}`, { method: 'DELETE' }); await loadAll(); close(); render(); } }, 'Delete') : null, h('button', { class: 'btn primary', onclick: async () => { if (!f.name) return toast('Name required', true); const payload = { ...f, org_id: f.org_id ? Number(f.org_id) : null }; const saved = c ? await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: payload }) : await api('/api/contacts', { method: 'POST', body: payload }); await loadAll(); close(); toast('Saved'); if (after) after(saved); else render(); } }, 'Save')]);
}

// ---------- Command palette
function openCmdk() {
  $('.cmdk')?.remove();
  const list = h('div', { class: 'cmdk-list' });
  const input = h('input', { placeholder: 'Jump to a lead, contact, market or view…', oninput: () => draw(input.value) });
  const box = h('div', { class: 'cmdk', onclick: (e) => { if (e.target === box) box.remove(); } }, h('div', { class: 'cmdk-box' }, input, list));
  let sel = 0, items = [];
  const draw = (q) => {
    const s = q.toLowerCase();
    items = [
      ...NAV.filter(n => n[0] !== 'sep' && n[1].toLowerCase().includes(s)).map(([p, l]) => ({ label: l, meta: 'view', go: () => navigate(p) })),
      ...state.leads.filter(l => [l.name, l.country, l.ref, l.city].join(' ').toLowerCase().includes(s)).slice(0, 8).map(l => ({ label: l.name, meta: `${l.ref} · ${l.country || ''} · ${l.grade} · ${l.temperature}`, go: () => navigate(`/lead/${l.id}`) })),
      ...state.contacts.filter(c => [c.name, c.org_name].join(' ').toLowerCase().includes(s)).slice(0, 5).map(c => ({ label: c.name, meta: c.org_name || 'contact', go: () => contactModal(c) })),
      ...state.orgs.filter(o => o.name.toLowerCase().includes(s)).slice(0, 5).map(o => ({ label: o.name, meta: fmt.title(o.kind), go: () => orgModal(o) })),
      ...Object.entries(state.config.markets).filter(([, m]) => m.label.toLowerCase().includes(s)).slice(0, 4).map(([k, m]) => ({ label: m.label, meta: `market · fit ${m.fit}/5`, go: () => { state.filters.region = k; navigate('/'); } })),
    ];
    if (s) items.push({ label: `Create lead "${q}"`, meta: 'action', go: () => { newLeadModal(); setTimeout(() => { const i = $('.modal input'); if (i) { i.value = q; i.dispatchEvent(new Event('change')); } }, 50); } });
    sel = 0;
    list.replaceChildren(...items.map((it, i) => h('div', { class: `cmdk-item${i === sel ? ' sel' : ''}`, onclick: () => { box.remove(); it.go(); } }, h('span', {}, it.label), h('span', { class: 'muted small' }, it.meta))));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') sel = Math.min(items.length - 1, sel + 1); else if (e.key === 'ArrowUp') sel = Math.max(0, sel - 1); else if (e.key === 'Enter') { box.remove(); items[sel]?.go(); return; } else return; list.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === sel)); });
  document.body.append(box); draw(''); input.focus();
}

boot();
