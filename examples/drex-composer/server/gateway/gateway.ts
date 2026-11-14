// The Drex gateway: one place that owns the API key, the queue, rate limiting and retries.
// Every musical decision in the project goes through `Gateway.ask`.
//
// With NACE_API_KEY set, requests go to POST https://console.nace.ai/v1/systemone.
// Without it, a local stand-in answers from the heuristic `prior` each question carries.
// Priors are never sent to the real API; they exist only so the project runs without a key.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallType, CallView, QuestionView } from '../../shared/types.ts';
import { clamp, mulberry32, sampleFrom, topOf, type Rng } from '../core/rng.ts';
import { modelFor } from './models.ts';

// ───────────────────────────── Question shapes ─────────────────────────────

export interface ChoiceOption {
  key: string;
  /** Short label for the panel. */
  label: string;
  /** The description Drex reads for this option (its effect, when it fits, measured facts). */
  criteria: string;
  /** Stand-in only: log-weight. Higher is more likely. */
  prior?: number;
}

export interface ChoiceQuestion {
  id: string;
  type: 'choice';
  label: string;
  instructions: string;
  options: ChoiceOption[];
}

export interface NoulQuestion {
  id: string;
  type: 'noul';
  label: string;
  instructions: string;
  yes?: string;
  no?: string;
  /** Stand-in only: probability of yes. */
  prior?: number;
}

export interface ScoreQuestion {
  id: string;
  type: 'score';
  label: string;
  instructions: string;
  /** Level descriptions, low to high. */
  levels: string[];
  /** Stand-in only: expected level index. */
  prior?: number;
  spread?: number;
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface AskRequest {
  callType: CallType;
  title: string;
  state: string;
  questions: Question[];
  /** Inline images (base64 or data: URLs). Max models only, at most 8. */
  images?: string[];
  /** 'top' takes the most probable answer; 'sampled' draws `draws` independent sets from the probabilities. */
  picking: 'top' | 'sampled';
  draws?: number;
  /** Show on the panel (default true). */
  quiet?: boolean;
  /** Force a model for this request (used when comparing models per call type). */
  model?: string;
  /** Jump the queue when the account is at its rate limit. */
  priority?: boolean;
}

/** One set of picks: question id → option key ("yes"/"no" for noul, level index for score). */
export type Picks = Record<string, string>;

export interface AskResult {
  probabilities: Record<string, Record<string, number>>;
  /** Expected level for score questions; P(yes) for noul. */
  values: Record<string, number>;
  /** picks[0] is the top pick when picking = 'top'; one entry per draw when sampled. */
  picks: Picks[];
  model: string;
  standin: boolean;
  ms: number;
}

export class DrexError extends Error {
  constructor(public status: number, public kind: string, message: string, public requestId?: string) {
    super(message);
  }
}

// ───────────────────────────── Account-wide pacing ─────────────────────────────

const TIERS = {
  free: { rpm: 120, inFlight: 8 },
  paid: { rpm: 1200, inFlight: 16 },
} as const;

class Limiter {
  private stamps: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(public rpm: number, public inFlight: number) {}

  private wake() {
    const w = this.waiters.shift();
    if (w) w();
  }

  private urgent = 0;

  /**
   * Wait for a slot. Priority requests go first: when the account is at its limit, the next free
   * slot goes to them and ordinary requests stand back (a hold must keep evolving while drafts queue).
   */
  async acquire(priority = false): Promise<void> {
    if (priority) this.urgent++;
    try {
      await this.wait(priority);
    } finally {
      if (priority) this.urgent--;
    }
  }

  private async wait(priority: boolean): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (!priority && this.urgent > 0) {
        await new Promise<void>((r) => setTimeout(r, 60));
        continue;
      }
      // A tenth of the per-minute budget is kept back for priority requests. Drafting burns its share
      // in bursts; without the reserve a hold would wait most of a minute for the window to move on.
      const budget = priority || !Number.isFinite(this.rpm) ? this.rpm : this.rpm - Math.ceil(this.rpm * 0.1);
      if (this.active < this.inFlight && this.stamps.length < budget) {
        this.active++;
        this.stamps.push(now);
        return;
      }
      if (this.active >= this.inFlight) {
        await new Promise<void>((r) => this.waiters.push(r));
      } else {
        // Wait until the oldest admission leaves the sliding window.
        // Wait until enough of the oldest admissions have left the sliding window.
        const over = Math.max(0, this.stamps.length - budget);
        const wait = Math.max(25, 60_000 - (now - this.stamps[Math.min(over, this.stamps.length - 1)]) + (priority ? 1 : 5));
        await new Promise<void>((r) => setTimeout(r, wait));
      }
    }
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.wake();
  }

  lastMinute(): number {
    const now = Date.now();
    return this.stamps.filter((t) => now - t < 60_000).length;
  }
}

