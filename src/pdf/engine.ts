/**
 * pdfmake 0.3 (server build) wrapper.
 *
 * - Font: Roboto bundled with pdfmake (full Hungarian coverage: ő ű Ő Ű), embedded as a subset.
 * - No network: the URL access policy rejects every URL, so no image/font/attachment is ever downloaded.
 * - No file access except the bundled font files (local access policy).
 *
 * pdfmake exports a process-wide singleton; fonts and policies are (re)applied right before every
 * createPdf() call – createPdf() captures them synchronously, so concurrent renders cannot interfere.
 */
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import pdfmake from 'pdfmake';

/** pdfmake document definition (TDocumentDefinitions of @types/pdfmake). */
export type DocDefinition = Parameters<typeof pdfmake.createPdf>[0];

const require = createRequire(import.meta.url);

/** Directory of the Roboto TTF files shipped with pdfmake (node_modules/pdfmake/fonts/Roboto). */
export const FONT_DIR: string = join(dirname(require.resolve('pdfmake/fonts/Roboto.js')), 'Roboto');

/** Roboto font family as used by pdfmake's own Roboto.js (Medium = bold). */
export function fontFiles(): { normal: string; bold: string; italics: string; bolditalics: string } {
  return {
    normal: join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: join(FONT_DIR, 'Roboto-Medium.ttf'),
    italics: join(FONT_DIR, 'Roboto-Italic.ttf'),
    bolditalics: join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
  };
}

/** URL access policy: nothing may be fetched while rendering. */
export function urlAccessPolicy(url: string): boolean {
  void url;
  return false;
}

/** Local access policy: only files inside the bundled font directory may be read. */
export function localAccessPolicy(path: string): boolean {
  const rel = relative(FONT_DIR, resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function configure(): void {
  pdfmake.setUrlAccessPolicy(urlAccessPolicy);
  pdfmake.setLocalAccessPolicy(localAccessPolicy);
  // A fresh descriptor object every time: pdfmake rewrites the descriptor entries while resolving them.
  pdfmake.setFonts({ Roboto: fontFiles() });
}

/** Renders a pdfmake document definition to a PDF buffer (the definition is consumed – build a fresh one per call). */
export async function renderPdfBuffer(doc: DocDefinition): Promise<Buffer> {
  configure();
  return pdfmake.createPdf(doc).getBuffer();
}
