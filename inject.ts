import { START, END } from './core';
import { MediaKind } from './media';

export type Scaling = 'none' | 'integer';

export interface OverlayConfig {
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  width: number;
  opacity: number;
  offset: [number, number];
  zIndex: number;
  hideOnHover: boolean;
  scaling: Scaling;
  avoidStatusBar: boolean;
}

export function build(cfg: OverlayConfig, media: { uri: string; kind: MediaKind }): string {
  const payload = JSON.stringify({ ...cfg, media });

  // Los estilos se aplican por CSSOM (element.style.x), no con un <style> ni con
  // atributos style en HTML parseado. CSP no bloquea CSSOM, asi que no hace falta
  // tocar la meta CSP del workbench y el parche queda mas pequeno y mas estable.
  //
  // El medio va por URL vscode-file, no embebido: ver el comentario de cabecera
  // de media.ts. El parche entero ocupa unos pocos KB.
  //
  // NADA de will-change aqui. Promovia la imagen a su propia capa de composicion
  // para un transform que nunca ocurre, y en una capa promovida Chromium
  // rasteriza a una textura del tamano de la capa antes de componer, lo que sumaba
  // una interpolacion extra. contain si se queda: acota el repintado que provoca
  // un GIF animado encima del editor, y eso si es una ganancia real.
  return `${START}
(function () {
  try {
    var CFG = ${payload};
    var ID = 'gifdeck-root';

    function statusBar() {
      return document.getElementById('workbench.parts.statusbar') ||
             document.querySelector('.part.statusbar');
    }

    /** Alto real de la barra de estado. Nunca un 22 hardcodeado: cambia con el
     *  zoom del editor y es 0 cuando el usuario la oculta. */
    function statusBarInset() {
      if (!CFG.avoidStatusBar) { return 0; }
      if (CFG.position.indexOf('bottom') !== 0) { return 0; }
      var bar = statusBar();
      if (!bar) { return 0; }
      var h = bar.getBoundingClientRect().height;
      return h > 0 ? Math.round(h) : 0;
    }

    function place(el) {
      var ox = CFG.offset[0], oy = CFG.offset[1];
      el.style.position = 'fixed';
      el.style.pointerEvents = 'none';
      el.style.zIndex = String(CFG.zIndex);
      el.style.opacity = String(CFG.opacity);
      el.style.transition = 'opacity 180ms ease';
      el.style.contain = 'layout paint';
      el.style.top = el.style.bottom = el.style.left = el.style.right = '';
      if (CFG.position.indexOf('bottom') === 0) { el.style.bottom = (oy + statusBarInset()) + 'px'; }
      else { el.style.top = oy + 'px'; }
      if (CFG.position.indexOf('right') > -1) { el.style.right = ox + 'px'; }
      else { el.style.left = ox + 'px'; }
    }

    function natural(el) {
      return CFG.media.kind === 'video'
        ? { w: el.videoWidth, h: el.videoHeight }
        : { w: el.naturalWidth, h: el.naturalHeight };
    }

    /**
     * El tamano se decide con las dimensiones reales del archivo, que solo se
     * conocen aqui, en el renderer, cuando el medio ya cargo.
     *
     * Ampliar por encima del tamano natural es lo que producia las franjas: un GIF
     * de 128 px llevado a 260 da un factor de 65/32, o sea que cada 32 pixeles de
     * origen se convierten en 65 de destino, 31 duplicados y uno triplicado. Eso
     * deja una costura periodica cada 65 pixeles por toda la imagen.
     */
    function size(el) {
      var n = natural(el);
      if (!n.w || !n.h) { return false; }

      var w;
      // El modo integer solo entra cuando el medio CABE en el ancho pedido. Si es
      // mas grande no hay multiplo entero que aplicar, y forzar un factor 1 lo
      // dejaria mas ancho de lo que el usuario configuro.
      if (CFG.scaling === 'integer' && n.w <= CFG.width) {
        var factor = Math.floor(CFG.width / n.w);
        w = n.w * factor;
        // Nearest solo cuando de verdad ampliamos. A 1x no cambia nada.
        el.style.imageRendering = factor > 1 ? 'pixelated' : 'auto';
      } else {
        w = Math.min(CFG.width, n.w);
        el.style.imageRendering = 'auto';
      }

      // Enteros en los dos ejes. Un alto fraccionario como 190.9375 deja los
      // bordes del elemento entre pixeles fisicos y anade otra pasada de
      // remuestreo encima de la primera.
      el.style.width = Math.round(w) + 'px';
      el.style.height = Math.max(1, Math.round(w * n.h / n.w)) + 'px';
      return true;
    }

    function make() {
      var old = document.getElementById(ID);
      if (old) { old.remove(); }

      var el;
      if (CFG.media.kind === 'video') {
        el = document.createElement('video');
        el.autoplay = true;
        el.loop = true;
        el.muted = true;
        el.playsInline = true;
        el.src = CFG.media.uri;
      } else {
        el = document.createElement('img');
        el.src = CFG.media.uri;
      }
      el.id = ID;
      el.setAttribute('aria-hidden', 'true');

      var failed = false;
      el.addEventListener('error', function () {
        failed = true;
        console.error('[gifdeck] el overlay no se monto: el renderer no pudo cargar\\n  ' +
          CFG.media.uri + '\\n' +
          'Causas tipicas: el archivo se borro de globalStorage, esta corrupto, o la CSP lo ' +
          'bloquea porque quedo fuera de una raiz valida del protocolo vscode-file. ' +
          'Ejecuta "GifDeck: Reaplicar parche" para volver a copiarlo.');
      });

      // Hasta saber el tamano natural no se pinta nada: dibujarlo antes daria un
      // salto visible del tamano configurado al real.
      el.style.visibility = 'hidden';
      place(el);
      document.body.appendChild(el);

      function measured() {
        if (size(el)) { el.style.visibility = 'visible'; }
      }
      el.addEventListener(CFG.media.kind === 'video' ? 'loadedmetadata' : 'load', measured);
      // Si venia de cache el evento ya paso.
      if (CFG.media.kind === 'video' ? el.readyState >= 1 : el.complete) { measured(); }

      // Hasta conocer las dimensiones el elemento esta en visibility hidden. Si el
      // medio no carga nunca se quedaria invisible para siempre y sin una sola
      // pista, asi que a los 8 segundos lo decimos, distinguiendo el caso de error
      // del de un archivo que ni siquiera responde.
      setTimeout(function () {
        if (el.style.visibility === 'visible' || failed) { return; }
        console.error('[gifdeck] el overlay sigue oculto 8 s despues de montarse: ' +
          'el medio no ha reportado dimensiones.\\n  ' + CFG.media.uri + '\\n' +
          'Si el archivo existe y no da error de carga, puede estar truncado o con una ' +
          'cabecera que este renderer no entiende. Prueba con un WebP o un WebM.');
      }, 8000);

      // La barra de estado se construye despues que este parche, asi que su alto
      // no se puede medir todavia. En cuanto aparece, recolocamos.
      whenStatusBar(function (bar) {
        place(el);
        if (typeof ResizeObserver === 'function') {
          new ResizeObserver(function () { place(el); }).observe(bar);
        }
      });
      window.addEventListener('resize', function () { place(el); }, { passive: true });

      if (CFG.hideOnHover) {
        // pointer-events esta en none, asi que el hover se detecta por posicion.
        window.addEventListener('mousemove', function (e) {
          var r = el.getBoundingClientRect();
          var inside = e.clientX >= r.left && e.clientX <= r.right &&
                       e.clientY >= r.top && e.clientY <= r.bottom;
          el.style.opacity = inside ? '0.08' : String(CFG.opacity);
        }, { passive: true });
      }
    }

    function whenStatusBar(cb) {
      var found = statusBar();
      if (found) { cb(found); return; }
      if (typeof MutationObserver !== 'function') { return; }
      var obs = new MutationObserver(function () {
        var bar = statusBar();
        if (bar) { obs.disconnect(); cb(bar); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      // Se desconecta en cuanto encuentra la barra, y el callback mientras tanto es
      // un solo getElementById. Aun asi el observer no puede quedarse vivo si la
      // barra nunca aparece, por ejemplo con la barra de estado desactivada, asi
      // que 10 s de margen y fuera: para entonces el workbench ya se monto.
      setTimeout(function () { obs.disconnect(); }, 10000);
    }

    if (document.body) { make(); }
    else { window.addEventListener('DOMContentLoaded', make); }
  } catch (err) {
    console.error('[gifdeck] fallo al montar el overlay', err);
  }
})();
${END}`;
}
