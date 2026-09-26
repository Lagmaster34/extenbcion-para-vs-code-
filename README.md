# GifDeck

Superpone un GIF, WebP o vídeo sobre la ventana de VS Code, anclado a una esquina,
sin ocupar espacio en el layout ni interceptar clics.

<!-- CAPTURA 1: el overlay en la esquina inferior derecha, sobre código real.
     Pon el archivo en docs/overlay.png y descomenta la línea de abajo.
     Usa un GIF propio o con licencia CC0: nada de material con derechos.
     Ver docs/LEEME.md. -->
<!-- ![El overlay anclado en la esquina inferior derecha](docs/overlay.png) -->

**GifDeck no incluye ningún medio.** Eliges tu propio archivo la primera vez que la
abres, y sólo ese archivo se usa.

## Antes de instalar, lee esto

GifDeck **modifica los archivos de tu instalación de VS Code**. No hay ninguna API
de extensión que permita dibujar encima del workbench, así que la única forma de
conseguirlo es inyectar un fragmento de JavaScript en el bundle del editor.

En concreto:

- Añade un bloque delimitado por `/* ==GIFDECK_START== */` al final de
  `out/vs/workbench/workbench.desktop.main.js`.
- Recalcula la entrada correspondiente en `product.json`, porque VS Code compara
  ese hash al arrancar y si no cuadra muestra "Your Code installation appears to
  be corrupt" en cada inicio.
- Guarda una copia del bundle original en `~/.gifdeck/` antes del primer parche.

Si eso no te parece aceptable, no instales esta extensión. Es una decisión
razonable.

## Plataformas

| Plataforma | Estado |
| --- | --- |
| Linux | Soportado |
| Windows | Soportado, requiere abrir VS Code como administrador una vez si usas System Setup |
| macOS | No soportado en esta versión |

macOS queda fuera a propósito. Modificar el bundle invalida la firma de la
aplicación, Gatekeeper puede negarse a abrirla y las actualizaciones automáticas
pueden empezar a fallar. Es un estado difícil de arreglar para quien lo sufre, así
que la extensión avisa y no toca nada.

Tampoco funciona en Remote SSH, WSL ni contenedores, y por eso el manifiesto
declara `"extensionKind": ["ui"]`. En esos escenarios el extension host corre en
la máquina remota, y parchear allí modificaría el editor equivocado.

## Permisos

En Linux, si instalaste VS Code con el gestor de paquetes, esos dos archivos
pertenecen a root. GifDeck te pedirá la contraseña **una sola vez**, y sólo para
un `chown` de esos dos archivos concretos:

```
pkexec /usr/bin/chown <uid>:<gid> <bundle> <product.json>
```

El diálogo te enseña el comando exacto antes de ejecutarlo, y puedes copiarlo y
correrlo tú en una terminal si lo prefieres. Todo el parcheo posterior corre sin
privilegios: la extensión nunca ejecuta escrituras arbitrarias como root.

Ten presente el efecto secundario: a partir de ese momento esos dos archivos son
escribibles por tu usuario, lo que baja un peldaño la protección frente a
cualquier proceso que corra con tu cuenta. Cada actualización de VS Code los
devuelve a root.

## Primera vez

Al activarse por primera vez, GifDeck muestra un aviso con un botón **Elegir GIF o
vídeo**. Ese botón abre un selector filtrado a los formatos soportados, comprueba
que el archivo sea válido y aplica el overlay. Si cierras el aviso no vuelve a
salir, y puedes hacerlo cuando quieras con el comando `GifDeck: Elegir medio`.

<!-- CAPTURA 2: el aviso de bienvenida con el botón "Elegir GIF o vídeo".
     Guárdala en docs/bienvenida.png y descomenta la línea siguiente.
     Ver docs/LEEME.md. -->
<!-- ![Aviso de la primera ejecución](docs/bienvenida.png) -->

## Uso

| Comando | Qué hace |
| --- | --- |
| `GifDeck: Elegir medio` | Abre el selector, valida el archivo y aplica el overlay |
| `GifDeck: Activar overlay` | Aplica el parche |
| `GifDeck: Desactivar overlay` | Lo revierte y deja el bundle como estaba |
| `GifDeck: Reaplicar parche` | Vuelve a aplicarlo tras una actualización del editor |

