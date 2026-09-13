/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — la app
   Un autenticador TOTP de escritorio. Las cuentas entran por un QR (leído de
   la pantalla, de una imagen o del portapapeles) o a mano; los códigos se
   calculan acá adentro cada segundo; y borrar una cuenta no pregunta: la saca
   al instante y deja un "Deshacer" en el toast por si el dedo se fue de largo.

   Dos capas: `S` es el espejo en memoria de lo que hay en disco (las vistas
   dibujan de ahí, nunca hacen IPC para pintarse), y el motor de tick es el
   único que toca el DOM por fuera de un repintado: una vez por segundo, y solo
   los nodos que cambian.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Menu, Modal } from './overlays.js';
import Palette from './palette.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2, exit, tick, bindSwitcher } from './motion.js';
import { viewEl, esc, paint, head, empty, attempt, copy, colorToken, path } from './ui.js';
import { plural, monogram, fmtDate } from './format.js';
import { designHTML, wireDesign } from './design-view.js';
import { totp, counterAt, msLeft, groupDigits, isValidSecret, normalizeSecret, ALGORITHMS } from './totp.js';
import { parseOtpauth, buildOtpauth, parseBackup } from './otpauth.js';

const api = window.onyx;

/* ══ Íconos del dominio ══════════════════════════════════════════════════════
   Sobre la misma grilla de 16 que el set base, trazo 1.5, puntas redondeadas. */
Icons.add({
  tessera: '<path d="M5.2 2.4h5.6a2.8 2.8 0 0 1 2.8 2.8v5.6a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8V5.2a2.8 2.8 0 0 1 2.8-2.8z"/><path d="M8 4.8a3.2 3.2 0 1 1-3.2 3.2"/>',
  qr: '<rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.1"/><rect x="9" y="2.2" width="4.8" height="4.8" rx="1.1"/><rect x="2.2" y="9" width="4.8" height="4.8" rx="1.1"/><path d="M9.2 9.2h2v2h-2zM11.8 11.8h2v2h-2z"/>',
  screen: '<rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.5"/><path d="M5.6 13.6h4.8M8 11.2v2.4"/>',
  image: '<rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.6"/><circle cx="5.7" cy="6.1" r="1.1"/><path d="M13.6 10.4 10.6 7.4l-4.2 4.2-1.7-1.7L2.5 12"/>',
  clipboard: '<path d="M6.2 2.4h3.6a1 1 0 0 1 1 1v.9H5.2v-.9a1 1 0 0 1 1-1z"/><path d="M4.6 3.7H4.2a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7.6a1.3 1.3 0 0 0 1.3-1.3V5a1.3 1.3 0 0 0-1.3-1.3h-.4"/><path d="M5.8 8.2h4.4M5.8 10.6h3"/>',
});

/* ══ Datos ═══════════════════════════════════════════════════════════════════ */

const S = {
  info: null,
  settings: {},
  accounts: [],
  codes: new Map(),   // id → { code, counter, msLeft, period } | { error } | null (sin clave)
  trash: null,        // la última cuenta borrada, por si hay que deshacer
};

const byId = (id) => S.accounts.find((a) => a.id === id) || null;
const sortAccounts = () => S.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

async function loadAll() {
  const [info, settings, accounts] = await Promise.all([api.info(), api.settings.get(), api.accounts.list()]);
  S.info = info;
  S.settings = settings;
  S.accounts = accounts;
  sortAccounts();
  await Promise.all(S.accounts.map(computeCode));
}

async function computeCode(acc, now = Date.now()) {
  if (acc.broken || !acc.secret) { S.codes.set(acc.id, null); return null; }
  try {
    const c = await totp(acc.secret, { digits: acc.digits, period: acc.period, algorithm: acc.algorithm, now });
    S.codes.set(acc.id, c);
    return c;
  } catch (err) {
    S.codes.set(acc.id, { error: err.message });
    return null;
  }
}

async function saveAccount(acc) {
  const saved = await api.accounts.save(acc);
  S.accounts = [...S.accounts.filter((a) => a.id !== saved.id), saved];
  sortAccounts();
  await computeCode(saved);
  registerCommands();
  updateChrome();
  return saved;
}

/* ══ El motor de tick ════════════════════════════════════════════════════════
   Una vez por segundo, alineado al segundo del reloj: recalcula los códigos
   cuyo contador cambió, y mueve el anillo y los segundos de cada fila visible.
   El anillo apunta al valor de DENTRO de un segundo y llega justo cuando
   vuelve a correr el tick, así el reloj se ve continuo y nunca atrasado. */

