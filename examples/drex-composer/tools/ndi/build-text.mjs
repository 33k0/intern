#!/usr/bin/env node
// build-text.mjs — turn the raw downloads in context-pack/books/<slug>/ into a
// cleaned, page-marked text.txt.
//
//   node tools/ndi/build-text.mjs            # all books
//   node tools/ndi/build-text.mjs prout-form # one book
//
// Output format of text.txt:
//   - one paragraph per line, blank line between paragraphs
//   - a line "[p. N]" before the text of each printed page (N is the printed
//     page number; "[leaf N]" when the scan has no printed number for that leaf)
//   - OCR'd music notation (lines with almost no real words) is dropped
// No dependencies. Node 24+.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOOKS, BOOKS_DIR } from './books.mjs';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', deg: '°', frac12: '½', times: '×', flat: '♭', sharp: '♯', natur: '♮' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => (n in ENT ? ENT[n] : m));
}

// ---------------------------------------------------------------- junk filter
const VOWEL = /[aeiouyAEIOUY]/;
function wordLike(tok) {
  const t = tok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (t.length < 3) return false;
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(t)) return false;
  if (!VOWEL.test(t)) return false;
  // mixed-case garbage such as "aLTeRnaTe" (allow Capitalised, ALLCAPS, lower)
  const inner = t.slice(1);
  if (/[A-Z]/.test(inner) && /[a-z]/.test(inner)) return false;
  return true;
}
/** true when an OCR line is real prose (or a heading) rather than notation debris */
export function isTextLine(line) {
  const s = line.trim();
  if (!s) return false;
  const chars = s.replace(/\s+/g, '');
  const letters = (chars.match(/[A-Za-z]/g) || []).length;
  const toks = s.split(/\s+/);
  const good = toks.filter(wordLike).length;
  if (/^(CHAPTER|Chapter|PART|DIVISION|SECTION|EXERCISE|Exercise|LESSON)\b/.test(s) && s.length < 80) return true;
  if (/^§?\s*\d{1,3}[.)]?$/.test(s)) return true; // bare paragraph / page number
  if (letters / chars.length < 0.6) return false;
  if (good === 0) return false;
  if (toks.length >= 4 && good / toks.length < 0.4) return false;
  if (toks.length <= 3 && good < 1) return false;
  return true;
}

// ---------------------------------------------------------------- djvu xml
function parseDjvuXml(xml) {
  const pages = [];
  const objRe = /<OBJECT\b[\s\S]*?<\/OBJECT>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const paras = [];
    const paraRe = /<PARAGRAPH>([\s\S]*?)<\/PARAGRAPH>/g;
    let p;
    while ((p = paraRe.exec(m[0]))) {
      const lines = [];
      const lineRe = /<LINE>([\s\S]*?)<\/LINE>/g;
      let l;
      while ((l = lineRe.exec(p[1]))) {
        const words = [...l[1].matchAll(/<WORD\b[^>]*>([\s\S]*?)<\/WORD>/g)].map((w) => decodeEntities(w[1]).trim());
        const line = words.join(' ').replace(/\s+/g, ' ').trim();
        if (line) lines.push(line);
      }
      if (lines.length) paras.push(lines);
    }
    pages.push(paras);
  }
  return pages;
}

export function pageLabels(pagesJsonPath, leafCount) {
  // archive.org page_numbers.json: [{leafNum, pageNumber}] — fill gaps by extrapolating
  // a constant leaf→page offset from the nearest numbered leaf (arabic numbers only).
  const meta = JSON.parse(readFileSync(pagesJsonPath, 'utf8')).pages;
  const nums = meta.map((p) => (/^\d+$/.test(p.pageNumber) ? Number(p.pageNumber) : null));
  const labels = [];
  for (let i = 0; i < leafCount; i++) {
    let n = nums[i] ?? null;
    if (n == null) {
      // nearest numbered leaf
      let best = null;
      for (let d = 1; d < leafCount && best == null; d++) {
        if (i + d < nums.length && nums[i + d] != null) best = nums[i + d] - d;
        else if (i - d >= 0 && nums[i - d] != null) best = nums[i - d] + d;
      }
      // extrapolate with the same offset, but never to a page number below 1
      const first = nums.findIndex((x) => x != null);
      if (best != null && best >= 1 && i >= first - (nums[first] - 1)) n = best;
    }
    labels.push(n != null ? `[p. ${n}]` : `[leaf ${meta[i]?.leafNum ?? i}]`);
  }
  return labels;
}

