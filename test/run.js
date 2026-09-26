#!/usr/bin/env node
/**
 * Ejecutor de los tests de GifDeck.  npm test
 *
 * Dos decisiones que importan:
 *
 * 1. Todo se prueba contra out/, el JavaScript compilado que empaqueta el .vsix y
 *    que carga el editor. Si out/ no existe, se aborta en vez de probar nada, para
 *    que no pueda pasar un test contra codigo que no es el que se publica.
 *
 * 2. require('vscode') se intercepta y devuelve un doble de prueba. Ese modulo
 *    solo existe dentro del extension host, asi que sin esto ni patcher.js ni
 *    extension.js se podrian cargar fuera del editor.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, '..', 'out');
const STUB = path.join(HERE, 'stubs', 'vscode.js');

if (!fs.existsSync(path.join(OUT, 'extension.js'))) {
  console.error('No hay nada compilado en out/. Ejecuta "npm run compile" antes de los tests.');
  process.exit(1);
}

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return load.call(this, STUB, parent, false); }
  return load.apply(this, arguments);
};

const tap = require('./tap.js');

const files = fs.readdirSync(HERE).filter(f => f.endsWith('.test.js')).sort();
for (const f of files) { require(path.join(HERE, f)); }

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';

(async () => {
  const started = Date.now();
  let pass = 0;
  const failures = [];
  const home = process.env.HOME;

  for (const entry of tap.registry) {
    if (entry.kind === 'group') {
      console.log(`\n${DIM}${entry.name}${OFF}`);
      continue;
    }
    try {
      await entry.fn();
      pass++;
      console.log(`  ${GREEN}ok${OFF}   ${entry.name}`);
    } catch (err) {
      failures.push({ name: entry.name, err });
      console.log(`  ${RED}FALLA${OFF} ${entry.name}`);
      console.log(`         ${String(err && err.message).split('\n').join('\n         ')}`);
      if (!(err instanceof tap.Failure)) {
        console.log(`${DIM}${String(err && err.stack).split('\n').slice(1, 5).join('\n')}${OFF}`);
      }
    }
  }

  // Los tests mueven HOME para no tocar el del usuario. Se restaura por si acaso.
  process.env.HOME = home;

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${pass} ok, ${failures.length} fallos, ${files.length} archivos, ${secs}s`);
  if (failures.length) {
    console.log(`\n${RED}Tests en rojo. No publiques.${OFF}`);
    process.exit(1);
  }
})().catch(err => {
  console.error('el ejecutor de tests se rompio:', err);
  process.exit(1);
});
