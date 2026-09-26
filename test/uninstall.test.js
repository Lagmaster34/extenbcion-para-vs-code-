/**
 * El hook vscode:uninstall corre como proceso Node aparte, sin modulo vscode.
 * Estos tests lo lanzan exactamente igual que lo lanza el editor.
 */
const { group, test, ok, eq, includes } = require('./tap.js');
const h = require('./helpers.js');
const { execFileSync } = require('child_process');

const core = h.out('core.js');
const patcher = h.out('patcher.js');
const { build } = h.out('inject.js');

const SCRIPT = h.path.join(h.OUT, 'uninstall.js');
const payload = () => build(
  { position: 'bottom-right', width: 260, opacity: 0.85, offset: [16, 16], zIndex: 100,
    hideOnHover: false, scaling: 'none', avoidStatusBar: true },
  { uri: 'vscode-file://vscode-app/x/a.gif', kind: 'image' }
);

function runUninstall(box) {
  try {
    return execFileSync('node', [SCRIPT], {
      env: { ...process.env, HOME: box.home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    return String(err.stdout ?? '') + String(err.stderr ?? '');
  }
}

const noteOf = box => h.path.join(box.gifdeckDir, 'LIMPIEZA-PENDIENTE.txt');

group('desinstalacion: camino normal');

test('revierte el parche y borra todo lo suyo', async () => {
  const box = await h.sandbox();
  try {
    const mediaDir = h.path.join(box.globalStorage, 'media');
    await h.fakeMedia(mediaDir, 'media-abc.gif');
    await patcher.apply(payload(), { mediaDir, extensionVersion: '0.0.1' });

    runUninstall(box);

    eq(await box.readBundle(), box.original, 'bundle identico al original');
    ok(await box.checksumMatches(), 'checksum restaurado');
    eq(await box.readState(), undefined, 'state.json borrado');
    eq(h.fs.existsSync(box.backupPath), false, 'backup borrado');
    eq(h.fs.existsSync(mediaDir), false, 'copia del medio borrada');
    eq(h.fs.existsSync(noteOf(box)), false, 'sin aviso pendiente');
  } finally {
    await h.cleanup(box);
  }
});

test('sin estado previo no toca nada', async () => {
  const box = await h.sandbox();
  try {
    runUninstall(box);
    eq(await box.readBundle(), box.original, 'bundle intacto');
    eq(h.fs.existsSync(noteOf(box)), false, 'no inventa un aviso');
  } finally {
    await h.cleanup(box);
  }
});

test('si el editor ya no esta donde estaba, limpia lo suyo y calla', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    await h.fsp.rm(h.path.join(box.appRoot, 'out'), { recursive: true, force: true });
    runUninstall(box);
    eq(await box.readState(), undefined, 'estado borrado');
    eq(h.fs.existsSync(box.backupPath), false, 'backup borrado');
  } finally {
    await h.cleanup(box);
  }
});

group('desinstalacion: sin permisos');

test('no puede pedir contrasena, asi que deja instrucciones y no toca el bundle', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    h.fs.chmodSync(box.bundle, 0o444);
    h.fs.chmodSync(box.product, 0o444);

    runUninstall(box);

    ok(core.isPatched(await box.readBundle()), 'el bundle se deja como estaba');
    ok(await box.readState() !== undefined, 'el estado se conserva para poder reintentar');
    ok(h.fs.existsSync(noteOf(box)), 'deja el aviso en el home del usuario');
    const texto = h.fs.readFileSync(noteOf(box), 'utf8');
    includes(texto, 'sudo chown', 'con el comando exacto que falta');
    includes(texto, 'uninstall.js', 'y como reintentar la limpieza');

    h.fs.chmodSync(box.bundle, 0o644);
    h.fs.chmodSync(box.product, 0o644);
    runUninstall(box);
    eq(await box.readBundle(), box.original, 'al reintentar con permisos, revierte');
    eq(h.fs.existsSync(noteOf(box)), false, 'y retira el aviso');
  } finally {
    await h.cleanup(box);
  }
});

group('desinstalacion: backup de otra version');

test('con el commit coincidente rescata un parche a medias', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    const text = await box.readBundle();
    await h.fsp.writeFile(box.bundle, text.slice(0, text.indexOf(core.START) + 100), 'utf8');

    runUninstall(box);
    eq(await box.readBundle(), box.original, 'recuperado desde el backup');
    eq(await box.readState(), undefined, 'estado limpio');
  } finally {
    await h.cleanup(box);
  }
});

test('con el commit cambiado NO restaura, porque seria de otra version del editor', async () => {
  const box = await h.sandbox();
  try {
    await patcher.apply(payload(), { mediaDir: box.globalStorage });
    const st = await box.readState();
    st.commit = 'commit-de-otra-version';
    await box.writeState(st);

    const text = await box.readBundle();
    await h.fsp.writeFile(box.bundle, text.slice(0, text.indexOf(core.START) + 100), 'utf8');

    runUninstall(box);
    ne_(await box.readBundle(), box.original);
    ok(h.fs.existsSync(noteOf(box)), 'avisa al usuario en vez de fallar en silencio');
    ok(await box.readState() !== undefined, 'conserva el estado');
  } finally {
    await h.cleanup(box);
  }
});

function ne_(actual, notExpected) {
  if (actual === notExpected) {
    throw new Error('restauro un backup que no corresponde a esta version del editor');
  }
}
