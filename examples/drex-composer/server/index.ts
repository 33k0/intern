// HTTP + WebSocket server. Serves the sample library and hall recordings under /assets and runs
// one composing session per socket.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { ClientEvent, ServerEvent } from '../shared/types.ts';
import { apiKey } from './gateway/gateway.ts';
import { modelFor } from './gateway/models.ts';
import { pack, ROOT } from './pack.ts';
import { Session } from './session.ts';
import { bookPath, theoryData } from './theory.ts';
import { scoresToMidi } from '../tools/midi.ts';

const app = express();
app.use('/assets', express.static(join(ROOT, 'assets'), { maxAge: '1h', fallthrough: false }));
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    standin: !apiKey(),
    model: apiKey() ? modelFor('setup') : 'stand-in',
    packRules: pack.rules.length,
    workedExamples: pack.examples.length,
  });
});
// Saved runs (eval/results/<name>/events.json, written by `npm run compose -- --json`), for the
// browser's replay mode: /?replay=<name> plays one through the real engine without calling Drex.
const RESULTS = join(ROOT, 'eval/results');
const RUN_NAME = /^[A-Za-z0-9_.-]+$/;
app.get('/api/replays', (_req, res) => {
  const names = existsSync(RESULTS)
    ? readdirSync(RESULTS).filter((name) => RUN_NAME.test(name) && !name.startsWith('.') && existsSync(join(RESULTS, name, 'events.json'))).sort()
    : [];
  const runs = names.map((name) => {
    try {
      const events = JSON.parse(readFileSync(join(RESULTS, name, 'events.json'), 'utf8')) as { type: string; prompt?: string }[];
      return { name, prompt: events.find((e) => e.type === 'session')?.prompt ?? '' };
    } catch {
      return { name, prompt: '' };
    }
  });
  res.json({ runs });
});
app.get('/api/replay/:name', (req, res) => {
  const { name } = req.params;
  const file = join(RESULTS, name, 'events.json');
  if (!RUN_NAME.test(name) || name.startsWith('.') || !existsSync(file)) {
    res.status(404).json({ error: `No saved run named "${name}"` });
    return;
  }
  res.type('application/json').send(readFileSync(file, 'utf8'));
});

// ───────────────────────────── Commissions: the door an agent uses ─────────────────────────────
// An agent harness such as Nace's Intern works from a terminal: it cannot hold a socket open or hear
// audio. It posts a prompt here, polls until the piece is done, and gets back links a person can open
// and a plain-text account of what Drex decided. The agent passes the prompt through untouched and
// makes no musical choice: Drex still makes every one. See INTERN.md and AGENTS.md.
interface Commission { id: string; prompt: string; status: 'composing' | 'done' | 'error'; phrases: number; total: number; error?: string; summary?: string; startedAt: number }
const commissions = new Map<string, Commission>();
const publicUrl = () => (process.env.PUBLIC_URL ?? '').replace(/\/$/, '') || (existsSync(join(ROOT, 'dist')) ? `http://localhost:${Number(process.env.PORT) || 8787}` : 'http://localhost:5173'); // in development the page is served by Vite
/** With COMPOSER_TOKEN set, callers must send it as a Bearer token. Without it, only this machine may commission. */
function allowed(req: express.Request): boolean {
  const token = (process.env.COMPOSER_TOKEN ?? '').trim();
  if (token) return req.get('authorization') === `Bearer ${token}`;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && !req.get('x-forwarded-for');
}
const view = (c: Commission) => ({
  id: c.id, prompt: c.prompt, status: c.status, phrases_composed: c.phrases, phrases_total: c.total,
  ...(c.error ? { error: c.error } : {}),
  ...(c.status === 'done' ? { listen_url: `${publicUrl()}/?replay=${c.id}`, midi_url: `${publicUrl()}/api/commissions/${c.id}/piece.mid`, summary: c.summary } : {}),
  status_url: `${publicUrl()}/api/commissions/${c.id}`,
});

