#!/usr/bin/env node
// ingest.mjs — re-derive the theory digest from the books with NDI (Nace Document Intelligence).
//
//   NACE_API_KEY=nace_sk_... node tools/ndi/ingest.mjs --book goetschius-melody
//   NACE_API_KEY=nace_sk_... node tools/ndi/ingest.mjs --all
//   node tools/ndi/ingest.mjs --all --dry-run            # no key needed: prints the requests
//
// Pipeline per book:  upload -> parse -> split by chapter -> classify by topic -> extract rules
//                     -> keep page references -> merge into context-pack/digest.ndi.json
// Outputs: context-pack/ndi/<slug>/{parse.json,chapters.json,rules.json} (+ state.json with the
// upload and job ids, so a re-run resumes instead of repeating paid work).
//
// Request and response shapes follow https://console.nace.ai/docs/perception/* as read on
// 2026-11-14. Every place where those pages do not settle the behaviour is marked
// "DOCS-UNVERIFIED:" — grep for it before the first paid run. This script has never been run
// against the live API (no key was available when it was written).
//
// Plain Node 24 ESM, no dependencies.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BOOKS, SLUGS, PACK, bookDir, ndiDir } from './books.mjs';
import { pageLabels } from './build-text.mjs';
import { localChapters, splitChapters, printedToPdfPage } from './local-fallback.mjs';
import { TOPICS, CALLS, MAX_WORDS, wordCount, ruleErrors } from './check-digest.mjs';

const BASE_URL = (process.env.NACE_BASE_URL || 'https://console.nace.ai').replace(/\/$/, '');
const STEPS = ['upload', 'parse', 'split', 'classify', 'extract', 'merge'];

// ------------------------------------------------------------------ what we ask NDI for

const TOPIC_CLASSES = [
  ['melody', 'Melody', 'How to write a single melodic line: steps and leaps, scale-degree tendencies, rhythm of the line, embellishing tones, melodic climax.'],
  ['phrase_structure', 'Phrase structure', 'Length and balance of phrases, sentences and periods; opening and answering phrases; extending, contracting or overlapping phrases.'],
  ['cadences', 'Cadences', 'Kinds of cadence (perfect, half, deceptive, plagal), where each belongs and how strong a close it makes.'],
  ['tension_release', 'Tension and release', 'Dissonance and its resolution, suspensions, deferring or weakening a close, anything that raises or relaxes tension.'],
  ['developing_variation', 'Developing variation', 'Building music from a motive: repetition, sequence, inversion, augmentation, diminution, fragmentation, varying a figure.'],
  ['departure_return', 'Departure and return', 'Key relationships, leaving the home key or theme and coming back, retransitions, how a return is prepared or varied.'],
  ['voice_leading', 'Voice leading', 'How the voices of a chord progression move: common tones, parallels, doubling, spacing, resolution of individual voices.'],
  ['harmony', 'Harmony', 'Chord choice and function, seventh/ninth/altered/chromatic chords, modulation technique, pedal points, harmonic sequences.'],
  ['orchestration', 'Orchestration', 'Character of instruments by register, doubling, balance, melody versus accompaniment, use of strings, woodwind, brass, harp, percussion, tutti.'],
  ['dynamics_pacing', 'Dynamics and pacing', 'Crescendo and diminuendo, where climaxes go, building and releasing over time, pauses, how a piece ends.'],
  ['form', 'Form', 'The plan of a whole piece: binary and ternary form, episodes, codas, introductions, proportions of sections.'],
].map(([id, label, description]) => ({ id, label, description }));

// Split classes. One class for chapters; `instance_key` is the documented way to tell one
// document of a class from the next, which is what separates Chapter IV from Chapter V.
const SPLIT_CLASSES = [
  {
    id: 'chapter',
    label: 'Chapter',
    description: 'One numbered chapter of the book, from its chapter heading up to the next chapter heading.',
    instance_key: { name: 'chapter_heading', description: 'The chapter number and title exactly as printed in its heading, e.g. "CHAPTER XII. Melodic Syntax, continued".', required: true },
  },
  { id: 'front_matter', label: 'Front matter', description: 'Title page, library stamps, preface, table of contents, introduction before the first chapter.' },
  { id: 'back_matter', label: 'Back matter', description: 'Index, appendix, publisher advertisements and blank pages after the last chapter.' },
];
const SPLIT_RULES = 'This is one book, not a packet of separate documents. Start a new segment at every chapter heading (a line such as "CHAPTER IV" followed by the chapter title). Running page headers are not chapter headings. Everything before the first chapter is front matter; the index and advertisements at the end are back matter.';

// Extract schema. Only keywords the docs list as supported are used (type, properties, items,
// required, description, enum, additionalProperties:false, maxItems on a root-level array).
const RULES_PER_UNIT = 12;
const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      maxItems: RULES_PER_UNIT,
      description: 'The distinct practical rules of composition this passage teaches. Leave empty if it teaches none (exercises, analyses of single pieces, history, notation).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'topic'],
        properties: {
          text: { type: 'string', description: `One rule, rewritten as a single imperative sentence of at most ${MAX_WORDS} words in plain modern English. Self-contained: no notation, no figure or example numbers, no author names, no cross-references.` },
          topic: { type: 'string', enum: TOPICS, description: 'The one topic the rule belongs to.' },
          section: { type: 'string', description: 'The printed paragraph or section number the rule comes from, digits only (for example "34"). Empty string if the passage is not numbered.' },
          calls: { type: 'array', items: { type: 'string', enum: CALLS }, description: 'Which composing decisions the rule helps with: setup (key, metre, tempo, form), plan (sections, climaxes, key scheme), theme_draft (next note of a theme), theme_judge, phrase_direction (how the next phrase develops and ends), voice_leading (chords and part movement), phrase_judge, orchestration, hold (pauses, long notes, pedals), ending.' },
        },
      },
    },
  },
};
const ruleInstructions = (book, chapter, topics) =>
  `This is part of "${book.title}" by ${book.author}` + (chapter ? `, chapter ${chapter.number} (${chapter.title})` : '') + '. ' +
  'Extract rules a composer can act on when choosing between options (which note next, which transformation of a motive, which chord, which instrument, how a phrase should end). ' +
  'Prefer rules that say when to do something and what it achieves over definitions. State only what the passage says. ' +
  (topics?.length ? `The passage is mostly about: ${topics.join(', ')}. ` : '') +
  'Modernise period terms (semicadence = half cadence, organ-point = pedal point, kettle-drums = timpani).';