const RING_C = 2 * Math.PI * 15.5;   // circunferencia del anillo (r=15.5 en un viewBox de 36)
let tickTimer = null;

function startTicking() {
  const loop = async () => {
    const now = Date.now();
    const changed = [];
    for (const acc of S.accounts) {
      const c = S.codes.get(acc.id);
      if (c && !c.error && counterAt(now, acc.period) !== c.counter) changed.push(acc);
    }
    if (changed.length) await Promise.all(changed.map((a) => computeCode(a, now)));
    paintTick(now, new Set(changed.map((a) => a.id)));
    tickTimer = setTimeout(loop, 1000 - (now % 1000) + 8);
  };
  clearTimeout(tickTimer);
  loop();
}

function ringOffset(msLeftValue, period) {
  const ahead = Math.max(0, msLeftValue - 1000);
  return RING_C * (1 - ahead / (period * 1000));
}

/** El anillo del tiempo, listo para pegar al lado de un código. */
function ringHTML(left, period) {
  return `
    <svg class="ts-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="ts-ring__track" cx="18" cy="18" r="15.5"/>
      <circle class="ts-ring__arc" cx="18" cy="18" r="15.5" stroke-dasharray="${RING_C}" style="stroke-dashoffset:${ringOffset(left, period)}"/>
      <text class="ts-ring__sec" x="18" y="18">${Math.ceil(left / 1000)}</text>
    </svg>`;
}

/** Mueve el anillo y los segundos de un contenedor (una fila, la vista previa). */
function updateRing(host, left, period) {
  const arc = host.querySelector('.ts-ring__arc');
  const sec = host.querySelector('.ts-ring__sec');
  if (arc) {
    const target = ringOffset(left, period);
    // Al reiniciarse el período, el arco saltaría "hacia atrás" (lleno de
    // nuevo). Ese salto va sin transición: es un reinicio, no un movimiento.
    if (target < Number(arc.dataset.offset ?? Infinity)) {
      arc.classList.add('is-reset');
      arc.style.strokeDashoffset = target;
      void arc.getBoundingClientRect();
      arc.classList.remove('is-reset');
    } else {
      arc.style.strokeDashoffset = target;
    }
    arc.dataset.offset = target;
  }
  if (sec) sec.textContent = Math.ceil(left / 1000);
  host.classList.toggle('is-expiring', left <= 5000);
}

function paintTick(now, changedIds = new Set()) {
  const stat = document.querySelector('#stat-period .ox-statusbar__value');
  if (stat) stat.textContent = `${Math.ceil(msLeft(now, 30) / 1000)} s`;
  if (Router.name !== 'codigos') return;

  for (const row of viewEl().querySelectorAll('.ts-acc[data-id]')) {
    const acc = byId(row.dataset.id);
    const c = acc && S.codes.get(acc.id);
    if (!acc || !c || c.error) continue;

    updateRing(row, msLeft(now, acc.period), acc.period);
    if (changedIds.has(acc.id)) {
      const codeEl = row.querySelector('.ts-code');
      if (codeEl) { codeEl.textContent = displayCode(c.code); tick(codeEl); }
    }
  }
}

const displayCode = (code) => (S.settings.agrupar ? groupDigits(code) : code);

/* ══ Vista: Códigos ══════════════════════════════════════════════════════════ */

function addButtonsHTML(variant = 'secondary') {
  return `
    <button class="ox-btn ox-btn--${variant} ox-flashable" data-action="scan"><i data-icon="screen"></i> Escanear la pantalla</button>
    <button class="ox-btn ox-btn--secondary ox-flashable" data-action="image"><i data-icon="image"></i> Desde una imagen</button>
    <button class="ox-btn ox-btn--secondary ox-flashable" data-action="clipboard"><i data-icon="clipboard"></i> Del portapapeles</button>
    <button class="ox-btn ox-btn--ghost ox-flashable" data-action="manual"><i data-icon="edit"></i> A mano</button>`;
}

