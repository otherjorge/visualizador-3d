// Service worker do HTML 3D: guarda o app e os modelos no aparelho para abrir sem sinal.
// Rede primeiro (com tempo limite) para páginas e lista, que mudam; cache primeiro para as bibliotecas, que não mudam.
const APP = 'vis3d-app-v4', LIB = 'vis3d-lib-v1', MOD = 'vis3d-modelos';
const SHELL = ['./', 'index.html', 'app.js', 'conversor.js', 'molde.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'lib/qrcode/qrcode.js'];
const ESCOPO = new URL('./', self.location).href;

self.addEventListener('install', e => e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('vis3d-app-') && k !== APP || k.startsWith('vis3d-lib-') && k !== LIB).map(k => caches.delete(k)))).then(() => self.clients.claim())));

const chave = url => { const u = new URL(url); u.search = ''; u.hash = ''; return u.href };
async function redePrimeiro(req, cacheNome, ms) {
  const k = chave(req.url), cache = await caches.open(cacheNome), guardado = await cache.match(k);
  // no-cache: revalida com o servidor (o GitHub Pages manda guardar 10 min; sem isso a atualização demora a aparecer)
  const rede = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => { if (r.ok) cache.put(k, r.clone()); return r });
  if (!guardado) return rede;
  const tempo = new Promise(res => setTimeout(() => res(null), ms));
  try { return (await Promise.race([rede, tempo])) || guardado } catch (e) { return guardado }
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET' || !req.url.startsWith(ESCOPO)) return;
  const rel = req.url.slice(ESCOPO.length);
  if (rel.startsWith('lib/')) {
    // pedido NOVO pelo endereço: repassar o pedido original da página (fetch(req)) falhou no app do PC em 22/10
    const k = chave(req.url);
    e.respondWith(caches.open(LIB).then(async c => (await c.match(k)) || fetch(k, { credentials: 'same-origin' }).then(r => { if (r.ok) c.put(k, r.clone()); return r })));
  } else if (rel.startsWith('m/')) {
    // modelo: só fica no aparelho quem foi guardado (ou já aberto); abrir de novo atualiza a cópia
    e.respondWith(redePrimeiro(req, MOD, 6000));
  } else {
    e.respondWith(redePrimeiro(req, APP, 4000).catch(() => caches.match(chave(req.url)).then(r => r || caches.match(ESCOPO))));
  }
});
self.addEventListener('message', e => {
  const d = e.data || {}, fonte = e.source;
  if (d.guardar) caches.open(MOD).then(async c => { const k = chave(d.guardar); if (!(await c.match(k))) { const r = await fetch(k, { cache: 'reload' }); if (!r.ok) throw Error('HTTP ' + r.status); await c.put(k, r) } })
    .then(() => fonte.postMessage({ guardado: d.guardar }), err => fonte.postMessage({ falhou: d.guardar, erro: err.message }));
  if (d.apagar) caches.open(MOD).then(c => c.delete(chave(d.apagar))).then(() => fonte.postMessage({ apagado: d.apagar }));
});
