/**
 * Mini marco de tests. Sin dependencias a proposito: la extension no tiene
 * ninguna en runtime y no merece arrastrar un runner entero para esto.
 */
const registry = [];

/** Agrupa los siguientes tests bajo un titulo. */
function group(name) {
  registry.push({ kind: 'group', name });
}

function test(name, fn) {
  registry.push({ kind: 'test', name, fn });
}

class Failure extends Error {}

function fail(label, detail) {
  throw new Failure(detail ? `${label}\n         ${detail}` : label);
}

function ok(cond, label) {
  if (!cond) { fail(label, 'se esperaba algo verdadero'); }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    fail(label, `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  }
}

function ne(actual, expected, label) {
  if (actual === expected) { fail(label, `no deberia ser ${JSON.stringify(expected)}`); }
}

function includes(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    fail(label, `no contiene ${JSON.stringify(needle)} en ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
}

/** Comprueba que algo falla, y devuelve el mensaje para poder inspeccionarlo. */
async function rejects(fn, label) {
  try {
    await fn();
  } catch (err) {
    return err?.message ?? String(err);
  }
  fail(label, 'se esperaba un error y no lo hubo');
  return '';
}

module.exports = { registry, group, test, ok, eq, ne, includes, rejects, Failure };
