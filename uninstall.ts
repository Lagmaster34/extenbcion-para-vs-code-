/**
 * Hook de desinstalacion: "vscode:uninstall" -> node ./out/uninstall.js
 *
 * Corre en un proceso Node suelto, lanzado por VS Code cuando el usuario
 * desinstala la extension. NO hay modulo 'vscode' aqui: nada de env.appRoot, ni
 * globalState, ni ventanas de dialogo. Por eso todo sale del archivo de estado
 * que escribio patcher.apply(), y toda la limpieza usa fs a pelo.
 *
 * Tampoco puede elevar privilegios. Si el chown no llego a hacerse, o el editor
 * se actualizo y devolvio los archivos a root, no hay forma de revertir: lo unico
 * honesto es dejar el estado intacto y escribirle al usuario, en un archivo que
 * pueda encontrar, el comando exacto que le falta.
 */
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as core from './core';
import * as state from './state';

const NOTE = path.join(state.homeDir(), 'LIMPIEZA-PENDIENTE.txt');

async function main(): Promise<void> {
  const st = await state.read();
  if (!st) { return; }

  let current: string;
  try {
    current = await fsp.readFile(st.bundlePath, 'utf8');
  } catch {
    // El editor ya no esta donde estaba. No hay nada que limpiar ahi.
    await finish(st.mediaDir, st.backupPath);
    return;
  }

  if (!core.isPatched(current)) {
    await finish(st.mediaDir, st.backupPath);
    return;
  }

  const blocked = [st.bundlePath, st.productPath].filter(f => !core.isWritable(f));
  if (blocked.length > 0) {
    await leaveNote(blocked);
    return;
  }

  // Restaurar un backup de otra version dejaria el editor con un workbench que no
  // le corresponde. Si el commit ya no coincide, solo se permite el strip.
  const commit = core.readCommit(st.appRoot);
  const backup = commit && st.commit && commit === st.commit ? st.backupPath : undefined;

  try {
    await core.cleanBundle(st.appRoot, backup);
  } catch (err: any) {
    await leaveNote(blocked, err?.message ?? String(err));
    return;
  }

  await finish(st.mediaDir, st.backupPath);
}

async function finish(mediaDir: string | undefined, backupPath: string): Promise<void> {
  if (mediaDir) { await fsp.rm(mediaDir, { recursive: true, force: true }); }
  await fsp.rm(backupPath, { force: true });
  await fsp.rm(NOTE, { force: true });
  await state.clear();
}

async function leaveNote(blocked: string[], reason?: string): Promise<void> {
  const user = `${os.userInfo().uid}:${os.userInfo().gid}`;
  const files = blocked.length ? blocked : ['<archivos de VS Code>'];
  const text = [
    'GifDeck se desinstalo, pero no pudo revertir el parche del workbench.',
    '',
    reason ? `Motivo: ${reason}` : 'Motivo: los archivos de VS Code ya no son escribibles por tu usuario.',
    '',
    'Un proceso de desinstalacion no puede pedir contrasena, asi que la ultima parte',
    'hay que hacerla a mano. Ejecuta esto en una terminal:',
    '',
    `  sudo chown ${user} ${files.map(f => `'${f.replace(/'/g, `'\\''`)}'`).join(' ')}`,
    `  node "${path.join(__dirname, 'uninstall.js')}"`,
    '',
    'Si ya borraste la extension y ese script no existe, reinstalar VS Code deja el',
    'bundle original en su sitio y el parche desaparece.',
    '',
    `Estado guardado en: ${state.statePath()}`,
    ''
  ].join('\n');

  await fsp.mkdir(state.homeDir(), { recursive: true });
  await fsp.writeFile(NOTE, text, 'utf8');
  console.error(text);
}

main().catch(err => {
  console.error('[gifdeck] fallo la limpieza de desinstalacion:', err);
});
