// One run of the engine: prompt in, a stream of panel events and phrase scores out.

import type { ClientEvent, PhraseScore, ServerEvent } from '../shared/types.ts';
import { composePhrase } from './calls/compose.ts';
import { chooseEnding, holdStep, startHold } from './calls/ending.ts';
import { revisePlan, runBackdrop, runPlan, runSetup } from './calls/setup.ts';
import { deriveCounterTheme, writeTheme } from './calls/themes.ts';
import type { Ctx } from './context.ts';
import { readMood } from './core/mood.ts';
import { hashString, mulberry32 } from './core/rng.ts';
import { DrexError, Gateway } from './gateway/gateway.ts';
import { Piece } from './piece.ts';

/** The look-ahead buffer holds up to this many accepted phrases beyond the one playing. */
// One more than the client needs: a phrase is only sent once the next one exists (see below).
const BUFFER_AHEAD = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SessionOptions {
  prompt: string;
  seed?: number;
  /** Paced sessions wait for the player before composing further ahead. Unpaced ones compose straight through. */
  paced: boolean;
  send: (event: ServerEvent) => void;
}

export class Session {
  readonly piece: Piece;
  readonly gw: Gateway;
  readonly seed: number;
  rejects = 0;
  holds = 0;
  private ctx: Ctx;
  private stopped = false;
  private started = -1;
  private holding = false;
  private wake: (() => void) | null = null;
  private lastStats = 0;

  constructor(private opts: SessionOptions) {
    this.seed = opts.seed ?? (hashString(opts.prompt) ^ (Date.now() & 0xffff)) >>> 0;
    this.piece = new Piece(opts.prompt, readMood(opts.prompt));
    this.gw = new Gateway({
      seed: this.seed,
      onCall: (call) => {
        this.send({ type: 'call', call });
        if (Date.now() - this.lastStats > 400) this.stats();
      },
    });
    this.ctx = { gw: this.gw, piece: this.piece, rng: mulberry32(this.seed), emit: (e) => this.send(e) };
  }

  private send(event: ServerEvent) {
    if (!this.stopped) this.opts.send(event);
  }

  private stats() {
    this.lastStats = Date.now();
    this.send({ type: 'stats', calls: this.gw.calls, callsLastMinute: this.gw.callsLastMinute(), rejects: this.rejects, holds: this.holds, composed: this.piece.phrases.length });
  }

  stop() {
    this.stopped = true;
    this.holding = false;
    this.gw.abort();
    this.wake?.();
  }

  onClient(event: ClientEvent) {
    if (event.type === 'phrase_started') {
      this.started = Math.max(this.started, event.index);
      this.wake?.();
    } else if (event.type === 'hold_started') {
      void this.runHold(event.afterIndex);
    } else if (event.type === 'hold_ended') {
      this.holding = false;
    } else if (event.type === 'stop') {
      this.stop();
    }
  }

  /** While playback holds, Drex keeps choosing how the sustain evolves. */
  private async runHold(afterIndex: number) {
    const after = this.piece.phrases[afterIndex];
    if (!after || this.holding || afterIndex >= this.piece.plan.totalPhrases - 1) return;
    this.holding = true;
    this.holds++;
    this.send({ type: 'status', stage: 'holding', message: `Holding after phrase ${afterIndex + 1} while drafts are redrawn` });
    const hold = startHold(after);
    const barMs = (after.score.beatsPerBar * 60_000) / after.score.bpm;
    await sleep(1500);
    while (this.holding && !this.stopped) {
      try {
        const update = await holdStep(this.ctx, hold, after);
        if (!this.holding || this.stopped) break;
        this.send({ type: 'hold_update', update });
      } catch (err) {
        if (!(err instanceof DrexError && err.kind === 'aborted')) console.error('[hold]', err);
        break;
      }
      await sleep(Math.max(2500, barMs));
    }
  }

  private async waitForRoom() {
    while (this.opts.paced && !this.stopped && this.piece.phrases.length - (this.started + 1) >= BUFFER_AHEAD) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  async run(): Promise<void> {
    const { piece, ctx } = this;
    try {
      this.send({ type: 'session', id: `s${this.seed.toString(36)}`, prompt: piece.prompt, standin: this.gw.standin, model: this.gw.model, seed: this.seed });
      this.send({ type: 'status', stage: 'setup', message: 'Drex is setting the rules of the piece' });
      await runSetup(ctx);
      this.send({ type: 'status', stage: 'plan', message: 'Drex is planning sections and the tension curve' });
      await runPlan(ctx);
      await runBackdrop(ctx);

      this.send({ type: 'status', stage: 'themes', message: 'Drafting and judging the theme' });
      await writeTheme(ctx, 'A', 'main');
      if (piece.plan.needsCounter) await deriveCounterTheme(ctx, 'B');
      this.stats();

      const total = piece.plan.totalPhrases;
      // A phrase can begin before its own bar line (a pickup, instruments stealing in), and those notes belong
      // to the end of the phrase before. So each phrase is sent once the next has been composed.
      let pending: PhraseScore | null = null;
      for (let index = 0; index < total && !this.stopped; index++) {
        await this.waitForRoom();
        if (this.stopped) break;
        const section = piece.sectionOf(index);
        // Drex revises its own plan at section ends.
        if (index === section.first && index > 0) await revisePlan(ctx, index);
        const lastSection = piece.plan.sections[piece.plan.sections.length - 1];
        if (!piece.endingPlan && (index === lastSection.first || index === total - 1)) await chooseEnding(ctx, index);
        // The plan calls for a new theme when the first departure arrives.
        if (piece.roleOf(index) === 'departure' && piece.plan.needsContrast && !piece.theme('C')) {
          this.send({ type: 'status', stage: 'themes', message: 'Drafting a contrast theme for the departure' });
          await writeTheme(ctx, 'C', 'contrast', piece.mainTheme);
        }

        this.send({
          type: 'status',
          stage: this.started < 0 ? 'buffering' : this.holding ? 'holding' : 'composing',
          message: `Composing phrase ${index + 1} of ${total} (${piece.roleOf(index)}, tension ${piece.tensionOf(index)})`,
        });
        const record = await composePhrase(ctx, index, () => {
          this.rejects++;
          this.stats();
        }, () => !this.stopped);
        if (!record) break;
        if (pending) {
          this.holding = false;
          this.send({ type: 'phrase', score: pending });
        }
        pending = record.score;
        this.stats();
      }
      if (!this.stopped) {
        if (pending) this.send({ type: 'phrase', score: pending });
        this.send({ type: 'status', stage: 'done', message: `Composed ${piece.phrases.length} phrases in ${this.gw.calls} Drex calls` });
        this.send({ type: 'done' });
      }
    } catch (err) {
      if (err instanceof DrexError && err.kind === 'aborted') return;
      console.error('[session]', err);
      this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.send({ type: 'status', stage: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}
