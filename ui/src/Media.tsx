import { useEffect, useRef, useState } from 'react';
import { act, artUrl, useNow, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { Icon } from './icons.tsx';
import { Art, Progress, Transport, pickMedia, sourceName } from './parts.tsx';

export function Media({ state }: { state: DeckState }) {
  const now = useNow();
  const run = useRun();
  const [picked, setPicked] = useState<string | null>(null);
  const m = pickMedia(state, picked);

  // The slider shows your finger, not the last push, while you drag it.
  const [level, setLevel] = useState<number | null>(null);
  const send = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(send.current), []);
  const shown = level ?? state.volume?.level ?? 0;
  const muted = !!state.volume?.muted;
  const onVolume = (v: number) => {
    setLevel(v);
    clearTimeout(send.current);
    send.current = setTimeout(() => {
      void act('/deck/volume', { level: v }).finally(() => setTimeout(() => setLevel(null), 800));
    }, 120);
  };

  return (
    <div className="media">
      {m?.art && <img className="backdrop" src={artUrl(m.art)} alt="" aria-hidden="true" />}
      <Art m={m} className="bigart" />
      <div className="mediaside">
        <div className="sources">
          {state.media.map((x) => (
            <button key={x.app} className={`target${x === m ? ' on' : ''}`} onClick={() => setPicked(x.app)}>
              {sourceName(x.app)}
              <span className="mono muted">{x.status === 'Playing' ? 'playing' : x.status.toLowerCase()}</span>
            </button>
          ))}
        </div>
        <div>
          <h1 className="bigtrack">{m?.title || 'Nothing playing'}</h1>
          <p className="bigartist">{m ? [m.artist, m.album].filter(Boolean).join(' · ') : 'Start Spotify or a video on the PC and it appears here.'}</p>
        </div>
        {m && <Progress m={m} now={now} />}
        {m && <Transport m={m} big />}
        {state.volume && (
          <div className="volume">
            <button
              className="round outline"
              aria-label={muted ? 'Unmute' : 'Mute'}
              onClick={() => run(act('/deck/volume', { muted: !muted }), muted ? 'Sound on' : 'Muted')}
            >
              <Icon name={muted ? 'muted' : 'speaker'} size={22} />
            </button>
            <label htmlFor="pc-volume" className="muted">
              PC volume
            </label>
            <input id="pc-volume" type="range" min={0} max={100} value={shown} onChange={(e) => onVolume(Number(e.target.value))} />
            <span className="mono">{muted ? 'off' : shown}</span>
          </div>
        )}
      </div>
    </div>
  );
}
