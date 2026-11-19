/**
 * Which characters the invoice PDF cannot show. The PDF embeds Roboto (engine.ts): Latin with every Central European
 * letter, Cyrillic and Greek. A character it has no glyph for – Arabic, Hebrew, Chinese, Japanese, Korean, Thai,
 * Georgian, Armenian, an emoji, signs like "→ ✓ ★ ℃ ㎡ ₴" – is printed as an empty box, also in a buyer's name.
 * missingGlyphs() names such characters, so they are reported before a document is issued (the service's validation).
 */
import { createRequire } from 'node:module';
import { fontFiles } from './engine.ts';

interface Face {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

let faces: Face[] | null | undefined;

/** Code points a text layout shows nothing for, with or without a glyph (Unicode Default_Ignorable_Code_Point). */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** The regular and the bold face (names and totals are printed bold); null when the font library cannot be loaded. */
function load(): Face[] | null {
  if (faces !== undefined) return faces;
  try {
    const require = createRequire(import.meta.url);
    // fontkit is the font library of pdfkit, the PDF writer under pdfmake: resolved from there, so it is the one the
    // PDF is made with, wherever the package manager put it.
    const fromPdfmake = createRequire(require.resolve('pdfmake/fonts/Roboto.js'));
    const fromPdfkit = createRequire(fromPdfmake.resolve('pdfkit'));
    const fontkit = fromPdfkit('fontkit') as { openSync(path: string): Face };
    const files = fontFiles();
    faces = [fontkit.openSync(files.normal), fontkit.openSync(files.bold)];
  } catch {
    faces = null; // the check is skipped: it must never stand in the way of a document
  }
  return faces;
}

/**
 * The distinct characters of `text` the PDF font has no glyph for, in the order they occur; control characters (line
 * breaks, tabs) and invisible format characters are layout, not ink. Empty when everything can be printed – or when
 * the font cannot be inspected.
 */
export function missingGlyphs(text: string): string[] {
  const fonts = load();
  if (!fonts || !text) return [];
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    // Not ink: control characters, and what the PDF's text layout hides (zero-width marks, direction marks and
    // overrides, variation selectors – the font library replaces them with a zero-width space).
    if (cp < 0x20 || cp === 0x7f || DEFAULT_IGNORABLE.test(ch)) continue;
    if (!fonts.every((f) => f.hasGlyphForCodePoint(cp))) missing.add(ch);
  }
  return [...missing];
}

/** "„株” (U+682A)": a character and its code point, for a message (the character itself may not show on a screen either). */
export function describeCharacter(ch: string): string {
  const cp = (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
  return `„${ch}” (U+${cp})`;
}