// Used when Extract returns no usable `calls` for a rule.
const DEFAULT_CALLS = {
  melody: ['theme_draft', 'theme_judge'], phrase_structure: ['phrase_direction', 'phrase_judge'], cadences: ['phrase_direction', 'ending'],
  tension_release: ['phrase_direction', 'hold'], developing_variation: ['phrase_direction'], departure_return: ['plan', 'phrase_direction'],
  voice_leading: ['voice_leading'], harmony: ['voice_leading'], orchestration: ['orchestration'], dynamics_pacing: ['plan', 'ending'], form: ['plan', 'setup'],
};

// ------------------------------------------------------------------ small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const log = (...a) => console.log(...a);
const ROMAN = { I: 1, V: 5, X: 10, L: 50 };
const romanToInt = (r) => [...r].reduce((acc, c, i, a) => acc + (ROMAN[c] < (ROMAN[a[i + 1]] ?? 0) ? -ROMAN[c] : ROMAN[c]), 0);

function parseArgs(argv) {
  const o = { books: [], dryRun: false, force: false, verbose: false, chapters: 'ndi', parseMode: 'low', source: 'upload', steps: STEPS, window: 12, limit: Infinity, concurrency: 3, timeout: 1800 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (argv[i + 1] == null) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--book') o.books.push(val());
    else if (a === '--all') o.books = [...SLUGS];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--chapters') o.chapters = val();
    else if (a === '--parse-mode') o.parseMode = val();
    else if (a === '--source') o.source = val();
    else if (a === '--steps') o.steps = val().split(',');
    else if (a === '--window') o.window = Number(val());
    else if (a === '--limit') o.limit = Number(val());
    else if (a === '--concurrency') o.concurrency = Number(val());
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else fail(`unknown argument ${a}`);
  }
  if (!o.books.length) { usage(); fail('choose a book with --book <slug> or use --all'); }
  for (const b of o.books) if (!BOOKS[b]) fail(`unknown book "${b}" (known: ${SLUGS.join(', ')})`);
  for (const s of o.steps) if (!STEPS.includes(s)) fail(`unknown step "${s}" (known: ${STEPS.join(', ')})`);
  if (!['ndi', 'local'].includes(o.chapters)) fail('--chapters must be ndi or local');
  if (!['low', 'medium', 'high'].includes(o.parseMode)) fail('--parse-mode must be low, medium or high');
  if (!['upload', 'url'].includes(o.source)) fail('--source must be upload or url');
  return o;
}
function usage() {
  log(`usage: node tools/ndi/ingest.mjs (--book <slug> | --all) [options]

  --dry-run            print every request that would be sent; needs no API key, writes nothing
  --force              redo steps even when their output exists (sends fresh idempotency keys)
  --steps a,b,c        run only these steps (${STEPS.join(', ')})
  --chapters ndi|local chapter boundaries from NDI Split (default) or from local-fallback.mjs
  --parse-mode M       low (default), medium or high (high costs twice as much per page)
  --source upload|url  upload the local file (default) or let NDI download the archive.org PDF
  --window N           pages per classify/extract unit inside a chapter (default 12)
  --limit N            only the first N units of each book (cheap trial run)
  --concurrency N      jobs in flight at once (default 3)
  --timeout S          seconds to wait for one job (default 1800)
  --verbose            in a dry run, print every per-unit request instead of the first of each kind

books: ${SLUGS.join(', ')}
env:   NACE_API_KEY (required unless --dry-run), NACE_BASE_URL (default https://console.nace.ai)`);
}
function fail(msg) { console.error(`ingest: ${msg}`); process.exit(1); }

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ------------------------------------------------------------------ HTTP with retries

class ApiError extends Error {
  constructor(status, body, what) {
    const e = body?.error ?? {};
    super(`${what}: HTTP ${status}${e.code ? ` ${e.code}` : ''}${e.message ? ` — ${e.message}` : ''}${body?.request_id ? ` (request ${body.request_id})` : ''}`);
    this.status = status; this.code = e.code; this.retryable = e.retryable; this.body = body;
  }
}

