/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — TOTP / HOTP (RFC 6238 / RFC 4226)
   Módulo puro: sin DOM, sin Electron. Usa WebCrypto, que está tanto en el
   renderer como en node ≥ 20, así que los vectores del RFC se corren con
   `node test/totp.test.mjs` sin levantar nada.
   ═══════════════════════════════════════════════════════════════════════════ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HASH = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export const ALGORITHMS = Object.keys(HASH);

/** Deja el secreto como lo entiende base32: mayúsculas, sin espacios ni `=`. */
export function normalizeSecret(s) {
  return String(s || '').toUpperCase().replace(/[\s\-=]/g, '');
}

export function isValidSecret(s) {
  const n = normalizeSecret(s);
  return n.length > 0 && /^[A-Z2-7]+$/.test(n);
}

export function base32Decode(s) {
  const n = normalizeSecret(s);
  if (!isValidSecret(n)) throw new Error('La clave no es base32 válida (letras A–Z y dígitos 2–7).');
  const out = new Uint8Array(Math.floor((n.length * 5) / 8));
  let bits = 0; let acc = 0; let i = 0;
  for (const ch of n) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

export function base32Encode(bytes) {
  let bits = 0; let acc = 0; let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/* Las claves importadas se cachean: computar un código por segundo para cada
   cuenta no tiene por qué re-importar la clave cada vez. */
const keys = new Map();

async function hmacKey(secret, algorithm) {
  const hash = HASH[algorithm];
  if (!hash) throw new Error(`Algoritmo no soportado: ${algorithm}`);
  const id = `${algorithm}:${normalizeSecret(secret)}`;
  if (!keys.has(id)) {
    const raw = base32Decode(secret);
    if (!raw.length) throw new Error('La clave está vacía.');
    keys.set(id, await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: { name: hash } }, false, ['sign']));
  }
  return keys.get(id);
}

/** HOTP: el código para un contador dado. Devuelve el string ya con ceros a la izquierda. */
export async function hotp(secret, counter, { digits = 6, algorithm = 'SHA1' } = {}) {
  const key = await hmacKey(secret, algorithm);
  const msg = new ArrayBuffer(8);
  const v = new DataView(msg);
  v.setUint32(0, Math.floor(counter / 2 ** 32));
  v.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** El contador TOTP en un instante dado (ms desde epoch). */
export function counterAt(now, period = 30) {
  return Math.floor(now / 1000 / period);
}

/** Milisegundos que le quedan al código vigente. */
export function msLeft(now, period = 30) {
  const p = period * 1000;
  return p - (now % p);
}

/** TOTP: el código vigente en `now`, con cuánto le queda. */
export async function totp(secret, { digits = 6, period = 30, algorithm = 'SHA1', now = Date.now() } = {}) {
  const counter = counterAt(now, period);
  const code = await hotp(secret, counter, { digits, algorithm });
  return { code, counter, msLeft: msLeft(now, period), period };
}

/** "893892" → "893 892"; con 8 dígitos, "1234 5678". */
export function groupDigits(code) {
  const n = code.length;
  const half = Math.ceil(n / 2);
  return n <= 4 ? code : `${code.slice(0, half)} ${code.slice(half)}`;
}
