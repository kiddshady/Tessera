'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — puente IPC
   El renderer no tiene fs, ni require, ni red: `contextIsolation` está activo.
   Todo lo que necesite del sistema pasa por acá, y acá se decide qué se puede
   pedir. Es la superficie de ataque de la app: todo lo que agregues es una
   puerta más.

   Convención: cada handler devuelve {ok:true, data} o {ok:false, error}. El
   preload la desenvuelve y convierte el error en una excepción real, así el
   renderer escribe try/catch normal en vez de chequear banderas.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app, dialog } = require('electron');
const fsp = require('fs/promises');
const store = require('./store.cjs');
const vault = require('./vault.cjs');
const qr = require('./qr.cjs');

/* Las colecciones que el renderer puede tocar. Es una lista blanca a
   propósito: sin ella, cualquier bug en el renderer puede crear carpetas
   sueltas en tu directorio de datos. Agregá las tuyas acá. */
/* Tessera no expone colecciones genéricas: las cuentas pasan por la bóveda,
   que es la única que sabe cifrar la clave. La lista queda vacía a propósito. */
const COLLECTIONS = [];

function coll(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`colección no permitida: ${name}`);
  return store.collection(name);
}

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function register({ getWin = () => null } = {}) {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    electron: process.versions.electron,
    vault: vault.available(),
  }));

  /* ── Cuentas: la bóveda cifra y descifra; el renderer ve la clave en claro ── */
  handle('accounts:list', () => vault.list());
  handle('accounts:save', (acc) => vault.save(acc));
  handle('accounts:remove', (id) => vault.remove(id).then(() => true));
  handle('accounts:next-id', () => vault.nextId());

  /* ── QR: devuelven el texto crudo del código, o null si no había ninguno ── */
  handle('qr:screen', () => qr.fromScreen(getWin()));
  handle('qr:file', () => qr.fromFile(getWin()));
  handle('qr:clipboard', () => qr.fromClipboard());

  /* ── Respaldo: texto plano, una URI por línea. El renderer lo arma y lo lee. ── */
  handle('backup:export', async (text, suggested = 'tessera-respaldo.txt') => {
    const { canceled, filePath } = await dialog.showSaveDialog(getWin(), {
      title: 'Guardar respaldo de Tessera',
      defaultPath: suggested,
      filters: [{ name: 'Texto', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, text, 'utf8');
    return filePath;
  });
  handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Respaldo de Tessera',
      filters: [{ name: 'Texto', extensions: ['txt'] }, { name: 'Todos', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.[0]) return null;
    return fsp.readFile(filePaths[0], 'utf8');
  });

  handle('settings:get', () => store.loadSettings());
  handle('settings:save', (patch) => store.saveSettings(patch));

  handle('doc:read', (name, fallback = null) => store.doc(name, fallback).read());
  handle('doc:write', (name, data) => store.doc(name).write(data).then(() => true));

  handle('col:list', (name) => coll(name).list());
  handle('col:get', (name, id) => coll(name).get(id));
  handle('col:save', (name, item) => coll(name).save(item));
  handle('col:remove', (name, id) => coll(name).remove(id).then(() => true));
  handle('col:next-id', (name, prefix) => coll(name).nextId(prefix));
}

module.exports = { register, COLLECTIONS };