Después de activar o desactivar hay que recargar la ventana. Si no ves el cambio,
cierra y abre VS Code entero: a veces el bundle queda cacheado.

## Ajustes

Todos bajo `gifdeck.*`. Cambiar cualquiera reaplica el parche solo.

| Ajuste | Por defecto | Qué hace |
| --- | --- | --- |
| `mediaPath` | vacío | Ruta a tu medio. Sin esto no hay nada que mostrar |
| `position` | `bottom-right` | Esquina de anclaje |
| `width` | `260` | Ancho **máximo** en píxeles |
| `scaling` | `none` | `none` o `integer`, ver abajo |
| `opacity` | `0.85` | Opacidad |
| `offset` | `[16, 16]` | Separación horizontal y vertical desde la esquina |
| `avoidStatusBar` | `true` | Sube el overlay por encima de la barra de estado |
| `zIndex` | `100` | Orden de apilamiento |
| `hideOnHover` | `false` | Se desvanece cuando el puntero entra en su zona |

Formatos aceptados: `webm`, `mp4`, `gif`, `webp`, `apng`, `png`. **WebM y WebP
pesan mucho menos y consumen mucha menos CPU que un GIF equivalente.**

### Tamaño y nitidez

`width` es un máximo, no un ancho exacto. GifDeck mide las dimensiones reales del
archivo en el renderer y **nunca amplía por encima de su tamaño natural**.

El motivo es concreto. Ampliar por un factor fraccionario introduce una costura
periódica que se ve como franjas. Un GIF de 128 píxeles llevado a 260 da un factor
de 65/32: cada 32 píxeles de origen se convierten en 65 de destino, 31 duplicados y
uno triplicado, y esa costura se repite por toda la imagen. El alto calculado
tampoco caía en un número entero, así que los bordes del elemento quedaban entre
píxeles físicos y se añadía otra pasada de remuestreo.

Por eso el overlay redondea ancho y alto a enteros, y `scaling` decide qué hacer
cuando el archivo es más pequeño que `width`:

- `none`, por defecto: se dibuja a su tamaño natural. Máxima fidelidad, sin ninguna
  interpolación.
- `integer`: amplía solo en múltiplos exactos, 2x, 3x y así, con interpolación
  nearest. **Los archivos pequeños se ven mejor con esta opción.** Ese GIF de 128
  píxeles pasa a ocupar 256 sin una sola interpolación. La estética es de pixel art,
  con bordes duros.

Cuando el medio es más grande que `width` se reduce, que es una operación que no
genera artefactos, y `scaling` no interviene.

### Barra de estado

Con `avoidStatusBar` activado y el overlay anclado abajo, la altura de la barra se
suma al desplazamiento vertical. La medida se toma del elemento real en cada cambio
de tamaño o de zoom, nunca de un valor fijo, y no se reserva nada si la tienes
oculta.

## Cuándo se reaplica el parche

Al arrancar, GifDeck comprueba dos cosas distintas.

La primera es si el bundle sigue siendo el que parcheó, comparando su tamaño y su
fecha de modificación con lo que guardó en `~/.gifdeck/state.json`. Es un `stat`, no
una lectura de 18 MB. Si no coinciden, el editor se actualizó y se llevó el parche
por delante, así que te ofrece reaplicarlo. En distribuciones como Arch el gestor de
paquetes además devuelve los archivos a root, así que volverá a pedirte el `chown`.

La segunda es si el parche que hay puesto es el que corresponde, comparando un
`sha256` del bloque inyectado. Comparar sólo la versión de VS Code no bastaría:
cuando GifDeck se actualiza a una versión que inyecta código distinto, el bundle
sigue teniendo el parche viejo y nada delataría que está desfasado. Con el hash sí,
y si los archivos ya son escribibles se reaplica solo, sin preguntar. Si hiciera
falta pedir permisos, pregunta antes, porque un diálogo de contraseña nada más abrir
el editor no es aceptable.

## Si no ves el overlay

Antes de parchear nada, GifDeck comprueba los bytes de cabecera del archivo. Si está
vacío, truncado, corrupto, o tiene una extensión que no corresponde a su contenido
real, verás un error concreto en el editor y no se toca la instalación.

