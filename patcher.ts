import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as core from './core';
import * as state from './state';

export { START, END, isPatched, strip } from './core';

/**
 * appRoot apunta a .../resources/app. Nunca hardcodees rutas de instalacion:
 * cambian entre distros, entre user-setup y system-setup, y entre forks (Cursor,
 * VSCodium). Esta es la unica forma soportada de encontrarlas.
 *
 * Ojo: en Remote SSH, WSL o contenedores el extension host corre en la maquina
 * remota y esto apuntaria al servidor, no al editor que dibuja la ventana. Por
 * eso el manifiesto declara "extensionKind": ["ui"].
 */
export function appRoot(): string {
  return vscode.env.appRoot;
}

export function outDir(): string {
  return core.outDirOf(appRoot());
}

export function productPath(): string {
  return core.productPathOf(appRoot());
}

/**
 * El bundle del workbench. La ruta ha sido estable, pero verificamos su
 * existencia y damos un error accionable en vez de reventar con ENOENT.
 */
export function bundlePath(): string {
  const p = core.bundlePathOf(appRoot());
  if (!fs.existsSync(p)) {
    throw new Error(
      `No encuentro el bundle del workbench en ${p}. ` +
      `Puede ser una version de VS Code no soportada, o una instalacion snap/flatpak.`
    );
  }
  return p;
}

export function isWritable(p: string): boolean {
  return core.isWritable(p);
}

/** Devuelve los archivos que hay que poder escribir para parchear. */
export function targets(): string[] {
  return [bundlePath(), productPath()];
}

/**
 * Cola de una sola via.
 *
 * apply() y remove() son leer-modificar-escribir sobre el mismo archivo, y el
 * listener de configuracion puede dispararlos mientras otro sigue en vuelo:
 * mover el slider de opacidad bastaba para intercalar dos escrituras y dejar el
 * bundle del editor corrupto. Todo pasa por aqui, en serie.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => undefined);
  return next;
}

/** Identidad del bloque inyectado, para detectar un parche desfasado. */
export function payloadHash(injection: string): string {
  return crypto.createHash('sha256').update(injection, 'utf8').digest('hex');
}

export interface ApplyOptions {
  mediaDir?: string;
  extensionVersion?: string;
}

/**
 * Compila el bloque antes de escribirlo. No lo ejecuta, solo comprueba que
 * parsea.
 *
 * Es la comprobacion mas barata que existe frente al peor fallo posible de esta
 * extension: un error de sintaxis en el bloque deja workbench.desktop.main.js sin
 * poder cargar, y el editor abre con la ventana en blanco. Ya paso una vez en
 * desarrollo, con un \n que TypeScript resolvia dentro del template literal y
 * acababa como salto de linea real dentro de una cadena JS.
 */
function assertParses(injection: string): void {
  try {
    new Function(injection);
  } catch (err: any) {
    throw new Error(
      `El bloque a inyectar no compila: ${err?.message ?? err}. No se ha tocado nada del editor.`
    );
  }
}

export function apply(injection: string, opts: ApplyOptions = {}): Promise<void> {
  assertParses(injection);
  return serialize(async () => {
    const root = appRoot();
    const file = bundlePath();

    await core.ensureBackup(root, state.backupPath());

    const original = await fsp.readFile(file, 'utf8');
    if (core.isTruncated(original)) {
      await core.cleanBundle(root, state.backupPath());
    }

    const clean = core.strip(await fsp.readFile(file, 'utf8'));
    await fsp.writeFile(file, clean + '\n' + injection, 'utf8');
    await core.refreshChecksum(root, file);

    // El stat va despues de escribir: es la huella del bundle ya parcheado.
    const stat = await fsp.stat(file);

    await state.write({
      version: 1,
      appRoot: root,
      bundlePath: file,
      productPath: productPath(),
      backupPath: state.backupPath(),
      commit: core.readCommit(root),
      vscodeVersion: vscode.version,
      patchedAt: new Date().toISOString(),
      mediaDir: opts.mediaDir,
      payloadHash: payloadHash(injection),
      extensionVersion: opts.extensionVersion,
      bundleSize: stat.size,
      bundleMtimeMs: stat.mtimeMs
    });
  });
}

export function remove(): Promise<void> {
  return serialize(async () => {
    await core.cleanBundle(appRoot(), state.backupPath());
    await state.clear();
  });
}
