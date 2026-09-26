const { group, test, ok, eq, includes, rejects } = require('./tap.js');
const h = require('./helpers.js');

const media = h.out('media.js');

group('media: URL del protocolo vscode-file');

test('mapea la ruta igual que lo hace el editor', () => {
  eq(media.toBrowserUri('/home/e/a.webm'), 'vscode-file://vscode-app/home/e/a.webm', 'ruta simple');
});

test('escapa lo que rompe una URL pero no los dos puntos', () => {
  eq(media.toBrowserUri('/home/e/mi gif.webp'),
    'vscode-file://vscode-app/home/e/mi%20gif.webp', 'los espacios van escapados');
  eq(media.toBrowserUri('/home/e/a#b.gif'),
    'vscode-file://vscode-app/home/e/a%23b.gif', 'la almohadilla cortaria la URL');
  eq(media.toBrowserUri('/home/e/a?b.gif'),
    'vscode-file://vscode-app/home/e/a%3Fb.gif', 'la interrogacion tambien');
  eq(media.toBrowserUri('/C:/Users/e/a.mp4'),
    'vscode-file://vscode-app/C:/Users/e/a.mp4', 'la letra de unidad de Windows se deja intacta');
});

group('media: formato e identificacion');

test('kindOf separa video de imagen', () => {
  eq(media.kindOf('/x/a.webm'), 'video', 'webm es video');
  eq(media.kindOf('/x/a.mp4'), 'video', 'mp4 es video');
  eq(media.kindOf('/x/a.gif'), 'image', 'gif es imagen');
  eq(media.kindOf('/x/a.webp'), 'image', 'webp es imagen');
  eq(media.kindOf('/x/a.apng'), 'image', 'apng es imagen');
});

test('un formato no soportado se rechaza al identificarlo', () => {
  let lanzo = false;
  try { media.kindOf('/x/a.txt'); } catch { lanzo = true; }
  ok(lanzo, 'txt no es un medio soportado');
});

group('media: validacion por bytes de cabecera');

test('acepta cada formato soportado', async () => {
  const box = await h.sandbox();
  try {
    for (const name of ['a.gif', 'a.png', 'a.apng', 'a.webp', 'a.webm', 'a.mp4', 'a.jpg']) {
      const f = await h.fakeMedia(box.tmp, name);
      await media.validate(f);
    }
    ok(true, 'los seis formatos pasan con su cabecera correcta');
  } finally {
    await h.cleanup(box);
  }
});

test('rechaza un archivo vacio', async () => {
  const box = await h.sandbox();
  try {
    const f = h.path.join(box.tmp, 'vacio.gif');
    await h.fsp.writeFile(f, '');
    const msg = await rejects(() => media.validate(f), 'un archivo vacio no vale');
    includes(msg, 'vacio', 'debe decir que esta vacio');
  } finally {
    await h.cleanup(box);
  }
});

test('rechaza contenido corrupto', async () => {
  const box = await h.sandbox();
  try {
    const f = h.path.join(box.tmp, 'basura.webm');
    await h.fsp.writeFile(f, Buffer.from('esto no es un video en absoluto'));
    const msg = await rejects(() => media.validate(f), 'sin cabecera valida no vale');
    includes(msg, 'corrupto', 'debe sugerir que esta corrupto');
  } finally {
    await h.cleanup(box);
  }
});

test('detecta una extension que no corresponde al contenido', async () => {
  const box = await h.sandbox();
  try {
    const webp = await h.fakeMedia(box.tmp, 'real.webp');
    const disfraz = h.path.join(box.tmp, 'disfraz.gif');
    await h.fsp.copyFile(webp, disfraz);
    const msg = await rejects(() => media.validate(disfraz), 'un webp llamado gif no vale');
    includes(msg, 'webp', 'debe decir cual es el formato real');
  } finally {
    await h.cleanup(box);
  }
});

test('rechaza una ruta inexistente y un directorio', async () => {
  const box = await h.sandbox();
  try {
    await rejects(() => media.validate(h.path.join(box.tmp, 'no-existe.gif')), 'ruta inexistente');
    const dir = h.path.join(box.tmp, 'carpeta.gif');
    await h.fsp.mkdir(dir);
    const msg = await rejects(() => media.validate(dir), 'un directorio no es un medio');
    includes(msg, 'No es un archivo', 'debe decir que no es un archivo');
  } finally {
    await h.cleanup(box);
  }
});

group('media: copia a globalStorage');

test('copia el medio y devuelve la URL de la copia', async () => {
  const box = await h.sandbox();
  try {
    const src = await h.fakeMedia(box.tmp, 'origen.gif');
    const dest = h.path.join(box.globalStorage, 'media');
    const staged = await media.stage(src, dest);

    ok(h.fs.existsSync(staged.file), 'la copia existe');
    ok(staged.file.startsWith(dest), 'la copia esta en globalStorage, que es raiz valida de vscode-file');
    eq(Buffer.compare(h.fs.readFileSync(src), h.fs.readFileSync(staged.file)), 0, 'copia identica');
    eq(staged.uri, media.toBrowserUri(staged.file), 'la URL apunta a la copia, no al origen');
    eq(staged.kind, 'image', 'kind correcto');
    eq(staged.bytes, h.fs.statSync(src).size, 'bytes informados');
  } finally {
    await h.cleanup(box);
  }
});

test('valida antes de copiar', async () => {
  const box = await h.sandbox();
  try {
    const malo = h.path.join(box.tmp, 'malo.gif');
    await h.fsp.writeFile(malo, 'no soy un gif');
    const dest = h.path.join(box.globalStorage, 'media');
    await rejects(() => media.stage(malo, dest), 'no debe copiar un archivo invalido');
    // La validacion va antes del mkdir, asi que el directorio no llega a crearse.
    const copiados = h.fs.existsSync(dest) ? h.fs.readdirSync(dest) : [];
    eq(copiados.length, 0, 'no deja nada copiado');
  } finally {
    await h.cleanup(box);
  }
});

test('no recopia si ya esta puesto, pero repone si falta', async () => {
  const box = await h.sandbox();
  try {
    const src = await h.fakeMedia(box.tmp, 'origen.gif');
    const dest = h.path.join(box.globalStorage, 'media');

    const a = await media.stage(src, dest);
    const mtime = h.fs.statSync(a.file).mtimeMs;
    await new Promise(r => setTimeout(r, 25));
    const b = await media.stage(src, dest);
    eq(b.file, a.file, 'el nombre es estable entre llamadas');
    eq(h.fs.statSync(b.file).mtimeMs, mtime, 'no se volvio a copiar');

    await h.fsp.rm(a.file);
    const c = await media.stage(src, dest);
    ok(h.fs.existsSync(c.file), 'si la copia desaparece, se repone');
  } finally {
    await h.cleanup(box);
  }
});

test('borra las copias viejas al cambiar de medio', async () => {
  const box = await h.sandbox();
  try {
    const dest = h.path.join(box.globalStorage, 'media');
    const uno = await h.fakeMedia(box.tmp, 'uno.gif');
    const otro = await h.fakeMedia(box.tmp, 'otro.webp');
    await media.stage(uno, dest);
    const segundo = await media.stage(otro, dest);
    const quedan = h.fs.readdirSync(dest);
    eq(quedan.length, 1, 'solo debe quedar la copia en uso');
    eq(quedan[0], h.path.basename(segundo.file), 'y es la del medio actual');
  } finally {
    await h.cleanup(box);
  }
});
