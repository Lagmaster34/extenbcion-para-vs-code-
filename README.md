# GifDeck

Superpone un GIF, WebP o vídeo sobre la ventana de VS Code, anclado a una esquina,
sin ocupar espacio en el layout ni interceptar clics.

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

## Uso

| Comando | Qué hace |
| --- | --- |
| `GifDeck: Elegir archivo...` | Selecciona el medio a mostrar |
| `GifDeck: Activar overlay` | Aplica el parche |
| `GifDeck: Desactivar overlay` | Lo revierte y deja el bundle como estaba |
| `GifDeck: Reaplicar parche` | Vuelve a aplicarlo tras una actualización del editor |

Después de activar o desactivar hay que recargar la ventana. Si no ves el cambio,
cierra y abre VS Code entero: a veces el bundle queda cacheado.

## Ajustes

Todos bajo `gifdeck.*`: `mediaPath`, `position`, `width`, `opacity`, `offset`,
`zIndex` y `hideOnHover`. Cambiar cualquiera reaplica el parche solo.

Formatos aceptados: `webm`, `mp4`, `gif`, `webp`, `apng`, `png`. **WebM y WebP
pesan mucho menos y consumen mucha menos CPU que un GIF equivalente.**

## Actualizaciones de VS Code

Cada actualización reescribe el bundle y se lleva el parche. GifDeck lo detecta al
arrancar y ofrece reaplicarlo. En distribuciones como Arch, el gestor de paquetes
además devuelve los archivos a root, así que volverá a pedirte el `chown`.

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
npm run compile
```

Luego F5 para abrir la ventana de desarrollo de extensiones.

## Licencia

MIT
# extenbcion-para-vs-code-
