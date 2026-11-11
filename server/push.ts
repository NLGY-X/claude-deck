// Phone push through ntfy (ntfy/install.sh writes the topic file). The topic
// name is the secret; a message carries a Click to the deck, which opens at
// the card. A push that fails is dropped: the card still waits on the deck.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './util.ts';

export interface PushTarget {
  url: string;
  topic: string;
  /** where Click lands: the deck's https address */
  deckUrl: string;
}
export const PUSH_FILE = join(DATA_DIR, 'ntfy.json');

export function readPush(file = PUSH_FILE): PushTarget | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<PushTarget>;
    if (!j.url || !j.topic) return null;
    return { url: j.url.replace(/\/+$/, ''), topic: j.topic, deckUrl: (j.deckUrl ?? '').replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

export interface PushNote {
  title: string;
  body: string;
  /** the deck address, or the deck at one card: `${deckUrl}/?card=session:<id>` */
  click?: string;
  /** ntfy tags, shown as emoji by the ntfy app */
  tags?: string;
  priority?: 'high' | 'default';
}

/** The deck at one card, for Click. */
export const cardUrl = (t: Pick<PushTarget, 'deckUrl'>, cardId: string | null): string | undefined =>
  t.deckUrl ? (cardId ? `${t.deckUrl}/?card=${encodeURIComponent(cardId)}` : `${t.deckUrl}/`) : undefined;

/** One POST, ten seconds, never throws. Resolves true when ntfy took it. */
export async function push(t: PushTarget, n: PushNote, fetchFn: typeof fetch = fetch): Promise<boolean> {
  // A header value must be plain ASCII or fetch refuses the whole request.
  const headers: Record<string, string> = { Title: n.title.replace(/[^\x20-\x7e]/g, '').trim() || 'Deck', Tags: n.tags ?? 'bell', Priority: n.priority ?? 'default' };
  if (n.click) headers.Click = n.click;
  try {
    const r = await fetchFn(`${t.url}/${t.topic}`, { method: 'POST', body: n.body, headers, signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}