function viewCodigos() {
  const n = S.accounts.length;
  paint(head({
    title: 'Códigos',
    sub: n ? `${plural(n, 'cuenta', 'cuentas')} · un clic copia el código` : 'Todavía no hay cuentas',
    actions: n ? '<button class="ox-btn ox-btn--primary ox-flashable" data-menu="add"><i data-icon="plus"></i> Agregar cuenta</button>' : '',
  }) + (n
    ? `<div class="ox-scroll ox-grow">
         <div class="ox-list" id="acc-list">${S.accounts.map(rowHTML).join('')}</div>
         <div style="height:32px"></div>
       </div>`
    : empty({
      icon: 'tessera',
      title: 'Ninguna cuenta todavía',
      text: 'Dejá el QR del sitio visible en pantalla y Tessera lo lee solo. También sirve una imagen guardada, el portapapeles, o la clave escrita a mano.',
      actions: addButtonsHTML('primary'),
    })));
  paintTick(Date.now());
}

function rowHTML(acc) {
  const c = S.codes.get(acc.id);
  const name = acc.issuer || acc.account || acc.id;
  const sub = acc.issuer ? acc.account : '';
  const copiable = S.settings.copiarAlClic && c && !c.error;
  const cls = `ox-listitem ts-acc${copiable ? ' is-copiable' : ''}${S.settings.ocultar ? ' is-masked' : ''}`;

  let middle;
  if (!c) {
    middle = `<span class="ts-code ts-code--broken" data-tip="No se pudo descifrar la clave. Restaurala desde un respaldo o borrá la cuenta."><i data-icon="alert" data-icon-class="ox-icon--sm"></i> Sin clave</span>`;
  } else if (c.error) {
    middle = `<span class="ts-code ts-code--broken" data-tip="${esc(c.error)}"><i data-icon="alert" data-icon-class="ox-icon--sm"></i> Clave inválida</span>`;
  } else {
    middle = `<span class="ts-code ox-copyable">${esc(displayCode(c.code))}</span>${ringHTML(c.msLeft, acc.period)}`;
  }

  return `
    <div class="${cls}" data-id="${esc(acc.id)}" role="button" tabindex="0">
      <div class="ox-avatar">${esc(monogram(name))}</div>
      <div class="ox-listitem__main">
        <span class="ox-listitem__title ox-truncate">${esc(name)}</span>
        ${sub ? `<span class="ox-listitem__sub ox-truncate">${esc(sub)}</span>` : ''}
      </div>
      ${middle}
      <div class="ox-rowactions">
        ${c && !c.error ? '<button class="ox-iconbtn ox-iconbtn--sm" data-act="copy" data-tip="Copiar"><i data-icon="copy"></i></button>' : ''}
        <button class="ox-iconbtn ox-iconbtn--sm" data-act="edit" data-tip="Renombrar"><i data-icon="edit"></i></button>
        <button class="ox-iconbtn ox-iconbtn--sm" data-act="delete" data-tip="Eliminar"><i data-icon="trash"></i></button>
      </div>
    </div>`;
}

async function copyCode(id) {
  const acc = byId(id);
  const c = S.codes.get(id);
  if (!acc || !c || c.error) return;
  // Si le quedan menos de 3 s, copiar el que ya está vencido es una trampa:
  // se copia el siguiente, que es el que va a valer cuando lo pegues.
  const now = Date.now();
  let code = c.code;
  if (msLeft(now, acc.period) < 3000) {
    try { code = (await totp(acc.secret, { digits: acc.digits, period: acc.period, algorithm: acc.algorithm, now: now + acc.period * 1000 })).code; } catch { /* se copia el vigente */ }
  }
  await copy(code, { label: `Código de ${acc.issuer || acc.account}` });
}

/* ══ Agregar ═════════════════════════════════════════════════════════════════ */

/** Toma el texto de un QR (o null), lo parsea, y si está bien lo confirma. */
async function intake(readFn, { emptyTitle, emptyText }) {
  let data;
  try { data = await readFn(); } catch (err) { Toast.error('No se pudo leer el QR', err.message); return; }
  if (data === undefined) return;                       // el diálogo se canceló
  if (data === null) { Toast.show({ title: emptyTitle, text: emptyText, icon: 'search' }); return; }
  let parsed;
  try { parsed = parseOtpauth(data); } catch (err) { Toast.error('Ese QR no sirve', err.message); return; }
  await confirmAccount(parsed);
}

const addFromScreen = () => intake(() => api.qr.screen(), {
  emptyTitle: 'Ningún QR a la vista',
  emptyText: 'Dejá el código QR visible en pantalla (sin nada encima) y volvé a intentar.',
});
const addFromFile = () => intake(() => api.qr.file(), {
  emptyTitle: 'La imagen no tiene un QR',
  emptyText: 'Probá con una captura más grande o sin recortar.',
});
const addFromClipboard = () => intake(() => api.qr.clipboard(), {
  emptyTitle: 'Nada en el portapapeles',
  emptyText: 'Copiá una imagen con el QR, o el texto otpauth:// del sitio.',
});

