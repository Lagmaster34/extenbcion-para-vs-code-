/**
 * Tests de integracion de activate(): la sincronizacion del parche al arrancar y
 * la bienvenida de la primera ejecucion.
 *
 * Aqui se carga out/extension.js de verdad, con el doble de 'vscode', asi que se
 * ejercita el mismo camino que recorre el editor al activar la extension.
 */
const { group, test, ok, eq, includes } = require('./tap.js');
const h = require('./helpers.js');

const core = h.out('core.js');
const patcher = h.out('patcher.js');
const extension = h.out('extension.js');
const { build } = h.out('inject.js');

const vscode = require('vscode');

const BLOQUE_VIEJO = core.START + '\n(function(){ /* parche de una version anterior */ })();\n' + core.END;

/** Deja el bundle parcheado con un bloque antiguo y su checksum al dia. */
async function parcheViejo(box) {
  await core.ensureBackup(box.appRoot, box.backupPath);
  await h.fsp.writeFile(box.bundle, box.original + '\n' + BLOQUE_VIEJO, 'utf8');
  await core.refreshChecksum(box.appRoot, box.bundle);
}

const tieneParcheNuevo = async box => (await box.readBundle()).includes('function size(el)');
const prompts = () => vscode.__test.state.info.map(i => i.message);
const pidioReaplicar = () => vscode.__test.state.info.some(i => (i.items ?? []).includes('Reaplicar'));

group('activate: sincronizacion del parche al arrancar');

test('un estado de una version anterior se reaplica solo, sin preguntar', async () => {
  // Este es exactamente el caso real: state.json escrito por una version que aun
  // no guardaba bundleSize ni payloadHash, con el parche viejo puesto en el bundle.
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'mio.gif');
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: { mediaPath: gif },
      globalState: { 'gifdeck.enabled': true, 'gifdeck.welcomed': true },
      infoAnswers: []
    });

    await parcheViejo(box);
    await box.writeState({
      version: 1,
      appRoot: box.appRoot,
      bundlePath: box.bundle,
      productPath: box.product,
      backupPath: box.backupPath,
      commit: box.commit,
      vscodeVersion: '1.134.0',
      patchedAt: '2026-09-24T22:50:42.672Z',
      mediaDir: h.path.join(box.globalStorage, 'media')
      // Sin payloadHash, sin bundleSize, sin bundleMtimeMs: version anterior.
    });

    await extension.activate(h.context(box));
    await h.waitFor('el parche nuevo llega al bundle', () => tieneParcheNuevo(box));

    ok(!(await box.readBundle()).includes('parche de una version anterior'),
      'el bloque viejo debe haber desaparecido');
    eq((await box.readBundle()).split(core.START).length - 1, 1, 'un solo bloque');
    ok(await box.checksumMatches(), 'checksum al dia');
    eq(pidioReaplicar(), false, `no debe preguntar nada, y mostro: ${JSON.stringify(prompts())}`);

    const st = await box.readState();
    ok(st.payloadHash, 'el estado nuevo ya guarda el hash del bloque');
    ok(st.bundleSize > 0, 'y el tamano del bundle');
  } finally {
    await h.cleanup(box);
  }
});

test('si el parche ya es el correcto, no hace absolutamente nada', async () => {
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'mio.gif');
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: { mediaPath: gif },
      globalState: { 'gifdeck.enabled': true, 'gifdeck.welcomed': true }
    });

    // Se aplica por el mismo camino que usa la extension, asi el hash coincide.
    const mediaDir = h.path.join(box.globalStorage, 'media');
    const media = h.out('media.js');
    const staged = await media.stage(gif, mediaDir);
    const injection = build({
      position: 'bottom-right', width: 260, opacity: 0.85, offset: [16, 16], zIndex: 100,
      hideOnHover: false, scaling: 'none', avoidStatusBar: true
    }, { uri: staged.uri, kind: staged.kind });
    await patcher.apply(injection, { mediaDir, extensionVersion: '0.0.1' });

    const antes = h.fs.statSync(box.bundle).mtimeMs;
    vscode.__test.state.info = [];

    await extension.activate(h.context(box));
    await h.settle(12);

    eq(h.fs.statSync(box.bundle).mtimeMs, antes, 'no debe reescribir el bundle');
    eq(vscode.__test.state.info.length, 0, `no debe mostrar nada, mostro: ${JSON.stringify(prompts())}`);
  } finally {
    await h.cleanup(box);
  }
});

