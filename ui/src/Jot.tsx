// Jot: one sheet from the plus key on every screen. Words, a pasted link, a
// photo, any file; the area guessed from the words; a kind. An idea is a note
// in the jots folder (server/jots.ts); the task kinds go to the day list.

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { JotAsk, JotSummary } from '../../server/jots.ts';
import { act, actForm, useNow, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { useBackClose } from './back.ts';
import { Icon } from './icons.tsx';
import { buzz, hueOf, when, speech, type Recognition } from './parts.tsx';

const KINDS: { id: JotAsk; label: string; save: string }[] = [
  { id: 'idea', label: 'Idea', save: 'Save idea' },
  { id: 'today', label: 'Task, today', save: 'Add to Today' },
  { id: 'soon', label: 'Task, soon', save: 'Add to the shortlist' },
  { id: 'someday', label: 'Someday', save: 'Add for someday' },
  { id: 'wait', label: 'Waiting on', save: 'Add to waiting on' },
];
const FILE_MB = 20;
const JOT_MB = 60;
const URL_RE = /^https?:\/\/\S+$/;

/** The area the words point at: an area's own name first, then its words. */
export function guessArea(text: string, state: DeckState): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  const has = (w: string): boolean => t.includes(` ${w.toLowerCase()} `);
  for (const a of state.areas) if (has(a.id) || has(a.label)) return a.id;
  for (const a of state.day?.areas ?? []) for (const w of a.words ?? []) if (has(w)) return a.id;
  return null;
}

const mb = (n: number): string => `${(n / 1_048_576).toFixed(n < 1_048_576 ? 2 : 1)} MB`;
const fileKind = (f: File): 'photo' | 'voice' | 'file' => (f.type.startsWith('image/') ? 'photo' : f.type.startsWith('audio/') ? 'voice' : 'file');
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

/** What a jot opens with when something was shared or handed in. */
export interface JotInitial {
  text?: string;
  links?: string[];
  files?: File[];
}