/** Segmentado + su cableado, para los tres parámetros avanzados. */
function segHTML(id, options, value) {
  return `<div class="ox-segmented" id="${id}" style="width:max-content">${options
    .map((o) => `<button class="ox-segmented__opt${String(o) === String(value) ? ' is-active' : ''}" data-value="${o}">${o}</button>`)
    .join('')}</div>`;
}

/** Modal de confirmación: qué se va a guardar, con el código vigente al lado
    para cotejar contra el sitio antes de decir que sí. */
async function confirmAccount(parsed) {
  const body = document.createElement('div');
  body.className = 'ox-col';
  body.style.gap = '16px';

  // El código de la vista previa vive: corre con su anillo mientras el modal
  // está abierto, y cambia cuando cambia el período. Si el sitio te pide "el
  // código actual" para terminar de activar el 2FA, es este, y se copia de acá.
  let current = null;
  try { current = await totp(parsed.secret, parsed); } catch { /* clave rara: se muestra el guion */ }

  body.innerHTML = `
    <div class="ts-preview">
      <span class="ts-code ox-copyable" id="prev-code">${esc(current ? displayCode(current.code) : '—')}</span>
      ${current ? ringHTML(current.msLeft, parsed.period) : ''}
      <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" id="prev-copy"${current ? '' : ' disabled'}><i data-icon="copy"></i> Copiar</button>
      <span class="ox-meta ts-preview__note">El código de ahora. Si el sitio te pide uno para activar, es este.</span>
    </div>
    <div class="ox-field">
      <label class="ox-field__label">Emisor</label>
      <input class="ox-input" id="f-issuer" placeholder="El sitio o servicio" spellcheck="false">
    </div>
    <div class="ox-field">
      <label class="ox-field__label">Cuenta</label>
      <input class="ox-input" id="f-account" placeholder="Tu usuario o mail ahí" spellcheck="false">
    </div>
    <div class="ox-row" style="gap:8px;flex-wrap:wrap">
      <span class="ox-chip ox-chip--mono">${esc(parsed.digits)} dígitos</span>
      <span class="ox-chip ox-chip--mono">${esc(parsed.period)} s</span>
      <span class="ox-chip ox-chip--mono">${esc(parsed.algorithm)}</span>
    </div>`;
  body.querySelector('#f-issuer').value = parsed.issuer;
  body.querySelector('#f-account').value = parsed.account;
  Icons.mount(body);

  const preview = body.querySelector('.ts-preview');
  const codeEl = body.querySelector('#prev-code');
  body.querySelector('#prev-copy').addEventListener('click', () => {
    if (current) copy(current.code, { label: 'Código copiado' });
  });
  const ticker = current ? setInterval(async () => {
    const now = Date.now();
    if (counterAt(now, parsed.period) !== current.counter) {
      try { current = await totp(parsed.secret, { ...parsed, now }); } catch { return; }
      codeEl.textContent = displayCode(current.code);
      tick(codeEl);
    }
    updateRing(preview, msLeft(now, parsed.period), parsed.period);
  }, 1000) : null;

  const ok = await Modal.show({
    title: 'Agregar esta cuenta',
    sub: 'La clave se guarda cifrada en tu disco. No sale de esta máquina.',
    body,
    width: 500,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Agregar', value: true, variant: 'primary', autofocus: true },
    ],
  });
  clearInterval(ticker);
  if (!ok) return null;

  return attempt(async () => {
    const acc = {
      ...parsed,
      id: await api.accounts.nextId(),
      issuer: body.querySelector('#f-issuer').value.trim(),
      account: body.querySelector('#f-account').value.trim(),
      createdAt: Date.now(),
    };
    const saved = await saveAccount(acc);
    Toast.show({ title: 'Cuenta agregada', text: saved.issuer || saved.account, icon: 'check' });
    Router.name === 'codigos' ? Router.refresh() : Router.go('codigos');
    return saved;
  }, { errorTitle: 'No se pudo guardar la cuenta' });
}

