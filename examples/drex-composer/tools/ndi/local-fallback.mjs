#!/usr/bin/env node
// local-fallback.mjs — offline chapter split, no API key needed.
//
//   node tools/ndi/local-fallback.mjs                 # all books
//   node tools/ndi/local-fallback.mjs --book prout-form
//   node tools/ndi/local-fallback.mjs --force          # overwrite an NDI-produced chapters.json too
//
// Reads context-pack/books/<slug>/text.txt (built by build-text.mjs, with "[p. N]" page
// markers), finds each chapter of the book's table of contents by its heading line, and
// writes context-pack/ndi/<slug>/chapters.json in the same shape ingest.mjs writes after an
// NDI Split, with "producedBy": "local-fallback". ingest.mjs replaces it with NDI's split when
// it runs with a key (or keeps it with --chapters local), and uses it for --dry-run.
// No dependencies. Node 24+.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKS, SLUGS, bookDir, ndiDir } from './books.mjs';
import { pageLabels } from './build-text.mjs';

const PAGE_MARK = /^\[(p\.|leaf) (\w+)\]$/;

/** printed page -> 1-based PDF page, from the archive.org page-number file (paged books only) */
export function printedToPdfPage(slug) {
  const b = BOOKS[slug];
  if (b.ndi.mode !== 'paged' || b.build.kind !== 'djvu-xml') return null;
  const pagesFile = join(bookDir(slug), b.build.pages);
  if (!existsSync(pagesFile)) return null;
  const leafCount = JSON.parse(readFileSync(pagesFile, 'utf8')).pages.length;
  const map = {};
  pageLabels(pagesFile, leafCount).forEach((label, i) => {
    const m = label.match(/^\[p\. (\d+)\]$/);
    if (m && !(m[1] in map)) map[m[1]] = i + 1;
  });
  return map;
}

