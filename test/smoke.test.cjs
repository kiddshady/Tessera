/* ═══════════════════════════════════════════════════════════════════════════
   Humo de Tessera: monta la app de verdad y la usa como una persona.

   `npm run smoke`. Necesita Electron (por eso no está en `npm test`).

   Lo que busca es lo que un test de unidad no ve: que una cuenta entre por la
   UI y quede cifrada en disco, que el código de la fila sea el que da el
   motor, que borrar NO pregunte y que "Deshacer" la traiga de vuelta, que los
   overlays caigan dentro de la ventana, y que el escaneo de pantalla lea un
   QR que está realmente en pantalla (una segunda ventana lo muestra).
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, clipboard, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-smoke-'));
process.env.TESSERA_DATA = DATA;   // antes de cargar el store: la carpeta de datos se fija al requerir

const SECRET = 'JBSWY3DPEHPK3PXP';
const W = 1100; const H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 120s'), 120000);

app.whenReady().then(async () => {
  let win = null;
  require(path.join(ROOT, 'src', 'ipc.cjs')).register({ getWin: () => win });
  const actualizador = require(path.join(ROOT, 'src', 'actualizador.cjs'));
  const qr = require(path.join(ROOT, 'src', 'qr.cjs'));
  const { totp } = await import('../renderer/js/totp.js');

  win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#0a0b0d',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(`${e.level}: ${e.message}`); });
  actualizador.iniciar(() => win);   // como en main.cjs: desde el código fuente queda "sin soporte"
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  // navigator.clipboard exige que el documento tenga el foco, y en una máquina
  // en uso el foco lo tiene quien está clickeando. Se intercepta la escritura
  // para probar la lógica de copiar sin depender de eso.
  await js(`navigator.clipboard.writeText = (t) => { window.__copied = String(t); return Promise.resolve(); }; true`);
  const copied = () => js(`window.__copied || ''`);
  const resetCopied = () => js(`window.__copied = ''; true`);
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const setVal = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
    el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const rect = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const inside = (r) => r && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H && r.w > 0 && r.h > 0;
  const expected = async () => {
    const now = Date.now();
    const a = (await totp(SECRET, { now })).code;
    const b = (await totp(SECRET, { now: now - 1500 })).code;   // por si el test cae justo en un borde de período
    return [a, b];
  };
  const files = () => fs.existsSync(path.join(DATA, 'accounts')) ? fs.readdirSync(path.join(DATA, 'accounts')).filter((f) => f.endsWith('.json')) : [];

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('arranca en el estado vacío', (await text('.ox-empty__title')) === 'Ninguna cuenta todavía');
  ok('la statusbar dice cómo se guardan las claves', /cifradas|Sin cifrar/.test(await text('#stat-vault')));

  console.log('\n2. Alta a mano por la UI: modal → confirmación → fila');
  await click('[data-action="manual"]');
  await sleep(500);
  ok('abre el modal', await js(`!!document.querySelector('.ox-modal')`));
  ok('el modal cae dentro de la ventana', inside(await rect('.ox-modal')), JSON.stringify(await rect('.ox-modal')));
  ok('con la clave vacía, Agregar está deshabilitado', await js(`document.querySelector('.ox-modal__foot .ox-btn--primary').disabled`));
  await setVal('#f-secret', 'no es base32 1');
  ok('una clave inválida se marca', await js(`document.querySelector('#f-secret').classList.contains('is-invalid')`));
  await setVal('#f-issuer', 'PAMI');
  await setVal('#f-account', 'RecetaElectronica');
  await setVal('#f-secret', 'jbsw y3dp ehpk 3pxp');
  ok('la clave válida habilita Agregar', !(await js(`document.querySelector('.ox-modal__foot .ox-btn--primary').disabled`)));
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(700);
  ok('pasa a la confirmación con el código de ahora', (await expected()).includes((await text('.ts-preview .ts-code'))?.replace(/\s/g, '')));
  ok('la confirmación trae emisor y cuenta', (await js(`document.querySelector('#f-issuer').value`)) === 'PAMI' && (await js(`document.querySelector('#f-account').value`)) === 'RecetaElectronica');
  ok('la vista previa tiene su ruedita con segundos', /^\d+$/.test(await text('.ts-preview .ts-ring__sec')));
  if (process.env.TESSERA_SHOT) {
    // Foto del modal para quien lee: en pantalla un instante, porque off-screen
    // capturePage devuelve un frame viejo (memoria: electron-capturepage-offscreen-stale).
    const a = screen.getPrimaryDisplay().workArea;
    win.setPosition(a.x + 60, a.y + 60);
    await sleep(600);
    fs.writeFileSync(process.env.TESSERA_SHOT.replace(/\.png$/i, '-modal.png'), (await win.webContents.capturePage()).toPNG());
    win.setPosition(-20000, -20000);
    await sleep(200);
  }
  await resetCopied();
  await click('#prev-copy');
  await sleep(300);
  ok('Copiar en el modal copia el código de ahora', (await expected()).includes(await copied()), await copied());
  const secBefore = Number(await text('.ts-preview .ts-ring__sec'));
  await sleep(2100);
  const secAfter = Number(await text('.ts-preview .ts-ring__sec'));
  ok('y la ruedita corre mientras el modal está abierto', secAfter !== secBefore, `${secBefore} -> ${secAfter}`);
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(1000);

  ok('aparece la fila', (await count('.ts-acc')) === 1);
  ok('con emisor y cuenta', (await text('.ts-acc .ox-listitem__title')) === 'PAMI' && (await text('.ts-acc .ox-listitem__sub')) === 'RecetaElectronica');
  ok('el código de la fila es el del motor', (await expected()).includes((await text('.ts-acc .ts-code')).replace(/\s/g, '')));
  ok('el anillo marca los segundos', /^\d+$/.test(await text('.ts-acc .ts-ring__sec')));
  ok('el rail y la statusbar cuentan 1', (await text('[data-view="codigos"] .ox-navitem__count')) === '1' && (await text('#stat-count')) === '1');

  console.log('\n3. En disco: cifrado');
  const [f1] = files();
  ok('hay un archivo por cuenta', files().length === 1);
  const onDisk = f1 ? JSON.parse(fs.readFileSync(path.join(DATA, 'accounts', f1), 'utf8')) : {};
  ok('la clave NO está en claro', !('secret' in onDisk), JSON.stringify(Object.keys(onDisk)));
  ok('está cifrada (secretEnc)', typeof onDisk.secretEnc === 'string' && onDisk.secretEnc.length > 20 && !onDisk.secretEnc.includes(SECRET));
  ok('los metadatos sí se leen a mano', onDisk.issuer === 'PAMI' && onDisk.digits === 6 && onDisk.period === 30);
  const relisted = await js(`window.onyx.accounts.list()`);
  ok('la bóveda la descifra de vuelta', relisted[0]?.secret === SECRET && relisted[0]?.sealed === true && relisted[0]?.broken === false);

  console.log('\n4. Un clic copia');
  await resetCopied();
  await click('.ts-acc');
  await sleep(400);
  ok('el portapapeles recibe el código, sin espacios', (await expected()).includes(await copied()), await copied());
  ok('lo confirma con un toast', await js(`!!document.querySelector('.ox-toast')`));
  await resetCopied();
  await js(`document.querySelector('.ts-acc [data-act="copy"]').click(); true`);
  await sleep(300);
  ok('el botón Copiar de la fila también copia', (await expected()).includes(await copied()), await copied());

  console.log('\n5. Borrar NO pregunta, y se puede deshacer');
  const id = relisted[0].id;
  await js(`document.querySelector('.ts-acc [data-act="delete"]').click(); true`);
  await sleep(80);
  ok('no apareció ningún modal de confirmación', !(await js(`!!document.querySelector('.ox-modal')`)));
  ok('la fila arranca su salida animada', await js(`document.querySelector('.ts-acc')?.dataset.state === 'closing' || !document.querySelector('.ts-acc')`));
  await sleep(700);
  ok('la vista pasó al estado vacío', (await text('.ox-empty__title')) === 'Ninguna cuenta todavía');
  ok('el archivo se fue del disco', files().length === 0);
  ok('el contador volvió a 0', (await text('#stat-count')) === '0');
  const undoBtn = await rect('.ox-toast__action');
  ok('el toast ofrece Deshacer, dentro de la ventana', inside(undoBtn) && (await text('.ox-toast__action')) === 'Deshacer');
  await click('.ox-toast__action');
  await sleep(900);
  ok('la cuenta vuelve a la lista', (await count('.ts-acc')) === 1);
  ok('y al disco, con el mismo id', files().length === 1 && files()[0] === `${id}.json`);
  ok('y vuelve cifrada', !('secret' in JSON.parse(fs.readFileSync(path.join(DATA, 'accounts', files()[0]), 'utf8'))));

  console.log('\n6. Renombrar');
  await js(`document.querySelector('.ts-acc [data-act="edit"]').click(); true`);
  await sleep(500);
  await setVal('#f-issuer', 'PAMI Salud');
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(800);
  ok('el nombre nuevo se ve', (await text('.ts-acc .ox-listitem__title')) === 'PAMI Salud');
  ok('el código sigue siendo el mismo', (await expected()).includes((await text('.ts-acc .ts-code')).replace(/\s/g, '')));

  console.log('\n7. Las otras vistas');
  for (const v of ['ajustes', 'piezas', 'codigos']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }
  await click('[data-view="ajustes"]');
  await sleep(600);
  await click('[data-setting="ocultar"]');
  await sleep(500);
  const settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  ok('un switch de Ajustes persiste en disco', settings.ocultar === true);
  await click('[data-view="codigos"]');
  await sleep(700);
  ok('y la lista lo aplica (códigos ocultos)', await js(`document.querySelector('.ts-acc').classList.contains('is-masked')`));
  // Se apaga de nuevo: el resto del test (y la foto final) va con los códigos a la vista.
  await click('[data-view="ajustes"]');
  await sleep(500);
  await click('[data-setting="ocultar"]');
  await sleep(400);
  await click('[data-view="codigos"]');
  await sleep(700);
  ok('y se apaga igual de fácil', !(await js(`document.querySelector('.ts-acc').classList.contains('is-masked')`)));

  console.log('\n7-bis. Actualizador');
  // Corrida como `electron test/…`, app.getVersion() es la de Electron, no la
  // del package.json; lo que se prueba es que la statusbar diga la misma que el main.
  ok('la statusbar muestra la versión', (await text('#stat-version .ox-statusbar__value')) === `v${app.getVersion()}`, await text('#stat-version .ox-statusbar__value'));
  await click('#stat-version');
  await sleep(500);
  ok('desde el código fuente, buscar avisa que acá no se actualiza sola', await js(`[...document.querySelectorAll('.ox-toast__title')].some(t => /no se actualiza sola/.test(t.textContent))`));
  ok('y explica por qué', await js(`[...document.querySelectorAll('.ox-toast__text')].some(t => /código fuente/.test(t.textContent))`));

  console.log('\n8. Paleta de comandos');
  await click('#btn-palette');
  await sleep(500);
  ok('abre y cae dentro de la ventana', inside(await rect('.ox-palette')), JSON.stringify(await rect('.ox-palette')));
  ok('lista la cuenta para copiar su código', await js(`[...document.querySelectorAll('.ox-palette *')].some(e => e.childElementCount === 0 && e.textContent.trim() === 'PAMI Salud')`));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(400);

  console.log('\n9. QR de verdad');
  const QRCode = require('qrcode');
  const uri = 'otpauth://totp/Umbrovex:fran?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Umbrovex&digits=8';
  const png = await QRCode.toBuffer(uri, { width: 260, margin: 2 });
  ok('decodeImage lee un PNG con QR', qr.decodeImage(nativeImage.createFromBuffer(png)) === uri);
  ok('y devuelve null en una imagen sin QR', qr.decodeImage(nativeImage.createFromBitmap(Buffer.alloc(96 * 96 * 4, 120), { width: 96, height: 96 })) === null);
  clipboard.writeText(uri);
  ok('del portapapeles como texto', qr.fromClipboard() === uri);
  clipboard.writeImage(nativeImage.createFromBuffer(png));
  ok('del portapapeles como imagen', qr.fromClipboard() === uri);

  // El QR en una ventana visible, y Tessera lo lee de la pantalla. Va por
  // archivos: un <img> con el PNG embebido en una data-URL no llegaba a
  // pintarse y la ventana testigo salía en blanco.
  fs.writeFileSync(path.join(DATA, 'qr.png'), png);
  fs.writeFileSync(path.join(DATA, 'qr.html'), '<body style="margin:0;background:#fff;display:grid;place-items:center;height:100vh"><img src="qr.png"></body>');
  const area = screen.getPrimaryDisplay().workArea;
  const shower = new BrowserWindow({
    x: area.x + 40, y: area.y + 40, width: 360, height: 360, frame: false, alwaysOnTop: true,
    backgroundColor: '#ffffff', webPreferences: { sandbox: true },
  });
  await shower.loadFile(path.join(DATA, 'qr.html'));
  await sleep(900);
  const seen = await qr.fromScreen(win);
  ok('el escaneo de pantalla encuentra el QR', seen === uri, String(seen));
  shower.close();

  // Y el camino completo por la UI: pegar el otpauth en el portapapeles → "Del portapapeles" → confirmar.
  clipboard.writeText(uri);
  await click('[data-menu="add"]');
  await sleep(400);
  ok('el menú de agregar cae dentro de la ventana', inside(await rect('.ox-menu')));
  await js(`[...document.querySelectorAll('.ox-menu *')].find(e => e.textContent.trim() === 'Del portapapeles' && e.childElementCount <= 2)?.click(); true`);
  await sleep(800);
  ok('la confirmación muestra 8 dígitos', /8 dígitos/.test(await js(`document.querySelector('.ox-modal')?.textContent || ''`)));
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(900);
  ok('ahora hay dos cuentas', (await count('.ts-acc')) === 2 && files().length === 2);
  ok('la nueva muestra un código de 8', (await js(`document.querySelectorAll('.ts-acc .ts-code')[1].textContent`)).replace(/\s/g, '').length === 8);

  console.log('\n9-bis. Migración de Google Authenticator');
  /* El mismo payload escrito a mano que en totp.test.mjs, con otra cuenta:
     secret "Hello!"+DEADBEEF, name "Migrada:fran", issuer "Migrada", SHA1, 6, TOTP. */
  const strHex = (t) => [...Buffer.from(t, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join('');
  const params = '0a0a48656c6c6f21deadbeef' + '120c' + strHex('Migrada:fran') + '1a07' + strHex('Migrada') + '200128013002';
  const payload = Buffer.from('0a' + (params.length / 2).toString(16).padStart(2, '0') + params + '10011801200028ff01', 'hex');
  const migUri = `otpauth-migration://offline?data=${encodeURIComponent(payload.toString('base64'))}`;
  clipboard.writeText(migUri);
  ok('del portapapeles se lee tal cual', qr.fromClipboard() === migUri);
  await click('[data-menu="add"]');
  await sleep(400);
  await js(`[...document.querySelectorAll('.ox-menu *')].find(e => e.textContent.trim() === 'Del portapapeles' && e.childElementCount <= 2)?.click(); true`);
  await sleep(800);
  ok('el modal lista la cuenta que trae', /Google Authenticator: 1 cuenta/.test(await text('.ox-modal')) && /Migrada/.test(await text('.ox-modal')));
  await click('.ox-modal__foot .ox-btn--primary');
  await sleep(900);
  ok('ahora hay tres cuentas', (await count('.ts-acc')) === 3 && files().length === 3);
  ok('la migrada muestra el mismo código que PAMI (misma clave)', (await js(`[...document.querySelectorAll('.ts-acc .ts-code')].map(e => e.textContent.replace(/\\s/g, ''))`)).filter((c, i, arr) => arr.indexOf(c) !== i).length === 1);
  // Escanearlo de nuevo no duplica.
  await click('[data-menu="add"]');
  await sleep(400);
  await js(`[...document.querySelectorAll('.ox-menu *')].find(e => e.textContent.trim() === 'Del portapapeles' && e.childElementCount <= 2)?.click(); true`);
  await sleep(700);
  ok('repetido: avisa que ya estaba y no abre modal', !(await js(`!!document.querySelector('.ox-modal')`)) && await js(`[...document.querySelectorAll('.ox-toast__title')].some(t => /Nada nuevo/.test(t.textContent))`));
  ok('y siguen siendo tres', (await count('.ts-acc')) === 3 && files().length === 3);

  console.log('\n10. Sin errores en la consola del renderer');
  ok('ninguno', errores.length === 0, errores.join(' | '));

  // Foto final para la persona que lee esto: la ventana en pantalla, con las
  // dos cuentas. Off-screen capturePage devuelve un frame viejo, por eso se
  // mueve primero (memoria: electron-capturepage-offscreen-stale).
  win.setPosition(area.x + 60, area.y + 60);
  await sleep(700);
  const shot = await win.webContents.capturePage();
  const out = process.env.TESSERA_SHOT || path.join(os.tmpdir(), 'tessera-smoke.png');
  fs.writeFileSync(out, shot.toPNG());
  console.log(`\n  captura → ${out}`);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  app.exit(fail ? 1 : 0);
});