/** Alta a mano: emisor, cuenta y la clave base32, con los parámetros raros plegados. */
async function addManual() {
  const body = document.createElement('div');
  body.className = 'ox-col';
  body.style.gap = '16px';
  body.innerHTML = `
    <div class="ox-field">
      <label class="ox-field__label">Emisor</label>
      <input class="ox-input" id="f-issuer" placeholder="El sitio o servicio" spellcheck="false">
    </div>
    <div class="ox-field">
      <label class="ox-field__label">Cuenta</label>
      <input class="ox-input" id="f-account" placeholder="Tu usuario o mail ahí" spellcheck="false">
    </div>
    <div class="ox-field">
      <label class="ox-field__label">Clave secreta</label>
      <input class="ox-input ox-input--mono" id="f-secret" placeholder="La clave base32 que muestra el sitio" spellcheck="false" autocomplete="off">
      <span class="ox-field__hint" id="f-secret-hint">Letras A–Z y dígitos 2–7. Los espacios no importan.</span>
    </div>
    <div class="ox-row" style="gap:20px;flex-wrap:wrap;align-items:flex-end">
      <div class="ox-field"><label class="ox-field__label">Dígitos</label>${segHTML('f-digits', [6, 8], 6)}</div>
      <div class="ox-field"><label class="ox-field__label">Período</label>${segHTML('f-period', [30, 60], 30)}</div>
      <div class="ox-field"><label class="ox-field__label">Algoritmo</label>${segHTML('f-algo', ALGORITHMS, 'SHA1')}</div>
    </div>`;

  const params = { digits: 6, period: 30, algorithm: 'SHA1' };
  const secret = body.querySelector('#f-secret');
  const hint = body.querySelector('#f-secret-hint');

  const done = Modal.show({
    title: 'Cuenta a mano',
    sub: 'Para cuando el sitio te da la clave en texto en vez de un QR.',
    body,
    width: 520,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Agregar', value: true, variant: 'primary' },
    ],
  });

  // El modal ya está montado: se cablean los segmentados y la validación en vivo.
  bindSwitcher(body.querySelector('#f-digits'), (v) => { params.digits = Number(v); });
  bindSwitcher(body.querySelector('#f-period'), (v) => { params.period = Number(v); });
  bindSwitcher(body.querySelector('#f-algo'), (v) => { params.algorithm = v; });
  const primary = () => document.querySelector('.ox-modal__foot .ox-btn--primary');
  const validate = () => {
    const v = secret.value;
    const bad = v.trim() && !isValidSecret(v);
    secret.classList.toggle('is-invalid', !!bad);
    hint.classList.toggle('ox-field__hint--error', !!bad);
    hint.textContent = bad ? 'Eso no es base32: solo letras A–Z y dígitos 2–7.' : 'Letras A–Z y dígitos 2–7. Los espacios no importan.';
    const btn = primary();
    if (btn) btn.disabled = !isValidSecret(v);
  };
  secret.addEventListener('input', validate);
  validate();
  body.querySelector('#f-issuer').focus();

  const ok = await done;
  if (!ok || !isValidSecret(secret.value)) return null;

  return confirmAccount({
    ...params,
    issuer: body.querySelector('#f-issuer').value.trim(),
    account: body.querySelector('#f-account').value.trim(),
    secret: normalizeSecret(secret.value),
  });
}

/* ══ Renombrar y borrar ══════════════════════════════════════════════════════ */

async function renameAccount(id) {
  const acc = byId(id);
  if (!acc) return;
  const body = document.createElement('div');
  body.className = 'ox-col';
  body.style.gap = '16px';
  body.innerHTML = `
    <div class="ox-field"><label class="ox-field__label">Emisor</label><input class="ox-input" id="f-issuer" spellcheck="false"></div>
    <div class="ox-field"><label class="ox-field__label">Cuenta</label><input class="ox-input" id="f-account" spellcheck="false"></div>`;
  body.querySelector('#f-issuer').value = acc.issuer;
  body.querySelector('#f-account').value = acc.account;

  const ok = await Modal.show({
    title: 'Renombrar',
    sub: 'Solo cambia cómo se ve. La clave y los códigos siguen iguales.',
    body,
    width: 440,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: true, variant: 'primary' }],
  });
  if (!ok) return;
  const issuer = body.querySelector('#f-issuer').value.trim();
  const account = body.querySelector('#f-account').value.trim();
  if (issuer === acc.issuer && account === acc.account) return;
  // Sin la clave en el paquete: la bóveda conserva la que ya tiene en disco.
  const { secret, sealed, broken, ...meta } = acc;
  await attempt(() => saveAccount({ ...meta, issuer, account }));
  Router.refresh();
}