test('si el editor reescribio el bundle, pregunta en vez de reaplicar solo', async () => {
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'mio.gif');
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: { mediaPath: gif },
      globalState: { 'gifdeck.enabled': true, 'gifdeck.welcomed': true },
      version: '1.140.0'
    });

    await box.writeState({
      version: 1, appRoot: box.appRoot, bundlePath: box.bundle, productPath: box.product,
      backupPath: box.backupPath, commit: box.commit, vscodeVersion: '1.134.0',
      patchedAt: new Date().toISOString(),
      payloadHash: 'da-igual', bundleSize: 999999, bundleMtimeMs: 1
    });

    await extension.activate(h.context(box));
    await h.waitFor('sale el aviso', async () => vscode.__test.state.info.length > 0);

    ok(pidioReaplicar(), 'debe ofrecer reaplicar');
    includes(prompts()[0], '1.140.0', 'y nombrar la version nueva del editor');
  } finally {
    await h.cleanup(box);
  }
});

test('sin permisos de escritura pregunta, no intenta elevar al arrancar', async () => {
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'mio.gif');
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: { mediaPath: gif },
      globalState: { 'gifdeck.enabled': true, 'gifdeck.welcomed': true }
    });
    await parcheViejo(box);
    await box.writeState({
      version: 1, appRoot: box.appRoot, bundlePath: box.bundle, productPath: box.product,
      backupPath: box.backupPath, commit: box.commit, vscodeVersion: '1.134.0',
      patchedAt: '2026-09-24T22:50:42.672Z'
    });
    h.fs.chmodSync(box.bundle, 0o444);
    h.fs.chmodSync(box.product, 0o444);

    await extension.activate(h.context(box));
    await h.waitFor('sale el aviso', async () => vscode.__test.state.info.length > 0);

    ok(pidioReaplicar(), 'un modal de contrasena al abrir el editor seria intolerable, se pregunta antes');
    ok(!(await tieneParcheNuevo(box)), 'y no se tocan los archivos');
  } finally {
    h.fs.chmodSync(box.bundle, 0o644);
    h.fs.chmodSync(box.product, 0o644);
    await h.cleanup(box);
  }
});

test('desactivado, no mira nada ni molesta', async () => {
  const box = await h.sandbox();
  try {
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: {},
      globalState: { 'gifdeck.enabled': false, 'gifdeck.welcomed': true }
    });
    await extension.activate(h.context(box));
    await h.settle(12);
    eq(vscode.__test.state.info.length, 0, 'ni un mensaje');
    eq(await box.readBundle(), box.original, 'ni un byte tocado');
  } finally {
    await h.cleanup(box);
  }
});

test('activado pero sin medio configurado, calla en vez de dar error en cada arranque', async () => {
  const box = await h.sandbox();
  try {
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: {},
      globalState: { 'gifdeck.enabled': true, 'gifdeck.welcomed': true }
    });
    await box.writeState({
      version: 1, appRoot: box.appRoot, bundlePath: box.bundle, productPath: box.product,
      backupPath: box.backupPath, commit: box.commit, vscodeVersion: '1.134.0',
      patchedAt: new Date().toISOString(),
      payloadHash: 'x', bundleSize: h.fs.statSync(box.bundle).size,
      bundleMtimeMs: h.fs.statSync(box.bundle).mtimeMs
    });

    await extension.activate(h.context(box));
    await h.settle(12);
    eq(vscode.__test.state.error.length, 0, 'sin errores emergentes al arrancar');
  } finally {
    await h.cleanup(box);
  }
});

group('activate: bienvenida de la primera ejecucion');

test('primera vez sin medio: ofrece elegirlo y lo aplica', async () => {
  // Sin medios empaquetados, recien instalada no se ve nada. Este aviso es lo
  // unico que hay entre instalar y ver algo en pantalla.
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'elegido.gif');
    vscode.__test.reset({
      appRoot: box.appRoot,
      config: {},
      globalState: {},
      infoAnswers: ['Elegir GIF o video'],
      openDialogResult: [{ fsPath: gif }]
    });

    const ctx = h.context(box);
    await extension.activate(ctx);
    await h.waitFor('se aplica el overlay tras elegir', () => tieneParcheNuevo(box));

    includes(prompts()[0], 'no incluye ningun medio', 'el aviso explica por que no se ve nada');
    eq(vscode.__test.state.config.mediaPath, gif, 'guarda el medio elegido en los ajustes');
    eq(ctx.globalState.get('gifdeck.enabled'), true, 'y queda activado');
    ok(await box.checksumMatches(), 'con el checksum al dia');
  } finally {
    await h.cleanup(box);
  }
});

