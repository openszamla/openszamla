/**
 * Small inline SVG icons of the web UI (no external assets – the program works offline). Always shown next
 * to a text label, never as the only carrier of meaning: aria-hidden, drawn with currentColor.
 */
import { trustedConstant, type SafeHtml } from './html.ts';

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4 18-7z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 3 2 21h20L12 3zM12 10v5M12 18h.01',
  x: 'M6 6l12 12M18 6 6 18',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  back: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6',
} as const;

export type IconName = keyof typeof PATHS;

const CACHE = new Map<IconName, SafeHtml>();

/** `<svg class="i">` with the icon (constant markup). */
export function icon(name: IconName): SafeHtml {
  let svg = CACHE.get(name);
  if (!svg) {
    svg = trustedConstant(
      `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`,
    );
    CACHE.set(name, svg);
  }
  return svg;
}
