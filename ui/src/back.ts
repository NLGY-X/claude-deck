// The system back gesture, which a phone app answers and a web page does
// not. A sheet pushes one history entry
// when it opens and goes when Back pops it, so Back closes the sheet, not
// the app; a tab away from Now pushes one too, so Back returns to Now first,
// as a bottom-bar app does. Closing from the sheet's own button pops its
// entry quietly. With nothing of ours on the stack, Back leaves the app,
// which is what a phone expects.

import { useEffect, useRef } from 'react';

const stack: (() => void)[] = [];
let quiet = 0;

// The shell keeps each tab's scroll place itself (App.tsx); the browser
// putting its own back on every pop would land on top of it.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

addEventListener('popstate', () => {
  if (quiet > 0) {
    quiet--;
    return;
  }
  stack.pop()?.();
});

/** Push one entry; the handler runs when Back pops it. The returned release
 *  takes the entry back without running the handler. */
export function pushBack(onBack: () => void): () => void {
  history.pushState({ deck: stack.length + 1 }, '');
  stack.push(onBack);
  return () => {
    const i = stack.lastIndexOf(onBack);
    if (i < 0) return;
    stack.splice(i, 1);
    if (i === stack.length) {
      quiet++;
      history.back();
    }
  };
}

/** For a sheet: Back closes it while it is open. */
export function useBackClose(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => pushBack(() => ref.current()), []);
}
