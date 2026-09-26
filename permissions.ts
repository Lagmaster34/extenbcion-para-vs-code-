import * as vscode from 'vscode';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { targets, isWritable } from './patcher';

const run = promisify(execFile);

/**
 * DECISION DE DISENO IMPORTANTE:
 *
 * Una extension NO puede elevarse a si misma. El extension host arranca con el
 * usuario y no hay API para pedir root. Lo unico que se puede hacer es lanzar un
 * proceso elevado, y correr TODO el parcheador como root seria darle a esta
 * extension escritura arbitraria con privilegios: exactamente la forma de un
 * ataque de cadena de suministro, y la razon numero uno por la que te reportan
 * en el Marketplace.
 *
 * Por eso aqui se eleva UNA sola vez, para un unico comando conocido y acotado:
 * cambiar el dueno de dos archivos. Despues de eso todos los parcheos y
 * reaplicados corren sin privilegios.
 */
export async function ensureWritable(): Promise<boolean> {
  if (process.platform === 'darwin') {
    await vscode.window.showErrorMessage(
      'GifDeck no soporta macOS todavia.',
      {
        modal: true,
        detail:
          'Modificar el bundle del workbench invalida la firma de la aplicacion. Gatekeeper puede negarse ' +
          'a abrir VS Code y las actualizaciones automaticas pueden empezar a fallar, dejando el editor en ' +
          'un estado dificil de arreglar. Preferimos no tocar nada antes que romperte la instalacion.'
      }
    );
    return false;
  }

  const files = targets();
  const blocked = files.filter(f => !isWritable(f));
  if (blocked.length === 0) { return true; }

  if (process.platform === 'win32') {
    // En Windows el instalador por defecto es User Setup (%LOCALAPPDATA%), que ya
    // es escribible. Si llegamos aqui es System Setup en Program Files, y lo
    // limpio es que el propio VS Code arranque elevado una vez.
    const choice = await vscode.window.showWarningMessage(
      'GifDeck no puede escribir en la instalacion de VS Code. Tienes System Setup (Program Files). ' +
      'Cierra VS Code, abrelo como administrador una vez y vuelve a ejecutar "GifDeck: Activar overlay".',
      'Entendido', 'Copiar ruta'
    );
    if (choice === 'Copiar ruta') { await vscode.env.clipboard.writeText(blocked.join('\n')); }
    return false;
  }

  const user = `${os.userInfo().uid}:${os.userInfo().gid}`;
  const cmd = `pkexec /usr/bin/chown ${user} ${blocked.map(q).join(' ')}`;

  const choice = await vscode.window.showWarningMessage(
    'GifDeck necesita permiso para escribir en los archivos de VS Code. Se te pedira la contrasena una sola vez, ' +
    'solo para cambiar el dueno de dos archivos. El parcheo posterior corre sin privilegios.',
    { modal: true, detail: cmd },
    'Ejecutar', 'Copiar comando'
  );

  if (choice === 'Copiar comando') {
    await vscode.env.clipboard.writeText(cmd);
    return false;
  }
  if (choice !== 'Ejecutar') { return false; }

  try {
    await run('pkexec', ['/usr/bin/chown', user, ...blocked]);
  } catch (err: any) {
    // Sin agente de polkit no hay pkexec, y es lo bastante comun en escritorios
    // minimos como para merecer su propio mensaje: "no se pudo elevar" no le dice
    // a nadie que le falta un paquete.
    if (err?.code === 'ENOENT') {
      const pick = await vscode.window.showErrorMessage(
        'No encuentro pkexec. Instala polkit y un agente de autenticacion, o ejecuta el chown a mano en una terminal.',
        'Copiar comando'
      );
      if (pick === 'Copiar comando') {
        await vscode.env.clipboard.writeText(`sudo chown ${user} ${blocked.map(q).join(' ')}`);
      }
      return false;
    }
    vscode.window.showErrorMessage(
      `No se pudo elevar (${err?.message ?? err}). Ejecuta el comando a mano en una terminal.`
    );
    return false;
  }

  return targets().every(isWritable);
}

function q(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
