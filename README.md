# Pliego / Firma de PDFs por lotes

Node.js 22, Express 5, React y AutoFirma. Preparacion del PDF en el servidor,
firma de su hash en el equipo del usuario e insercion de CMS detached validado.
La clave privada nunca se envia al backend.

## Ejecucion local

```sh
npm ci
npm test
npm run build
npm start
```

Abrir http://localhost:3000. Express sirve la interfaz compilada y la API con el
mismo origen. Para desarrollar, mantener `npm start` y ejecutar `npm run dev`
en otra terminal (Vite muestra su URL y reenvia `/api` al puerto 3000).
En desarrollo con Vite, establecer `APP_ORIGIN` al origen que muestre Vite
antes de arrancar Express, por ejemplo `http://localhost:5173`.

Variables del servidor:

| Variable     | Valor predeterminado  | Uso                                                                                        |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `PORT`       | `3000`                | Puerto HTTP                                                                                |
| `APP_ORIGIN` | Origen de la peticion | Origen permitido para llamadas del navegador; fijarlo en produccion a la URL publica HTTPS |

## Configurar AutoFirma

1. Instalar AutoFirma desde https://firmaelectronica.gob.es/ciudadanos/descargas y disponer de un certificado con clave privada.
2. La biblioteca oficial ya esta incluida en `public/autofirma/autoscript.js`, sin modificaciones, desde la etiqueta `v1.9.2` del repositorio `ctt-gob-es/clienteafirma`, commit `b4fe147c322932ebdd11e25db3134af934e0e832`. Su version JavaScript interna es `1.9.0` y soporta **lotes locales JSON**.
3. `public/config.js` ya configura `autofirmaScriptUrl: '/autofirma/autoscript.js'`. Se sirve localmente y se carga como script clasico al iniciar la firma, sin CDN ni paquetes npm de terceros. La aplicacion reconoce `AutoScript`, `MiniApplet` o `AutoFirma` si exponen la API oficial.
4. Ejecutar `npm run build` y `npm start`. Docker incluye la biblioteca automaticamente. Puede montarse un archivo de configuracion alternativo en `/app/dist/config.js`, de solo lectura.

La procedencia, el commit inmutable y la huella SHA-256 estan en
`public/autofirma/UPSTREAM.md`. Se incluyen los avisos oficiales y los textos
GPL-2.0 y EUPL-1.1; respetar sus condiciones al redistribuir. `npm test` verifica
la integridad del script y sus exportaciones. La biblioteca web no instala la
aplicacion nativa AutoFirma ni sustituye la prueba con un certificado real.

`clientAddress` identifica el despliegue de AutoFirma, **no** nuestra API. En
escritorio se usa la conexion local de la biblioteca. Si el entorno necesita un
servidor intermedio, configurar sus `storageServlet` y `retrieverServlet` reales;
estos servlets no los implementa Express. No se garantiza soporte movil.

Antes de preparar los PDFs, el adaptador usa `selectCertificate` una vez y
`setStickySignatory(true)` para mantener esa seleccion. Envia el certificado
publico a la preparacion; nunca solicita ni transmite la clave privada. La
operacion de lote usa el filtro `encodedcert` con ese mismo certificado:

```js
client.setLocalBatchProcess(true);
client.createBatch('SHA256withRSA', 'CAdES', 'sign', [
  'precalculatedHashAlgorithm=SHA-256',
  'mode=explicit',
  'profile=baseline',
  'includeSigningTimeAttribute=false',
  'includeContentHintAttribute=false',
].join('\n'));
documents.forEach(doc => client.addDocumentToBatch(doc.documentId, doc.hashBase64));
client.signBatchProcess(false, null, null,
  `filters=encodedcert:${certificateBase64}\nheadless=true`, successCallback, errorCallback);
```

