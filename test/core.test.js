const { group, test, ok, eq, includes, rejects } = require('./tap.js');
const h = require('./helpers.js');

const core = h.out('core.js');

group('core: marcadores y limpieza');

test('strip devuelve el original byte a byte', () => {
  const body = 'ANTES\n';
  const patched = body + core.START + '\nvar x=1;\n' + core.END;
  eq(core.strip(patched), 'ANTES', 'strip no debe dejar el salto de linea que mete apply');
});

test('strip es idempotente y no toca un archivo sin parche', () => {
  eq(core.strip('SIN PARCHE'), 'SIN PARCHE', 'sin marcador no cambia nada');
  const doble = core.strip(core.strip('X\n' + core.START + 'a' + core.END));
  eq(doble, 'X', 'aplicar strip dos veces da lo mismo');
});

test('isPatched e isTruncated distinguen los tres estados', () => {
  const limpio = 'X';
  const entero = 'X\n' + core.START + 'a' + core.END;
  const cortado = 'X\n' + core.START + 'a';
  eq(core.isPatched(limpio), false, 'limpio no esta parcheado');
  eq(core.isPatched(entero), true, 'entero esta parcheado');
  eq(core.isTruncated(entero), false, 'entero no esta truncado');
  eq(core.isTruncated(cortado), true, 'sin marca de cierre esta truncado');
  eq(core.isTruncated(limpio), false, 'limpio no esta truncado');
});

group('core: checksum de product.json');

test('refreshChecksum deja el hash que espera el editor', async () => {
  const box = await h.sandbox();
  try {
    await h.fsp.writeFile(box.bundle, box.original + 'EXTRA', 'utf8');
    await core.refreshChecksum(box.appRoot, box.bundle);
    ok(await box.checksumMatches(), 'el checksum guardado debe cuadrar con el archivo');
    const p = await box.readProduct();
    eq(p.checksums['vs/otro.js'], 'no-se-toca', 'no debe tocar otras entradas');
  } finally {
    await h.cleanup(box);
  }
});

test('refreshChecksum no explota si product.json no tiene checksums', async () => {
  const box = await h.sandbox();
  try {
    await h.fsp.writeFile(box.product, JSON.stringify({ commit: 'x' }), 'utf8');
    await core.refreshChecksum(box.appRoot, box.bundle);
    ok(true, 'debe terminar sin lanzar');
  } finally {
    await h.cleanup(box);
  }
});

test('readCommit lee el commit y aguanta una ruta inexistente', async () => {
  const box = await h.sandbox();
  try {
    eq(core.readCommit(box.appRoot), box.commit, 'commit de product.json');
    eq(core.readCommit(h.path.join(box.tmp, 'nada')), undefined, 'ruta inexistente da undefined');
  } finally {
    await h.cleanup(box);
  }
});

group('core: copia de seguridad');

test('ensureBackup guarda el original limpio y no lo sobreescribe', async () => {
  const box = await h.sandbox();
  try {
    await core.ensureBackup(box.appRoot, box.backupPath);
    eq(h.fs.readFileSync(box.backupPath, 'utf8'), box.original, 'el backup es el original');

    // Con el bundle ya parcheado, un segundo ensureBackup no debe machacarlo.
    await h.fsp.writeFile(box.bundle, box.original + '\n' + core.START + 'x' + core.END, 'utf8');
    await core.ensureBackup(box.appRoot, box.backupPath);
    eq(h.fs.readFileSync(box.backupPath, 'utf8'), box.original, 'sigue siendo el original limpio');
  } finally {
    await h.cleanup(box);
  }
});

test('ensureBackup se niega si el bundle ya esta danado y no hay backup', async () => {
  const box = await h.sandbox();
  try {
    await h.fsp.writeFile(box.bundle, box.original + '\n' + core.START + 'a medias', 'utf8');
    const msg = await rejects(() => core.ensureBackup(box.appRoot, box.backupPath),
      'deberia negarse a hacer un backup de un archivo roto');
    includes(msg, 'danado', 'el mensaje debe decir que el bundle esta danado');
  } finally {
    await h.cleanup(box);
  }
});

group('core: revertir');

test('cleanBundle quita el parche y restaura el checksum', async () => {
  const box = await h.sandbox();
  try {
    await core.ensureBackup(box.appRoot, box.backupPath);
    await h.fsp.writeFile(box.bundle, box.original + '\n' + core.START + 'x' + core.END, 'utf8');
    await core.refreshChecksum(box.appRoot, box.bundle);

    eq(await core.cleanBundle(box.appRoot, box.backupPath), 'stripped', 'debe limpiar con strip');
    eq(await box.readBundle(), box.original, 'bundle identico al original');
    ok(await box.checksumMatches(), 'checksum restaurado');
    eq(await core.cleanBundle(box.appRoot, box.backupPath), 'noop', 'sobre un bundle limpio no hace nada');
  } finally {
    await h.cleanup(box);
  }
});

test('una escritura a medias se recupera del backup', async () => {
  const box = await h.sandbox();
  try {
    await core.ensureBackup(box.appRoot, box.backupPath);
    await h.fsp.writeFile(box.bundle, box.original + '\n' + core.START + 'cortado', 'utf8');
    eq(await core.cleanBundle(box.appRoot, box.backupPath), 'restored', 'debe restaurar el backup');
    eq(await box.readBundle(), box.original, 'bundle recuperado');
    ok(await box.checksumMatches(), 'checksum recalculado tras restaurar');
  } finally {
    await h.cleanup(box);
  }
});

test('sin backup, un truncamiento falla en vez de mutilar el bundle', async () => {
  const box = await h.sandbox();
  try {
    const roto = box.original + '\n' + core.START + 'cortado';
    await h.fsp.writeFile(box.bundle, roto, 'utf8');
    await rejects(() => core.cleanBundle(box.appRoot, undefined),
      'sin backup no puede arreglarlo y debe fallar');
    eq(await box.readBundle(), roto, 'no debe haber tocado el archivo');
  } finally {
    await h.cleanup(box);
  }
});