export function Jot({ state, preset, initial, onClose }: { state: DeckState; preset: JotAsk; initial?: JotInitial; onClose: () => void }) {
  useBackClose(onClose);
  const run = useRun();
  const [recording, setRecording] = useState<{ rec: MediaRecorder; since: number } | null>(null);
  const now = useNow(recording ? 1000 : 15_000);
  const [text, setText] = useState(initial?.text ?? '');
  const [links, setLinks] = useState<string[]>(initial?.links ?? []);
  const [files, setFiles] = useState<File[]>(initial?.files ?? []);
  // undefined: take the guess; null: None
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [kind, setKind] = useState<JotAsk>(preset);
  const [linkBox, setLinkBox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const photoIn = useRef<HTMLInputElement>(null);
  const voiceIn = useRef<HTMLInputElement>(null);
  const anyIn = useRef<HTMLInputElement>(null);

  const guessed = guessArea(text, state);
  const area = chosen === undefined ? guessed : chosen;
  const chips = state.areas.map((a) => ({ id: a.id, label: a.label, hue: a.color }));
  // Speech and the mic need a secure page; over plain http the keyboard's own mic is the way.
  const canSpeak = !!speech() && window.isSecureContext;
  const canRecord = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const empty = !text.trim() && !links.length && !files.length;

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', key);
    return () => {
      removeEventListener('keydown', key);
      rec.current?.stop();
    };
  }, [onClose]);
  useEffect(() => () => recording?.rec.stream.getTracks().forEach((t) => t.stop()), [recording]);

  /** A sentence on the toast with no request behind it. */
  const say = (s: string, bad = false): Promise<boolean> => run(bad ? Promise.reject(new Error(s)) : Promise.resolve(), bad ? '' : s);

  const addLink = (raw: string): boolean => {
    const u = raw.trim();
    if (!URL_RE.test(u)) return false;
    setLinks((l) => (l.includes(u) ? l : [...l, u]));
    return true;
  };
  const addFiles = (list: Iterable<File>): void => {
    const next = [...files];
    for (const f of list) {
      if (f.size > FILE_MB * 1_048_576) {
        void say(`${f.name} is ${mb(f.size)}. One file can be ${FILE_MB} MB at most.`, true);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    if (next.reduce((n, f) => n + f.size, 0) > JOT_MB * 1_048_576) {
      void say(`That is over ${JOT_MB} MB in one jot. Drop something.`, true);
      return;
    }
    setFiles(next);
  };
  const onPaste = (e: ClipboardEvent<HTMLElement>): void => {
    const fs = Array.from(e.clipboardData.files ?? []);
    if (fs.length) {
      e.preventDefault();
      addFiles(fs);
      return;
    }
    // A bare link pasted anywhere is an attachment, not words in the box.
    const t = e.clipboardData.getData('text').trim();
    if (URL_RE.test(t)) {
      e.preventDefault();
      addLink(t);
    }
  };
  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setDragging(false);
    const fs = Array.from(e.dataTransfer.files ?? []);
    if (fs.length) return addFiles(fs);
    const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text')).split(/\r?\n/)[0] ?? '';
    if (!addLink(u) && u.trim()) setText((t) => `${t} ${u.trim()}`.trim());
  };
  const pasteLink = async (): Promise<void> => {
    // Reading the clipboard needs https and a granted permission; asking for
    // one can hang on a prompt nobody sees, so only read when it is already
    // granted. Otherwise the box is the way.
    try {
      const p = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
      if (p.state === 'granted' && addLink(await navigator.clipboard.readText())) return;
    } catch {
      /* no clipboard here */
    }
    setLinkBox('');
  };
  /** A voice note recorded here: one file, named by the clock, the PC writes it down after save. */
  const record = async (): Promise<void> => {
    if (recording) return recording.rec.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = (r.mimeType || 'audio/webm').split(';')[0];
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const d = new Date();
        const two = (n: number): string => String(n).padStart(2, '0');
        const f = new File(chunks, `voice-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.${ext}`, { type: mime });
        setRecording(null);
        if (f.size) setFiles((cur) => [...cur, f]);
      };
      r.start();
      setRecording({ rec: r, since: Date.now() });
    } catch (e) {
      void say(`Couldn't start the mic: ${(e as Error).message}`, true);
    }
  };
  const speak = (): void => {
    const S = speech();
    if (!S) return;
    if (listening) return rec.current?.stop();
    const r = new S();
    r.lang = 'en-GB';
    r.interimResults = false;
    r.onresult = (e) => setText((t) => `${t} ${Array.from(e.results, (x) => x[0].transcript).join(' ')}`.trim());
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  const save = async (): Promise<void> => {
    if (busy || empty) return;
    const fd = new FormData();
    fd.append('text', text.trim());
    fd.append('kind', kind);
    fd.append('area', area ?? '');
    fd.append('links', JSON.stringify(links));
    fd.append('source', 'deck');
    for (const f of files) fd.append('file', f, f.name);
    setBusy(true);
    try {
      const r = await actForm<{ said: string }>('/deck/jot', fd);
      buzz();
      await say(r.said);
      onClose();
    } catch (e) {
      await say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const makeTask = async (j: JotSummary): Promise<void> => {
    try {
      await say((await act<{ said: string }>('/deck/jot/task', { stem: j.stem })).said);
    } catch (e) {
      await say((e as Error).message, true);
    }
  };
  const chosenKind = KINDS.find((k) => k.id === kind)!;

  return (
    <div
      className={`jot${dragging ? ' dragging' : ''}`}
      role="dialog"
      aria-label="Jot"
      onPaste={onPaste}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={onClose}
    >
      <div className="jotcard" onClick={(e) => e.stopPropagation()}>
        <div className="jothead">
          <h1>Jot it down</h1>
          <span className="mono muted">one line is enough · filed in a second</span>
          <button className="hbbtn quiet sm push" onClick={onClose}>
            Cancel
          </button>
        </div>

        <label>
          <span className="sr">What is it</span>
          <textarea
            className="jottext"
            rows={2}
            autoFocus
            value={text}
            placeholder="What is it"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
            }}
          />
        </label>

        <div className="jotrows" aria-label="Attached">
          {links.map((u) => (
            <div key={u} className="jotrow">
              <span className="joticon" aria-hidden="true">
                <Icon name="link" size={18} stroke={1.8} />
              </span>
              <div className="jotrowtext">
                <p>{u}</p>
                <p>{hostOf(u)} · pasted · the PC keeps a text copy in the note, so the page can change and you still have what you saw</p>
              </div>
              <button className="jotx" aria-label="Remove link" onClick={() => setLinks((l) => l.filter((x) => x !== u))}>
                <Icon name="x" size={14} stroke={2.2} />
              </button>
            </div>
          ))}
          {files.map((f) => {
            const k = fileKind(f);
            return (
              <div key={`${f.name}-${f.size}`} className="jotrow">
                <span className="joticon" aria-hidden="true">
                  {k === 'photo' ? <Thumb f={f} /> : <Icon name={k === 'voice' ? 'mic' : 'file'} size={18} stroke={1.8} />}
                </span>
                <div className="jotrowtext">
                  <p>{f.name}</p>
                  <p>
                    {k === 'photo' ? 'photo · the PC describes it into the note' : k === 'voice' ? 'voice note · the PC writes down what it hears, and keeps the audio' : 'file · kept beside the note'} · {mb(f.size)}
                  </p>
                </div>
                <button className="jotx" aria-label={`Remove ${f.name}`} onClick={() => setFiles((l) => l.filter((x) => x !== f))}>
                  <Icon name="x" size={14} stroke={2.2} />
                </button>
              </div>
            );
          })}
          {linkBox !== null && (
            <div className="jotlink">
              <input
                type="url"
                inputMode="url"
                autoFocus
                placeholder="https://"
                value={linkBox}
                onChange={(e) => setLinkBox(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter' && addLink(linkBox)) setLinkBox(null);
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setLinkBox(null);
                  }
                }}
              />
              <button
                className="hbbtn primary sm"
                disabled={!URL_RE.test(linkBox.trim())}
                onClick={() => {
                  if (addLink(linkBox)) setLinkBox(null);
                }}
              >
                Add link
              </button>
              <button className="hbbtn quiet sm" onClick={() => setLinkBox(null)}>
                Cancel
              </button>
            </div>
          )}
          <div className="jotadd">
            <button className="jotaddbtn" onClick={() => void pasteLink()}>
              <Icon name="link" size={16} stroke={1.8} />
              Paste a link
            </button>
            <button className="jotaddbtn" onClick={() => photoIn.current?.click()}>
              <Icon name="image" size={16} stroke={1.8} />
              Photo or screenshot
            </button>
            {canRecord ? (
              <button className={`jotaddbtn${recording ? ' on' : ''}`} onClick={() => void record()} aria-pressed={!!recording}>
                <Icon name="mic" size={16} stroke={1.8} />
                {recording ? `Stop · ${Math.max(0, Math.round((now - recording.since) / 1000))}s` : 'Record a voice note'}
              </button>
            ) : (
              <button className="jotaddbtn" onClick={() => voiceIn.current?.click()}>
                <Icon name="mic" size={16} stroke={1.8} />
                Voice note
              </button>
            )}
            <button className="jotaddbtn" onClick={() => anyIn.current?.click()}>
              <Icon name="file" size={16} stroke={1.8} />
              Any file
            </button>
            <span className="hint">or drop it anywhere on this sheet</span>
            <input
              ref={photoIn}
              type="file"
              accept="image/*"
              multiple
              className="sr"
              onChange={(e) => {
                addFiles(e.target.files ?? []);
                e.target.value = '';
              }}
            />
            <input
              ref={voiceIn}
              type="file"
              accept="audio/*"
              className="sr"
              onChange={(e) => {
                addFiles(e.target.files ?? []);
                e.target.value = '';
              }}
            />
            <input
              ref={anyIn}
              type="file"
              multiple
              className="sr"
              onChange={(e) => {
                addFiles(e.target.files ?? []);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <div className="jotfor" role="group" aria-label="For">
          <span className="eyebrow">For</span>
          {chips.map((c) => {
            const on = area === c.id;
            return (
              <button
                key={c.id}
                className={`jotpill${on ? ' on' : ''}`}
                aria-pressed={on}
                style={on ? { borderColor: c.hue, background: `${c.hue}24` } : undefined}
                onClick={() => setChosen(on ? null : c.id)}
              >
                <span className="vdot" style={{ background: c.hue }} />
                {c.label}
                {on && chosen === undefined && <span className="muted">· guessed</span>}
              </button>
            );
          })}
          <button className={`jotpill${area === null ? ' on' : ''}`} aria-pressed={area === null} onClick={() => setChosen(null)}>
            None
          </button>
        </div>

        <div className="vswitch" role="group" aria-label="What kind">
          {KINDS.map((k) => (
            <button key={k.id} className={kind === k.id ? 'on' : ''} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>

        <p className="hint">
          Each jot is one dated markdown note in the jots folder, with the link's text copy, the photo and the audio beside it. The PC reads links, describes photos and writes down voice notes, so every jot is searchable as words. Nothing lands on the
          day list unless you make it a task.
        </p>

        <div className="jotfoot">
          {canSpeak && (
            <button className={`jotmic${listening ? ' on' : ''}`} aria-label={listening ? 'Stop listening' : 'Dictate'} onClick={speak}>
              <Icon name="mic" size={24} stroke={1.8} />
            </button>
          )}
          <span className="hint">
            {canSpeak
              ? 'Tap to dictate into the box, or record a voice note above and the PC writes it down.'
              : "Dictate with the keyboard's mic. Recording here needs the https address; a voice note picked as a file is still written down by the PC."}
          </span>
          <button className="primary jotsave" disabled={empty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : chosenKind.save}
          </button>
        </div>

        <div className="jotweek">
          <span className="eyebrow">
            Jotted this week · {state.jots.length}
            {state.jots.length === 0 ? ' · nothing yet' : ''}
          </span>
          {state.jots.slice(0, 5).map((j) => (
            <div key={j.stem} className="jotweekrow">
              <span className="vdot" style={{ background: hueOf(state, j.area) }} />
              <span className="jottextline">{j.text}</span>
              <span className={`mono${j.pending ? ' amber' : ' muted'}`}>{j.pending ?? `${when(j.at, now)} · ${j.kind === 'idea' ? 'text' : j.kind}`}</span>
              {j.task ? <span className="mono muted">on the list</span> : <button onClick={() => void makeTask(j)}>Make it a task</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thumb({ f }: { f: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [f]);
  return url ? <img src={url} alt="" /> : <Icon name="image" size={18} stroke={1.8} />;
}
