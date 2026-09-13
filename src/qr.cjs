'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   TESSERA — lectura de QR
   Todo pasa por acá y todo termina en la misma función: una NativeImage se
   convierte a RGBA y jsQR la lee. Tres fuentes:

     · la pantalla   → desktopCapturer, a resolución física. La ventana se
                       esconde antes de capturar: si el QR está justo debajo
                       de Tessera, taparlo con la propia app sería ridículo.
     · un archivo    → diálogo nativo del sistema (PNG/JPEG, lo que entiende
                       nativeImage.createFromPath).
     · el portapapeles → primero como imagen, y si no hay, como texto
                       otpauth:// pegado.

   Devuelve el texto del QR, o null. Decidir qué significa ese texto (parsear
   la URI, validar) es cosa del renderer: acá solo se lee.
   ═══════════════════════════════════════════════════════════════════════════ */

const { desktopCapturer, screen, nativeImage, clipboard, dialog } = require('electron');
const jsQR = require('jsqr');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** NativeImage → texto del primer QR que encuentre, o null. */
function decodeImage(img) {
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (!width || !height) return null;
  const bgra = img.toBitmap();
  const rgba = new Uint8ClampedArray(width * height * 4);
  // toBitmap entrega BGRA (el orden nativo de Skia); jsQR quiere RGBA.
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = 255;
  }
  const found = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  return found?.data || null;
}

/** Captura cada pantalla a su resolución real y devuelve el primer QR. */
async function fromScreen(win) {
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  if (visible) win.hide();
  try {
    // El compositor necesita un momento para pintar lo que había debajo.
    if (visible) await sleep(320);
    const displays = screen.getAllDisplays();
    const size = displays.reduce((m, d) => ({
      width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)),
      height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)),
    }), { width: 0, height: 0 });
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    for (const s of sources) {
      const data = decodeImage(s.thumbnail);
      if (data) return data;
    }
    return null;
  } finally {
    if (visible && win && !win.isDestroyed()) win.show();
  }
}

async function fromFile(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Imagen con el código QR',
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) return undefined;   // cancelado ≠ sin QR
  const img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) throw new Error('No pude leer esa imagen (solo PNG o JPEG).');
  return decodeImage(img);
}

function fromClipboard() {
  const data = decodeImage(clipboard.readImage());
  if (data) return data;
  const text = (clipboard.readText() || '').trim();
  return /^otpauth(-migration)?:/i.test(text) ? text : null;
}

module.exports = { decodeImage, fromScreen, fromFile, fromClipboard };