Lo que ya no puede avisarte desde el editor es un fallo dentro del renderer, porque
el código inyectado corre en el workbench y no tiene ningún canal de vuelta hacia la
extensión. Ahí el overlay se queda invisible a propósito, para no dejar un icono de
imagen rota sobre tu código, y el diagnóstico va a la consola. Para verlo, **Ayuda >
Alternar herramientas de desarrollo**, pestaña Console, y busca `[gifdeck]`. Hay dos
mensajes posibles:

- Un error de carga, con la URL y la causa probable. Lo habitual es que la copia de
  `globalStorage` se haya borrado, y se arregla con `GifDeck: Reaplicar parche`.
- Un aviso a los 8 segundos si el medio nunca reportó dimensiones, que apunta a un
  archivo truncado o a una cabecera que ese renderer no entiende.

## Cómo llega el medio a la pantalla

El renderer del workbench corre bajo una CSP que declara `media-src 'self'`, sin
`data:`. Eso significa que un vídeo embebido en base64 está bloqueado, por mucho
que la etiqueta de imagen sí acepte `data:`.

La solución es servir el archivo por `vscode-file://vscode-app/...`, el mismo
esquema con el que el workbench carga sus propios recursos. Ese protocolo sólo
sirve archivos bajo una de sus raíces válidas, y el almacenamiento global de la
extensión es una de ellas, así que GifDeck copia ahí el medio elegido y lo
referencia por URL. El parche inyectado ocupa unos cientos de bytes en vez de
megabytes de base64, y el arranque del editor no se resiente.

Nota para quien use perfiles de VS Code no predeterminados: sólo el
almacenamiento global del perfil por defecto está registrado como raíz válida. Con
otro perfil, los formatos de la lista blanca del protocolo (`png`, `jpg`, `gif`,
`webp`, `bmp`, `mp4`) siguen cargando, pero `webm` y `apng` pueden no hacerlo.

## Desinstalación

Desinstalar desde VS Code ejecuta `out/uninstall.js`, que revierte el parche,
restaura el checksum y borra `~/.gifdeck/`. Ese script corre en un proceso Node
suelto, sin acceso al módulo `vscode`, y por eso toda la información que necesita
está en `~/.gifdeck/state.json`.

Lo que ese script **no** puede hacer es pedir contraseña. Si para entonces los
archivos han vuelto a pertenecer a root, por ejemplo tras una actualización del
editor, la limpieza no se puede completar. En ese caso GifDeck deja un archivo
`~/.gifdeck/LIMPIEZA-PENDIENTE.txt` con el comando exacto que hay que ejecutar a
mano.

Recomendación: ejecuta `GifDeck: Desactivar overlay` **antes** de desinstalar.

## Desarrollo

```bash
npm install
npm test     # compila y ejecuta los tests
npm run compile
```

Luego F5 para abrir la ventana de desarrollo de extensiones. **El overlay sólo
cambia cuando la extensión se activa de verdad en una ventana de desarrollo**, así
que después de editar el código hace falta F5 y recargar, no basta con compilar.

### Tests

Los tests viven en `test/` y se ejecutan con Node a secas, sin dependencias. Dos
reglas los definen:

- **Corren contra `out/`**, el mismo JavaScript que empaqueta el `.vsix` y que carga
  el editor. `npm test` compila primero y el ejecutor aborta si `out/` está vacío,
  para que sea imposible dar por bueno un código que no es el que se publica.
- **`vscode:prepublish` ejecuta `npm test`**, así que no se puede empaquetar ni
  publicar una versión con los tests en rojo. En esta extensión eso importa más de
  lo normal: un bloque inyectado mal formado deja el workbench del usuario sin
  cargar.

El módulo `vscode` sólo existe dentro del editor, así que el ejecutor intercepta
ese `require` y devuelve un doble de prueba. Eso permite cargar `patcher.js` y
`extension.js` tal cual y probar `activate()` de principio a fin: la
sincronización del parche, la bienvenida y la selección de medio. El parcheador se
prueba siempre contra una instalación de VS Code falsa en un directorio temporal,
nunca contra la real.

## Licencia

MIT
