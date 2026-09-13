/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — URIs otpauth://
   El formato que viaja adentro de los QR de doble factor:

     otpauth://totp/Emisor:cuenta?secret=BASE32&issuer=Emisor&digits=6&period=30&algorithm=SHA1

   Módulo puro, compartido entre el renderer (parsea lo que decodificó el QR)
   y los tests. Solo TOTP: HOTP con contador manual casi no existe en la
   práctica y complica la UI para nada.
   ═══════════════════════════════════════════════════════════════════════════ */

import { normalizeSecret, isValidSecret, ALGORITHMS, base32Encode } from './totp.js';

export const isMigration = (input) => /^otpauth-migration:\/\//i.test(String(input || '').trim());

/** Parsea una URI y devuelve una cuenta lista para guardar. Tira con un mensaje legible. */
export function parseOtpauth(input) {
  const uri = String(input || '').trim();
  if (isMigration(uri)) {
    throw new Error('Es un QR de migración de Google Authenticator: trae varias cuentas. Usá parseMigration.');
  }
  if (!/^otpauth:\/\//i.test(uri)) throw new Error('El QR no contiene una URI otpauth://.');

  let url;
  try { url = new URL(uri); } catch { throw new Error('La URI otpauth:// está malformada.'); }

  const type = url.hostname.toLowerCase();
  if (type !== 'totp') throw new Error(type === 'hotp' ? 'Es un código HOTP (por contador); Tessera solo maneja TOTP (por tiempo).' : `Tipo desconocido: ${type}.`);

  let label = '';
  try { label = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { label = url.pathname.replace(/^\/+/, ''); }

  const q = url.searchParams;
  const secret = normalizeSecret(q.get('secret'));
  if (!isValidSecret(secret)) throw new Error('La URI no trae una clave base32 válida.');

  // El emisor puede venir en el parámetro, en la etiqueta ("Emisor:cuenta"), o en los dos.
  let issuer = (q.get('issuer') || '').trim();
  let account = label;
  const colon = label.indexOf(':');
  if (colon >= 0) {
    const fromLabel = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
    if (!issuer) issuer = fromLabel;
  }

  const algorithm = (q.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`Algoritmo no soportado: ${algorithm}.`);

  const digits = q.has('digits') ? Number(q.get('digits')) : 6;
  if (![6, 7, 8].includes(digits)) throw new Error(`Cantidad de dígitos no soportada: ${q.get('digits')}.`);

  const period = q.has('period') ? Number(q.get('period')) : 30;
  if (!Number.isInteger(period) || period < 5 || period > 300) throw new Error(`Período no válido: ${q.get('period')}.`);

  return { issuer, account, secret, algorithm, digits, period };
}

/** El inverso: una cuenta a su URI, para respaldos y para volver a generar el QR. */
export function buildOtpauth({ issuer = '', account = '', secret, algorithm = 'SHA1', digits = 6, period = 30 }) {
  const label = issuer ? `${issuer}:${account}` : account;
  const p = new URLSearchParams();
  p.set('secret', normalizeSecret(secret));
  if (issuer) p.set('issuer', issuer);
  if (algorithm !== 'SHA1') p.set('algorithm', algorithm);
  if (digits !== 6) p.set('digits', String(digits));
  if (period !== 30) p.set('period', String(period));
  return `otpauth://totp/${encodeURIComponent(label)}?${p.toString()}`;
}

/** Un respaldo es texto plano: una URI por línea. Las líneas que no son URIs se ignoran. */
export function parseBackup(text) {
  const out = []; const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try { out.push(parseOtpauth(line)); } catch (err) { errors.push(`${line.slice(0, 40)}… → ${err.message}`); }
  }
  return { accounts: out, errors };
}

/* ══ Google Authenticator: otpauth-migration:// ═════════════════════════════
   "Transferir cuentas → Exportar" en el teléfono muestra uno o varios QR con
   TODAS las cuentas adentro, como un protobuf en base64:

     otpauth-migration://offline?data=<base64 url-encoded>

   El esquema es conocido (google_auth.proto) y chico, así que se decodifica a
   mano en vez de traer una librería de protobuf por dos mensajes:

     MigrationPayload { repeated OtpParameters otp_parameters = 1;
                        int32 version = 2; int32 batch_size = 3;
                        int32 batch_index = 4; int32 batch_id = 5; }
     OtpParameters    { bytes secret = 1; string name = 2; string issuer = 3;
                        Algorithm algorithm = 4;   // 1 SHA1 · 2 SHA256 · 3 SHA512 · 4 MD5
                        DigitCount digits = 5;     // 1 seis · 2 ocho
                        OtpType type = 6;          // 1 HOTP · 2 TOTP
                        int64 counter = 7; }

   Solo se usan los dos tipos de campo del wire format que aparecen acá:
   varint (0) y length-delimited (2). */

function readVarint(buf, pos) {
  let value = 0; let shift = 0; let b;
  do {
    if (pos >= buf.length) throw new Error('protobuf truncado');
    b = buf[pos++];
    // Más allá de 2^53 no hay ningún campo de este esquema; alcanza con Number.
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [value, pos];
}

/** Recorre un mensaje y devuelve sus campos como lista [{ field, wire, value }]. */
function readMessage(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v; [v, pos] = readVarint(buf, pos);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('protobuf truncado');
      out.push({ field, wire, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) { pos += 8; } else if (wire === 5) { pos += 4; }
    else throw new Error(`protobuf: tipo de campo desconocido (${wire})`);
  }
  return out;
}

function base64ToBytes(b64) {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

const GA_ALGORITHM = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
const GA_DIGITS = { 0: 6, 1: 6, 2: 8 };
const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * Un QR de migración → { accounts, skipped, batch: { index, size } }.
 * `skipped` explica cada cuenta que no se pudo traer (HOTP, MD5, sin clave).
 */
export function parseMigration(input) {
  const uri = String(input || '').trim();
  if (!isMigration(uri)) throw new Error('No es un QR de migración de Google Authenticator.');
  let url;
  try { url = new URL(uri); } catch { throw new Error('La URI otpauth-migration:// está malformada.'); }
  const data = url.searchParams.get('data');
  if (!data) throw new Error('El QR de migración no trae datos.');

  let fields;
  try { fields = readMessage(base64ToBytes(data)); } catch (err) { throw new Error(`No pude decodificar el QR de migración: ${err.message}`); }

  const accounts = []; const skipped = [];
  const batch = { index: 0, size: 1 };
  for (const f of fields) {
    if (f.field === 3 && f.wire === 0) batch.size = f.value || 1;
    if (f.field === 4 && f.wire === 0) batch.index = f.value;
    if (f.field !== 1 || f.wire !== 2) continue;

    const p = {};
    for (const q of readMessage(f.value)) {
      if (q.field === 1 && q.wire === 2) p.secret = q.value;
      else if (q.field === 2 && q.wire === 2) p.name = text(q.value);
      else if (q.field === 3 && q.wire === 2) p.issuer = text(q.value);
      else if (q.field === 4) p.algorithm = q.value;
      else if (q.field === 5) p.digits = q.value;
      else if (q.field === 6) p.type = q.value;
    }
    const label = [p.issuer, p.name].filter(Boolean).join(' · ') || '(sin nombre)';
    if (p.type === 1) { skipped.push(`${label}: es HOTP (por contador), Tessera solo maneja TOTP`); continue; }
    if (!(p.algorithm in GA_ALGORITHM)) { skipped.push(`${label}: algoritmo no soportado (MD5)`); continue; }
    if (!p.secret?.length) { skipped.push(`${label}: viene sin clave`); continue; }

    // El nombre puede venir como "Emisor:cuenta"; el campo issuer manda si está.
    let issuer = (p.issuer || '').trim();
    let account = (p.name || '').trim();
    const colon = account.indexOf(':');
    if (colon >= 0) {
      if (!issuer) issuer = account.slice(0, colon).trim();
      account = account.slice(colon + 1).trim();
    }
    accounts.push({
      issuer, account,
      secret: base32Encode(p.secret),
      algorithm: GA_ALGORITHM[p.algorithm],
      digits: GA_DIGITS[p.digits] ?? 6,
      period: 30,
    });
  }
  return { accounts, skipped, batch };
}