function reflow(lines) {
  // join the lines of one paragraph, undoing end-of-line hyphenation
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else if (/[A-Za-z]¬$/.test(out)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out.replace(/¬ /g, '').replace(/\s+/g, ' ').trim();
}

function buildFromDjvu(dir, cfg) {
  const pages = parseDjvuXml(readFileSync(join(dir, cfg.xml), 'utf8'));
  const labels = pageLabels(join(dir, cfg.pages), pages.length);
  const out = [];
  let kept = 0, dropped = 0;
  pages.forEach((paras, i) => {
    const body = [];
    for (const lines of paras) {
      const good = [];
      for (const line of lines) {
        if (cfg.runningHead && cfg.runningHead.test(line)) { dropped++; continue; }
        if (isTextLine(line)) { good.push(line); kept++; } else dropped++;
      }
      if (good.length) body.push(reflow(good));
    }
    // drop a leading/trailing bare page number (it is already in the marker)
    const num = labels[i].match(/\d+/)?.[0];
    if (body.length && body[0] === num) body.shift();
    if (body.length && body[body.length - 1] === num) body.pop();
    if (!body.length) return;
    out.push(labels[i], ...body);
  });
  return { text: out.join('\n\n') + '\n', stats: { leaves: pages.length, keptLines: kept, droppedLines: dropped } };
}

// ---------------------------------------------------------------- gutenberg html
function buildFromGutenbergHtml(dir, cfg) {
  let html = readFileSync(join(dir, cfg.html), 'utf8');
  const a = html.indexOf('*** START OF THE PROJECT GUTENBERG');
  const b = html.indexOf('*** END OF THE PROJECT GUTENBERG');
  html = html.slice(html.indexOf('>', a) + 1, html.lastIndexOf('<', b));
  // Volume II is only the list of musical examples (images) — keep Volume I text.
  const v2 = html.search(/<h2>\s*<a id="rimsky2"/);
  if (v2 > 0) html = html.slice(0, v2);
  html = html
    .replace(/<span class="pagenum">\s*<a id="Page_([^"]+)">[\s\S]*?<\/a>\s*<\/span>/g, (_, p) => `\n\n@@PAGE ${p}@@\n\n`)
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, (_, alt) => (alt && !/^(Table|\[|music|illustration)/i.test(alt) ? ` ${alt} ` : ' '))
    .replace(/\[<a [^>]*>Enlarge<\/a>\]/g, '')
    .replace(/<a [^>]*>\[Listen\]<\/a>/g, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<br\s*\/?>/g, ' ').replace(/\s+/g, ' ')}\n\n`)
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/g, ' | ')
    .replace(/<\/tr>/g, '\n\n')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<\/(p|div|li|table|blockquote|ul|ol)>/g, '\n\n')
    .replace(/<(p|div|li|table|blockquote|tr)\b[^>]*>/g, '\n\n')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(html)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^@@PAGE (\S+)@@$/);
      if (m) return /^\d+$/.test(m[1]) ? `[p. ${m[1]}]` : `[p. ${m[1]}]`;
      return p.replace(/^(#+) (.*)$/, '$1 $2');
    })
    .join('\n\n');
  return { text: text + '\n', stats: { pageMarkers: (text.match(/^\[p\. /gm) || []).length } };
}

// ---------------------------------------------------------------- main
function main() {
  const want = process.argv.slice(2);
  const slugs = want.length ? want : Object.keys(BOOKS);
  for (const slug of slugs) {
    const cfg = BOOKS[slug]?.build;
    if (!cfg) { console.error(`unknown book: ${slug}`); process.exitCode = 1; continue; }
    const dir = join(BOOKS_DIR, slug);
    const raw = join(dir, cfg.kind === 'djvu-xml' ? cfg.xml : cfg.html);
    if (!existsSync(raw)) { console.error(`${slug}: missing raw file ${raw}`); process.exitCode = 1; continue; }
    const { text, stats } = cfg.kind === 'djvu-xml' ? buildFromDjvu(dir, cfg) : buildFromGutenbergHtml(dir, cfg);
    writeFileSync(join(dir, 'text.txt'), text);
    console.log(`${slug}: text.txt ${text.length} chars`, JSON.stringify(stats));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
