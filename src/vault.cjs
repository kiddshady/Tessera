'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — la bóveda
   Las cuentas viven como archivos JSON en `data/accounts/`, igual que
   cualquier colección de Onyx: legibles, versionables, un archivo por cuenta.
   Lo único que NO va en claro es la clave TOTP: se cifra con `safeStorage`
   (en Windows, DPAPI atado a tu usuario) y se guarda como `secretEnc`.

   Trampa conocida (memoria `electron-safestorage-windows`): la llave de
   safeStorage vive en el `Local State` del userData de la app. Si ese
   directorio desaparece, los `secretEnc` quedan ilegibles para siempre. Por
   eso existe el respaldo en texto plano (Ajustes → Respaldo) y por eso una
   cuenta que no se pudo descifrar se muestra como `broken` en vez de
   desaparecer en silencio: que se vea, y que se restaure desde el respaldo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { safeStorage } = require('electron');
const store = require('./store.cjs');

const col = store.collection('accounts');

const available = () => {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
};

/** Cómo se guarda una clave: cifrada si se puede, en claro (y marcado) si no. */
function seal(secret) {
  if (available()) return { secretEnc: safeStorage.encryptString(secret).toString('base64'), secret: undefined };
  return { secret, secretEnc: undefined };
}

/** La clave de un archivo, o null si no se pudo descifrar. */
function open(item) {
  if (item.secretEnc) {
    try { return safeStorage.decryptString(Buffer.from(item.secretEnc, 'base64')); } catch { return null; }
  }
  return typeof item.secret === 'string' ? item.secret : null;
}

/** La forma que ve el renderer: la clave en claro y dos banderas de estado. */
function publicShape(item) {
  const secret = open(item);
  const { secretEnc, ...rest } = item;
  return { ...rest, secret, sealed: !!secretEnc, broken: secret === null };
}

async function list() {
  const items = await col.list();
  return items
    .sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0))
    .map(publicShape);
}

function cleanMeta(acc) {
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  return {
    id: store.assertId(acc.id),
    issuer: s(acc.issuer, 80),
    account: s(acc.account, 120),
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(acc.algorithm) ? acc.algorithm : 'SHA1',
    digits: [6, 7, 8].includes(acc.digits) ? acc.digits : 6,
    period: Number.isInteger(acc.period) && acc.period >= 5 && acc.period <= 300 ? acc.period : 30,
    createdAt: Number(acc.createdAt) || Date.now(),
    updatedAt: Date.now(),
    order: Number.isFinite(acc.order) ? acc.order : (Number(acc.createdAt) || Date.now()),
  };
}

/** Guarda una cuenta. Si viene sin `secret`, conserva la clave que ya tenía en disco. */
async function save(acc) {
  const meta = cleanMeta(acc);
  let sealed;
  if (typeof acc.secret === 'string' && acc.secret) {
    sealed = seal(acc.secret.toUpperCase().replace(/[\s\-=]/g, ''));
  } else {
    const prev = await col.get(meta.id);
    if (!prev) throw new Error('La cuenta no tiene clave.');
    sealed = { secret: prev.secret, secretEnc: prev.secretEnc };
  }
  const item = { ...meta, ...sealed };
  // Sin claves `undefined` en el JSON: el archivo se lee a mano.
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  await col.save(item);
  return publicShape(item);
}

const remove = (id) => col.remove(store.assertId(id));
const nextId = () => col.nextId('a');

module.exports = { available, list, save, remove, nextId, dir: col.dir };
