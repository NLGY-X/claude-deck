// The phone's share sheet lands in Jot. The service
// worker (public/sw.js) keeps what Android posted under /share/… in the Cache
// API and sends the app to /?share=1; this reads it back, once, and clears it.

export interface Shared {
  text: string;
  links: string[];
  files: File[];
}

const URL_RE = /https?:\/\/\S+/g;

export async function readShare(): Promise<Shared | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open('deck-share');
  const pending = await cache.match('/share/pending');
  if (!pending) return null;
  const meta = (await pending.json()) as { title: string; text: string; url: string; files: { name: string; type: string }[] };
  const files: File[] = [];
  for (let i = 0; i < meta.files.length; i++) {
    const r = await cache.match(`/share/file/${i}`);
    if (r) files.push(new File([await r.blob()], meta.files[i].name, { type: meta.files[i].type }));
  }
  for (const k of await cache.keys()) await cache.delete(k);
  // A shared page arrives as title plus text plus url, or the link inside the
  // text; the link is an attachment, the rest are the words.
  const links = new Set<string>();
  if (meta.url) links.add(meta.url);
  const words = [meta.title, meta.text]
    .filter(Boolean)
    .join(' ')
    .replace(URL_RE, (u) => {
      links.add(u);
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text: words, links: [...links], files };
}
