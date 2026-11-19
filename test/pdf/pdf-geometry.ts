/**
 * Test helper: where text runs and filled rectangles end up on the pages of a PDF written by pdfkit
 * (pdfmake's backend), so layout tests can assert that nothing leaves the content box and that
 * neighbouring amounts are visibly apart. Text pushed off the page is still in the content stream
 * (and in the extracted text) – it is only invisible – so text extraction alone cannot catch it.
 *
 * Reads exactly what pdfkit emits: page content streams (FlateDecode), one operator per line,
 * `x y w h re` rectangles, text as `BT 1 0 0 1 x y Tm /Fn size Tf [c Tc] [<cids> kern …] TJ ET`, and
 * Type0 / Identity-H fonts with a single `/W [0 [w0 w1 …]]` width array and a ToUnicode CMap made of
 * `<first> <last> [<u0> <u1> …]` ranges. Text drawn in a rotated coordinate system (the draft
 * watermark) is skipped. Every pdfmake inline (a word, or a whole amount) becomes one text box.
 */
import { inflateSync } from 'node:zlib';

export interface Box {
  kind: 'text' | 'rect';
  page: number;
  /** Left / right edge in PDF points from the left page edge. */
  x0: number;
  x1: number;
  /** Baseline (text) or top edge (rect) in PDF points from the top of the page. */
  y: number;
  /** Decoded text of a text box (U+00A0 kept), '' for rectangles. */
  text: string;
}

interface PdfObject {
  body: string;
  /** Offset of `body` in the file. */
  start: number;
}

function streamOf(pdf: Buffer, obj: PdfObject | undefined): string {
  if (!obj) return '';
  const s = obj.body.indexOf('stream');
  if (s < 0) return '';
  const from = obj.start + s + obj.body.slice(s).search(/\n/) + 1;
  const data = pdf.subarray(from, obj.start + obj.body.lastIndexOf('endstream'));
  return (/\/FlateDecode/.test(obj.body.slice(0, s)) ? inflateSync(data) : data).toString('latin1');
}

/** CID → text from a ToUnicode CMap. */
function toUnicodeMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexText = (h: string): string => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map((u) => parseInt(u, 16)));
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const first = parseInt(r[1] ?? '0', 16);
      const last = parseInt(r[2] ?? '0', 16);
      const target = r[3] ?? '';
      if (target.startsWith('[')) {
        [...target.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((u, i) => map.set(first + i, hexText(u[1] ?? '')));
      } else {
        const base = parseInt(target.slice(1, -1), 16);
        for (let cid = first; cid <= last; cid++) map.set(cid, String.fromCodePoint(base + cid - first));
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const c of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(c[1] ?? '0', 16), hexText(c[2] ?? ''));
    }
  }
  return map;
}