function makeClient(opts) {
  const key = process.env.NACE_API_KEY;
  let dryCounter = 0;

  /** fetch with retry on network errors, 408, 429 and 5xx, waiting Retry-After seconds when given */
  async function send(what, url, init, { maxAttempts = 6 } = {}) {
    for (let attempt = 1; ; attempt++) {
      let res, body, text;
      try {
        res = await fetch(url, typeof init === 'function' ? init() : init);
        text = await res.text();
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      } catch (err) {
        if (attempt >= maxAttempts) throw new Error(`${what}: network error after ${attempt} attempts — ${err.message}`);
        const wait = Math.min(60, 2 ** attempt) + Math.random();
        log(`  ${what}: network error (${err.message}); retry ${attempt}/${maxAttempts - 1} in ${wait.toFixed(0)}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.ok) return { status: res.status, body, headers: res.headers };
      const transient = res.status === 408 || res.status === 429 || res.status >= 500;
      // the error envelope's `retryable: false` means the same request can never succeed
      if (!transient || body?.error?.retryable === false || attempt >= maxAttempts) throw new ApiError(res.status, body, what);
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : Math.min(60, 2 ** attempt) + Math.random();
      log(`  ${what}: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}; retry ${attempt}/${maxAttempts - 1} in ${wait.toFixed(0)}s${Number.isFinite(ra) && ra > 0 ? ' (Retry-After)' : ''}`);
      await sleep(wait * 1000);
    }
  }

  function printRequest(what, method, url, headers, body, note) {
    log(`\n# ${what}${note ? `  — ${note}` : ''}`);
    log(`${method} ${url}`);
    for (const [k, v] of Object.entries(headers)) log(`${k}: ${v}`);
    if (body !== undefined) log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }

  /** JSON call to the Drex API. Creates carry an Idempotency-Key so a retry can never bill twice. */
  async function api(what, method, path, { body, idemParts, query, quiet } = {}) {
    const url = `${BASE_URL}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const headers = { Authorization: `Bearer ${key ?? '$NACE_API_KEY'}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idemParts) {
      // The docs: a replay under the same key ignores later body changes, so the key carries a
      // hash of the body. --force adds a nonce so a failed or stale job is not replayed.
      const nonce = opts.force ? `-${Date.now().toString(36)}` : '';
      headers['Idempotency-Key'] = `drexc-${idemParts.join('-')}-${sha(JSON.stringify(body)).slice(0, 16)}${nonce}`.slice(0, 200);
    }
    if (opts.dryRun) {
      if (!quiet) printRequest(what, method, url, { ...headers, Authorization: 'Bearer $NACE_API_KEY' }, body);
      return { status: 0, body: null, headers: new Headers(), dry: ++dryCounter };
    }
    return send(what, url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** poll GET /v1/documents/jobs/{id} until succeeded / failed / cancelled */
  async function waitJob(what, job) {
    const started = Date.now();
    let delay = 1000;
    while (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      if ((Date.now() - started) / 1000 > opts.timeout) throw new Error(`${what}: job ${job.job_id} still ${job.status} after ${opts.timeout}s — re-run later to resume (the job keeps running)`);
      await sleep(delay);
      delay = Math.min(10000, delay * 2);
      job = (await api(`${what} (poll)`, 'GET', `/v1/documents/jobs/${job.job_id}`)).body;
      if (opts.verbose && job.progress) log(`  ${what}: ${job.status} ${job.progress.stage ?? ''} ${job.progress.units_done ?? '?'}/${job.progress.units_total ?? '?'}`);
    }
    if (job.status !== 'succeeded') throw new Error(`${what}: job ${job.job_id} ${job.status}${job.error ? ` — ${job.error.code}: ${job.error.message}` : ''}`);
    if (job.result == null) throw new Error(`${what}: job ${job.job_id} succeeded but its result is ${job.result_state ?? 'missing'} (expired or not retained) — re-run with --force`);
    return job;
  }

  /** create a document job (parse/split/classify/extract) and wait for it */
  async function runTool(what, tool, body, idemParts) {
    const res = await api(what, 'POST', `/v1/documents/${tool}`, { body, idemParts, query: { wait_seconds: 60 } });
    if (opts.dryRun) return { job_id: `<${idemParts.slice(1).join(' ')} job_id>`, status: 'dry-run', result: null };
    return waitJob(what, res.body);
  }

  /** read a job that an earlier run created (resume) */
  async function getJob(what, jobId) {
    const res = await api(what, 'GET', `/v1/documents/jobs/${jobId}`);
    return waitJob(what, res.body);
  }

  /** upload one file: grant -> multipart POST straight to the document service */
  async function upload(what, { path, bytes, fileName, contentType }) {
    const grant = await api(`${what}: upload grant`, 'POST', '/v1/documents/upload-grants', { body: { path, ttl_seconds: 900 } });
    const metadata = JSON.stringify({ path, total_size_bytes: bytes?.length ?? 0, on_conflict: 'new_version' });
    if (opts.dryRun) {
      printRequest(`${what}: upload the file`, 'POST', '<upload_url from the grant>', { 'X-Upload-Token': '<token from the grant>', 'Content-Type': 'multipart/form-data' }, `file=@${fileName}   (${bytes ? `${bytes.length} bytes` : 'built at run time'})\nmetadata=${metadata}`, 'goes straight to the document service, no Authorization header');
      return { workspace_id: '<workspace_id from the grant>', file_id: `<file_id of ${fileName}>`, path };
    }
    const { workspace_id, upload_url, token } = grant.body;
    const res = await send(`${what}: upload`, upload_url, () => {
      // rebuilt on every attempt: a FormData body cannot be re-read after a failed send
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), fileName);
      form.append('metadata', metadata); // a text field holding JSON, as the docs require
      return { method: 'POST', headers: { 'X-Upload-Token': token }, body: form };
    }, { maxAttempts: 1 }); // a grant works once, so a failed upload needs a new grant: no blind retry
    let job = res.body;
    // DOCS-UNVERIFIED: the docs say the upload "answers with a job that carries the file under
    // result.file" but not whether that job can still be queued/running for a one-request
    // upload. If it is, poll it like any other job.
    if (!job?.result?.file && job?.job_id && !['succeeded', 'failed', 'cancelled'].includes(job.status)) job = await waitJob(`${what}: upload`, job);
    const file_id = job?.result?.file?.file_id;
    if (!file_id) throw new Error(`${what}: upload answered without result.file.file_id: ${JSON.stringify(job).slice(0, 300)}`);
    return { workspace_id, file_id, path, deduplicated: job.result.deduplicated === true };
  }

  /** follow a document.content_url for a result that was too large to return inline */
  async function fetchContent(what, url) {
    for (let i = 0; i < 60; i++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 200) return res.text();
      if (res.status === 202) { await sleep((Number(res.headers.get('retry-after')) || 5) * 1000); continue; }
      throw new Error(`${what}: content_url answered HTTP ${res.status}`);
    }
    throw new Error(`${what}: content_url still pending`);
  }

  return { api, runTool, getJob, upload, fetchContent, hasKey: Boolean(key) };
}

// ------------------------------------------------------------------ page helpers

/** 1-based PDF page -> printed page number (or null), from the archive.org page-number file */
function pdfToPrinted(slug) {
  const b = BOOKS[slug];
  if (b.ndi.mode !== 'paged') return null;
  const pagesFile = join(bookDir(slug), b.build.pages);
  if (!existsSync(pagesFile)) return null;
  const n = readJson(pagesFile).pages.length;
  return [null, ...pageLabels(pagesFile, n).map((l) => { const m = l.match(/^\[p\. (\d+)\]$/); return m ? Number(m[1]) : null; })];
}

