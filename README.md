# Tessera

Autenticador TOTP de escritorio. Los códigos de doble factor que antes vivían
en una extensión del navegador, en una app propia: oscura, sobre Onyx, y con
las claves cifradas en tu disco.

La *tessera* era la contraseña de guardia de las legiones romanas: la tablita
con la palabra del día. Eso es exactamente un código TOTP.

```
npm run dev      # con la consola del renderer en la terminal
npm test         # motor TOTP contra los vectores del RFC + store + tokens + actualizador
npm run smoke    # monta la app con Electron y la usa como una persona
npm run icon     # regenera build/icon.ico desde tools/icon.py (Pillow)
npm run build    # instalador NSIS + portable en dist/, sin publicar
npm run release  # lo mismo, y lo sube como release de GitHub (ver abajo)
```

## Cómo entra una cuenta

Cuatro caminos, todos terminan en el mismo modal de confirmación (que muestra
el código de ahora, para cotejar contra el sitio antes de guardar):

| Camino | Qué hace |
|---|---|
| **Escanear la pantalla** | Esconde la ventana, captura cada monitor a resolución real y busca un QR. Dejá el QR del sitio a la vista y listo. |
| **Desde una imagen** | Un PNG/JPEG con el QR (una captura, una foto). |
| **Del portapapeles** | Una imagen copiada, o el texto `otpauth://` pegado. |
| **A mano** | Emisor, cuenta y la clave base32; dígitos/período/algoritmo plegados abajo. |

Solo TOTP (por tiempo). HOTP por contador casi no existe y complicaba la UI
para nada: el error lo dice con todas las letras.

### Traer las cuentas de Google Authenticator

En el teléfono, *Transferir cuentas → Exportar cuentas* muestra uno o varios QR
`otpauth-migration://` con todas las cuentas adentro (un protobuf en base64;
`otpauth.js` lo decodifica a mano, el esquema es chico). Cualquiera de los
cuatro caminos lo entiende: se lista lo que trae, se saltea lo que ya está y lo
que no es TOTP, y se importa el lote entero. Si son varios QR, se escanea uno
por uno.

Para que Tessera vea la pantalla del teléfono: espejarlo con scrcpy
(`phone <alias>`) y *Escanear la pantalla*, o sacarle una foto al QR y entrar
por *Desde una imagen*.

## Borrar no pregunta

El tacho de una fila la saca **al instante**, sin modal. A cambio, el toast
trae **Deshacer** durante seis segundos y la trae de vuelta con el mismo id y
la clave intacta. Para eso el `Toast` de Onyx ganó un `action: { label, run }`
(ver `renderer/js/overlays.js`).

## Siempre a mano

Tessera corre en **una sola instancia**: abrirla de nuevo trae al frente la que
ya está. Y **cerrar la ventana la esconde en la bandeja**, no la termina: un
autenticador se quiere abierto. El ícono de la bandeja la muestra con un clic;
*Salir* está en su menú, y es lo único (además del actualizador) que la cierra
de verdad.

## Dónde viven las claves

`data/accounts/<id>.json`, un archivo por cuenta, como cualquier colección de
Onyx. Los metadatos van en claro (se leen y se arreglan a mano); la clave va
como `secretEnc`, cifrada con `safeStorage` — en Windows, DPAPI atado a tu
usuario. Nunca se escribe en claro si el sistema puede cifrar.

**La trampa que hay que saber:** la llave de `safeStorage` vive en el
`userData` de la app (`%APPDATA%\tessera`). Si ese directorio desaparece —
reinstalar Windows, borrar los datos de la app, cambiar de usuario — los
`secretEnc` quedan ilegibles para siempre. Tessera no los esconde: la cuenta
aparece como **Sin clave**, en rojo. La única vuelta atrás es el respaldo:
**Ajustes → Exportar respaldo** escribe un `.txt` con una URI `otpauth://` por
línea (en texto plano, y el modal te lo advierte). **Importar respaldo** lee
ese mismo archivo y saltea las que ya están.

Corolario para desarrollo: una instancia lanzada desde otro árbol de procesos
(otro usuario, un sandbox que virtualiza AppData) tiene OTRA llave. Nunca des
de alta cuentas reales desde ahí sobre el `data/` de producción: el de humo
usa un `TESSERA_DATA` temporal justamente por eso.

## El motor

`renderer/js/totp.js` implementa RFC 4226/6238 sobre WebCrypto (SHA1, SHA256 y
SHA512; 6, 7 u 8 dígitos; período libre). `test/totp.test.mjs` lo corre contra
los vectores oficiales de los dos RFC. `renderer/js/otpauth.js` parsea y arma
las URIs. Los dos son módulos puros: se prueban con `node`, sin Electron.

Los códigos se calculan en el renderer una vez por segundo, alineado al reloj.
El anillo de cada fila apunta al valor de *dentro* de un segundo con una
transición lineal, así el reloj se ve continuo tocando el DOM una sola vez por
tick. Si le quedan menos de 3 s al código, el clic copia el **siguiente**: el
que va a valer cuando lo pegues.

## Instalar y actualizar

Los releases viven en <https://github.com/kiddshady/Tessera/releases>: un
instalador (`Tessera-Setup-x.y.z.exe`) y un portable. Instalada, **se actualiza
sola** con `electron-updater` leyendo el `latest.yml` que electron-builder sube
a cada release — no hay servidor ni endpoint que mantener.

Cómo se comporta, a propósito:

- Busca al arrancar, en silencio. **Solo avisa si hay algo**: un "estás al día"
  en cada arranque es lo que hace que la gente odie a los actualizadores.
- **Nunca descarga sin que se lo pidas** (pesa ~90 MB). El toast ofrece *Ver*, el
  modal dice cuánto pesa y linkea las notas, y *Descargar* es tu clic.
- Bajada, se instala con *Reiniciar y actualizar* — o sola la próxima vez que
  cerrás la app, si nunca hacés clic.
- La versión de la statusbar es el botón: clic para buscar a mano, o para abrir
  la que ya está esperando.
- **La portable no se actualiza sola** (es un solo `.exe` que dejaste donde
  quisiste), y desde el código fuente tampoco. En los dos casos la app lo dice.

Para publicar una versión: bump de `version` en `package.json` en su propio
commit `chore(release): vX.Y.Z`, y después, en una sola línea porque cada shell
es una sesión nueva:

```powershell
$env:GH_TOKEN = gh auth token; npm run release
```

Eso compila, crea el release `vX.Y.Z` y sube los dos `.exe` + `latest.yml`. El
título del release es lo que ve el usuario en el cartel: que sea descriptivo.
La primera instalación es a mano, siempre: una versión sin actualizador no se
entera de nada.

## Mapa de lo propio

```
src/vault.cjs           la bóveda: cifra al guardar, descifra al listar, marca lo ilegible
src/qr.cjs              pantalla / archivo / portapapeles → texto del QR (jsQR)
src/actualizador.cjs    electron-updater con las decisiones aparte y testeables
renderer/js/totp.js     HOTP/TOTP + base32, puro
renderer/js/otpauth.js  otpauth:// ida y vuelta, y el formato del respaldo
renderer/js/app.js      vistas, alta, borrado con deshacer, motor de tick
renderer/css/tessera.css  la fila, el código, el anillo (prefijo ts-)
tools/icon.py           la marca como baldosa a sangre → build/icon.ico
test/smoke.test.cjs     la app usada de punta a punta, con un QR real en pantalla
```

Todo lo demás es Onyx sin tocar: ver `docs/sistema.md`.