export function pdfBoxes(pdf: Buffer): Box[] {
  const src = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  for (const m of src.matchAll(/(\d+) 0 obj\b([\s\S]*?)\bendobj/g)) {
    const body = m[2] ?? '';
    objects.set(Number(m[1]), { body, start: m.index + m[0].length - 'endobj'.length - body.length });
  }
  const body = (id: number): string => objects.get(id)?.body ?? '';
  const ref = (text: string, key: string): number => Number(new RegExp(`/${key}\\s*\\[?\\s*(\\d+) 0 R`).exec(text)?.[1] ?? -1);

  // font resource name (F1, F2 …) → CID advance widths (1/1000 em) and CID → text
  const fonts = new Map<string, { widths: number[]; chars: Map<number, string> }>();
  for (const dict of src.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
    for (const f of (dict[1] ?? '').matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
      const type0 = body(Number(f[2]));
      const w = /\/W\s*\[\s*0\s*\[([^\]]*)\]/.exec(body(ref(type0, 'DescendantFonts')));
      fonts.set(f[1] ?? '', {
        widths: (w?.[1] ?? '').trim().split(/\s+/).map(Number),
        chars: toUnicodeMap(streamOf(pdf, objects.get(ref(type0, 'ToUnicode')))),
      });
    }
  }

  // pages in document order: /Kids of the page tree root
  const kids = /\/Type \/Pages[\s\S]*?\/Kids \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  const pageIds = [...kids.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));

  const boxes: Box[] = [];
  pageIds.forEach((pageId, pageIndex) => {
    const page = pageIndex + 1;
    const height = Number(/\/MediaBox \[\s*\S+ \S+ \S+ (\S+)\s*\]/.exec(body(pageId))?.[1] ?? 0);
    const rotated: boolean[] = [false];
    let x = 0;
    let y = 0;
    let font = '';
    let size = 0;
    let tc = 0;
    for (const line of streamOf(pdf, objects.get(ref(body(pageId), 'Contents'))).split('\n')) {
      const op = line.trim();
      let m: RegExpExecArray | null;
      if (op === 'q') rotated.push(rotated.at(-1) ?? false);
      else if (op === 'Q') rotated.pop();
      else if ((m = /^\S+ (\S+) (\S+) \S+ \S+ \S+ cm$/.exec(op))) {
        if (Number(m[1]) !== 0 || Number(m[2]) !== 0) rotated[rotated.length - 1] = true;
      } else if (op === 'BT') tc = 0;
      else if ((m = /^\S+ \S+ \S+ \S+ (\S+) (\S+) Tm$/.exec(op))) [x, y] = [Number(m[1]), height - Number(m[2])];
      else if ((m = /^\/(F\d+) (\S+) Tf$/.exec(op))) [font, size] = [m[1] ?? '', Number(m[2])];
      else if ((m = /^(\S+) Tc$/.exec(op))) tc = Number(m[1]);
      else if ((m = /^\[(.*)\] TJ$/.exec(op))) {
        if (rotated.at(-1)) continue;
        const f = fonts.get(font);
        let width = 0;
        let text = '';
        for (const part of (m[1] ?? '').matchAll(/<([0-9a-fA-F]*)>|(-?[\d.]+)/g)) {
          if (part[1] === undefined) {
            width -= (Number(part[2]) / 1000) * size;
            continue;
          }
          for (let i = 0; i + 4 <= part[1].length; i += 4) {
            const cid = parseInt(part[1].slice(i, i + 4), 16);
            width += ((f?.widths[cid] ?? 0) / 1000) * size + tc;
            text += f?.chars.get(cid) ?? '�';
          }
        }
        boxes.push({ kind: 'text', page, x0: x, x1: x + width, y, text });
      } else if ((m = /^(\S+) (\S+) (\S+) \S+ re$/.exec(op))) {
        if (rotated.at(-1)) continue;
        // pdfkit draws in a y-down system (1 0 0 -1 0 h cm): the rectangle's y is its top edge
        boxes.push({ kind: 'rect', page, x0: Number(m[1]), x1: Number(m[1]) + Number(m[3]), y: Number(m[2]), text: '' });
      }
    }
  });
  return boxes;
}

/**
 * Boxes that leave the horizontal content area [left, right]. `tolerance` absorbs the trailing space
 * pdfmake leaves at the end of a full line (it is drawn, though not counted for line breaking).
 */
export function outsideContentBox(boxes: Box[], left: number, right: number, tolerance = 4): Box[] {
  return boxes.filter((b) => b.x0 < left - 0.5 || b.x1 > right + tolerance);
}

/** Text boxes on the same page and baseline, left to right. */
export function textRows(boxes: Box[]): Box[][] {
  const rows = new Map<string, Box[]>();
  for (const b of boxes) {
    if (b.kind !== 'text') continue;
    const key = `${b.page}:${b.y.toFixed(1)}`;
    rows.set(key, [...(rows.get(key) ?? []), b]);
  }
  return [...rows.values()].map((r) => r.sort((a, b) => a.x0 - b.x0));
}