test('si se cierra el aviso, no vuelve a salir nunca', async () => {
  const box = await h.sandbox();
  try {
    vscode.__test.reset({ appRoot: box.appRoot, config: {}, globalState: {}, infoAnswers: [] });

    const ctx = h.context(box);
    await extension.activate(ctx);
    await h.waitFor('sale la bienvenida', async () => vscode.__test.state.info.length > 0);
    eq(ctx.globalState.get('gifdeck.welcomed'), true, 'se marca como ya presentada');

    // Segunda activacion, mismo globalState.
    vscode.__test.state.info = [];
    await extension.activate(h.context(box));
    await h.settle(12);
    eq(vscode.__test.state.info.length, 0, 'no debe volver a molestar');
    eq(await box.readBundle(), box.original, 'y no toca nada');
  } finally {
    await h.cleanup(box);
  }
});

test('con un medio ya configurado no da la bienvenida', async () => {
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'ya.gif');
    vscode.__test.reset({ appRoot: box.appRoot, config: { mediaPath: gif }, globalState: {} });
    const ctx = h.context(box);
    await extension.activate(ctx);
    await h.settle(12);
    eq(vscode.__test.state.info.length, 0, 'quien ya tiene medio no necesita presentacion');
    eq(ctx.globalState.get('gifdeck.welcomed'), true, 'pero se marca para no evaluarlo cada arranque');
  } finally {
    await h.cleanup(box);
  }
});

group('activate: comandos y seleccion de medio');

test('registra los cuatro comandos', async () => {
  const box = await h.sandbox();
  try {
    vscode.__test.reset({ appRoot: box.appRoot, config: {}, globalState: { 'gifdeck.welcomed': true } });
    await extension.activate(h.context(box));
    for (const id of ['gifdeck.enable', 'gifdeck.disable', 'gifdeck.reapply', 'gifdeck.pickMedia']) {
      ok(typeof vscode.__test.state.commands[id] === 'function', `falta el comando ${id}`);
    }
  } finally {
    await h.cleanup(box);
  }
});

test('elegir medio rechaza un archivo invalido y no lo guarda en los ajustes', async () => {
  const box = await h.sandbox();
  try {
    const malo = h.path.join(box.tmp, 'malo.gif');
    await h.fsp.writeFile(malo, 'no soy un gif');
    vscode.__test.reset({
      appRoot: box.appRoot, config: {}, globalState: { 'gifdeck.welcomed': true },
      openDialogResult: [{ fsPath: malo }]
    });

    await extension.activate(h.context(box));
    await vscode.__test.state.commands['gifdeck.pickMedia']();

    eq(vscode.__test.state.config.mediaPath, undefined, 'no debe quedar configurado');
    ok(vscode.__test.state.error.length > 0, 'y debe avisar del problema');
    eq(await box.readBundle(), box.original, 'sin tocar el editor');
  } finally {
    await h.cleanup(box);
  }
});

test('elegir medio con el overlay ya puesto no lo aplica dos veces', async () => {
  const box = await h.sandbox();
  try {
    const gif = await h.fakeMedia(box.tmp, 'otro.gif');
    vscode.__test.reset({
      appRoot: box.appRoot, config: {},
      globalState: { 'gifdeck.welcomed': true, 'gifdeck.enabled': true },
      openDialogResult: [{ fsPath: gif }]
    });

    await extension.activate(h.context(box));
    await h.settle(6);
    const antes = await box.readBundle();
    await vscode.__test.state.commands['gifdeck.pickMedia']();

    eq(vscode.__test.state.config.mediaPath, gif, 'guarda el medio elegido');
    eq(await box.readBundle(), antes,
      'con el overlay ya activo, del reparcheo se encarga el listener de configuracion');
  } finally {
    await h.cleanup(box);
  }
});
