/* Hesabu — single-page front end. No build step, no framework.
   Each screen is a module that returns HTML; buttons carry data-act and are
   handled by the matching function in `actions`. Routes live in the URL hash
   (#/invoices/abc123) so reloads and links land in the right place. */

import { state, app, api, can, toast, esc, whenSignedOut, loadReference } from './js/core.js';
import * as gate from './js/views/gate.js';
import * as today from './js/views/today.js';
import * as quotations from './js/views/quotations.js';
import * as invoices from './js/views/invoices.js';
import * as recurring from './js/views/recurring.js';
import * as payments from './js/views/payments.js';
import * as operations from './js/views/operations.js';
import * as items from './js/views/items.js';
import * as clients from './js/views/clients.js';
import * as reminders from './js/views/reminders.js';
import * as importer from './js/views/import.js';
import * as audit from './js/views/audit.js';
import * as team from './js/views/team.js';
import * as settings from './js/views/settings.js';
import * as account from './js/views/account.js';

const modules = [gate, today, quotations, invoices, recurring, payments, operations, items, clients, reminders, importer, audit, team, settings, account];
const routes = Object.assign({}, ...modules.map((m) => m.routes || {}));
const actions = Object.assign({}, ...modules.map((m) => m.actions || {}));

const NAV = [
  [null, [['today', 'Today']]],
  ['Money', [['quotations', 'Quotations', 'tallyQuotes'], ['invoices', 'Invoices', 'tallyInvoices'], ['recurring', 'Recurring'], ['payments', 'Payments', 'tallyPayments']]],
  ['Work', [['operations', 'Operations', 'tallyJobs'], ['items', 'Items & stock', 'tallyStock'], ['clients', 'Clients']]],
  ['Admin', [['reminders', 'Reminders'], ['import', 'Import'], ['audit', 'Audit log'], ['team', 'Team'], ['settings', 'Settings']]]
];

const main = document.getElementById('main');
const shell = document.getElementById('shell');
const gateEl = document.getElementById('gate');

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const [route = 'today', param = null] = path.split('/');
  return { route: route || 'today', param, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function buildNav() {
  const html = NAV.map(([group, links]) => {
    const visible = links.filter(([route]) => !routes[route].permission || can(routes[route].permission));
    if (!visible.length) return '';
    return `${group ? `<div class="group" aria-hidden="true">${group}</div>` : ''}
      ${visible.map(([route, label, tally]) => `<a href="#/${route}" data-route="${route}">${label}${tally ? `<span class="tally" id="${tally}"></span>` : ''}</a>`).join('')}`;
  }).join('');
  document.getElementById('nav').innerHTML = html;
}

function markNav(route) {
  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

let firstRender = true;
let renderSeq = 0;

async function render() {
  const { route, param, query } = parseHash();

  if (route === 'link') return gate.showLink(param);
  if (!state.me) return;

  const view = routes[route] || routes.today;
  const name = routes[route] ? route : 'today';
  markNav(name);
  const seq = ++renderSeq;
  main.setAttribute('aria-busy', 'true');
  if (!main.innerHTML) main.innerHTML = '<div class="empty">Loading…</div>';

  try {
    if (view.permission && !can(view.permission)) {
      main.innerHTML = `<div class="head"><h1 tabindex="-1">${esc(view.title)}</h1></div>
        <div class="empty"><p>Your role doesn't include this screen. Ask the owner if you need it.</p></div>`;
    } else {
      const html = await view.render(param, query);
      if (seq !== renderSeq) return; // a newer navigation won the race
      main.innerHTML = html;
      if (view.mount) view.mount(main, param, query);
    }
    document.title = `${typeof view.title === 'function' ? view.title(param) : view.title} · Hesabu`;
  } catch (err) {
    if (seq !== renderSeq) return;
    main.innerHTML = `<div class="head"><h1 tabindex="-1">Something went wrong</h1></div>
      <div class="empty"><p>Could not load this screen: ${esc(err.message)}</p>
      <button class="ghost" data-act="reload">Try again</button></div>`;
  } finally {
    if (seq === renderSeq) main.removeAttribute('aria-busy');
  }

  // Move focus to the new heading so screen readers announce the page — but not on first load.
  if (!firstRender && !document.getElementById('sheet').open) {
    const h1 = main.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus(); }
  }
  firstRender = false;
  chrome();
}

async function chrome() {
  if (!state.me) return;
  try {
    const d = await api('/dashboard');
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n || ''; };
    set('tallyQuotes', d.openQuotations);
    set('tallyInvoices', d.unpaidInvoices);
    set('tallyJobs', d.jobsDueToday);
    set('tallyStock', d.lowStock.length);
    set('tallyPayments', d.unallocatedMpesa.count);
    const labels = [['tallyQuotes', 'open'], ['tallyInvoices', 'unpaid'], ['tallyJobs', 'due'], ['tallyStock', 'low'], ['tallyPayments', 'unmatched']];
    labels.forEach(([id, word]) => { const el = document.getElementById(id); if (el && el.textContent) el.setAttribute('aria-label', `${el.textContent} ${word}`); });
  } catch { /* the screen itself shows any error */ }
}

async function enter(me) {
  state.me = me;
  gateEl.hidden = true;
  gateEl.innerHTML = ''; // no stale sign-in form lingering in the page
  shell.hidden = false;
  document.getElementById('accountName').textContent = me.name;
  document.getElementById('accountRole').textContent = me.role;
  document.getElementById('accountButton').setAttribute('aria-label', `Account: ${me.name}, ${me.role}`);
  state.settings = await api('/settings');
  document.getElementById('companyName').textContent = state.settings.name;
  await loadReference(true);
  buildNav();
  if (parseHash().route === 'link') location.hash = '#/today';
  firstRender = true;
  await render();
}

app.render = render;
app.chrome = chrome;
app.enter = enter;
app.signOut = () => {
  state.me = null;
  shell.hidden = true;
  main.innerHTML = '';
  gate.showSignIn();
};

whenSignedOut(() => { if (state.me) { toast('Your session ended. Please sign in again.', true); app.signOut(); } });

actions.reload = () => render();

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  try {
    await actions[el.dataset.act](el, e);
  } catch (err) {
    toast(err.message, true);
  }
});

window.addEventListener('hashchange', render);

/* ---------- appearance ---------- */

const themeSelect = document.getElementById('themeSelect');
try { themeSelect.value = localStorage.getItem('hesabu-theme') || 'system'; } catch { themeSelect.value = 'system'; }
themeSelect.addEventListener('change', () => {
  const v = themeSelect.value;
  if (v === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  try { localStorage.setItem('hesabu-theme', v); } catch { /* not saved; still applied */ }
});

/* ---------- boot ---------- */

(async function boot() {
  if (parseHash().route === 'link') return gate.showLink(parseHash().param);
  // Ask first rather than calling /auth/me blind, so a signed-out visit doesn't log a 401.
  const status = await api('/auth/status').catch(() => ({ needsSetup: false, signedIn: false }));
  if (status.signedIn) {
    try { return await enter(await api('/auth/me')); } catch { /* fall through to sign-in */ }
  }
  if (status.needsSetup) gate.showSetup();
  else gate.showSignIn();
})();
