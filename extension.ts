import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as patcher from './patcher';
import * as media from './media';
import { build, OverlayConfig, Scaling } from './inject';
import * as state from './state';
import { ensureWritable } from './permissions';

const KEY_ENABLED = 'gifdeck.enabled';
const KEY_VERSION = 'gifdeck.patchedVersion';
const KEY_WELCOMED = 'gifdeck.welcomed';

/**
 * Ya no se embebe el medio en el bundle, asi que el tamano no penaliza el
 * arranque del editor. Sigue penalizando la RAM y la CPU del renderer, que es
 * motivo suficiente para avisar, pero con un umbral mucho mas alto.
 */
const WARN_BYTES = 20 * 1024 * 1024;
const DEBOUNCE_MS = 400;

let ctx: vscode.ExtensionContext;
let debounce: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
  ctx = context;

  context.subscriptions.push(
    vscode.commands.registerCommand('gifdeck.enable', () => enable()),
    vscode.commands.registerCommand('gifdeck.disable', () => disable()),
    vscode.commands.registerCommand('gifdeck.reapply', () => enable(true)),
    vscode.commands.registerCommand('gifdeck.pickMedia', () => pickMedia()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('gifdeck') || !context.globalState.get(KEY_ENABLED)) { return; }
      // Arrastrar el slider de opacidad emite un evento por cada paso. Sin este
      // debounce cada uno lanzaria un reparcheo del bundle del editor.
      if (debounce) { clearTimeout(debounce); }
      debounce = setTimeout(() => { debounce = undefined; void enable(true); }, DEBOUNCE_MS);
    }),
    new vscode.Disposable(() => { if (debounce) { clearTimeout(debounce); } })
  );

  void start();
}

async function start(): Promise<void> {
  await sync();
  await welcome();
}

/**
 * Primera activacion. GifDeck no empaqueta ningun medio, asi que recien instalada
 * no se ve absolutamente nada y el usuario la desinstala pensando que no funciona.
 * Este aviso es lo unico que hay entre instalar y ver algo.
 */
async function welcome(): Promise<void> {
  if (ctx.globalState.get(KEY_WELCOMED)) { return; }

  const configured = vscode.workspace.getConfiguration('gifdeck').get<string>('mediaPath', '');

  // Se marca ANTES de esperar la respuesta. Una notificacion descartada devuelve
  // undefined igual que una que caduca, asi que si se marcara despues no habria
  // forma de distinguir "la cerro" de "no contesto", y volveria a salir.
  await ctx.globalState.update(KEY_WELCOMED, true);

  if (configured) { return; }

  const ELEGIR = 'Elegir GIF o video';
  const pick = await vscode.window.showInformationMessage(
    'GifDeck esta listo, pero no incluye ningun medio: elige tu propio GIF, WebP o video ' +
    'para superponerlo en la ventana del editor.',
    ELEGIR
  );
  if (pick === ELEGIR) { await pickMedia(); }
}

/**
 * Decide al arrancar si el parche que hay puesto sigue siendo el correcto.
 *
 * Comparar la version de VS Code no basta. Detecta que el editor se actualizo y
 * se llevo el parche, pero no que la extension se actualizo y ahora inyecta otro
 * codigo: el usuario se quedaria con el parche de la version anterior hasta que
 * ejecutara "Reaplicar" a mano, sin ninguna senial de que hace falta.
 *
 * Por eso se comparan dos cosas: la huella del bundle, que delata que el editor
 * lo reescribio, y el hash del bloque inyectado, que delata cualquier cambio en
 * lo que deberiamos estar inyectando.
 */
async function sync(): Promise<void> {
  if (!ctx.globalState.get(KEY_ENABLED)) { return; }

  let reason: 'editor' | 'payload' | undefined;
  try {
    const st = await state.read();
    if (!st) {
      reason = 'editor';
    } else if (st.bundleSize === undefined || st.bundleMtimeMs === undefined) {
      // Estado escrito por una version de GifDeck anterior a estos campos. No
      // sabemos si el bundle cambio, pero si que el parche es de otra version, y
      // decirle al usuario que "VS Code se actualizo" seria mentirle.
      reason = 'payload';
    } else if (!(await bundleUntouched(st.bundlePath, st.bundleSize, st.bundleMtimeMs))) {
      reason = 'editor';
    } else {
      const cfg = vscode.workspace.getConfiguration('gifdeck');
      const source = await resolveMedia(cfg.get<string>('mediaPath', ''));
      const { injection } = await prepare(source);
      if (st.payloadHash !== patcher.payloadHash(injection)) { reason = 'payload'; }
    }
  } catch {
    // Si no podemos ni calcular lo que tocaria, callamos: molestar con un error
    // en cada arranque es peor que no avisar.
    return;
  }
  if (!reason) { return; }

  let writable = false;
  try { writable = patcher.targets().every(patcher.isWritable); } catch { writable = false; }

  // Un parche desfasado por una actualizacion de la extension se arregla solo si
  // no hace falta pedir permisos. Un modal de contrasena nada mas abrir el editor
  // seria intolerable, asi que en ese caso se pregunta.
  if (reason === 'payload' && writable) { void enable(true); return; }

  const message = reason === 'editor'
    ? `VS Code se actualizo a ${vscode.version} y el overlay de GifDeck se perdio.`
    : 'GifDeck se actualizo y el overlay que tienes aplicado es el de la version anterior.';
  const pick = await vscode.window.showInformationMessage(message, 'Reaplicar', 'Ahora no');
  if (pick === 'Reaplicar') { void enable(true); }
}

