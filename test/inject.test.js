/**
 * Ejecuta el script que se inyecta en el workbench contra un DOM simulado.
 *
 * No hay forma de probar esto de otra manera: ese codigo corre dentro del
 * renderer del editor, no en el extension host, asi que aqui se le da un
 * document y un window falsos y se comprueba que estilos acaba aplicando.
 */
const { group, test, ok, eq, includes } = require('./tap.js');
const h = require('./helpers.js');

const { build } = h.out('inject.js');

const BASE = {
  position: 'bottom-right', width: 260, opacity: 0.85, offset: [16, 16],
  zIndex: 100, hideOnHover: false, scaling: 'none', avoidStatusBar: true
};
const GIF = { uri: 'vscode-file://vscode-app/x/a.gif', kind: 'image' };
const VID = { uri: 'vscode-file://vscode-app/x/a.webm', kind: 'video' };

function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(),
    style: {},
    _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener() {},
    setAttribute() {},
    remove() { this._removed = true; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, height: 0 }; },
    fire(t, arg) { (this._l[t] || []).forEach(f => f(arg)); }
  };
}

/** Monta el overlay en un DOM falso. statusBarH null = la barra aun no existe. */
function mount(cfg, media, statusBarH) {
  const registry = {};
  const bar = makeEl('div');
  bar.getBoundingClientRect = () => ({ height: statusBarH, left: 0, top: 0, right: 0, bottom: 0 });
  if (statusBarH !== null && statusBarH !== undefined) {
    registry['workbench.parts.statusbar'] = bar;
  }

  const appended = [];
  const document = {
    body: { appendChild: el => appended.push(el) },
    getElementById: id => registry[id] || null,
    querySelector: () => null,
    createElement: makeEl,
    addEventListener() {}
  };
  const window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {} };

  const mo = { created: 0, observing: 0, disconnects: 0, callbacks: [] };
  const ro = { observing: 0 };
  class MutationObserver {
    constructor(cb) { mo.created++; mo.callbacks.push(cb); }
    observe() { mo.observing++; }
    disconnect() { mo.disconnects++; }
  }
  class ResizeObserver {
    constructor(cb) { this.cb = cb; }
    observe() { ro.observing++; }
  }

  const errors = [];
  const fakeConsole = { error: m => errors.push(String(m)), warn() {}, log() {} };
  const timers = [];
  const fakeTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };

  new Function('document', 'window', 'console', 'MutationObserver', 'ResizeObserver', 'setTimeout',
    build(cfg, media))(document, window, fakeConsole, MutationObserver, ResizeObserver, fakeTimeout);

  const el = appended[0];
  const api = {
    el, errors, mo, ro, timers,
    load(w, hh) {
      if (media.kind === 'video') {
        el.videoWidth = w; el.videoHeight = hh; el.readyState = 1; el.fire('loadedmetadata');
      } else {
        el.naturalWidth = w; el.naturalHeight = hh; el.complete = true; el.fire('load');
      }
      return api;
    },
    failLoad() { el.fire('error'); return api; },
    tick(ms) { timers.filter(t => t.ms === ms).forEach(t => t.fn()); return api; },
    addStatusBar(hh) {
      bar.getBoundingClientRect = () => ({ height: hh, left: 0, top: 0, right: 0, bottom: 0 });
      registry['workbench.parts.statusbar'] = bar;
      mo.callbacks.forEach(cb => cb());
      return api;
    }
  };
  return api;
}

group('overlay: el bloque inyectado es JavaScript valido');

test('compila, lleva los marcadores y no ocupa de mas', () => {
  const code = build(BASE, GIF);
  new Function(code);
  ok(code.startsWith('/* ==GIFDECK_START== */'), 'empieza con el marcador de apertura');
  ok(code.endsWith('/* ==GIFDECK_END== */'), 'termina con el de cierre');
  ok(Buffer.byteLength(code) < 12000, `el bloque deberia ser pequeno, son ${Buffer.byteLength(code)} bytes`);
  ok(!code.includes('willChange'), 'nada de will-change: promovia la imagen a una capa y la ablandaba');
  ok(!code.includes('data:'), 'el medio va por URL, nunca embebido');
});