app.post('/api/commissions', express.json({ limit: '10kb' }), (req, res) => {
  if (!allowed(req)) { res.status(401).json({ error: 'Send the commission token as "Authorization: Bearer <token>".' }); return; }
  const prompt = String(req.body?.prompt ?? '').trim().slice(0, 600);
  if (!prompt) { res.status(400).json({ error: 'Send JSON with a "prompt": the words the piece should be composed from.' }); return; }
  if ([...commissions.values()].some((c) => c.status === 'composing')) { res.status(429).json({ error: 'A piece is being composed. Try again in a minute.' }); return; }
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'piece';
  const id = `c-${slug}-${Date.now().toString(36)}`;
  const c: Commission = { id, prompt, status: 'composing', phrases: 0, total: 0, startedAt: Date.now() };
  commissions.set(id, c);
  const events: ServerEvent[] = [];
  const session = new Session({
    prompt, paced: false,
    send: (e) => {
      events.push(e);
      if (e.type === 'plan') c.total = e.plan.totalPhrases;
      if (e.type === 'phrase') c.phrases += 1;
      if (e.type === 'error') { c.status = 'error'; c.error = e.message; }
    },
  });
  void session.run().then(() => {
    if (c.status === 'error') return;
    const scores = events.flatMap((e) => (e.type === 'phrase' ? [e.score] : []));
    if (!scores.length) { c.status = 'error'; c.error = 'Nothing was composed.'; return; }
    mkdirSync(join(RESULTS, id), { recursive: true });
    writeFileSync(join(RESULTS, id, 'events.json'), JSON.stringify(events));
    writeFileSync(join(RESULTS, id, 'piece.mid'), scoresToMidi(scores));
    // What Drex decided, in plain words, for the agent to pass on. Facts only: nothing here is the agent's opinion.
    const rules = events.find((e) => e.type === 'rules');
    const plan = [...events].reverse().find((e) => e.type === 'plan');
    const secs = Math.round(scores.reduce((t, s) => t + (s.beats * 60) / s.bpm, 0));
    const r = rules?.type === 'rules' ? rules.rules : null;
    const pl = plan?.type === 'plan' ? plan.plan : null;
    c.summary = [
      r ? `${r.styleName}${r.groove ? ` (${r.groove})` : ''}, ${r.keyName}, ${r.bpm} BPM, ${r.meter}. ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} long, ${scores.length} phrases.` : '',
      r ? `Instruments Drex chose: ${r.palette.join(', ')}.` : '',
      pl ? `Sections: ${pl.sections.map((x) => x.part ?? x.role).join(', ')}. The climax is phrase ${pl.climaxPhrase + 1}${pl.climaxArrival ? `, arriving as "${pl.climaxArrival.replace(/_/g, ' ')}"` : ''}.` : '',
      `Drex answered ${session.gw.calls} sets of questions to compose it${session.gw.standin ? ' (offline stand-in, not live Drex)' : ''}.`,
    ].filter(Boolean).join(' ');
    c.status = 'done';
  }).catch((err: unknown) => { c.status = 'error'; c.error = err instanceof Error ? err.message : String(err); });
  res.status(202).json(view(c));
});
app.get('/api/commissions/:id', (req, res) => {
  const c = commissions.get(req.params.id);
  if (!c) { res.status(404).json({ error: 'No such commission.' }); return; }
  res.json(view(c));
});
app.get('/api/commissions/:id/piece.mid', (req, res) => {
  const file = join(RESULTS, req.params.id, 'piece.mid');
  if (!RUN_NAME.test(req.params.id) || !commissions.has(req.params.id) || !existsSync(file)) { res.status(404).json({ error: 'No such piece.' }); return; }
  res.type('audio/midi').send(readFileSync(file));
});

// Theory sources, for the panel that shows what Drex was given. `/api/theory` lists the four books
// and the rules each kind of decision receives; `/api/books/<slug>` serves a book's scan.
app.get('/api/theory', (req, res) => {
  res.json(theoryData(typeof req.query.style === 'string' ? req.query.style : undefined, (slug) => `/api/books/${slug}`));
});
app.get('/api/books/:slug', (req, res) => {
  const path = bookPath(req.params.slug);
  if (!path) {
    res.status(404).json({ error: 'No such book' });
    return;
  }
  // Inline, so the browser's PDF viewer opens it and honours #page=N.
  res.sendFile(path, { headers: { 'Content-Disposition': 'inline' } });
});

const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|assets|ws).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  let session: Session | null = null;
  const send = (event: ServerEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  socket.on('message', (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event.type === 'start') {
      session?.stop();
      const prompt = String(event.prompt ?? '').trim().slice(0, 600) || 'a quiet piece';
      session = new Session({ prompt, seed: event.seed, paced: true, send });
      void session.run();
    } else {
      session?.onClient(event);
      if (event.type === 'stop') session = null;
    }
  });
  socket.on('close', () => session?.stop());
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  console.log(`Drex Composer server on http://localhost:${port}`);
  console.log(apiKey() ? `Drex: live, model ${modelFor('setup')}` : 'Drex: no NACE_API_KEY set, the local STAND-IN is answering');
  console.log(`Context pack: ${pack.rules.length} rules, ${pack.examples.length} worked examples`);
});