No existe una llamada generica `sign(arrayDeHashes)` en esta API. El lote local
selecciona un certificado para todas las operaciones y devuelve
`{ signs: [{ id, result, signature, description? }] }`. No requiere desplegar los
servicios Java de pre/postfirma de **lotes remotos**. La biblioteca y AutoFirma
deben soportar este modo; las versiones antiguas se rechazan. El adaptador no
inventa callbacks de firma masiva ni solicita acceso a la clave privada.

Fuentes oficiales consultadas en el repositorio `ctt-gob-es/clienteafirma`:

- [autoscript.js fijado](https://github.com/ctt-gob-es/clienteafirma/blob/b4fe147c322932ebdd11e25db3134af934e0e832/afirma-ui-miniapplet-deploy/src/main/webapp/js/autoscript.js)
- [JSONBatchManager](https://github.com/ctt-gob-es/clienteafirma/blob/master/afirma-simple/src/main/java/es/gob/afirma/standalone/protocol/JSONBatchManager.java)
- [CAdESExtraParams](https://github.com/ctt-gob-es/clienteafirma/blob/master/afirma-crypto-cades/src/main/java/es/gob/afirma/signers/cades/CAdESExtraParams.java)

## API

### POST /api/pdf/prepare

Multipart con uno o varios archivos en el campo `files`. Maximo 10 PDFs por
peticion y 10 MiB por archivo. La UI permite hasta 50 documentos y prepara cada
uno por separado para aislar errores. Los lotes enviados juntos son atomicos:
si un PDF no se puede preparar, no se guarda ninguno.

```sh
curl -F "files=@documento.pdf" http://localhost:3000/api/pdf/prepare
```

La interfaz activa **Firma visible** y **Usar casilla del PDF** por defecto.
El DNI/NIE se obtiene del certificado seleccionado en AutoFirma, sin entrada
manual. La fecha es automatica y coincide con `/M` del diccionario de firma PDF
(UTC). Ambos se incorporan a la apariencia antes de calcular el hash.

Si hay un campo de firma AcroForm vacio utilizable, se conserva su nombre,
pagina y rectangulo, sin crear un campo duplicado. Si hay varios, se usa el
primero en orden de pagina y de formulario. Se omiten campos de solo lectura,
ocultos, fuera del CropBox, con varios widgets o menores de 120 x 36 puntos
visuales. No se intenta reconocer rectangulos dibujados o cajas escaneadas:
no son campos de firma identificables de forma fiable.

Si no hay una casilla util, o se desactiva **Usar casilla del PDF**, se usa la
primera/ultima pagina y esquina elegidas. El valor alternativo por defecto es
ultima pagina, esquina inferior derecha. Desmarcar **Firma visible** conserva
la firma invisible.

La API acepta un campo multipart opcional `visibleSignature` con JSON:

```json
{
  "certificateBase64": "CERTIFICADO_DER_BASE64_DEVUELTO_POR_AUTOFIRMA",
  "useExisting": true,
  "page": "last",
  "position": "bottom-right"
}
```

`page` admite `first` o `last`; `position` admite `bottom-right`, `bottom-left`,
`top-right` o `top-left`, y actuan como posicion alternativa. `useExisting` es
un booleano opcional, `true` por defecto. `certificateBase64` es obligatorio
cuando se solicita apariencia visible. Se extrae el DNI/NIE del atributo
`serialNumber` del sujeto (OID 2.5.4.5, incluidos prefijos IDCES/PNOES), o de un
CN con un identificador inequivoco. Si no se puede extraer, se rechaza la firma
visible en lugar de admitir una identidad escrita a mano. En la inyeccion se
exige que el certificado CMS coincida con el usado para crear la apariencia.

La hora `/M` se registra automaticamente al preparar la firma y queda cubierta
por su hash. No es la fecha de emision del certificado ni un sello TSA. El perfil
PAdES no incluye `signingTime` dentro de CMS; copiar un tiempo obtenido despues
de firmar cambiaria el PDF y romperia la firma. Las opciones se aplican a todos
los PDFs de la peticion. Omitir el campo mantiene la API de firma invisible.

Respuesta `201`:

```json
[
  {
    "documentId": "identificador-uuid-aleatorio",
    "filename": "documento.pdf",
    "hashBase64": "SHA256_EN_BASE64",
    "expiresAt": 1792320000000
  }
]
```

El servidor usa `pdf-lib` y `@signpdf/placeholder-pdf-lib` para crear un campo
de firma y reservar **16384 bytes CMS**, representados por **32768 caracteres
hexadecimales**. El placeholder se rellena con ceros ASCII.
Si se solicita firma visible, el campo tiene una apariencia imprimible con
DNI/NIE y fecha, ajustada al CropBox y la rotacion de la pagina. La caja puede
cubrir contenido existente: elegir una esquina libre y comprobar el PDF final.

Si `<Contents>` empieza en `inicio` y termina en `fin` (posicion de `>`),
`ByteRange = [0, inicio, fin + 1, longitud - fin - 1]`. Se excluyen tanto el
contenido como `<` y `>`. Primero se fija ByteRange sin cambiar su anchura;
despues se calcula `SHA256(segmento1 || segmento2)`. No se vuelve a serializar
el PDF tras este paso.

### POST /api/pdf/inject

JSON:

```json
{
  "documentId": "ID_RECIBIDO_EN_PREPARE",
  "signatureBase64": "CMS_DETACHED_EN_BASE64"
}
```

Respuesta `200`, `application/pdf`, con nombre de descarga. El CMS se convierte
a hex y se rellena el resto del hueco con ceros. No se cambia ningun byte fuera
de Contents. El ID se consume tras responder correctamente; ante una firma
rechazada se conserva hasta su caducidad. Si se pierde la respuesta de una
inyeccion correcta hay que preparar y firmar otra vez.

El backend comprueba el hash del PDF, la firma CMS con WebCrypto/PKIjs, SHA-256,
la ausencia de contenido encapsulado, un unico firmante, vigencia temporal del
certificado, `signingCertificateV2` vinculado al certificado y la ausencia de
atributos `signingTime` y `content-hint` incompatibles con PAdES. El PDF usa
`/SubFilter /ETSI.CAdES.detached`; la hora declarada se guarda en `/M` del PDF.

**PKCS#1 aislado no es CMS ni se puede insertar como si lo fuera.** Se rechaza:
necesitaria, al menos, certificado y un protocolo de atributos firmados
determinista acordado con el cliente. Este proyecto elige la variante CAdES/CMS
completa generada por AutoFirma para evitar producir PDFs aparentemente firmados
pero invalidos. Tampoco se acepta CMS generico sin atributos CAdES.

Errores JSON `{ "error": "..." }`: `400` entrada incompleta, `403` origen,
`404` ID consumido/caducado, `409` inyeccion simultanea, `413` limites de carga,
`422` PDF/CMS no aceptado, `429` exceso de peticiones y `503` capacidad temporal.
`GET /api/health` responde `{ "status": "ok" }`.

## Alcance y seguridad

- Aunque el enunciado lo denomina "Client-Side Hashing", en este contrato el hash del ByteRange se calcula en el **servidor** y se firma en el cliente. No es el protocolo de servicios trifasicos Java de @firma; son las tres fases de esta API.
- Almacen efimero en memoria: TTL de 15 minutos y limite de 128 MiB. Los IDs UUID son capacidades secretas, no deben registrarse ni compartirse. Un reinicio elimina documentos pendientes. Un despliegue con varias replicas requiere almacen compartido con bloqueo atomico y vinculacion a la sesion autenticada.
- Antes de exponerlo publicamente, incorporar autenticacion/autorizacion, cuotas por usuario y TLS. La comprobacion de Origin y el rate limit no sustituyen esos controles. Configurar correctamente el proxy de confianza antes de habilitar `trust proxy`.
- Hasta dos preparaciones simultaneas, limites de Multer y rate limit de 120 peticiones/minuto/IP. Fijar tambien limites de cuerpo, tiempos y memoria en el proxy/contenedor; pdf-lib procesa archivos en memoria y no es un sandbox contra PDFs hostiles.
- Se rechazan PDFs cifrados, con firmas previas o campos de firma ya rellenados: pdf-lib reescribe el archivo y no preserva firmas anteriores. Los campos vacios se pueden reutilizar. La multifirma incremental sobre el mismo PDF requiere otra implementacion. Aqui "lote" significa distintos PDFs.
- La verificacion criptografica no comprueba cadena de confianza, OCSP/CRL ni condicion de certificado cualificado. No incluye TSA ni perfiles PAdES-T/LT/LTA. No es una certificacion de conformidad ETSI/eIDAS. Validar PDFs resultantes con un validador PAdES independiente (por ejemplo DSS o VALIDe) y probar con la version concreta de AutoFirma y el certificado de destino antes de produccion.
- Las pruebas automatizadas usan certificados efimeros de prueba y un doble del contrato JavaScript. No sustituyen la prueba manual con AutoFirma instalada ni los dialogos del sistema operativo; la seleccion de certificado es unica por lote, pero el dispositivo puede volver a pedir PIN/consentimiento.
- La biblioteca oficial no se descarga de un CDN durante una firma. La fuente web de Google Fonts es opcional y solo afecta al aspecto. Ajustar la politica CSP del despliegue a la biblioteca y sus conexiones locales/servlets; Helmet mantiene el resto de cabeceras, pero no impone aqui una CSP que bloquee AutoFirma.

## Docker

```sh
docker build -t multi-sign-pdf .
docker run --rm --init -p 3000:3000 -e APP_ORIGIN=http://localhost:3000 multi-sign-pdf
```

Build multi-stage: ejecuta pruebas y compila React; imagen final Node 22 Alpine,
solo dependencias de produccion, usuario `node`, puerto 3000 y healthcheck.
La biblioteca oficial y sus licencias ya se incluyen en el build. Puede montarse
un `config.js` alternativo. No hay secretos ni claves privadas dentro de la imagen.

### Docker Compose

Con Docker Engine y el plugin Docker Compose instalados:

```sh
docker compose config
docker compose up --build -d
docker compose logs -f pdf-signer
```

Abrir http://localhost:3001. `compose.yaml` construye el target `production`,
hereda el healthcheck del Dockerfile y ejecuta el contenedor como usuario `node`,
con filesystem de solo lectura y sin capabilities. El puerto solo se publica en
`127.0.0.1`; se usa 3001 para evitar el servidor de desarrollo habitual en 3000.

Para cambiar el puerto, establecer `HOST_PORT` en el entorno o en un archivo
`.env`, por ejemplo `HOST_PORT=8080`. El origen permitido se ajusta al mismo
puerto. Para un proxy HTTPS, establecer tambien `APP_ORIGIN` con la URL publica
exacta y configurar el proxy; este ejemplo no proporciona TLS ni autenticacion.

```sh
docker compose down
```

Los documentos pendientes viven en memoria y se pierden al reiniciar o recrear
el contenedor. No hay volumen de datos que preserve ese estado. AutoFirma y el
certificado deben estar en el equipo del usuario, no dentro del contenedor.

## GitHub Actions / Docker Hub

Crear en el repositorio los secretos `DOCKER_USERNAME` y `DOCKER_PASSWORD`
(preferiblemente un access token de Docker Hub con permiso de escritura).
Crear el repositorio `DOCKER_USERNAME/multi-sign-pdf` en Docker Hub.

Al hacer push a `main`, `.github/workflows/docker-publish.yml` ejecuta el build
(incluidas pruebas), hace login y publica con `docker/build-push-action@v5`:

- `DOCKER_USERNAME/multi-sign-pdf:latest`
- `DOCKER_USERNAME/multi-sign-pdf:<SHA completo del commit>`

No hace despliegue automatico a un servidor ni configura secretos por si mismo.