/** Borra al instante — sin preguntar — y deja "Deshacer" en el toast. */
async function deleteAccount(id) {
  const acc = byId(id);
  if (!acc) return;
  const index = S.accounts.indexOf(acc);

  S.accounts = S.accounts.filter((a) => a.id !== id);
  S.codes.delete(id);
  S.trash = { acc, index };
  registerCommands();
  updateChrome();

  // La fila se va animada; si era la última, la vista pasa al estado vacío.
  const row = viewEl().querySelector(`.ts-acc[data-id="${CSS.escape(id)}"]`);
  if (row && S.accounts.length) {
    exit(row, { fallback: 320 });
    const sub = viewEl().querySelector('.ox-viewhead__sub');
    if (sub) sub.textContent = `${plural(S.accounts.length, 'cuenta', 'cuentas')} · un clic copia el código`;
  } else {
    Router.refresh();
  }

  const removed = await attempt(() => api.accounts.remove(id), { errorTitle: 'No se pudo borrar' });
  if (removed === null) { await restoreTrash(); return; }

  Toast.show({
    title: 'Cuenta eliminada',
    text: acc.issuer || acc.account,
    icon: 'trash',
    duration: 6500,
    action: { label: 'Deshacer', run: restoreTrash },
  });
}

async function restoreTrash() {
  const t = S.trash;
  if (!t) return;
  S.trash = null;
  const ok = await attempt(async () => {
    const saved = await api.accounts.save({ ...t.acc, secret: t.acc.secret || undefined });
    S.accounts.splice(Math.min(t.index, S.accounts.length), 0, saved);
    await computeCode(saved);
    return saved;
  }, { errorTitle: 'No se pudo restaurar' });
  registerCommands();
  updateChrome();
  if (ok) Router.refresh();
}

/* ══ Respaldo ════════════════════════════════════════════════════════════════ */

async function exportBackup() {
  if (!S.accounts.length) { Toast.show({ title: 'No hay nada que respaldar', icon: 'info' }); return; }
  const ok = await Modal.confirm({
    title: 'Exportar las claves en texto plano',
    sub: 'El archivo va sin cifrar: quien lo tenga puede generar tus códigos. Guardalo en un lugar que solo vos abras, y borralo cuando ya no haga falta.',
    confirmLabel: 'Exportar igual',
  });
  if (!ok) return;
  const lines = [
    '# Respaldo de Tessera — una cuenta por línea, formato otpauth://',
    `# ${fmtDate(Date.now())} · ${plural(S.accounts.length, 'cuenta', 'cuentas')}`,
    '',
    ...S.accounts.filter((a) => a.secret).map(buildOtpauth),
    '',
  ];
  const file = await attempt(() => api.backup.export(lines.join('\n'), `tessera-respaldo-${new Date().toISOString().slice(0, 10)}.txt`), { errorTitle: 'No se pudo exportar' });
  if (file) Toast.show({ title: 'Respaldo guardado', text: file, icon: 'download' });
}

async function importBackup() {
  const text = await attempt(() => api.backup.import(), { errorTitle: 'No se pudo leer el archivo' });
  if (!text) return;
  const { accounts, errors } = parseBackup(text);
  if (!accounts.length) { Toast.error('El archivo no tiene cuentas', errors[0] || 'Ninguna línea con otpauth://'); return; }

  const key = (a) => `${a.issuer}|${a.account}|${a.secret}`;
  const have = new Set(S.accounts.map(key));
  const fresh = accounts.filter((a) => !have.has(key(a)));
  let n = 0;
  await attempt(async () => {
    for (const a of fresh) {
      await saveAccount({ ...a, id: await api.accounts.nextId(), createdAt: Date.now() + n });
      n++;
    }
  }, { errorTitle: 'Falló a mitad de la importación' });

  const skipped = accounts.length - fresh.length;
  Toast.show({
    title: n ? `${plural(n, 'cuenta importada', 'cuentas importadas')}` : 'Nada nuevo',
    text: [skipped ? `${skipped} ya estaban` : '', errors.length ? `${errors.length} líneas ilegibles` : ''].filter(Boolean).join(' · ') || undefined,
    icon: n ? 'check' : 'info',
  });
  if (n) Router.go('codigos');
}

/* ══ Vista: Ajustes ══════════════════════════════════════════════════════════ */

const SETTINGS = [
  { key: 'agrupar', title: 'Agrupar los dígitos', text: '«893 892» en vez de «893892». Se copia siempre sin el espacio.' },
  { key: 'copiarAlClic', title: 'Un clic copia el código', text: 'Clic o Enter sobre la fila. Si quedan menos de 3 s, copia el siguiente.' },
  { key: 'ocultar', title: 'Ocultar los códigos', text: 'Salen desenfocados hasta pasar el mouse por encima. Para compartir pantalla tranquilo.' },
];