/** split one book's text.txt into chapters; pure function of the text and the book config */
export function splitChapters(slug, text) {
  const b = BOOKS[slug];
  const lines = text.split('\n');
  // page of every line, and first line of every printed page
  const pageOf = new Array(lines.length);
  const firstLineOfPage = new Map();
  let cur = null;
  lines.forEach((line, i) => {
    const m = line.match(PAGE_MARK);
    if (m) { cur = m[1] === 'p.' ? m[2] : `leaf ${m[2]}`; if (!firstLineOfPage.has(cur)) firstLineOfPage.set(cur, i); }
    pageOf[i] = cur;
  });
  const markerLines = [...firstLineOfPage.values()].sort((x, y) => x - y);
  const nextMarkerAfter = (i, skip = 1) => { const later = markerLines.filter((m) => m > i); return later[skip - 1] ?? lines.length; };

  const starts = [];
  let prevStart = -1;
  for (const entry of b.toc) {
    const pageLine = firstLineOfPage.get(String(entry.page));
    if (pageLine == null) { starts.push({ entry, line: null, found: false }); continue; }
    const from = Math.max(pageLine, prevStart + 1);
    const to = nextMarkerAfter(pageLine, 2); // search this page and the next one
    const isRoman = /^[IVXL]+$/.test(entry.n);
    const re = isRoman ? b.chapterHeading : new RegExp(`^#*\\s*${entry.n.toUpperCase()}\\.?$`, 'i');
    let hit = null;
    for (let i = from; i < to; i++) if (re.test(lines[i].trim())) { hit = i; break; }
    const line = hit ?? from;
    starts.push({ entry, line, found: hit != null });
    prevStart = line;
  }

  const endLine = b.endPage != null && firstLineOfPage.has(String(b.endPage + 1)) ? firstLineOfPage.get(String(b.endPage + 1)) - 1 : lines.length - 1;
  const pdfMap = printedToPdfPage(slug);
  const chapters = [];
  starts.forEach((s, k) => {
    if (s.line == null) return;
    const next = starts.slice(k + 1).find((x) => x.line != null);
    let last = (next ? next.line : endLine + 1) - 1;
    while (last > s.line && (!lines[last].trim() || PAGE_MARK.test(lines[last]))) last--;
    const body = lines.slice(s.line, last + 1);
    const startPage = pageOf[s.line];
    const endPage = pageOf[last];
    const ch = {
      id: `ch-${String(k + 1).padStart(2, '0')}`,
      number: s.entry.n,
      title: s.entry.title,
      start_page: /^\d+$/.test(startPage) ? Number(startPage) : startPage,
      end_page: /^\d+$/.test(endPage) ? Number(endPage) : endPage,
      pdf_start_page: pdfMap ? pdfMap[startPage] ?? null : null,
      pdf_end_page: pdfMap ? pdfMap[endPage] ?? null : null,
      start_line: s.line + 1,
      end_line: last + 1,
      chars: body.join('\n').length,
      heading_found: s.found,
    };
    if (b.paragraphNumber) {
      ch.paragraph_pages = []; // filled below, once the whole book's numbering is known
    } else {
      // headed sections instead (Rimsky): "## Melody in stringed instruments."
      ch.sections = [];
      for (let i = s.line + 1; i <= last; i++) {
        const m = lines[i].match(/^(#{2,4}) (.+)$/);
        if (m) ch.sections.push({ level: m[1].length, title: m[2].replace(/\.$/, ''), page: /^\d+$/.test(pageOf[i]) ? Number(pageOf[i]) : pageOf[i], line: i + 1 });
      }
    }
    chapters.push(ch);
  });
  // Numbered paragraphs (§) run through the whole book. Collect every line that starts like
  // one, then keep the longest strictly increasing run of numbers: that drops OCR misreads
  // ("37." printed where 27 belongs) and numbered list items without losing what follows.
  if (b.paragraphNumber && chapters.length) {
    const cands = [];
    for (let i = chapters[0].start_line - 1; i <= chapters.at(-1).end_line - 1; i++) {
      const m = lines[i].match(b.paragraphNumber);
      if (m) cands.push({ line: i, n: Number(m[1]) });
    }
    const len = cands.map(() => 1), prev = cands.map(() => -1);
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      for (let j = 0; j < i; j++) if (cands[j].n < cands[i].n && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      if (best < 0 || len[i] > len[best]) best = i;
    }
    const keep = [];
    for (let i = best; i >= 0; i = prev[i]) keep.push(cands[i]);
    keep.reverse();
    for (const ch of chapters) {
      ch.paragraph_pages = keep
        .filter((c) => c.line >= ch.start_line - 1 && c.line <= ch.end_line - 1)
        .map((c) => [c.n, /^\d+$/.test(pageOf[c.line]) ? Number(pageOf[c.line]) : pageOf[c.line]]);
      ch.first_paragraph = ch.paragraph_pages[0]?.[0] ?? null;
      ch.last_paragraph = ch.paragraph_pages.at(-1)?.[0] ?? null;
    }
  }
  return chapters;
}

export function localChapters(slug) {
  const textPath = join(bookDir(slug), 'text.txt');
  if (!existsSync(textPath)) throw new Error(`${slug}: ${textPath} is missing — run node tools/ndi/build-text.mjs first`);
  const chapters = splitChapters(slug, readFileSync(textPath, 'utf8'));
  const b = BOOKS[slug];
  return {
    book: slug,
    title: b.title,
    producedBy: 'local-fallback',
    source: `context-pack/books/${slug}/text.txt`,
    pageNumbers: 'start_page/end_page are printed page numbers; pdf_* are 1-based pages of the scan PDF (null when the book has no scan)',
    chapters,
  };
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const i = args.indexOf('--book');
  const slugs = i >= 0 ? [args[i + 1]] : SLUGS;
  for (const slug of slugs) {
    if (!BOOKS[slug]) { console.error(`unknown book: ${slug} (known: ${SLUGS.join(', ')})`); process.exitCode = 1; continue; }
    const out = join(ndiDir(slug), 'chapters.json');
    if (existsSync(out) && !force) {
      const prev = JSON.parse(readFileSync(out, 'utf8'));
      if (prev.producedBy && prev.producedBy !== 'local-fallback') { console.log(`${slug}: chapters.json was produced by ${prev.producedBy} — kept (use --force to overwrite)`); continue; }
    }
    let doc;
    try { doc = localChapters(slug); } catch (err) { console.error(err.message); process.exitCode = 1; continue; }
    mkdirSync(ndiDir(slug), { recursive: true });
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
    const missed = doc.chapters.filter((c) => !c.heading_found).map((c) => c.number);
    console.log(`${slug}: ${doc.chapters.length}/${BOOKS[slug].toc.length} chapters -> ${out}` + (missed.length ? `  (heading not found, page start used: ${missed.join(', ')})` : ''));
    for (const c of doc.chapters) {
      const pars = c.first_paragraph != null ? `  §${c.first_paragraph}-${c.last_paragraph}` : c.sections ? `  ${c.sections.length} sections` : '';
      console.log(`    ${c.number.padEnd(12)} pp. ${String(c.start_page).padStart(3)}-${String(c.end_page).padEnd(3)} ${c.pdf_start_page != null ? `pdf ${c.pdf_start_page}-${c.pdf_end_page}` : ''}${pars}  ${c.title}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
