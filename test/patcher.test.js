const { group, test, ok, eq, ne, includes, rejects } = require('./tap.js');
const h = require('./helpers.js');

const core = h.out('core.js');
const patcher = h.out('patcher.js');
const { build } = h.out('inject.js');

const CFG = {
  position: 'bottom-right', width: 260, opacity: 0.85, offset: [16, 16],
  zIndex: 100, hideOnHover: false, scaling: 'none', avoidStatusBar: true
};
const payload = over => build({ ...CFG, ...over }, { uri: 'vscode-file://vscode-app/x/a.gif', kind: 'image' });

group('patcher: aplicar y revertir');

test('deja el parche, el checksum y el estado coherentes', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage, extensionVersion: '0.0.1' });

    const text = await box.readBundle();
    ok(core.isPatched(text), 'el bundle lleva el parche');
    ok(text.startsWith(box.original.trimEnd()), 'el contenido original sigue delante');
    ok(await box.checksumMatches(),
      'sin esto el editor avisa de instalacion corrupta en cada arranque');

    const st = await box.readState();
    eq(st.appRoot, box.appRoot, 'guarda appRoot para la desinstalacion');
    eq(st.commit, box.commit, 'guarda el commit para no restaurar un backup de otra version');
    eq(st.extensionVersion, '0.0.1', 'guarda la version de la extension');
    eq(st.payloadHash, patcher.payloadHash(payload()), 'guarda el hash del bloque');
    eq(st.bundleSize, h.fs.statSync(box.bundle).size, 'guarda el tamano del bundle parcheado');
    ok(Math.abs(st.bundleMtimeMs - h.fs.statSync(box.bundle).mtimeMs) < 1, 'y su fecha');
    eq(h.fs.readFileSync(st.backupPath, 'utf8'), box.original, 'el backup es el original limpio');
  } finally {
    await h.cleanup(box);
  }
});

test('reaplicar no acumula bloques ni hace crecer el archivo', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    const size = h.fs.statSync(box.bundle).size;
    for (let i = 0; i < 4; i++) { await patcher.apply(payload(), { mediaDir: box.globalStorage }); }

    const text = await box.readBundle();
    eq(text.split(core.START).length - 1, 1, 'un solo bloque');
    eq(h.fs.statSync(box.bundle).size, size, 'el tamano no crece con cada reaplicado');
    ok(await box.checksumMatches(), 'checksum al dia');
  } finally {
    await h.cleanup(box);
  }
});

test('remove devuelve el bundle byte a byte y limpia el estado', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    await patcher.remove();
    eq(await box.readBundle(), box.original, 'identico al original');
    ok(await box.checksumMatches(), 'checksum restaurado');
    eq(await box.readState(), undefined, 'sin estado pendiente');
  } finally {
    await h.cleanup(box);
  }
});

group('patcher: escrituras en serie');

test('40 apply simultaneos no corrompen el bundle', async () => {
  // Esto es lo que provocaba arrastrar el slider de opacidad: el listener de
  // configuracion lanzaba un reparcheo por cada paso, y sin cola se intercalaban
  // dos leer-modificar-escribir sobre el mismo archivo.
  const box = await h.sandbox();
  try {
    await Promise.all(Array.from({ length: 40 }, (_, i) =>
      patcher.apply(payload({ opacity: 0.5 + i / 100 }), { mediaDir: box.globalStorage })));

    const text = await box.readBundle();
    eq(text.split(core.START).length - 1, 1, 'un solo marcador de apertura');
    eq(text.split(core.END).length - 1, 1, 'un solo marcador de cierre');
    ok(!core.isTruncated(text), 'no quedo a medias');
    ok(await box.checksumMatches(), 'el checksum final cuadra con el archivo final');
  } finally {
    await h.cleanup(box);
  }
});

test('apply y remove entrelazados acaban en un estado limpio', async () => {
  const box = await h.sandbox();
  try {
    const ops = [];
    for (let i = 0; i < 12; i++) {
      ops.push(patcher.apply(payload(), { mediaDir: box.globalStorage }));
      ops.push(patcher.remove());
    }
    await Promise.all(ops);
    eq(await box.readBundle(), box.original, 'el ultimo remove deja el original');
    ok(await box.checksumMatches(), 'con su checksum');
  } finally {
    await h.cleanup(box);
  }
});

test('un fallo no bloquea la cola', async () => {
  const box = await h.sandbox();
  try {
    await h.fsp.rm(box.bundle);
    await rejects(() => patcher.apply(payload(), {}), 'sin bundle debe fallar');
    await h.fsp.writeFile(box.bundle, box.original, 'utf8');
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    ok(core.isPatched(await box.readBundle()), 'la cola sigue viva despues del fallo');
  } finally {
    await h.cleanup(box);
  }
});

group('patcher: guardia de sintaxis');

test('un bloque que no compila no llega al editor', async () => {
  // El peor fallo posible de esta extension: un error de sintaxis deja
  // workbench.desktop.main.js sin cargar y el editor abre en blanco.
  const box = await h.sandbox();
  try {
    const roto = core.START + "\n(function(){ var x = 'sin cerrar; })();\n" + core.END;
    const msg = await rejects(() => patcher.apply(roto, {}), 'debe rechazarlo');
    includes(msg, 'No se ha tocado nada', 'y decir que no toco nada');
    eq(await box.readBundle(), box.original, 'el bundle sigue intacto');
    eq(await box.readState(), undefined, 'no dejo estado a medias');
  } finally {
    await h.cleanup(box);
  }
});

test('el bloque real si compila', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    ok(core.isPatched(await box.readBundle()), 'el payload de produccion pasa la guardia');
  } finally {
    await h.cleanup(box);
  }
});

group('patcher: huella del bloque');

test('el hash cambia con cualquier ajuste', async () => {
  const base = patcher.payloadHash(payload());
  eq(patcher.payloadHash(payload()), base, 'el mismo bloque da el mismo hash');
  ne(patcher.payloadHash(payload({ opacity: 0.5 })), base, 'la opacidad cambia el hash');
  ne(patcher.payloadHash(payload({ position: 'top-left' })), base, 'la posicion tambien');
  ne(patcher.payloadHash(payload({ scaling: 'integer' })), base, 'y el modo de escalado');
  ne(patcher.payloadHash(payload({ avoidStatusBar: false })), base, 'y la barra de estado');
  eq(base.length, 64, 'es un sha256 en hexadecimal');
});

test('reescribir el bundle invalida la huella guardada', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    const st = await box.readState();
    await new Promise(r => setTimeout(r, 25));
    // Esto es lo que hace una actualizacion de VS Code.
    await h.fsp.writeFile(box.bundle, box.original, 'utf8');
    const ahora = h.fs.statSync(box.bundle);
    ok(ahora.size !== st.bundleSize || Math.abs(ahora.mtimeMs - st.bundleMtimeMs) >= 1,
      'la huella debe dejar de cuadrar para que se detecte el parche perdido');
  } finally {
    await h.cleanup(box);
  }
});

test('bundlePath da un error accionable si no encuentra el bundle', async () => {
  const box = await h.sandbox();
  try {
    await h.fsp.rm(box.bundle);
    let msg = '';
    try { patcher.bundlePath(); } catch (e) { msg = e.message; }
    includes(msg, 'snap', 'debe mencionar snap o flatpak, que es la causa tipica');
  } finally {
    await h.cleanup(box);
  }
});