/** split NDI markdown at the documented "--- Page N ---" markers -> Map(pdf page -> text) */
function pagesOfMarkdown(md) {
  const pages = new Map();
  if (!md) return pages;
  // DOCS-UNVERIFIED: the docs say the marker "--- Page N ---" is inserted *between* PDF pages
  // and do not say whether N names the page that follows (assumed here) or the one before,
  // nor whether page 1 gets a marker. Text before the first marker is taken as page 1.
  const parts = md.split(/^\s*-{3}\s*Page (\d+)\s*-{3}\s*$/m);
  if (parts[0].trim()) pages.set(1, parts[0]);
  for (let i = 1; i < parts.length; i += 2) pages.set(Number(parts[i]), (pages.get(Number(parts[i])) ?? '') + parts[i + 1]);
  return pages;
}
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function formatRef(slug, { chapter, section, page, heading }) {
  const sec = section && /^\d{1,3}[a-z]?$/.test(section) ? section : null;
  switch (slug) {
    case 'goetschius-melody': return `${sec ? `par. ${sec}, ` : `Ch. ${chapter.number}, `}p. ${page}`;
    case 'prout-form': return `${sec ? `§ ${sec}, ` : `Ch. ${chapter.number}, `}p. ${page}`;
    case 'tchaikovsky-harmony': return `${/^[IVXL]+$/.test(chapter.number) ? `Ch. ${chapter.number}` : chapter.number}, ${sec ? `§ ${sec}, ` : ''}p. ${page}`;
    default: return `Ch. ${chapter.number}, ${heading ? `"${heading}", ` : ''}p. ${page}`;
  }
}

// ------------------------------------------------------------------ pipeline steps

async function stepUpload(ctx) {
  const { slug, book, state, client, opts } = ctx;
  if (opts.source === 'url' && book.ndi.url) {
    ctx.source = { type: 'url', url: book.ndi.url, file_name: basename(book.ndi.file) };
    log(`[${slug}] upload: skipped, NDI downloads ${book.ndi.url}`);
    return;
  }
  if (state.upload && !opts.force) { ctx.source = { type: 'workspace_file', workspace_id: state.upload.workspace_id, file_id: state.upload.file_id }; log(`[${slug}] upload: already done (${state.upload.file_id})`); return; }
  const file = join(bookDir(slug), book.ndi.file);
  if (!existsSync(file)) {
    if (!opts.dryRun) throw new Error(`${file} is missing — download it (see context-pack/books/sources.json) or use --source url`);
  }
  const bytes = existsSync(file) ? readFileSync(file) : null;
  const up = await client.upload(`[${slug}]`, { path: book.ndi.uploadPath, bytes, fileName: basename(book.ndi.file), contentType: file.endsWith('.pdf') ? 'application/pdf' : 'text/plain' });
  ctx.source = { type: 'workspace_file', workspace_id: up.workspace_id, file_id: up.file_id };
  if (!opts.dryRun) { state.upload = up; ctx.saveState(); log(`[${slug}] upload: ${up.file_id}${up.deduplicated ? ' (already there)' : ''}`); }
}

async function stepParse(ctx) {
  const { slug, book, state, client, opts, dir } = ctx;
  const out = join(dir, 'parse.json');
  if (existsSync(out) && !opts.force) { ctx.parse = readJson(out); log(`[${slug}] parse: already done (${ctx.parse.job_id}, ${ctx.parse.result?.document?.page_count ?? '?'} pages)`); return; }
  if (!ctx.source) throw new Error('parse needs the upload step (or --source url)');
  const body = {
    source: ctx.source,
    parse_mode: opts.parseMode,
    // markdown for the text, blocks so later tools can cite page regions; page markers on so
    // every page boundary survives in the markdown.
    output: { formats: ['markdown', 'blocks'], include_page_markers: true, table_format: 'markdown' },
    figures: { mode: 'omit' }, // the figures in these books are engraved music examples
    name: `drex-composer ${slug} parse`,
  };
  let job;
  if (state.parseJobId && !opts.force && !opts.dryRun) job = await client.getJob(`[${slug}] parse`, state.parseJobId);
  else job = await client.runTool(`[${slug}] parse`, 'parse', body, [slug, 'parse']);
  if (opts.dryRun) { ctx.parse = { job_id: job.job_id, result: null }; return; }
  state.parseJobId = job.job_id; ctx.saveState();
  const doc = job.result.document ?? {};
  if ((job.result.disclosures ?? []).some((d) => d.code === 'content_truncated') && doc.content_url) {
    // documented: over 1 MiB the markdown is a preview and the full text is at content_url
    doc.markdown = await client.fetchContent(`[${slug}] parse`, doc.content_url);
    doc.markdown_fetched_from_content_url = true;
  }
  ctx.parse = { book: slug, job_id: job.job_id, source: ctx.source, parse_mode: opts.parseMode, cost: job.cost ?? null, result: job.result };
  writeJson(out, ctx.parse);
  log(`[${slug}] parse: ${job.job_id}, ${doc.page_count ?? '?'} pages, OCR ${job.result.ocr_applied ? 'applied' : 'not applied'} -> ${out}`);
}

