/**
 * Nucleo del parcheador. NO importa 'vscode' a proposito.
 *
 * El hook vscode:uninstall corre en un proceso Node suelto, sin extension host y
 * sin acceso al modulo vscode: alli no existen env.appRoot ni globalState ni
 * showErrorMessage. Todo lo que tenga que poder ejecutarse en la desinstalacion
 * vive en este archivo y recibe appRoot como argumento explicito, nunca lo
 * descubre por API.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export const START = '/* ==GIFDECK_START== */';
export const END = '/* ==GIFDECK_END== */';

export function outDirOf(appRoot: string): string {
  return path.join(appRoot, 'out');
}

export function productPathOf(appRoot: string): string {
  return path.join(appRoot, 'product.json');
}

export function bundlePathOf(appRoot: string): string {
  return path.join(outDirOf(appRoot), 'vs', 'workbench', 'workbench.desktop.main.js');
}

export function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quita cualquier inyeccion previa. Idempotente.
 *
 * Se come tambien el salto de linea que apply() mete antes del marcador. Sin eso
 * el bundle no vuelve byte a byte a su estado original y, peor, cada reaplicado
 * dejaba un '\n' de mas: reaplicar es lo que hace el listener de configuracion en
 * cada cambio de ajuste, asi que el archivo crecia solo.
 */
export function strip(source: string): string {
  let s = source.indexOf(START);
  if (s === -1) { return source; }
  const e = source.indexOf(END, s);
  if (s > 0 && source[s - 1] === '\n') { s -= 1; }
  if (e === -1) { return source.slice(0, s); }
  return source.slice(0, s) + source.slice(e + END.length);
}

export function isPatched(source: string): boolean {
  return source.includes(START);
}

/**
 * Un parche sin marca de cierre significa que una escritura quedo a medias. En
 * ese caso strip() trunca el archivo por el START y el bundle queda mutilado, asi
 * que hay que restaurar desde el backup en vez de limpiar.
 */
export function isTruncated(source: string): boolean {
  const s = source.indexOf(START);
  return s !== -1 && source.indexOf(END, s) === -1;
}

/**
 * VS Code guarda en product.json un sha256 en base64 (sin padding) de varios
 * archivos core y compara al arrancar. Si no actualizas esta entrada, el usuario
 * ve "Your Code installation appears to be corrupt" en cada arranque.
 *
 * El hash es sobre los bytes crudos, no sobre el texto decodificado.
 */
export async function refreshChecksum(appRoot: string, file: string): Promise<void> {
  const productPath = productPathOf(appRoot);
  const raw = await fsp.readFile(productPath, 'utf8');
  const product = JSON.parse(raw);
  if (!product.checksums) { return; }

  const rel = path.relative(outDirOf(appRoot), file).split(path.sep).join('/');
  if (!(rel in product.checksums)) { return; }

  const bytes = await fsp.readFile(file);
  product.checksums[rel] = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('base64')
    .replace(/=+$/, '');

  await fsp.writeFile(productPath, JSON.stringify(product, null, '\t'), 'utf8');
}

/**
 * El backup NO puede vivir junto al bundle: crear un archivo en
 * <appRoot>/out/vs/workbench/ exige permiso de escritura sobre el directorio, y
 * la elevacion solo cambia el dueno de dos archivos concretos. Va al home del
 * usuario, que ademas sobrevive a que el gestor de paquetes devuelva la
 * instalacion a root.
 */
export async function ensureBackup(appRoot: string, backupPath: string): Promise<void> {
  try {
    await fsp.access(backupPath);
    return;
  } catch { /* no hay backup todavia */ }

  const current = await fsp.readFile(bundlePathOf(appRoot), 'utf8');
  if (isTruncated(current)) {
    throw new Error('El bundle ya esta danado y no hay backup previo. Reinstala VS Code.');
  }

  await fsp.mkdir(path.dirname(backupPath), { recursive: true });
  await fsp.writeFile(backupPath, strip(current), 'utf8');
}

/**
 * Devuelve el bundle a su estado original. Usa strip() salvo que la escritura
 * anterior quedara a medias, en cuyo caso restaura el backup.
 *
 * Restaurar un backup viejo sobre un VS Code ya actualizado dejaria el editor con
 * un workbench de otra version, asi que el llamante debe verificar antes que el
 * commit registrado coincide con el de la instalacion actual.
 */
export async function cleanBundle(appRoot: string, backupPath: string | undefined): Promise<'stripped' | 'restored' | 'noop'> {
  const file = bundlePathOf(appRoot);
  const current = await fsp.readFile(file, 'utf8');

  if (!isPatched(current)) { return 'noop'; }

  if (isTruncated(current)) {
    if (!backupPath) {
      throw new Error('Parche incompleto y sin backup disponible.');
    }
    const backup = await fsp.readFile(backupPath, 'utf8');
    await fsp.writeFile(file, backup, 'utf8');
    await refreshChecksum(appRoot, file);
    return 'restored';
  }

  await fsp.writeFile(file, strip(current), 'utf8');
  await refreshChecksum(appRoot, file);
  return 'stripped';
}

/** El commit de la instalacion, para no restaurar un backup de otra version. */
export function readCommit(appRoot: string): string | undefined {
  try {
    const product = JSON.parse(fs.readFileSync(productPathOf(appRoot), 'utf8'));
    return typeof product.commit === 'string' ? product.commit : undefined;
  } catch {
    return undefined;
  }
}