group('overlay: tamano segun las dimensiones reales');

test('nunca amplia por encima del tamano natural', () => {
  // El caso que producia las franjas: 128 px estirados a 260 dan 65/32, o sea una
  // costura periodica cada 65 pixeles.
  const m = mount(BASE, GIF, 22).load(128, 94);
  eq(m.el.style.width, '128px', 'se queda en su tamano natural');
  eq(m.el.style.height, '94px', 'y el alto en proporcion exacta');
  eq(m.el.style.imageRendering, 'auto', 'sin interpolacion nearest cuando no amplia');
  eq(m.el.style.visibility, 'visible', 'se muestra una vez medido');
});

test('scaling integer amplia solo en multiplos exactos', () => {
  const m = mount({ ...BASE, scaling: 'integer' }, GIF, 22).load(128, 94);
  eq(m.el.style.width, '256px', '128 x 2, que cabe en los 260 pedidos');
  eq(m.el.style.height, '188px', '94 x 2');
  eq(m.el.style.imageRendering, 'pixelated', 'bordes duros al ampliar en entero');
});

test('integer a 1x no activa el nearest', () => {
  const m = mount({ ...BASE, width: 200, scaling: 'integer' }, GIF, 22).load(128, 94);
  eq(m.el.style.width, '128px', 'no cabe un 2x en 200 px');
  eq(m.el.style.imageRendering, 'auto', 'a 1x no hay nada que interpolar');
});

test('un medio mas grande que width se reduce, en los dos modos', () => {
  const a = mount(BASE, GIF, 22).load(640, 360);
  eq(a.el.style.width, '260px', 'none reduce al ancho pedido');
  eq(a.el.style.height, '146px', 'el alto se redondea a entero');
  const b = mount({ ...BASE, scaling: 'integer' }, GIF, 22).load(640, 360);
  eq(b.el.style.width, '260px', 'integer no puede dejarlo mas ancho de lo pedido');
  eq(b.el.style.imageRendering, 'auto', 'ni aplicar nearest al reducir');
});

test('el alto siempre cae en un entero', () => {
  // 333 de ancho sobre 127x71 da un alto fraccionario si no se redondea.
  const m = mount({ ...BASE, width: 333 }, GIF, 0).load(127, 71);
  eq(m.el.style.width, '127px', 'no amplia');
  ok(/^\d+px$/.test(m.el.style.height), `el alto debe ser entero, es ${m.el.style.height}`);
});

test('video: usa videoWidth y videoHeight', () => {
  const m = mount(BASE, VID, 22).load(240, 135);
  eq(m.el.style.width, '240px', 'ancho del video');
  eq(m.el.style.height, '135px', 'alto del video');
  eq(mount({ ...BASE, width: 500, scaling: 'integer' }, VID, 0).load(240, 135).el.style.width,
    '480px', 'integer tambien vale para video');
});

group('overlay: posicion y barra de estado');

test('mide el alto real de la barra en vez de asumirlo', () => {
  eq(mount(BASE, GIF, 22).load(128, 94).el.style.bottom, '38px', '16 de offset mas 22 de barra');
  eq(mount(BASE, GIF, 30.5).load(128, 94).el.style.bottom, '47px', 'un alto fraccionario por zoom se redondea');
  eq(mount(BASE, GIF, 0).load(128, 94).el.style.bottom, '16px', 'barra oculta: no reserva nada');
});

test('avoidStatusBar desactivado la ignora', () => {
  eq(mount({ ...BASE, avoidStatusBar: false }, GIF, 22).load(128, 94).el.style.bottom,
    '16px', 'sin el ajuste no se suma el alto de la barra');
});

