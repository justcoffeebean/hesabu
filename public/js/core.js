/* Shared plumbing for every screen: API calls, the dialog, formatting, permissions. */

export const state = { me: null, settings: {}, currencies: { base: 'KES', currencies: [] }, clients: [], items: [] };

/** Filled in by app.js so screens can ask for a redraw or a new route without importing the shell. */
export const app = {
  render: async () => {},
  chrome: async () => {},
  go: (hash) => { if (location.hash === hash) app.render(); else location.hash = hash; }
};

/* ---------------- API ---------------- */

export class ApiError extends Error {
  constructor(status, data) {
    super(data.error || 'Request failed.');
    this.status = status;
    this.data = data;
  }
}

let onSignedOut = () => {};
export const whenSignedOut = (fn) => { onSignedOut = fn; };

export async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
  if (res.status === 401 && !path.startsWith('/auth/')) onSignedOut();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const can = (permission) => Boolean(state.me && state.me.permissions.includes(permission));

/* ---------------- feedback ---------------- */

export function toast(message, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show' + (bad ? ' bad' : '');
  el.setAttribute('role', bad ? 'alert' : 'status');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, bad ? 6000 : 3200);
}

/* ---------------- formatting ---------------- */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "KES 1,200.00" — the code always shown when it isn't the base currency. */
export const cash = (n, currency) => `${currency || state.currencies.base} ${money(n)}`;

const STATUS_LABEL = { 'part-paid': 'part paid', todo: 'to do', doing: 'in progress', logged: 'logged only' };
export const pill = (s, cls = s) => `<span class="pill ${esc(cls)}">${esc(STATUS_LABEL[s] || s)}</span>`;

/** Today in the browser's own timezone — never UTC's. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function plusDays(n, from = today()) {
  const [y, m, d] = from.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d} ${MONTHS[+m - 1]} ${y.slice(2)}`;
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------------- dialog ---------------- */

const sheet = document.getElementById('sheet');
let onSave = null;
let returnFocus = null;

/**
 * openSheet('Title', html, async () => { ...; closeSheet(); }, 'Save', { wide, hideSave })
 * The handler may throw; its message shows inside the dialog.
 */
export function openSheet(title, bodyHtml, handler, saveLabel = 'Save', opts = {}) {
  if (!sheet.open) returnFocus = document.activeElement;
  document.getElementById('sheetTitle').textContent = title;
  document.getElementById('sheetBody').innerHTML = bodyHtml;
  document.getElementById('sheetError').textContent = '';
  const save = document.getElementById('sheetSave');
  save.textContent = saveLabel;
  save.hidden = Boolean(opts.hideSave);
  save.disabled = false;
  document.getElementById('sheetCancel').textContent = opts.cancelLabel || 'Cancel';
  sheet.classList.toggle('wide', Boolean(opts.wide));
  onSave = handler;
  sheet.onclose = () => {
    onSave = null;
    if (opts.onClose) opts.onClose();
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  };
  if (!sheet.open) sheet.showModal();
  const first = sheet.querySelector('#sheetBody input:not([type=hidden]):not([readonly]), #sheetBody select, #sheetBody textarea');
  if (first) first.focus();
}

export function closeSheet() {
  if (sheet.open) sheet.close();
}

export const sheetBody = () => document.getElementById('sheetBody');
export const sheetError = (message) => { document.getElementById('sheetError').textContent = message; };
export const setSaveLabel = (label, hidden = false) => {
  const save = document.getElementById('sheetSave');
  save.textContent = label;
  save.hidden = hidden;
};

document.getElementById('sheetClose').onclick = closeSheet;
document.getElementById('sheetCancel').onclick = closeSheet;
document.getElementById('sheetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!onSave) return;
  const btn = document.getElementById('sheetSave');
  btn.disabled = true;
  sheetError('');
  try {
    await onSave();
  } catch (err) {
    sheetError(err.message);
  } finally {
    btn.disabled = false;
  }
});

/** Value of a named field inside the dialog. Checkboxes give booleans. */
export function val(name) {
  const el = sheet.querySelector(`[name="${name}"]`);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

/* ---------------- small building blocks ---------------- */

export function field(label, name, { type = 'text', value = '', hint = '', attrs = '', id } = {}) {
  const fid = id || `f-${name}`;
  const hintId = hint ? `${fid}-hint` : '';
  return `<div class="field"><label for="${fid}">${esc(label)}</label>
    <input id="${fid}" name="${name}" type="${type}" value="${esc(value)}" ${hint ? `aria-describedby="${hintId}"` : ''} ${attrs}>
    ${hint ? `<p class="hint" id="${hintId}">${hint}</p>` : ''}</div>`;
}

export function selectField(label, name, options, selected, { hint = '', id } = {}) {
  const fid = id || `f-${name}`;
  return `<div class="field"><label for="${fid}">${esc(label)}</label>
    <select id="${fid}" name="${name}" ${hint ? `aria-describedby="${fid}-hint"` : ''}>
      ${options.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(text)}</option>`).join('')}
    </select>${hint ? `<p class="hint" id="${fid}-hint">${hint}</p>` : ''}</div>`;
}

export function currencyOptions() {
  return [state.currencies.base, ...state.currencies.currencies.map((c) => c.code)].map((c) => [c, c]);
}

export const clientOptions = (clients = state.clients) =>
  clients.length ? clients.map((c) => [c.id, c.name]) : [['', 'No clients yet — add one first']];

/** A table with an accessible caption and column scopes. cols: [label, className?] */
export function table(caption, cols, rowsHtml) {
  return `<div class="table-wrap"><table>
    <caption class="sr-only">${esc(caption)}</caption>
    <thead><tr>${cols.map(([label, cls = '']) => `<th scope="col" class="${cls}">${label ? esc(label) : '<span class="sr-only">Actions</span>'}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml}</tbody></table></div>`;
}

export function copyToClipboard(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => toast('Copied.'));
  toast('Select the link and copy it.');
  return Promise.resolve();
}

/** Reads a chosen file as text (for CSV imports). */
export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsText(file);
  });
}

export async function loadReference(force = false) {
  const tasks = [];
  if (force || !state.currencies.loaded) tasks.push(api('/currencies').then((c) => { state.currencies = { ...c, loaded: true }; }));
  if (can('clients:read')) tasks.push(api('/clients').then((c) => { state.clients = c; }));
  if (can('items:read')) tasks.push(api('/items').then((i) => { state.items = i; }));
  await Promise.all(tasks);
}
