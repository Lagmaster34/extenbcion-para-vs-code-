/**
 * Estado en disco. Tampoco importa 'vscode'.
 *
 * globalState del ExtensionContext no sirve como fuente de verdad para revertir:
 * el hook de desinstalacion no puede leerlo. Y guardarlo dentro de la carpeta de
 * la extension tampoco, porque esa carpeta cambia de nombre en cada version y se
 * borra al desinstalar. Por eso vive en el home del usuario.
 */
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface GifDeckState {
  version: 1;
  appRoot: string;
  bundlePath: string;
  productPath: string;
  backupPath: string;
  /** commit de product.json cuando se hizo el backup. */
  commit?: string;
  vscodeVersion: string;
  patchedAt: string;
  /** Copia del medio servida por vscode-file, para poder borrarla al limpiar. */
  mediaDir?: string;

  /**
   * sha256 del bloque inyectado. Es lo que permite saber que el parche que hay
   * puesto ya no es el que toca: al publicar una version nueva de la extension
   * cambia el codigo inyectado, y sin esto el usuario se quedaria con el parche
   * viejo hasta que reaplicara a mano.
   */
  payloadHash?: string;
  extensionVersion?: string;

  /**
   * Identidad del bundle justo despues de parchearlo. Si al arrancar no coincide,
   * el editor reescribio el archivo y se llevo el parche por delante. Compararlo
   * cuesta un stat, frente a leer 18 MB para buscar el marcador.
   */
  bundleSize?: number;
  bundleMtimeMs?: number;
}

export function homeDir(): string {
  return path.join(os.homedir(), '.gifdeck');
}

export function statePath(): string {
  return path.join(homeDir(), 'state.json');
}

export function backupPath(): string {
  return path.join(homeDir(), 'workbench.desktop.main.js.backup');
}

export async function read(): Promise<GifDeckState | undefined> {
  try {
    const raw = await fsp.readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 ? parsed as GifDeckState : undefined;
  } catch {
    return undefined;
  }
}

export async function write(state: GifDeckState): Promise<void> {
  await fsp.mkdir(homeDir(), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

export async function clear(): Promise<void> {
  await fsp.rm(statePath(), { force: true });
}