/** Nace documents two hosts for the same API: console.nace.ai (the default) and drex.nace.ai. DREX_API_URL picks one. */
const HOSTS = ['https://console.nace.ai/v1/systemone', 'https://drex.nace.ai/v1/systemone'];
let hostIndex = 0;
export const apiUrl = (): string => (process.env.DREX_API_URL ?? '').trim().replace(/^["']|["']$/g, '') || HOSTS[hostIndex];
/** console.nace.ai sometimes answers with a security-check page (HTTP 403, not JSON) instead of the API. Then the other host is used. */
function switchHost(): boolean {
  if ((process.env.DREX_API_URL ?? '').trim() || hostIndex >= HOSTS.length - 1) return false;
  hostIndex += 1;
  console.warn(`[drex] ${HOSTS[hostIndex - 1]} answered with a non-API 403; using ${HOSTS[hostIndex]}`);
  return true;
}

export function apiKey(): string | null {
  // Tolerate a key pasted with quotes or spaces around it.
  const k = (process.env.NACE_API_KEY ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return k.startsWith('nace_sk_') ? k : null;
}

function tier(): { rpm: number; inFlight: number } {
  if (!apiKey()) {
    // Nothing upstream to respect without a key. Set STANDIN_RPM to rehearse a tier's pacing (120 = free tier).
    return { rpm: Number(process.env.STANDIN_RPM) || Infinity, inFlight: 16 };
  }
  const t = (process.env.DREX_TIER ?? '').toLowerCase();
  return t === 'paid' ? TIERS.paid : TIERS.free;
}

let limiter: Limiter | null = null;
function sharedLimiter(): Limiter {
  if (!limiter) {
    const t = tier();
    limiter = new Limiter(Number(process.env.DREX_RPM) || t.rpm, Number(process.env.DREX_IN_FLIGHT) || t.inFlight);
  }
  return limiter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── Gateway ─────────────────────────────

export interface GatewayOptions {
  seed: number;
  onCall?: (call: CallView) => void;
  /** Force the stand-in even if a key is present (used by tests). */
  forceStandin?: boolean;
  /** Images to attach to calls of a given type when the caller passes none (key frames, when scoring a video). */
  imagesFor?: (callType: CallType) => string[] | undefined;
}

export class Gateway {
  readonly standin: boolean;
  calls = 0;
  private rng: Rng;
  private standinRng: Rng;
  private started = Date.now();
  private aborted = false;

  /** DREX_PICKER=random swaps Drex for a uniform random picker: the control for the blind listening test. */
  readonly random = (process.env.DREX_PICKER ?? '').toLowerCase() === 'random';
  private dumped = new Map<string, number>();

  constructor(private opts: GatewayOptions) {
    this.standin = opts.forceStandin || this.random || !apiKey();
    this.rng = mulberry32(opts.seed ^ 0x9e3779b9);
    this.standinRng = mulberry32(opts.seed ^ 0x51ed270b);
  }

  abort() {
    this.aborted = true;
  }

  get model(): string {
    return this.random ? 'random picker' : this.standin ? 'stand-in' : modelFor('setup');
  }

  /** DREX_DUMP_DIR=<dir> saves the first few request bodies of each call type, exactly as Drex would receive them. */
  private dump(req: AskRequest) {
    const dir = process.env.DREX_DUMP_DIR;
    if (!dir) return;
    const n = this.dumped.get(req.callType) ?? 0;
    if (n >= (Number(process.env.DREX_DUMP_MAX) || 3)) return;
    this.dumped.set(req.callType, n + 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${req.callType}.${n + 1}.json`), JSON.stringify(this.buildBody(req, modelFor(req.callType, !!req.images?.length)), null, 2));
  }

  callsLastMinute(): number {
    return sharedLimiter().lastMinute();
  }

  async ask(req: AskRequest): Promise<AskResult> {
    if (this.aborted) throw new DrexError(0, 'aborted', 'Session stopped');
    if (!req.questions.length) throw new Error(`${req.callType}: no questions`);
    if (!req.images) {
      const images = this.opts.imagesFor?.(req.callType);
      if (images?.length) req = { ...req, images: images.slice(0, 8) };
    }
    this.dump(req);
    const lim = sharedLimiter();
    await lim.acquire(req.priority);
    const t0 = Date.now();
    let probabilities: Record<string, Record<string, number>>;
    let values: Record<string, number>;
    let model: string;
    try {
      if (this.standin) {
        ({ probabilities, values } = await this.answerLocally(req));
        model = 'stand-in';
      } else {
        ({ probabilities, values, model } = await this.answerRemotely(req));
      }
    } finally {
      lim.release();
    }
    if (this.aborted) throw new DrexError(0, 'aborted', 'Session stopped');
    const ms = Date.now() - t0;
    this.calls++;

    const picks: Picks[] = [];
    const n = req.picking === 'sampled' ? Math.max(1, req.draws ?? 1) : 1;
    for (let i = 0; i < n; i++) {
      const p: Picks = {};
      for (const qn of req.questions) {
        const probs = probabilities[qn.id];
        if (req.picking === 'sampled') p[qn.id] = sampleFrom(probs, this.rng);
        else if (qn.type === 'score') p[qn.id] = String(clamp(Math.round(values[qn.id]), 0, qn.levels.length - 1));
        else p[qn.id] = topOf(probs);
      }
      picks.push(p);
    }

    if (!req.quiet && this.opts.onCall) {
      const questions: QuestionView[] = req.questions.map((qn) => ({
        id: qn.id,
        type: qn.type,
        label: qn.label,
        options:
          qn.type === 'choice'
            ? qn.options.map((o) => ({ key: o.key, label: o.label }))
            : qn.type === 'score'
              ? qn.levels.map((l, i) => ({ key: String(i), label: l }))
              : [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
        probabilities: probabilities[qn.id],
        picked: picks.map((p) => p[qn.id]),
        picking: req.picking,
      }));
      this.opts.onCall({
        id: this.calls,
        callType: req.callType,
        title: req.title,
        at: Date.now() - this.started,
        model,
        standin: this.standin,
        ms,
        questions,
      });
    }
    return { probabilities, values, picks, model, standin: this.standin, ms };
  }

  // ── The local stand-in ──

  private async answerLocally(req: AskRequest) {
    const [lo, hi] = (process.env.STANDIN_LATENCY_MS ?? '30-110').split('-').map(Number);
    const wait = (lo || 0) + this.standinRng() * Math.max(0, (hi || lo || 0) - (lo || 0));
    if (wait > 0) await sleep(wait);
    const probabilities: Record<string, Record<string, number>> = {};
    const values: Record<string, number> = {};
    // Sampled calls draw straight from these probabilities, so the stand-in is made surer of itself there.
    const sharp = this.random ? 0 : Number(process.env.STANDIN_SHARPNESS) || (req.picking === 'sampled' ? 1.8 : 1);
    for (const qn of req.questions) {
      if (qn.type === 'choice') {
        const w = qn.options.map((o) => Math.exp((o.prior ?? 0) * sharp + (this.standinRng() - 0.5) * 0.35));
        const total = w.reduce((a, b) => a + b, 0) || 1;
        probabilities[qn.id] = Object.fromEntries(qn.options.map((o, i) => [o.key, w[i] / total]));
        values[qn.id] = Math.max(...w) / total;
      } else if (qn.type === 'noul') {
        const raw = this.random ? 0.5 : clamp(qn.prior ?? 0.5, 0.01, 0.99);
        const logit = Math.log(raw / (1 - raw)) * (req.picking === 'sampled' ? 1.3 : 1) + (this.standinRng() - 0.5) * 0.4;
        const p = clamp(1 / (1 + Math.exp(-logit)), 0.01, 0.99);
        probabilities[qn.id] = { yes: p, no: 1 - p };
        values[qn.id] = p;
      } else {
        const mean = this.random ? this.standinRng() * (qn.levels.length - 1) : clamp((qn.prior ?? (qn.levels.length - 1) / 2) + (this.standinRng() - 0.5) * 0.3, 0, qn.levels.length - 1);
        const sd = this.random ? 3 : qn.spread ?? 0.7;
        const w = qn.levels.map((_l, i) => Math.exp(-((i - mean) ** 2) / (2 * sd * sd)));
        const total = w.reduce((a, b) => a + b, 0) || 1;
        probabilities[qn.id] = Object.fromEntries(w.map((x, i) => [String(i), x / total]));
        values[qn.id] = w.reduce((s, x, i) => s + (i * x) / total, 0);
      }
    }
    return { probabilities, values };
  }

  // ── The real API ──

  private buildBody(req: AskRequest, model: string) {
    const questions: Record<string, unknown> = {};
    for (const qn of req.questions) {
      if (qn.type === 'choice') {
        questions[qn.id] = {
          type: 'choice',
          instructions: qn.instructions,
          criteria: Object.fromEntries(qn.options.map((o) => [o.key, o.criteria])),
        };
      } else if (qn.type === 'noul') {
        const criteria: Record<string, string> = {};
        if (qn.yes) criteria.true = qn.yes;
        if (qn.no) criteria.false = qn.no;
        questions[qn.id] = { type: 'noul', instructions: qn.instructions, ...(Object.keys(criteria).length ? { criteria } : {}) };
      } else {
        questions[qn.id] = { type: 'score', instructions: qn.instructions, criteria: qn.levels };
      }
    }
    const body: Record<string, unknown> = { model, state: req.state, questions };
    if (req.images?.length) body.images = req.images;
    return body;
  }

  private async answerRemotely(req: AskRequest) {
    const model = req.model ?? modelFor(req.callType, !!req.images?.length);
    const payload = JSON.stringify(this.buildBody(req, model));
    if (Buffer.byteLength(payload) > 4_194_304) {
      throw new DrexError(422, 'invalid_request_error', `${req.callType}: request body is over the 4 MiB limit`);
    }
    const maxAttempts = 6;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.aborted) throw new DrexError(0, 'aborted', 'Session stopped');
      let res: Response;
      try {
        res = await fetch(apiUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            'Content-Type': 'application/json',
            'X-Nace-Legend': 'array',
          },
          body: payload,
          // Drex can take up to 55 s before answering 529; shorter client timeouts cancel requests about to succeed.
          signal: AbortSignal.timeout(65_000),
        });
      } catch (err) {
        lastError = err;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { model: string; answers: Record<string, any> };
        return { ...this.normalise(req, json.answers), model: json.model };
      }
      let detail: any = null;
      try {
        detail = await res.json();
      } catch {
        /* non-JSON platform error */
      }
      // A 403 that is not the API's own JSON is the host's security page: try the other host, without using up an attempt.
      if (res.status === 403 && !detail?.error && switchHost()) { attempt--; continue; }
      const kind = detail?.error?.type ?? `http_${res.status}`;
      const issues = (detail?.error?.issues ?? []).map((i: any) => `${i.path}: ${i.message}`).join('; ');
      const message = `${detail?.error?.message ?? res.statusText}${issues ? ` (${issues})` : ''}`;
      const error = new DrexError(res.status, kind, `Drex ${res.status} on ${req.callType}: ${message}`, detail?.request_id);
      // Never retry 401, 402 or 422: they fail the same way every time.
      if (![429, 500, 503, 529, 408].includes(res.status)) throw error;
      lastError = error;
      const retryMs = Number(res.headers.get('retry-after-ms')) || Number(res.headers.get('retry-after')) * 1000 || 0;
      await sleep(Math.max(retryMs, backoff(attempt)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private normalise(req: AskRequest, answers: Record<string, any>) {
    const probabilities: Record<string, Record<string, number>> = {};
    const values: Record<string, number> = {};
    for (const qn of req.questions) {
      const a = answers?.[qn.id];
      if (!a) throw new DrexError(500, 'missing_answer', `Drex returned no answer for "${qn.id}"`);
      if (qn.type === 'choice') {
        const probs: Record<string, number> = {};
        for (const o of qn.options) probs[o.key] = Number(a.probabilities?.[o.key] ?? (a.choice === o.key ? 1 : 0));
        probabilities[qn.id] = probs;
        values[qn.id] = Number(a.confidence ?? 0);
      } else if (qn.type === 'noul') {
        const p = clamp(Number(a.noul ?? 0.5), 0, 1);
        probabilities[qn.id] = { yes: p, no: 1 - p };
        values[qn.id] = p;
      } else {
        const probs: Record<string, number> = {};
        qn.levels.forEach((_l, i) => (probs[String(i)] = Number(a.probabilities?.[String(i)] ?? 0)));
        probabilities[qn.id] = probs;
        values[qn.id] = Number(a.score ?? 0);
      }
    }
    return { probabilities, values };
  }
}

function backoff(attempt: number): number {
  const base = Math.min(5000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}
