/**
 * Como llega el medio al renderer.
 *
 * HALLAZGO QUE MANDA SOBRE TODO ESTE ARCHIVO: la CSP del workbench declara
 * `img-src 'self' data: blob: ... https:` pero `media-src 'self'`. O sea, un
 * <video> con data: URI esta BLOQUEADO por CSP. Embeber el medio en base64
 * nunca podia funcionar para WebM ni MP4, que es justo el formato que la propia
 * extension recomienda por consumo.
 *
 * Lo que si sirve es vscode-file://vscode-app/<ruta>, el esquema con el que el
 * propio workbench carga sus recursos: cuenta como 'self' y por tanto vale para
 * img-src y para media-src. El handler de ese protocolo solo sirve archivos que
 * esten bajo una de sus raices validas (appRoot, extensionsPath, globalStorage y
 * workspaceStorage) o cuya extension este en su lista blanca, que incluye png,
 * jpg, gif, webp, bmp y mp4, pero NO webm ni apng.
 *
 * De ahi el diseno: copiamos el medio al globalStorage de la extension, que es
 * raiz valida y ademas escribible sin ninguna elevacion, y lo referenciamos por
 * URL. El bundle deja de crecer megabytes y el parche pasa a ser unos cientos de
 * bytes.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export type MediaKind = 'video' | 'image';

const MIME: Record<string, string> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.apng': 'image/apng',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4'
};

export interface StagedMedia {
  /** Ruta ya dentro de globalStorage. */
  file: string;
  uri: string;
  kind: MediaKind;
  bytes: number;
}

export function mimeOf(file: string): string {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) { throw new Error(`Formato no soportado: ${path.extname(file)}`); }
  return mime;
}

export function kindOf(file: string): MediaKind {
  return mimeOf(file).startsWith('video/') ? 'video' : 'image';
}

/**
 * Formato real segun los bytes de cabecera, no segun la extension.
 *
 * Importa porque el renderer no tiene forma de avisarnos: si el archivo esta
 * corrupto o es un .webm que en realidad es otra cosa, el overlay se queda
 * invisible y el unico rastro es un console.error que nadie mira. Aqui todavia
 * estamos en el extension host y podemos enseniar un error de verdad.
 */
function sniff(b: Buffer): string | undefined {
  const ascii = (from: number, to: number) => b.toString('latin1', from, to);
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) { return 'gif'; }
  if (b.length >= 8 && b.toString('hex', 0, 8) === '89504e470d0a1a0a') { return 'png'; }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'jpeg'; }
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') { return 'webp'; }
  if (b.length >= 4 && b.toString('hex', 0, 4) === '1a45dfa3') { return 'webm'; }
  if (b.length >= 8 && ascii(4, 8) === 'ftyp') { return 'mp4'; }
  return undefined;
}

/** Que formato deberia tener cada extension. apng es png por dentro. */
const EXPECTED: Record<string, string> = {
  '.gif': 'gif', '.png': 'png', '.apng': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg',
  '.webp': 'webp', '.webm': 'webm', '.mp4': 'mp4'
};

export async function validate(src: string): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  const expected = EXPECTED[ext];
  if (!expected) { throw new Error(`Formato no soportado: ${ext}`); }

  const stat = await fsp.stat(src);
  if (!stat.isFile()) { throw new Error(`No es un archivo: ${src}`); }
  if (stat.size === 0) { throw new Error(`El archivo esta vacio: ${src}`); }

  const head = Buffer.alloc(16);
  const fh = await fsp.open(src, 'r');
  try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }

  const actual = sniff(head);
  if (!actual) {
    throw new Error(
      `${path.basename(src)} no parece un archivo ${expected} valido. Puede estar corrupto o truncado.`
    );
  }
  if (actual !== expected) {
    throw new Error(
      `${path.basename(src)} tiene extension ${ext} pero por dentro es ${actual}. ` +
      `Renombralo a .${actual} o convierte el archivo.`
    );
  }
}

/**
 * Mismo mapeo que hace VS Code internamente: file:///a/b -> vscode-file://vscode-app/a/b.
 * Los dos puntos se dejan sin escapar para no romper la letra de unidad en Windows.
 */
export function toBrowserUri(fsPath: string): string {
  let p = fsPath.split(path.sep).join('/');
  if (!p.startsWith('/')) { p = '/' + p; }
  const encoded = p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
  return `vscode-file://vscode-app${encoded}`;
}

/**
 * Copia el medio a destDir con un nombre derivado de su identidad, borra las
 * copias viejas y devuelve la URL lista para inyectar.
 */
export async function stage(src: string, destDir: string): Promise<StagedMedia> {
  await validate(src);

  const kind = kindOf(src);
  const stat = await fsp.stat(src);
  const ext = path.extname(src).toLowerCase();

  const id = crypto
    .createHash('sha1')
    .update(`${path.resolve(src)}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 12);

  const name = `media-${id}${ext}`;
  const dest = path.join(destDir, name);

  await fsp.mkdir(destDir, { recursive: true });
  // El nombre ya codifica ruta, tamano y mtime del origen, asi que si el destino
  // existe con el mismo tamano es la misma copia. Saltarsela permite llamar a
  // stage() en cada arranque para comprobar el parche sin copiar megabytes.
  let already = false;
  try { already = (await fsp.stat(dest)).size === stat.size; } catch { /* no existe */ }
  if (!already) { await fsp.copyFile(src, dest); }
  await prune(destDir, name);

  return { file: dest, uri: toBrowserUri(dest), kind, bytes: stat.size };
}

async function prune(dir: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter(f => f !== keep && f.startsWith('media-'))
      .map(f => fsp.rm(path.join(dir, f), { force: true }))
  );
}
