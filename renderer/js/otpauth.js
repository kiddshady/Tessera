/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — URIs otpauth://
   El formato que viaja adentro de los QR de doble factor:

     otpauth://totp/Emisor:cuenta?secret=BASE32&issuer=Emisor&digits=6&period=30&algorithm=SHA1

   Módulo puro, compartido entre el renderer (parsea lo que decodificó el QR)
   y los tests. Solo TOTP: HOTP con contador manual casi no existe en la
   práctica y complica la UI para nada.
   ═══════════════════════════════════════════════════════════════════════════ */

import { normalizeSecret, isValidSecret, ALGORITHMS } from './totp.js';

/** Parsea una URI y devuelve una cuenta lista para guardar. Tira con un mensaje legible. */
export function parseOtpauth(input) {
  const uri = String(input || '').trim();
  if (/^otpauth-migration:/i.test(uri)) {
    throw new Error('Es un QR de migración de Google Authenticator, no de una cuenta. Escaneá el QR original del sitio.');
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
