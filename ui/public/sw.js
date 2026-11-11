// The deck's service worker. It caches nothing: a rebuilt UI must show on the
// next load, and the bridge is on the same machine or the same tailnet. Its
// one job is the phone's share sheet: Android posts
// what was shared to /share, this keeps it in the Cache API under /share/…,
// and the app opens Jot with it (ui/src/share.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== '/share') return;
  e.respondWith(
    (async () => {
      const fd = await e.request.formData();
      const cache = await caches.open('deck-share');
      for (const k of await cache.keys()) await cache.delete(k);
      const files = fd.getAll('files').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
      const meta = { title: String(fd.get('title') || ''), text: String(fd.get('text') || ''), url: String(fd.get('url') || ''), files: [] };
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const type = f.type || 'application/octet-stream';
        meta.files.push({ name: f.name || `shared-${i + 1}`, type });
        await cache.put(`/share/file/${i}`, new Response(f, { headers: { 'content-type': type } }));
      }
      await cache.put('/share/pending', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
      return Response.redirect('/?share=1', 303);
    })()
  );
});