/** chapters -> classify/extract units (page windows for a scan, text parts for a text book) */
function buildUnits(ctx, chapters) {
  const { book, opts } = ctx;
  const units = [];
  for (const ch of chapters) {
    if (book.ndi.mode === 'paged') {
      if (ch.pdf_start_page == null || ch.pdf_end_page == null) continue;
      for (let s = ch.pdf_start_page; s <= ch.pdf_end_page; s += opts.window) units.push({ id: `${ch.id}.p${s}`, chapter: ch.id, pdf_start_page: s, pdf_end_page: Math.min(ch.pdf_end_page, s + opts.window - 1) });
    } else {
      // text book: cut the chapter into parts of about 24k characters at paragraph boundaries
      const lines = ctx.textLines.slice(ch.start_line - 1, ch.end_line);
      // every part starts with the "[p. N]" marker of the page it begins on, so a quote found
      // anywhere in it has a page marker above it
      let part = [], size = 0, n = 1, page = ch.start_page, partPage = ch.start_page;
      const flush = () => { if (part.some((l) => l.trim())) units.push({ id: `${ch.id}.t${n++}`, chapter: ch.id, text: `[p. ${partPage}]\n\n${part.join('\n')}`, first_page: partPage }); part = []; size = 0; partPage = page; };
      for (const line of lines) {
        const m = line.match(/^\[p\. (\w+)\]$/);
        if (size > 24000 && (m || !line.trim())) flush();
        if (m) { page = m[1]; if (!part.length) partPage = page; }
        part.push(line); size += line.length + 1;
      }
      flush();
    }
  }
  return units;
}

async function stepSplit(ctx) {
  const { slug, book, state, client, opts, dir } = ctx;
  const out = join(dir, 'chapters.json');
  const existing = existsSync(out) ? readJson(out) : null;
  const wantLocal = opts.chapters === 'local' || book.ndi.mode === 'text';

  if (existing && !opts.force && (existing.producedBy === 'ndi-split' || wantLocal)) { ctx.chapters = existing; log(`[${slug}] split: already done (${existing.chapters.length} chapters, ${existing.producedBy})`); return; }

  if (wantLocal) {
    // A text book has no pages for Split to cut on (Split returns page-range segments), so its
    // chapters come from the heading splitter. Prefer NDI's own text of the book when it kept
    // the "[p. N]" markers and "## Chapter" headings; otherwise use the local text.txt.
    let doc = localChapters(slug);
    const md = ctx.parse?.result?.document?.markdown;
    if (book.ndi.mode === 'text' && md) {
      // DOCS-UNVERIFIED: that Parse returns a plain-text file's lines unchanged (the docs say
      // this of Markdown files; for .txt they only say Parse "reads" it).
      const fromNdi = splitChapters(slug, md);
      if (fromNdi.length === book.toc.length && fromNdi.every((c) => c.heading_found)) { doc = { ...doc, source: `NDI parse ${ctx.parse.job_id}`, chapters: fromNdi }; ctx.textLines = md.split('\n'); }
      else log(`[${slug}] split: NDI's text lost the chapter headings or page markers (${fromNdi.length}/${book.toc.length} found) — using local text.txt`);
    }
    ctx.chapters = doc;
    if (opts.dryRun) log(`\n# [${slug}] split: no request — ${book.ndi.mode === 'text' ? 'a text book has no pages for Split to cut on' : '--chapters local'}; chapters come from the heading splitter`);
    else { writeJson(out, doc); log(`[${slug}] split: ${doc.chapters.length} chapters by heading (${doc.source}) -> ${out}`); }
    return;
  }

  // --- NDI Split on the finished parse
  // DOCS-UNVERIFIED: Split is documented for packets of separate documents ("invoice",
  // "receipt"). Using it to cut one book at its chapter headings — one "chapter" class plus an
  // instance_key and split_rules — is our reading of those options, not a documented use.
  const body = {
    source: { type: 'parse_result', job_id: ctx.parse.job_id },
    classes: SPLIT_CLASSES,
    split_rules: SPLIT_RULES,
    unknown_policy: 'include',
    overlap_policy: 'shared_boundary_page', // a chapter usually starts part-way down a page
    output: { include_content: false },
    name: `drex-composer ${slug} split`,
  };
  let job;
  if (state.splitJobId && !opts.force && !opts.dryRun) job = await client.getJob(`[${slug}] split`, state.splitJobId);
  else job = await client.runTool(`[${slug}] split`, 'split', body, [slug, 'split']);
  if (opts.dryRun) { ctx.chapters = existing ?? localChapters(slug); return; }
  state.splitJobId = job.job_id; ctx.saveState();

  const printed = pdfToPrinted(slug);
  const byNumber = new Map(book.toc.map((t) => [t.n, t]));
  const chapters = [];
  for (const seg of job.result.segments ?? []) {
    if (seg.status !== 'matched' || seg.class?.id !== 'chapter') continue;
    const heading = String(seg.instance?.value ?? '').trim();
    const roman = (heading.toUpperCase().match(/\b([IVXL]+)\b(?!\w)/) || [])[1];
    const t = roman ? byNumber.get(roman) : null;
    chapters.push({
      id: `ch-${String(chapters.length + 1).padStart(2, '0')}`,
      number: t?.n ?? roman ?? String(chapters.length + 1),
      title: t?.title ?? heading,
      heading_as_read: heading,
      // DOCS-UNVERIFIED: with a parse_result source, start_page/end_page are assumed to be
      // 1-based pages of the original PDF (the same numbers the page markers carry).
      pdf_start_page: seg.start_page,
      pdf_end_page: seg.end_page,
      start_page: printed?.[seg.start_page] ?? null,
      end_page: printed?.[seg.end_page] ?? null,
      segment_id: seg.id,
      classification_confidence: seg.classification_confidence ?? null,
      boundary_confidence: seg.boundary_confidence ?? null,
    });
  }
  const found = new Set(chapters.map((c) => c.number));
  const missing = book.toc.filter((t) => !found.has(t.n)).map((t) => t.n);
  let doc = { book: slug, title: book.title, producedBy: 'ndi-split', source: `NDI split ${job.job_id} of parse ${ctx.parse.job_id}`, pageNumbers: 'start_page/end_page are printed page numbers; pdf_* are 1-based pages of the scan PDF', missing_from_toc: missing, chapters };
  if (missing.length > book.toc.length * 0.4) {
    // Split did not behave like a chapter cutter: keep its answer for inspection, use ours.
    writeJson(join(dir, 'chapters.ndi-split.json'), doc);
    doc = { ...localChapters(slug), note: `NDI split found only ${chapters.length} of ${book.toc.length} chapters (see chapters.ndi-split.json); local heading split used instead` };
    log(`[${slug}] split: NDI found ${chapters.length}/${book.toc.length} chapters — falling back to the local heading split`);
  }
  ctx.chapters = doc;
  writeJson(out, doc);
  log(`[${slug}] split: ${doc.chapters.length} chapters (${doc.producedBy})${missing.length && doc.producedBy === 'ndi-split' ? `, not found: ${missing.join(', ')}` : ''} -> ${out}`);
}

