/**
 * Utilidades comunes de los tests.
 *
 * Regla que no se rompe: todo lo que se prueba se carga desde out/, el mismo
 * JavaScript que empaqueta el .vsix y que carga el editor. Nada de reimplementar
 * logica aqui, porque un test que prueba su propia copia no prueba nada.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');

/** Carga un modulo compilado de out/. */
function out(name) {
  return require(path.join(OUT, name));
}

const REL_BUNDLE = 'vs/workbench/workbench.desktop.main.js';

/** sha256 en base64 sin padding, el formato que usa product.json. */
function checksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

const FAKE_BUNDLE = '/*fake workbench*/var a=1;console.log(a);\n//# sourceMappingURL=x.map\n';
const FAKE_COMMIT = 'deadbeefcafe0000000000000000000000000000';

/**
 * Monta una instalacion falsa de VS Code y un HOME falso, y apunta el doble de
 * 'vscode' y os.homedir() hacia ellos. Nunca se toca la instalacion real.
 */
async function sandbox(over = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gifdeck-test-'));
  const appRoot = path.join(tmp, 'resources', 'app');
  const home = path.join(tmp, 'home');
  const bundle = path.join(appRoot, 'out', REL_BUNDLE.split('/').join(path.sep));
  const product = path.join(appRoot, 'product.json');
  const globalStorage = path.join(tmp, 'globalStorage');

  await fsp.mkdir(path.dirname(bundle), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(globalStorage, { recursive: true });
  await fsp.writeFile(bundle, FAKE_BUNDLE, 'utf8');
  await fsp.writeFile(product, JSON.stringify({
    nameShort: 'Code',
    commit: FAKE_COMMIT,
    checksums: {
      [REL_BUNDLE]: checksum(Buffer.from(FAKE_BUNDLE, 'utf8')),
      'vs/otro.js': 'no-se-toca'
    }
  }, null, '\t'), 'utf8');

  process.env.HOME = home;
  const vscode = require('vscode');
  vscode.__test.reset({ appRoot, ...over });

  return {
    tmp, appRoot, home, bundle, product, globalStorage,
    gifdeckDir: path.join(home, '.gifdeck'),
    statePath: path.join(home, '.gifdeck', 'state.json'),
    backupPath: path.join(home, '.gifdeck', 'workbench.desktop.main.js.backup'),
    original: FAKE_BUNDLE,
    commit: FAKE_COMMIT,
    relBundle: REL_BUNDLE,

    readBundle: () => fsp.readFile(bundle, 'utf8'),
    readProduct: async () => JSON.parse(await fsp.readFile(product, 'utf8')),
    /** El checksum guardado cuadra con el archivo que hay en disco. */
    checksumMatches: async () => {
      const p = JSON.parse(await fsp.readFile(product, 'utf8'));
      return p.checksums[REL_BUNDLE] === checksum(await fsp.readFile(bundle));
    },
    readState: async () => {
      try { return JSON.parse(await fsp.readFile(path.join(home, '.gifdeck', 'state.json'), 'utf8')); }
      catch { return undefined; }
    },
    writeState: async st => {
      await fsp.mkdir(path.join(home, '.gifdeck'), { recursive: true });
      await fsp.writeFile(path.join(home, '.gifdeck', 'state.json'), JSON.stringify(st, null, 2), 'utf8');
    }
  };
}

/** Contexto de extension falso, con el minimo que usa extension.ts. */
function context(box, over = {}) {
  const store = require('vscode').__test.state.globalState;
  return {
    subscriptions: [],
    extensionPath: path.join(box.tmp, 'extension'),
    globalStorageUri: { fsPath: box.globalStorage },
    extension: { packageJSON: { version: over.version ?? '0.0.1' } },
    globalState: {
      get: k => store[k],
      update: async (k, v) => { store[k] = v; },
      keys: () => Object.keys(store)
    }
  };
}

/** Cabeceras reales de cada formato, para fabricar medios validos minimos. */
const MAGIC = {
  gif: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 7)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 7)]),
  webp: Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([40, 0, 0, 0]),
    Buffer.from('WEBP', 'latin1'), Buffer.alloc(28, 7)
  ]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 7)]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(24, 7)])
};

/**
 * Escribe un medio minimo pero valido del formato pedido. Los tests no dependen
 * de ningun archivo empaquetado, porque la extension ya no incluye medios.
 */
async function fakeMedia(dir, name, format = undefined) {
  const ext = path.extname(name).toLowerCase().replace('.', '');
  const kind = format ?? (ext === 'apng' ? 'png' : ext === 'jpg' ? 'jpeg' : ext);
  if (!MAGIC[kind]) { throw new Error(`formato de prueba desconocido: ${kind}`); }
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(file, MAGIC[kind]);
  return file;
}

/** Espera hasta que la condicion se cumpla, o falla con un mensaje util. */
async function waitFor(label, fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = false; }
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`se agoto la espera: ${label}`); }
    await new Promise(r => setTimeout(r, 10));
  }
}

/** Cede el control para que terminen las promesas ya encoladas. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) { await new Promise(r => setImmediate(r)); }
}

async function cleanup(box) {
  await fsp.rm(box.tmp, { recursive: true, force: true });
}

module.exports = {
  ROOT, OUT, out, sandbox, context, fakeMedia, waitFor, settle, cleanup,
  checksum, fs, fsp, path, REL_BUNDLE
};
