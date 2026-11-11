import { useCallback, useEffect, useRef, useState } from 'react';

// The tablet is an OLED that sits on the desk all day. A static deck at full
// brightness for hours burns its outline into the panel, so two things run:
// - Shift: the whole deck walks a few pixels round a small square on a slow
//   cycle, so no edge or label sits on the same pixels for long.
// - Rest: after a few idle minutes the deck dims behind a dark veil. A tap on
//   the veil only wakes it and never reaches the button underneath. Something
//   new needing you (a new card) wakes it on its own, and it rests again if
//   nobody comes.
// Over plain http on the LAN the page cannot hold the screen on itself (the
// Wake Lock API needs https), so Android's stay-awake-while-charging does that
// part; over Tailscale's https, useWakeLock in parts.tsx does.

const REST_AFTER_MS = 3 * 60_000;
const SHIFT_EVERY_MS = 90_000;
const SHIFT_PX = 3; // CSS px

const OFFSETS: [number, number][] = [
  [0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export interface Rest {
  resting: boolean;
  wake: () => void;
  shift: string;
}

/** `on` is false on the phone: its screen times itself out and the veil
 *  and the shift would only get in the hand's way. */
export function useRest(alerts: number, on = true): Rest {
  const [resting, setResting] = useState(false);
  const [step, setStep] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restingRef = useRef(false);
  restingRef.current = resting;

  const wake = useCallback(() => {
    setResting(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResting(true), REST_AFTER_MS);
  }, []);

  // Any touch while awake restarts the idle clock. While resting the veil owns
  // the tap, so the global listener stays out of it: waking on pointerdown here
  // would drop the veil mid-tap and let the click land on whatever is below.
  useEffect(() => {
    if (!on) return;
    const poke = () => {
      if (!restingRef.current) wake();
    };
    wake();
    addEventListener('pointerdown', poke, { passive: true });
    addEventListener('keydown', poke);
    return () => {
      removeEventListener('pointerdown', poke);
      removeEventListener('keydown', poke);
      clearTimeout(timer.current);
    };
  }, [wake, on]);

  const seen = useRef(alerts);
  useEffect(() => {
    if (alerts > seen.current) wake();
    seen.current = alerts;
  }, [alerts, wake]);

  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => setStep((s) => (s + 1) % OFFSETS.length), SHIFT_EVERY_MS);
    return () => clearInterval(iv);
  }, [on]);

  const [x, y] = OFFSETS[step];
  if (!on) return { resting: false, wake, shift: '' };
  return { resting, wake, shift: `translate(${x * SHIFT_PX}px, ${y * SHIFT_PX}px)` };
}

export function Veil({ onWake }: { onWake: () => void }) {
  return <div className="veil" onClick={onWake} aria-label="Wake the deck" role="button" />;
}
