// ════════════════════════════════════════════════════════════════════════════
// Service worker – Busca Ativa NSP/CCIH
// Guarda as telas e bibliotecas no aparelho para o app abrir SEM INTERNET.
// Os dados (Firestore) têm cache próprio do Firebase; este arquivo cuida só
// dos arquivos do app.
// Ao publicar uma versão nova, troque VERSAO para forçar a atualização.
// ════════════════════════════════════════════════════════════════════════════
const VERSAO = 'nsp-2026-10-29c';
const APP = ['./', 'index.html', 'styles.css', 'config.js', 'app.js', 'logo.png', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const CDN = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js'
];
// O leitor de planilhas (~900 KB) NÃO é baixado na instalação: só quando
// alguém importa o censo pela primeira vez (depois fica guardado).
// Nunca interceptar: tráfego de dados e login (o Firebase cuida do offline deles)
const NAO_INTERCEPTAR = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|script\.google(usercontent)?\.com|firebaseinstallations|googleapis\.com\/v1/;

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSAO);
    await cache.addAll(APP);
    // Bibliotecas externas: guarda o que conseguir (não impede a instalação)
    await Promise.all(CDN.map(async url => {
      try { const r = await fetch(url, { mode: 'no-cors' }); await cache.put(url, r); } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET' || NAO_INTERCEPTAR.test(req.url)) return;
  const url = new URL(req.url);

  // Arquivos do próprio app: rede primeiro (pega atualizações), cache se offline
  if (url.origin === self.location.origin) {
    ev.respondWith((async () => {
      const cache = await caches.open(VERSAO);
      try {
        const r = await fetch(req);
        if (r && r.ok) cache.put(req, r.clone());
        return r;
      } catch (e) {
        const c = await cache.match(req, { ignoreSearch: true })
               || (req.mode === 'navigate' ? await cache.match('index.html') : null);
        return c || Response.error();
      }
    })());
    return;
  }

  // Bibliotecas e fontes externas: cache primeiro
  if (/gstatic\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com/.test(url.host)) {
    ev.respondWith((async () => {
      const cache = await caches.open(VERSAO);
      const c = await cache.match(req, { ignoreSearch: false }) || await cache.match(req.url);
      if (c) return c;
      try { const r = await fetch(req); cache.put(req, r.clone()); return r; }
      catch (e) { return Response.error(); }
    })());
  }
});