/** source for one unit: pages of the parse for a scan, an uploaded chapter part for a text book */
async function unitSource(ctx, unit) {
  const { slug, book, state, client, opts } = ctx;
  if (book.ndi.mode === 'paged') return { source: { type: 'parse_result', job_id: ctx.parse.job_id }, page_ranges: [{ start: unit.pdf_start_page, end: unit.pdf_end_page }] };
  state.unitFiles ??= {};
  const key = `${unit.id}:${sha(unit.text).slice(0, 12)}`;
  const cache = opts.dryRun ? (ctx.dryUnitFiles ??= {}) : state.unitFiles; // a dry run never touches state
  if (!cache[key]) {
    const bytes = Buffer.from(unit.text, 'utf8');
    const up = await client.upload(`[${slug}] ${unit.id}`, { path: `drex-composer/${slug}/units/${unit.id}.md`, bytes, fileName: `${unit.id}.md`, contentType: 'text/markdown' });
    cache[key] = { workspace_id: up.workspace_id, file_id: up.file_id }; ctx.saveState();
  }
  return { source: { type: 'workspace_file', ...cache[key] } };
}

/**
 * Run a tool on one unit. For a scan the unit is "these pages of the earlier parse".
 * DOCS-UNVERIFIED: the Sources table says Split, Extract and Classify accept `page_ranges`
 * with a parse_result source ("keeps only those pages of the earlier parse"), but the Extract
 * page's Pages section is headed "Not with a parse_result source". If the create is refused
 * with 422 we fall back to the uploaded file itself with the same page_ranges (which re-parses
 * those pages and is billed for it).
 */
async function runOnUnit(ctx, what, tool, unit, rest, idem) {
  const src = await unitSource(ctx, unit);
  try {
    return await ctx.client.runTool(what, tool, { ...src, ...rest }, idem);
  } catch (err) {
    const canFallBack = err instanceof ApiError && err.status === 422 && src.source.type === 'parse_result' && ctx.source?.type !== undefined;
    if (!canFallBack) throw err;
    log(`  ${what}: refused with ${err.code ?? 422} on the parse_result source — retrying on the original file (pages are parsed again)`);
    return ctx.client.runTool(what, tool, { source: ctx.source, page_ranges: src.page_ranges, parse_mode: ctx.opts.parseMode, ...rest }, [...idem, 'file']);
  }
}

async function stepClassify(ctx) {
  const { slug, state, opts, dir } = ctx;
  const out = join(dir, 'chapters.json');
  const units = ctx.units;
  state.classify ??= {};
  const todo = units.filter((u) => opts.force || !state.classify[u.id]?.topics);
  if (!todo.length) { log(`[${slug}] classify: already done (${units.length} units)`); }
  const shown = opts.dryRun && !opts.verbose ? todo.slice(0, 1) : todo;
  await mapPool(shown, opts.dryRun ? 1 : opts.concurrency, async (unit) => {
    const what = `[${slug}] classify ${unit.id}`;
    const rest = {
      classes: TOPIC_CLASSES,
      granularity: 'document', // page granularity cannot reuse a parse (documented)
      unknown_policy: 'allow',
      output: { max_alternatives: 5, include_reason: false },
      name: `drex-composer ${slug} classify ${unit.id}`,
    };
    const job = await runOnUnit(ctx, what, 'classify', unit, rest, [slug, 'classify', unit.id]);
    if (opts.dryRun) return;
    const u = job.result.units?.[0];
    // DOCS-UNVERIFIED: the docs describe the runner-up labels and their `confidence` but give
    // no guidance on reading several labels as "this passage covers several topics". We keep
    // the winner plus any runner-up at 0.15 or more; the threshold is ours.
    const topics = u && !u.unknown ? (u.labels ?? []).filter((l) => TOPICS.includes(l.class_id) && (l.rank === 1 || (l.confidence ?? 0) >= 0.15)).map((l) => ({ topic: l.class_id, confidence: l.confidence ?? null, rank: l.rank })) : [];
    state.classify[unit.id] = { job_id: job.job_id, topics };
    ctx.saveState();
    log(`${what}: ${topics.map((t) => t.topic).join(', ') || '(no topic)'}`);
  });
  if (opts.dryRun) { if (todo.length > shown.length) log(`\n# … plus ${todo.length - shown.length} more classify requests of the same shape, one per unit: ${todo.slice(1, 6).map((u) => u.id).join(', ')}${todo.length > 6 ? ', …' : ''}  (--verbose prints all)`); return; }
  // record each chapter's topics in chapters.json
  for (const ch of ctx.chapters.chapters) {
    const merged = new Map();
    for (const u of units.filter((x) => x.chapter === ch.id)) for (const t of state.classify[u.id]?.topics ?? []) if ((merged.get(t.topic) ?? -1) < (t.confidence ?? 0)) merged.set(t.topic, t.confidence ?? 0);
    ch.topics = [...merged].sort((a, b) => b[1] - a[1]).map(([topic, confidence]) => ({ topic, confidence }));
  }
  writeJson(out, ctx.chapters);
}