function viewAjustes() {
  const st = S.settings;
  const vault = S.info?.vault;
  paint(head({ title: 'Ajustes', sub: 'Cómo se ven los códigos, y dónde viven las claves' }) + `
    <div class="ox-scroll ox-grow">
      <div class="ox-col" style="gap:28px;max-width:680px">

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Códigos</span></div>
          <div class="ox-card"><div class="ox-card__body" style="padding-top:4px;padding-bottom:4px">
            ${SETTINGS.map((s) => `
              <div class="ts-setting">
                <div class="ts-setting__main">
                  <div class="ts-setting__title">${esc(s.title)}</div>
                  <div class="ts-setting__text">${esc(s.text)}</div>
                </div>
                <button class="ox-switch${st[s.key] ? ' is-on' : ''}" data-setting="${s.key}" aria-label="${esc(s.title)}"></button>
              </div>`).join('')}
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Respaldo</span></div>
          <div class="ox-card"><div class="ox-card__body">
            <p class="ox-meta" style="line-height:1.65;margin:0 0 14px">
              ${vault
                ? 'Las claves se guardan cifradas con la protección de datos de Windows, atada a tu usuario. Si reinstalás Windows o borrás los datos de la app, no se pueden recuperar: el respaldo es la única vuelta atrás.'
                : 'Este sistema no ofrece cifrado; las claves están guardadas en texto plano dentro de la carpeta de datos.'}
            </p>
            <div class="ox-row" style="gap:8px;flex-wrap:wrap">
              <button class="ox-btn ox-btn--secondary ox-flashable" data-action="export"><i data-icon="download"></i> Exportar respaldo</button>
              <button class="ox-btn ox-btn--secondary ox-flashable" data-action="import"><i data-icon="upload"></i> Importar respaldo</button>
            </div>
          </div></div>
        </div>

        <div class="ox-section">
          <div class="ox-section__head"><span class="ox-section__title">Datos</span></div>
          <div class="ox-card"><div class="ox-card__body">
            <div class="ox-kv">
              <span class="ox-kv__k">Carpeta</span>
              <span class="ox-kv__v ox-mono ox-copyable" data-copy="${esc(S.info?.dataDir || '')}">${esc(S.info?.dataDir || '—')}</span>
              <span class="ox-kv__k">Cuentas</span><span class="ox-kv__v ox-num">${S.accounts.length}</span>
              <span class="ox-kv__k">Claves</span><span class="ox-kv__v">${vault ? 'Cifradas (DPAPI)' : 'Sin cifrar'}</span>
              <span class="ox-kv__k">App</span><span class="ox-kv__v">${esc(S.info?.name || '—')} ${esc(S.info?.version || '')} · Electron <span class="ox-mono">${esc(S.info?.electron || '—')}</span></span>
            </div>
          </div></div>
        </div>

      </div>
      <div style="height:32px"></div>
    </div>`);

  const root = viewEl();
  root.querySelectorAll('[data-setting]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.setting;
    const value = !S.settings[key];
    b.classList.toggle('is-on', value);
    S.settings = await attempt(() => api.settings.save({ [key]: value })) || S.settings;
  }));
}

/* ══ Vista: Piezas (la vitrina de Onyx) ══════════════════════════════════════ */

function viewPiezas() {
  paint(head({ title: 'Piezas', sub: 'Todos los primitivos del sistema, vivos' }) + designHTML());
  wireDesign(viewEl());
}

Router.define({
  codigos: { view: viewCodigos },
  ajustes: { view: viewAjustes },
  piezas: { view: viewPiezas },
}, document.getElementById('view'));

/* ══ Menús ═══════════════════════════════════════════════════════════════════ */

const MENUS = {
  add: () => [
    { label: 'Escanear la pantalla', icon: 'screen', onSelect: addFromScreen },
    { label: 'Desde una imagen…', icon: 'image', onSelect: addFromFile },
    { label: 'Del portapapeles', icon: 'clipboard', onSelect: addFromClipboard },
    { sep: true },
    { label: 'Escribir la clave a mano', icon: 'edit', onSelect: addManual },
  ],
};