/**
 * Un stat basta para saber si el bundle sigue siendo el que parcheamos. Leer los
 * 18 MB del archivo para buscar el marcador costaria mucho mas en cada arranque.
 */
async function bundleUntouched(file: string, size: number, mtimeMs: number): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    return stat.size === size && Math.abs(stat.mtimeMs - mtimeMs) < 1;
  } catch {
    return false;
  }
}

/** Prepara el bloque a inyectar para el medio ya resuelto. */
async function prepare(source: string): Promise<{ injection: string; mediaDir: string }> {
  const cfg = vscode.workspace.getConfiguration('gifdeck');
  const mediaDir = path.join(ctx.globalStorageUri.fsPath, 'media');
  const staged = await media.stage(source, mediaDir);

  const overlay: OverlayConfig = {
    position: cfg.get('position', 'bottom-right'),
    width: cfg.get('width', 260),
    opacity: cfg.get('opacity', 0.85),
    offset: cfg.get('offset', [16, 16]) as [number, number],
    zIndex: cfg.get('zIndex', 100),
    hideOnHover: cfg.get('hideOnHover', false),
    scaling: cfg.get<Scaling>('scaling', 'none'),
    avoidStatusBar: cfg.get('avoidStatusBar', true)
  };

  return { injection: build(overlay, { uri: staged.uri, kind: staged.kind }), mediaDir };
}

async function enable(silent = false) {
  try {
    if (!(await ensureWritable())) { return; }

    const source = await resolveMedia(
      vscode.workspace.getConfiguration('gifdeck').get<string>('mediaPath', '')
    );

    // El aviso va antes de copiar nada: si el usuario cancela, no queremos haber
    // dejado ya un archivo de 40 MB en su globalStorage.
    const { size } = await fsp.stat(source);
    if (size > WARN_BYTES && !silent) {
      const go = await vscode.window.showWarningMessage(
        `Ese archivo pesa ${(size / 1024 / 1024).toFixed(1)} MB. El renderer lo mantiene decodificado ` +
        `en memoria mientras la ventana este abierta. Un WebM equivalente suele pesar 10 veces menos.`,
        'Continuar igual', 'Cancelar'
      );
      if (go !== 'Continuar igual') { return; }
    }

    const { injection, mediaDir } = await prepare(source);
    await patcher.apply(injection, {
      mediaDir,
      extensionVersion: ctx.extension.packageJSON.version
    });
    await ctx.globalState.update(KEY_ENABLED, true);
    await ctx.globalState.update(KEY_VERSION, vscode.version);

    promptRestart();
  } catch (err: any) {
    vscode.window.showErrorMessage(`GifDeck: ${err?.message ?? err}`);
  }
}

async function disable() {
  try {
    if (!(await ensureWritable())) { return; }
    await patcher.remove();
    await fsp.rm(path.join(ctx.globalStorageUri.fsPath, 'media'), { recursive: true, force: true });
    await ctx.globalState.update(KEY_ENABLED, false);
    promptRestart();
  } catch (err: any) {
    vscode.window.showErrorMessage(`GifDeck: ${err?.message ?? err}`);
  }
}

async function pickMedia(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Usar este archivo',
    title: 'Elige el GIF, WebP o video del overlay',
    filters: { 'Animaciones y video': ['gif', 'webp', 'apng', 'png', 'webm', 'mp4'] }
  });
  if (!picked?.length) { return; }
  const file = picked[0].fsPath;

  // Validar antes de guardar el ajuste. Dejar configurado un archivo que no sirve
  // solo traslada el fallo a enable(), mas lejos de la accion que lo causo.
  try {
    await media.validate(file);
  } catch (err: any) {
    vscode.window.showErrorMessage(`GifDeck: ${err?.message ?? err}`);
    return;
  }

  await vscode.workspace.getConfiguration('gifdeck')
    .update('mediaPath', file, vscode.ConfigurationTarget.Global);

  // Con el overlay ya puesto, el listener de configuracion se encarga de
  // reaplicarlo. Si no lo estaba, hay que aplicarlo aqui: es el camino de la
  // primera ejecucion, y sin esto elegir un archivo no haria nada visible.
  if (!ctx.globalState.get(KEY_ENABLED)) { await enable(); }
}

/**
 * GifDeck no empaqueta ningun medio: cada usuario usa el suyo. Sin ajuste no hay
 * nada que mostrar, y el error tiene que nombrar el comando que lo arregla.
 */
async function resolveMedia(configured: string): Promise<string> {
  if (!configured) {
    throw new Error('No hay ningun medio configurado. Ejecuta "GifDeck: Elegir medio".');
  }
  try {
    await fsp.access(configured);
  } catch {
    throw new Error(`No existe el archivo configurado: ${configured}`);
  }
  return configured;
}

/**
 * reloadWindow recarga el renderer y suele bastar, pero en algunas versiones el
 * bundle queda cacheado y hace falta cerrar la app entera.
 */
function promptRestart() {
  vscode.window.showInformationMessage(
    'GifDeck aplicado. Recarga la ventana; si no ves cambios, cierra y abre VS Code.',
    'Recargar ventana'
  ).then(pick => {
    if (pick === 'Recargar ventana') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

/**
 * Desactivar la extension no revierte el parche a proposito: volver a activarla
 * pediria otra vez el chown. La limpieza de verdad la hace out/uninstall.js, que
 * corre en la desinstalacion sin acceso al modulo vscode.
 */
export function deactivate() { /* el parche persiste a proposito */ }
