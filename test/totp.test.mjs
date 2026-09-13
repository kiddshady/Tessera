/* Vectores oficiales: RFC 4226 (HOTP, apéndice D) y RFC 6238 (TOTP, apéndice B).
   Si esto falla, ningún código que muestre la app sirve. */

import { hotp, totp, base32Decode, base32Encode, groupDigits, msLeft, counterAt, isValidSecret } from '../renderer/js/totp.js';
import { parseOtpauth, buildOtpauth, parseBackup, parseMigration, isMigration } from '../renderer/js/otpauth.js';

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

// "12345678901234567890" en ASCII, el secreto de los RFC, en base32.
const S20 = base32Encode(new TextEncoder().encode('12345678901234567890'));
const S32 = base32Encode(new TextEncoder().encode('12345678901234567890123456789012'));
const S64 = base32Encode(new TextEncoder().encode('1234567890123456789012345678901234567890123456789012345678901234'));

console.log('\n1. base32');
ok('codifica el secreto del RFC', S20 === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', S20);
ok('decodifica de vuelta', new TextDecoder().decode(base32Decode(S20)) === '12345678901234567890');
ok('tolera minúsculas, espacios y relleno', new TextDecoder().decode(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==')) === '12345678901234567890');
ok('rechaza caracteres inválidos', !isValidSecret('ABC1') && !isValidSecret(''));

console.log('\n2. HOTP (RFC 4226)');
const HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
for (let c = 0; c < HOTP.length; c++) {
  ok(`contador ${c} → ${HOTP[c]}`, (await hotp(S20, c)) === HOTP[c]);
}

console.log('\n3. TOTP (RFC 6238, 8 dígitos)');
const T = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
for (const [t, sha1, sha256, sha512] of T) {
  const now = t * 1000;
  ok(`T=${t} SHA1`, (await totp(S20, { digits: 8, now })).code === sha1);
  ok(`T=${t} SHA256`, (await totp(S32, { digits: 8, now, algorithm: 'SHA256' })).code === sha256);
  ok(`T=${t} SHA512`, (await totp(S64, { digits: 8, now, algorithm: 'SHA512' })).code === sha512);
}

console.log('\n4. Tiempo');
ok('contador a los 59 s es 1', counterAt(59_000) === 1);
ok('a los 59 s le queda 1 s', msLeft(59_000) === 1000);
ok('al empezar el período le quedan 30 s', msLeft(60_000) === 30000);
ok('período de 60', counterAt(119_000, 60) === 1 && msLeft(119_000, 60) === 1000);
ok('agrupa 6 dígitos', groupDigits('893892') === '893 892');
ok('agrupa 8 dígitos', groupDigits('12345678') === '1234 5678');
ok('agrupa 7 dígitos', groupDigits('1234567') === '1234 567');

console.log('\n5. otpauth://');
const a = parseOtpauth('otpauth://totp/PAMI:RecetaElectronica?secret=JBSWY3DPEHPK3PXP&issuer=PAMI');
ok('emisor y cuenta de la etiqueta', a.issuer === 'PAMI' && a.account === 'RecetaElectronica');
ok('defaults', a.digits === 6 && a.period === 30 && a.algorithm === 'SHA1' && a.secret === 'JBSWY3DPEHPK3PXP');
const b = parseOtpauth('otpauth://totp/Ejemplo%3Ause%40mail.com?secret=jbswy3dpehpk3pxp&digits=8&period=60&algorithm=SHA-256');
ok('etiqueta URL-encoded + emisor implícito', b.issuer === 'Ejemplo' && b.account === 'use@mail.com');
ok('parámetros no default', b.digits === 8 && b.period === 60 && b.algorithm === 'SHA256');
ok('normaliza la clave', b.secret === 'JBSWY3DPEHPK3PXP');
const c = parseOtpauth('otpauth://totp/solo-cuenta?secret=JBSWY3DPEHPK3PXP');
ok('sin emisor', c.issuer === '' && c.account === 'solo-cuenta');
const d = parseOtpauth('otpauth://totp/Mail:%20usuario?secret=JBSWY3DPEHPK3PXP&issuer=Otro');
ok('el parámetro issuer manda sobre la etiqueta', d.issuer === 'Otro' && d.account === 'usuario');

const rejects = (uri, re) => { try { parseOtpauth(uri); return false; } catch (e) { return re.test(e.message); } };
ok('rechaza hotp con mensaje claro', rejects('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=0', /HOTP/));
ok('rechaza la migración de Google', rejects('otpauth-migration://offline?data=abc', /migración/));
ok('rechaza texto cualquiera', rejects('https://ejemplo.com', /otpauth/));
ok('rechaza clave inválida', rejects('otpauth://totp/x?secret=ABC1', /base32/));
ok('rechaza algoritmo raro', rejects('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5', /Algoritmo/));
ok('rechaza dígitos raros', rejects('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4', /dígitos/));

console.log('\n6. Ida y vuelta');
for (const acc of [a, b, c]) {
  const back = parseOtpauth(buildOtpauth(acc));
  ok(`${acc.issuer || '(sin emisor)'}/${acc.account} sobrevive build→parse`, JSON.stringify(back) === JSON.stringify(acc), buildOtpauth(acc));
}
ok('el build omite los defaults', buildOtpauth(a) === 'otpauth://totp/PAMI%3ARecetaElectronica?secret=JBSWY3DPEHPK3PXP&issuer=PAMI');
const bk = parseBackup(`# respaldo\n${buildOtpauth(a)}\n\nbasura\n${buildOtpauth(b)}\n`);
ok('el respaldo lee 2 cuentas y reporta 1 línea mala', bk.accounts.length === 2 && bk.errors.length === 1);

console.log('\n7. Google Authenticator (otpauth-migration)');
/* Los bytes están escritos a mano desde google_auth.proto, no generados con el
   mismo código que los lee: si el lector y el test compartieran una suposición
   equivocada sobre el wire format, esto no la taparía.
     OtpParameters:
       0a 0a  <10 bytes>          secret = "Hello!" + DE AD BE EF  (= JBSWY3DPEHPK3PXP)
       12 18  "Example:alice@google.com"   name
       1a 07  "Example"           issuer
       20 01                      algorithm = SHA1
       28 01                      digits = SIX
       30 02                      type = TOTP
     MigrationPayload:
       0a 35  <OtpParameters>     otp_parameters[0]
       10 01  version=1 · 18 01 batch_size=1 · 20 00 batch_index=0 · 28 2a batch_id=42 */
const hex = (h) => Uint8Array.from(h.replace(/\s+/g, '').match(/../g).map((b) => parseInt(b, 16)));
const str = (t) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('');
const params = '0a0a' + '48656c6c6f21deadbeef' + '1218' + str('Example:alice@google.com') + '1a07' + str('Example') + '2001' + '2801' + '3002';
const payload = hex('0a35' + params + '1001' + '1801' + '2000' + '282a');
const b64 = btoa(String.fromCharCode(...payload));
const mig = `otpauth-migration://offline?data=${encodeURIComponent(b64)}`;
ok('se reconoce como migración', isMigration(mig) && !isMigration('otpauth://totp/x?secret=A'));
const m = parseMigration(mig);
ok('trae una cuenta', m.accounts.length === 1 && m.skipped.length === 0, JSON.stringify(m));
ok('emisor y cuenta (el issuer manda, el nombre pierde el prefijo)', m.accounts[0].issuer === 'Example' && m.accounts[0].account === 'alice@google.com');
ok('la clave binaria pasa a base32', m.accounts[0].secret === 'JBSWY3DPEHPK3PXP', m.accounts[0].secret);
ok('parámetros', m.accounts[0].algorithm === 'SHA1' && m.accounts[0].digits === 6 && m.accounts[0].period === 30);
ok('el lote', m.batch.index === 0 && m.batch.size === 1);
ok('y el mismo código que la cuenta parseada por otpauth://', (await totp(m.accounts[0].secret, { now: 59_000 })).code === (await totp(a.secret, { now: 59_000 })).code);
// Una HOTP adentro del lote se saltea con explicación, la TOTP de al lado entra igual.
const hotpParams = '0a0a' + '48656c6c6f21deadbeef' + '1204' + str('hotp') + '2001' + '2801' + '3001' + '3805';
const two = hex('0a' + (params.length / 2).toString(16).padStart(2, '0') + params + '0a' + (hotpParams.length / 2).toString(16).padStart(2, '0') + hotpParams + '1802' + '2001');
const m2 = parseMigration(`otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...two)))}`);
ok('lote 2 de 2 con una HOTP: entra la TOTP y la otra se explica', m2.accounts.length === 1 && m2.skipped.length === 1 && /HOTP/.test(m2.skipped[0]) && m2.batch.index === 1 && m2.batch.size === 2, JSON.stringify(m2.skipped));
ok('parseOtpauth sigue rechazándolo con mensaje claro', rejects(mig, /migración/));
ok('datos rotos → error legible', (() => { try { parseMigration('otpauth-migration://offline?data=%%%'); return false; } catch (e) { return /decodificar|malformada|datos/.test(e.message); } })());

console.log(`\n${pass} ok, ${fail} fallas`);
process.exit(fail ? 1 : 0);