function locateCitation(ctx, unit, citations) {
  // -> { page (printed), source_text } or null; "keep page references" lives here
  const { slug, book } = ctx;
  for (const c of citations ?? []) {
    const loc = c.location ?? {};
    if (book.ndi.mode === 'paged') {
      // documented: page_region carries a one-based `page`; text_span carries `page` when it maps to one
      let pdfPage = Number.isInteger(loc.page) ? loc.page : null;
      if (pdfPage == null && c.source_text) {
        const needle = squash(c.source_text).slice(0, 80);
        for (let p = unit.pdf_start_page; p <= unit.pdf_end_page && pdfPage == null; p++) if (needle && squash(ctx.mdPages.get(p) ?? '').includes(needle)) pdfPage = p;
      }
      const printed = pdfPage != null ? ctx.printed?.[pdfPage] : null;
      if (printed != null) return { page: printed, pdf_page: pdfPage, source_text: c.source_text ?? null };
    } else {
      // Text book: the unit's text carries "[p. N]" lines. Find the quote, take the marker above it.
      let at = -1;
      if (c.source_text) {
        at = unit.text.indexOf(c.source_text);
        if (at < 0) { const needle = squash(c.source_text).slice(0, 60); const hay = unit.text; for (let i = 0; i < hay.length && at < 0; i += 200) if (needle && squash(hay.slice(i, i + 600)).includes(needle)) at = i + 200; }
      }
      // DOCS-UNVERIFIED: for a text source the docs give `text_span` offsets "into the derived
      // text"; we assume the derived text of an uploaded .md file is the file itself and use
      // the offset only when the quote could not be found.
      if (at < 0 && loc.kind === 'text_span' && Number.isInteger(loc.char_start)) at = loc.char_start;
      if (at >= 0) {
        const marks = unit.text.slice(0, at + 1).match(/\[p\. (\w+)\]/g);
        const page = marks ? marks.at(-1).match(/\[p\. (\w+)\]/)[1] : unit.first_page;
        const head = (unit.text.slice(0, at).match(/^#{2,4} .+$/gm) || []).at(-1);
        if (/^\d+$/.test(String(page))) return { page: Number(page), source_text: c.source_text ?? null, heading: head ? head.replace(/^#+ /, '').replace(/\.$/, '') : null };
      }
    }
  }
  return null;
}

async function stepExtract(ctx) {
  const { slug, book, state, opts, dir } = ctx;
  const out = join(dir, 'rules.json');
  if (existsSync(out) && !opts.force && !opts.dryRun) { const prev = readJson(out); if (prev.complete) { ctx.rules = prev; log(`[${slug}] extract: already done (${prev.rules.length} rules)`); return; } }
  state.extract ??= {};
  const chapterById = new Map(ctx.chapters.chapters.map((c) => [c.id, c]));
  const withTopics = ctx.units.filter((u) => opts.dryRun || (state.classify?.[u.id]?.topics ?? []).length);
  const todo = withTopics.filter((u) => opts.force || !state.extract[u.id]);
  const shown = opts.dryRun && !opts.verbose ? todo.slice(0, 1) : todo;
  await mapPool(shown, opts.dryRun ? 1 : opts.concurrency, async (unit) => {
    const what = `[${slug}] extract ${unit.id}`;
    const ch = chapterById.get(unit.chapter);
    const topics = (state.classify?.[unit.id]?.topics ?? []).map((t) => t.topic);
    const rest = {
      schema: RULE_SCHEMA,
      instructions: ruleInstructions(book, ch, opts.dryRun ? ['<topics from the classify step>'] : topics),
      citations: { enabled: true, include_source_text: true },
      name: `drex-composer ${slug} extract ${unit.id}`,
    };
    const job = await runOnUnit(ctx, what, 'extract', unit, rest, [slug, 'extract', unit.id]);
    if (opts.dryRun) return;
    const data = job.result.data?.rules ?? [];
    // documented: `fields` has one entry per item of a top-level array, at /rules/0, /rules/1, …
    // DOCS-UNVERIFIED: whether the properties *inside* each item also get entries (such as
    // /rules/0/text). Citations are therefore collected from every path under /rules/<i>.
    const cites = (i) => (job.result.fields ?? []).filter((f) => f.path === `/rules/${i}` || f.path?.startsWith(`/rules/${i}/`)).flatMap((f) => f.citations ?? []);
    state.extract[unit.id] = { job_id: job.job_id, rules: data.map((r, i) => ({ ...r, citation: locateCitation(ctx, unit, cites(i)), status: (job.result.fields ?? []).find((f) => f.path === `/rules/${i}`)?.status ?? null })) };
    ctx.saveState();
    log(`${what}: ${data.length} rules`);
  });
  if (opts.dryRun) { if (todo.length > shown.length) log(`\n# … plus ${todo.length - shown.length} more extract requests of the same shape (units with at least one topic)  (--verbose prints all)`); return; }

  // assemble the book's rules in the digest schema, keeping only what can be cited
  const rules = [], dropped = [];
  for (const unit of ctx.units) {
    const ch = chapterById.get(unit.chapter);
    for (const r of state.extract[unit.id]?.rules ?? []) {
      const text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
      const why = !text ? 'empty text' : !TOPICS.includes(r.topic) ? 'invalid topic' : wordCount(text) > MAX_WORDS ? `over ${MAX_WORDS} words` : !r.citation ? 'no page reference could be established' : null;
      if (why) { dropped.push({ unit: unit.id, reason: why, text, topic: r.topic ?? null }); continue; }
      const calls = [...new Set((r.calls ?? []).filter((c) => CALLS.includes(c)))];
      rules.push({
        topic: r.topic,
        text,
        // a headed book (Rimsky): name the nearest heading at or before the cited page
        source: { book: slug, ref: formatRef(slug, { chapter: ch, section: String(r.section ?? '').trim(), page: r.citation.page, heading: r.citation.heading ?? (ch.sections ?? []).filter((x) => Number(x.page) <= r.citation.page).at(-1)?.title ?? null }) },
        calls: calls.length ? calls : DEFAULT_CALLS[r.topic],
        evidence: r.citation.source_text ?? null,
        unit: unit.id,
      });
    }
  }
  const pendingUnits = withTopics.filter((u) => !state.extract[u.id]).map((u) => u.id);
  ctx.rules = { book: slug, producedBy: 'ndi-extract', complete: pendingUnits.length === 0 && opts.limit === Infinity, pendingUnits, rules, dropped };
  writeJson(out, ctx.rules);
  log(`[${slug}] extract: ${rules.length} rules kept, ${dropped.length} dropped -> ${out}`);
}

function stepMerge(opts) {
  // every book that has a rules.json, in the curated digest's schema
  const all = [];
  for (const slug of SLUGS) {
    const p = join(ndiDir(slug), 'rules.json');
    if (existsSync(p)) all.push(...readJson(p).rules);
  }
  if (!all.length) { log('merge: no rules.json yet — nothing to merge'); return; }
  const seenText = new Set(), ids = new Set(), rules = [];
  for (const topic of TOPICS) {
    for (const r of all.filter((x) => x.topic === topic)) {
      const k = squash(r.text);
      if (seenText.has(k)) continue;
      seenText.add(k);
      const stem = squash(r.text).split(' ').filter((w) => w.length > 3 && !['that', 'with', 'from', 'this', 'when', 'into', 'must', 'only', 'them', 'their', 'should'].includes(w)).slice(0, 4).join('-') || 'rule';
      let id = `${topic}.${stem}`;
      for (let n = 2; ids.has(id); n++) id = `${topic}.${stem}-${n}`;
      ids.add(id);
      rules.push({ id, topic, text: r.text, source: r.source, calls: r.calls });
    }
  }
  const bad = rules.flatMap((r) => ruleErrors(r));
  if (bad.length) throw new Error(`merge produced invalid rules:\n  ${bad.join('\n  ')}`);
  const out = join(PACK, 'digest.ndi.json');
  if (opts.dryRun) { log(`merge: would write ${rules.length} rules to ${out}`); return; }
  writeJson(out, { version: 1, producedBy: 'tools/ndi/ingest.mjs', generatedAt: new Date().toISOString(), rules });
  log(`merge: ${rules.length} rules -> ${out}  (validate with: node tools/ndi/check-digest.mjs context-pack/digest.ndi.json)`);
}

// ------------------------------------------------------------------ main

async function runBook(slug, opts, client) {
  const book = BOOKS[slug];
  const dir = ndiDir(slug);
  const statePath = join(dir, 'state.json');
  const state = existsSync(statePath) ? readJson(statePath) : {};
  const ctx = { slug, book, dir, state, opts, client, saveState: () => { if (!opts.dryRun) writeJson(statePath, state); } };
  const has = (s) => opts.steps.includes(s);
  if (opts.dryRun) log(`\n================ ${slug} — ${book.title} (${book.ndi.mode === 'paged' ? 'scan PDF' : 'text'}: ${book.ndi.file}${existsSync(join(bookDir(slug), book.ndi.file)) ? `, ${statSync(join(bookDir(slug), book.ndi.file)).size} bytes` : ', NOT DOWNLOADED'}) ================`);

  if (has('upload')) await stepUpload(ctx);
  else if (state.upload) ctx.source = { type: 'workspace_file', workspace_id: state.upload.workspace_id, file_id: state.upload.file_id };
  if (has('parse')) await stepParse(ctx);
  else if (existsSync(join(dir, 'parse.json'))) ctx.parse = readJson(join(dir, 'parse.json'));

  if (has('split') || has('classify') || has('extract')) {
    if (!ctx.parse) throw new Error(`[${slug}] no parse yet — run the parse step first`);
    ctx.textLines = book.ndi.mode === 'text' ? readFileSync(join(bookDir(slug), 'text.txt'), 'utf8').split('\n') : null;
    if (has('split')) await stepSplit(ctx);
    else if (existsSync(join(dir, 'chapters.json'))) ctx.chapters = readJson(join(dir, 'chapters.json'));
    if (!ctx.chapters) throw new Error(`[${slug}] no chapters.json — run the split step (or node tools/ndi/local-fallback.mjs)`);
    // line numbers in chapters.json refer to whichever text the chapters were cut from
    const ndiText = ctx.parse.result?.document?.markdown;
    if (book.ndi.mode === 'text' && String(ctx.chapters.source).startsWith('NDI parse') && ndiText) ctx.textLines = ndiText.split('\n');
    // chapters cut by NDI carry PDF pages; chapters from the local splitter carry both
    ctx.printed = pdfToPrinted(slug);
    const toPdf = printedToPdfPage(slug);
    for (const ch of ctx.chapters.chapters) if (book.ndi.mode === 'paged' && ch.pdf_start_page == null && toPdf) { ch.pdf_start_page = toPdf[ch.start_page] ?? null; ch.pdf_end_page = toPdf[ch.end_page] ?? null; }
    ctx.mdPages = pagesOfMarkdown(ctx.parse.result?.document?.markdown);
    ctx.units = buildUnits(ctx, ctx.chapters.chapters).slice(0, opts.limit);
    if (opts.dryRun) log(`\n# ${slug}: ${ctx.chapters.chapters.length} chapters (${ctx.chapters.producedBy}) -> ${ctx.units.length} classify/extract units`);
    if (has('classify')) await stepClassify(ctx);
    if (has('extract')) await stepExtract(ctx);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dryRun && !process.env.NACE_API_KEY) {
    fail('NACE_API_KEY is not set.\n  Create a key at https://console.nace.ai and run:  NACE_API_KEY=nace_sk_... node tools/ndi/ingest.mjs --book <slug>\n  To see the requests without a key:  node tools/ndi/ingest.mjs --all --dry-run\n  To split chapters offline:  node tools/ndi/local-fallback.mjs');
  }
  if (opts.dryRun) log(`DRY RUN — nothing is sent and nothing is written. Base URL ${BASE_URL}. Placeholders in <angle brackets> are values earlier responses supply.`);
  const client = makeClient(opts);
  let failed = 0;
  for (const slug of opts.books) {
    try { await runBook(slug, opts, client); }
    catch (err) { failed++; console.error(`[${slug}] FAILED: ${err.message}\n  Re-run the same command to resume from the last finished step.`); if (opts.verbose) console.error(err.stack); }
  }
  if (opts.steps.includes('merge')) { try { stepMerge(opts); } catch (err) { failed++; console.error(`merge FAILED: ${err.message}`); } }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
