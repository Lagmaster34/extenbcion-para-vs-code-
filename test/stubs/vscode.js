/**
 * Doble de prueba del modulo 'vscode'.
 *
 * El runner intercepta require('vscode') y devuelve esto, de forma que patcher.js
 * y extension.js se cargan tal cual, sin copias ni reescrituras del codigo que se
 * publica. Todo lo que la extension le pregunta al editor pasa por aqui, asi que
 * los tests pueden fijar la configuracion y leer los mensajes que se mostrarian.
 */
const s = {
  appRoot: '',
  version: '1.134.0',
  /** Valores de gifdeck.*, sin el prefijo de seccion. */
  config: {},
  globalState: {},
  /** Mensajes que la extension intento mostrar. */
  info: [],
  warn: [],
  error: [],
  /** Respuestas que daran los dialogos, en orden de llamada. */
  infoAnswers: [],
  warnAnswers: [],
  openDialogResult: undefined,
  commands: {},
  executed: [],
  clipboard: []
};

function reset(over = {}) {
  s.appRoot = over.appRoot ?? '';
  s.version = over.version ?? '1.134.0';
  s.config = { ...(over.config ?? {}) };
  s.globalState = { ...(over.globalState ?? {}) };
  s.info = [];
  s.warn = [];
  s.error = [];
  s.infoAnswers = over.infoAnswers ? [...over.infoAnswers] : [];
  s.warnAnswers = over.warnAnswers ? [...over.warnAnswers] : [];
  s.openDialogResult = over.openDialogResult;
  s.commands = {};
  s.executed = [];
  s.clipboard = [];
  return s;
}

class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() { if (this._fn) { this._fn(); } }
}

/** Separa el argumento de opciones de los botones, como hace la API real. */
function splitItems(args) {
  if (args.length && typeof args[0] === 'object' && args[0] !== null) {
    return { options: args[0], items: args.slice(1) };
  }
  return { options: undefined, items: args };
}

const vscode = {
  version: '',
  env: {
    get appRoot() { return s.appRoot; },
    clipboard: { writeText: async t => { s.clipboard.push(t); } }
  },
  Disposable,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { file: p => ({ fsPath: p, scheme: 'file', path: p }) },
  commands: {
    registerCommand(id, fn) { s.commands[id] = fn; return new Disposable(); },
    executeCommand(id) { s.executed.push(id); return Promise.resolve(); }
  },
  workspace: {
    getConfiguration() {
      return {
        get: (key, dflt) => (s.config[key] !== undefined ? s.config[key] : dflt),
        update: async (key, value) => { s.config[key] = value; }
      };
    },
    onDidChangeConfiguration() { return new Disposable(); }
  },
  window: {
    async showInformationMessage(message, ...args) {
      const { items } = splitItems(args);
      s.info.push({ message, items });
      return s.infoAnswers.shift();
    },
    async showWarningMessage(message, ...args) {
      const { items } = splitItems(args);
      s.warn.push({ message, items });
      return s.warnAnswers.shift();
    },
    async showErrorMessage(message, ...args) {
      const { items } = splitItems(args);
      s.error.push({ message, items });
      return undefined;
    },
    async showOpenDialog() { return s.openDialogResult; }
  }
};

// vscode.version se lee como propiedad plana en el codigo de produccion.
Object.defineProperty(vscode, 'version', { get: () => s.version });

module.exports = vscode;
module.exports.__test = { state: s, reset };