const ACTIONS = {
  scan: addFromScreen,
  image: addFromFile,
  clipboard: addFromClipboard,
  manual: addManual,
  export: exportBackup,
  import: importBackup,
};

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function wireShell() {
  const w = api?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.addEventListener('click', () => Router.go(b.dataset.view)));
  document.getElementById('btn-palette')?.addEventListener('click', () => Palette.toggle());

  /* Delegación global, cableada una sola vez: las vistas se repintan enteras
     con innerHTML y un listener en #view se acumularía a cada visita. */
  document.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { copy(cp.dataset.copy); return; }

    const trigger = e.target.closest('[data-menu]');
    if (trigger) {
      e.stopPropagation();
      const build = MENUS[trigger.dataset.menu];
      if (build) Menu.show(trigger, build(trigger.dataset.menuArg), { align: 'end' });
      return;
    }

    const act = e.target.closest('[data-action]');
    if (act) { ACTIONS[act.dataset.action]?.(); return; }

    const rowBtn = e.target.closest('[data-act]');
    const row = e.target.closest('.ts-acc[data-id]');
    if (rowBtn && row) {
      e.stopPropagation();
      if (rowBtn.dataset.act === 'copy') copyCode(row.dataset.id);
      if (rowBtn.dataset.act === 'edit') renameAccount(row.dataset.id);
      if (rowBtn.dataset.act === 'delete') deleteAccount(row.dataset.id);
      return;
    }
    // Clic en la fila (no en un botón ni sobre el texto seleccionado) → copiar.
    if (row && row.classList.contains('is-copiable') && !window.getSelection()?.toString()) copyCode(row.dataset.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest?.('.ts-acc[data-id]');
    if (!row || e.target !== row) return;
    e.preventDefault();
    copyCode(row.dataset.id);
  });
}

/** Todo lo que vive fuera de la vista: statusbar, contador del rail, pie del rail. */
function updateChrome() {
  const n = S.accounts.length;
  document.querySelector('[data-view="codigos"] .ox-navitem__count').textContent = n;
  document.getElementById('stat-count').textContent = n;
  document.getElementById('stat-count-label').textContent = n === 1 ? 'cuenta' : 'cuentas';

  const vault = document.querySelector('#stat-vault .ox-statusbar__value');
  if (vault) vault.textContent = S.info?.vault ? 'Claves cifradas' : 'Sin cifrar';

  const dir = S.info?.dataDir || '';
  document.getElementById('rail-foot').innerHTML =
    dir ? `<div class="ox-meta" data-tip="${esc(dir)}">${path(dir)}</div>` : '';
}

function registerCommands() {
  Palette.clear();
  Palette.register([
    { id: 'scan', group: 'Agregar', icon: 'screen', label: 'Escanear la pantalla', run: addFromScreen },
    { id: 'image', group: 'Agregar', icon: 'image', label: 'Desde una imagen', run: addFromFile },
    { id: 'clip', group: 'Agregar', icon: 'clipboard', label: 'Del portapapeles', run: addFromClipboard },
    { id: 'manual', group: 'Agregar', icon: 'edit', label: 'Escribir la clave a mano', run: addManual },
    { id: 'nav-codigos', group: 'Ir a', icon: 'key', label: 'Códigos', run: () => Router.go('codigos') },
    { id: 'nav-ajustes', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => Router.go('ajustes') },
    { id: 'nav-piezas', group: 'Ir a', icon: 'layers', label: 'Piezas', run: () => Router.go('piezas') },
    { id: 'export', group: 'Respaldo', icon: 'download', label: 'Exportar respaldo', run: exportBackup },
    { id: 'import', group: 'Respaldo', icon: 'upload', label: 'Importar respaldo', run: importBackup },
    ...S.accounts.map((a) => ({
      id: `copy-${a.id}`, group: 'Copiar código', icon: 'copy',
      label: a.issuer || a.account, hint: a.issuer ? a.account : '',
      run: () => copyCode(a.id),
    })),
  ]);
}

/* ══ Color de la ventana ═════════════════════════════════════════════════════
   --ox-bg está en oklch y Electron solo entiende hex. colorToken() lo resuelve
   con un canvas, no con un regex: parseando el texto la app se mandaba VERDE. */
function syncWindowColor() {
  const hex = colorToken('--ox-bg');
  if (hex) api?.win?.setBackground(hex);
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  Palette.init({ placeholder: 'Copiar un código, agregar una cuenta…' });
  initClickFlash();
  initScrollFades();
  wireShell();
  syncWindowColor();

  try {
    await loadAll();
  } catch (err) {
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  registerCommands();
  updateChrome();
  Router.go('codigos');
  startTicking();

  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });
}

boot();
