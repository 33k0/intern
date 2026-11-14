// What Drex was given: the four source books and the rules each kind of decision receives.
// Used by the local server (/api/theory) and written out as static files for the Vercel build.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pack, ROOT } from './pack.ts';

const BOOKS = join(ROOT, 'context-pack/books');
const NDI = join(ROOT, 'context-pack/ndi');
interface BookSource { slug: string; title: string; author: string; year: number; sourceUrl?: string; files?: Record<string, string> }
function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
export function bookSources(): BookSource[] {
  return readJsonFile<{ books: BookSource[] }>(join(BOOKS, 'sources.json'))?.books ?? [];
}
/** The file a reader should open: the scan PDF when there is one, else the HTML transcription. */
export function bookFile(b: BookSource): string | null {
  const names = Object.keys(b.files ?? {});
  const name = names.find((n) => n.endsWith('.pdf')) ?? names.find((n) => n.endsWith('.html'));
  return name && existsSync(join(BOOKS, b.slug, name)) ? name : null;
}
/** Full path of a book's readable file, or null. */
export function bookPath(slug: string): string | null {
  const book = bookSources().find((b) => b.slug === slug);
  const file = book && bookFile(book);
  return book && file ? join(BOOKS, book.slug, file) : null;
}
/** Printed page -> page of the scan PDF, from the chapter table. Null when the book has no scan. */
function pdfPage(slug: string, printed: number): number | null {
  const chapters = readJsonFile<{ chapters: { start_page: number; end_page: number; pdf_start_page: number | null }[] }>(join(NDI, slug, 'chapters.json'))?.chapters ?? [];
  const ch = chapters.find((c) => printed >= c.start_page && printed <= c.end_page && c.pdf_start_page !== null);
  return ch ? ch.pdf_start_page! + (printed - ch.start_page) : null;
}

/** `bookUrl` says where a book's file is served: an API route locally, a static file on Vercel. */
export function theoryData(styleId: string | undefined, bookUrl: (slug: string, file: string) => string) {
  const style = pack.sheets.find((s) => s.id === styleId)?.id;
  const books = bookSources().map((b) => {
    const file = bookFile(b);
    // What NDI has really produced for this book: only a completed extract counts.
    const extract = readJsonFile<{ producedBy?: string; rules?: unknown[] }>(join(NDI, b.slug, 'rules.json'));
    const state = readJsonFile<{ parseJobId?: string; classify?: Record<string, unknown> }>(join(NDI, b.slug, 'state.json'));
    const ndi = extract?.producedBy === 'ndi-extract' && state?.parseJobId
      ? { parsed: true, chapters: Object.keys(state.classify ?? {}).length, rules: extract.rules?.length ?? 0 }
      : null;
    return {
      slug: b.slug, title: b.title.split(/[:,]/)[0], author: b.author, year: b.year,
      url: file ? bookUrl(b.slug, file) : b.sourceUrl ?? null, pdf: !!file?.endsWith('.pdf'),
      rulesInPack: pack.rules.filter((r) => r.source?.book === b.slug).length, ndi,
    };
  });
  const slices: Record<string, { text: string; book: string | null; ref: string | null; page: number | null }[]> = {};
  for (const type of pack.sliceTypes()) {
    slices[type] = pack.slice(type, style).map((r) => {
      const printed = Number(/p\.\s*(\d+)/.exec(r.source?.ref ?? '')?.[1]);
      return {
        text: r.text, book: r.source?.book ?? null, ref: r.source?.ref ?? null,
        page: r.source && Number.isFinite(printed) ? pdfPage(r.source.book, printed) : null,
      };
    });
  }
  return { books, slices };
}
