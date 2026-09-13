'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — preload
   La única puerta entre el renderer y el sistema. Todo lo que NO esté acá, el
   renderer no lo puede hacer: no tiene require, ni fs, ni acceso al proceso
   principal. Esa es la idea.

   Regla: exponé funciones, nunca objetos de Electron. `ipcRenderer` en el
   window anula por completo el aislamiento de contexto.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

contextBridge.exposeInMainWorld('onyx', {
  info: () => call('app:info'),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    /** El renderer le pasa a la ventana su color base ya resuelto (ver app.js). */
    setBackground: (hex) => ipcRenderer.send('win:set-bg', hex),
    onMaximized: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
  },

  /** Documento suelto: un borrador, un caché, el último estado de la UI. */
  doc: {
    read: (name, fallback = null) => call('doc:read', name, fallback),
    write: (name, data) => call('doc:write', name, data),
  },

  /** Las cuentas TOTP. La clave viaja en claro por el IPC local; en disco va cifrada. */
  accounts: {
    list: () => call('accounts:list'),
    save: (acc) => call('accounts:save', acc),
    remove: (id) => call('accounts:remove', id),
    nextId: () => call('accounts:next-id'),
  },

  /** Lectura de QR. Cada una devuelve el texto del código o null. */
  qr: {
    screen: () => call('qr:screen'),
    file: () => call('qr:file'),
    clipboard: () => call('qr:clipboard'),
  },

  backup: {
    export: (text, suggested) => call('backup:export', text, suggested),
    import: () => call('backup:import'),
  },

  /** Actualizaciones: el estado viene entero en cada cambio. */
  update: {
    estado: () => call('update:estado'),
    buscar: (opts) => call('update:buscar', opts),
    descargar: () => call('update:descargar'),
    instalar: () => call('update:instalar'),
    onCambio: (cb) => {
      const handler = (_e, estado) => cb(estado);
      ipcRenderer.on('update:cambio', handler);
      return () => ipcRenderer.off('update:cambio', handler);
    },
  },

  /** Colección: una carpeta con un archivo por ítem. */
  col: (name) => ({
    list: () => call('col:list', name),
    get: (id) => call('col:get', name, id),
    save: (item) => call('col:save', name, item),
    remove: (id) => call('col:remove', name, id),
    nextId: (prefix) => call('col:next-id', name, prefix),
  }),
});
