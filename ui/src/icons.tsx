// Stroke icons, 24px grid. Names match the `icon` fields in deck.config.jsonc
// and the five tabs.

const PATHS: Record<string, string> = {
  now: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  day: 'M5 12l4 4L19 6',
  sessions: 'M3 5h18v14H3zM7 10l3 2-3 2M12 15h5',
  keys: 'M3 6h18v12H3zM7 10h2M11 10h2M15 10h2M8 14h8',
  media: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  check: 'M5 12l5 5L20 7',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  bug: 'M8 8h8v8a4 4 0 0 1-8 0zM12 4v4M4 13h4M16 13h4M5 7l3 2M19 7l-3 2',
  pen: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  broom: 'M4 20l7-7M14 4l6 6-5 5-6-6zM3 21h6',
  fold: 'M4 6h16M4 12h10M4 18h6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  pr: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 15V8a2 2 0 0 0-2-2h-5M13 3l-2 3 2 3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  radar: 'M12 12l6-6M12 21a9 9 0 1 1 9-9M12 17a5 5 0 1 1 5-5',
  x: 'M6 6l12 12M18 6L6 18',
  window: 'M3 5h18v14H3zM3 9h18',
  crop: 'M6 2v14h14M2 6h14v14',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  back: 'M15 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  speaker: 'M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  muted: 'M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  resume: 'M4 4v6h6M20 20v-6h-6M20 10a8 8 0 0 0-14-4L4 10M4 14a8 8 0 0 0 14 4l2-4',
  seat: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  image: 'M3 5h18v14H3zM11 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM21 16l-5-5-8 8',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
};

export function Icon({ name, size = 22, stroke = 2 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.keys} />
    </svg>
  );
}

export function Play({ playing, size = 24 }: { playing: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'} />
    </svg>
  );
}

export function Skip({ dir, size = 20 }: { dir: 'next' | 'prev'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={dir === 'next' ? 'M16 5h2v14h-2zM4 5v14l11-7z' : 'M6 5h2v14H6zM20 5v14L9 12z'} />
    </svg>
  );
}