test('las cuatro esquinas se anclan al lado correcto', () => {
  const tl = mount({ ...BASE, position: 'top-left' }, GIF, 22).load(128, 94).el.style;
  eq(tl.top, '16px', 'top-left usa top'); eq(tl.left, '16px', 'y left');
  eq(tl.bottom, '', 'sin bottom'); eq(tl.right, '', 'sin right');
  const br = mount(BASE, GIF, 0).load(128, 94).el.style;
  eq(br.bottom, '16px', 'bottom-right usa bottom'); eq(br.right, '16px', 'y right');
  const tr = mount({ ...BASE, position: 'top-right' }, GIF, 22).load(128, 94).el.style;
  eq(tr.top, '16px', 'top-right no suma la barra de estado'); eq(tr.right, '16px', 'y usa right');
});

test('no intercepta clics', () => {
  eq(mount(BASE, GIF, 22).load(128, 94).el.style.pointerEvents, 'none', 'el overlay no debe robar el raton');
});

group('overlay: ciclo de vida del MutationObserver');

test('si la barra ya existe, no crea ningun observer', () => {
  const m = mount(BASE, GIF, 22).load(128, 94);
  eq(m.mo.created, 0, 'no hace falta observar nada');
  eq(m.ro.observing, 1, 'pero si vigila su tamano para recolocar');
});

test('se desconecta en cuanto encuentra la barra', () => {
  const m = mount(BASE, GIF, null).load(128, 94);
  eq(m.mo.created, 1, 'la barra no existe todavia, hay que esperarla');
  eq(m.mo.disconnects, 0, 'todavia observando');
  eq(m.el.style.bottom, '16px', 'de momento coloca sin inset');

  m.addStatusBar(22);
  eq(m.mo.disconnects, 1, 'al encontrarla se desconecta, no se queda escuchando el DOM del editor');
  eq(m.el.style.bottom, '38px', 'y recoloca con el alto medido');
  eq(m.ro.observing, 1, 'pasa a vigilar solo ese elemento');
});

test('si la barra nunca aparece, el observer muere solo', () => {
  const m = mount(BASE, GIF, null).load(128, 94);
  ok(m.timers.some(t => t.ms === 10000), 'debe haber una red de seguridad');
  m.tick(10000);
  eq(m.mo.disconnects, 1, 'se desconecta sin necesidad de que aparezca la barra');
});

group('overlay: el medio que no carga no puede fallar en silencio');

test('un error de carga se reporta con la URL y que hacer', () => {
  const m = mount(BASE, GIF, 22).failLoad();
  eq(m.el.style.visibility, 'hidden', 'no deja un icono de imagen rota sobre el codigo');
  eq(m.errors.length, 1, 'avisa una vez');
  includes(m.errors[0], '/x/a.gif', 'nombra la URL que fallo');
  includes(m.errors[0], 'Reaplicar parche', 'dice como arreglarlo');
});

test('el vigilante no duplica el aviso tras un error', () => {
  const m = mount(BASE, GIF, 22).failLoad();
  m.tick(8000);
  eq(m.errors.length, 1, 'un solo mensaje, no dos');
});

test('un medio que no responde se reporta a los 8 segundos', () => {
  const m = mount(BASE, GIF, 22);
  eq(m.el.style.visibility, 'hidden', 'sigue oculto mientras no se sepa el tamano');
  eq(m.errors.length, 0, 'todavia no avisa');
  m.tick(8000);
  eq(m.errors.length, 1, 'el vigilante salta');
  includes(m.errors[0], 'dimensiones', 'explica que no reporto dimensiones');
});

test('si carga bien, el vigilante se calla', () => {
  const m = mount(BASE, GIF, 22).load(128, 94);
  m.tick(8000);
  eq(m.errors.length, 0, 'ningun mensaje cuando todo va bien');
});

test('dimensiones cero no inventan un tamano', () => {
  const m = mount(BASE, GIF, 22).load(0, 0);
  eq(m.el.style.visibility, 'hidden', 'se queda oculto');
  eq(m.el.style.width, undefined, 'no fija ningun ancho');
  m.tick(8000);
  eq(m.errors.length, 1, 'y lo reporta');
});
