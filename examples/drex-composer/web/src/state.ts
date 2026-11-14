// One pure reducer that folds ServerEvents (plus a few local events from the socket and the
// audio engine) into everything the panel shows. No timers, no DOM, no engine calls in here:
// per-frame values (beat position, layer levels) are read straight from the engine by the
// components that need them.

import type {
  CallType, CallView, DraftView, HoldUpdate, PhraseScore, PlanView, RulesView, ServerEvent,
  Stage, ThemeView, VerdictView,
} from '../../shared/types';

export type EngineEvent =
  | { type: 'phrase_started'; index: number }
  | { type: 'hold_started'; afterIndex: number }
  | { type: 'hold_ended' }
  | { type: 'ended' };

export type Conn = 'connecting' | 'open' | 'reconnecting' | 'mock' | 'replay';
export type RunPhase = 'idle' | 'starting' | 'running' | 'finished' | 'stopped' | 'error';
/** pending: engine still loading. real: sound comes out. silent: engine unavailable, a timer stands in. */
export type AudioMode = 'pending' | 'real' | 'silent';

export type LocalEvent =
  | { type: 'local/conn'; conn: Conn }
  | { type: 'local/compose'; prompt: string }
  | { type: 'local/stopped' }
  | { type: 'local/audio'; mode: AudioMode }
  | { type: 'local/instruments'; loaded: number; total: number; ready: boolean }
  | { type: 'local/playback_started' }
  | { type: 'local/engine'; event: EngineEvent };

export type Action = ServerEvent | LocalEvent;

export interface DraftRound {
  /** Arrival order across the whole run. */
  seq: number;
  kind: 'theme' | 'phrase';
  themeId: string | null;
  phrase: number | null;
  round: number;
  drafts: DraftView[];
  verdict: VerdictView;
  /** The judge turned every draft down. */
  rejected: boolean;
}

export interface SessionInfo {
  id: string;
  prompt: string;
  standin: boolean;
  model: string;
  seed: number;
}

export interface Stats {
  calls: number;
  callsLastMinute: number;
  rejects: number;
  holds: number;
  composed: number;
}

export interface HoldState {
  active: boolean;
  afterIndex: number | null;
  /** How the sustain has evolved during the current (or most recent) hold, oldest first. */
  updates: HoldUpdate[];
  /** Number of holds the engine has entered this run. */
  count: number;
}

export interface PanelState {
  conn: Conn;
  phase: RunPhase;
  /** Prompt the user just submitted, shown until the server confirms the session. */
  pendingPrompt: string | null;
  session: SessionInfo | null;
  stage: Stage;
  message: string;
  rules: RulesView | null;
  plan: PlanView | null;
  /** The plan before the latest revision, for the ghost curve. */
  previousPlan: PlanView | null;
  planRevisions: number;
  backdrop: { id: string; file: string; mood: string } | null;
  themeRounds: DraftRound[];
  themes: ThemeView[];
  /** Judge rounds per phrase index, in arrival order. */
  phraseRounds: Record<number, DraftRound[]>;
  /** The most recent judge round of either kind: what the drafts view shows. */
  focusRound: DraftRound | null;
  /** The most recent all-rejected round, kept so it can still be pointed at after the redraft. */
  lastRejection: DraftRound | null;
  roundSeq: number;
  /** Accepted phrases keyed by phrase index. Composition runs ahead of playback. */
  phrases: Record<number, PhraseScore>;
  /** Highest phrase index composed so far, -1 before the first. */
  composedThrough: number;
  /** Every call of the run, oldest first (capped only as a safety net). */
  calls: CallView[];
  /** The call shown at full size. */
  featured: CallView | null;
  hold: HoldState;
  /** Phrase indices after which the engine had to hold. */
  holdsAfter: number[];
  stats: Stats;
  error: string | null;
  serverDone: boolean;
  engineEnded: boolean;
  /** Phrase currently sounding, from the engine. null before playback. */
  nowIndex: number | null;
  playbackStarted: boolean;
  audio: { mode: AudioMode; loaded: number; total: number; instrumentsReady: boolean };
}

export /** Enough for a whole piece (a three-minute run makes a few hundred), so the history is complete. */
const CALL_LOG_LIMIT = 4000;
export const CONNECTION_LOST = 'Connection to the composer lost. Reconnecting.';
const HOLD_UPDATE_LIMIT = 6;

const EMPTY_STATS: Stats = { calls: 0, callsLastMinute: 0, rejects: 0, holds: 0, composed: 0 };

/** Fields that belong to one run; cleared on every new prompt and every new session. */
function freshRun() {
  return {
    session: null as SessionInfo | null,
    stage: 'idle' as Stage,
    message: '',
    rules: null as RulesView | null,
    plan: null as PlanView | null,
    previousPlan: null as PlanView | null,
    planRevisions: 0,
    backdrop: null as PanelState['backdrop'],
    themeRounds: [] as DraftRound[],
    themes: [] as ThemeView[],
    phraseRounds: {} as Record<number, DraftRound[]>,
    focusRound: null as DraftRound | null,
    lastRejection: null as DraftRound | null,
    roundSeq: 0,
    phrases: {} as Record<number, PhraseScore>,
    composedThrough: -1,
    calls: [] as CallView[],
    featured: null as CallView | null,
    hold: { active: false, afterIndex: null, updates: [], count: 0 } as HoldState,
    holdsAfter: [] as number[],
    stats: EMPTY_STATS,
    error: null as string | null,
    serverDone: false,
    engineEnded: false,
    nowIndex: null as number | null,
    playbackStarted: false,
  };
}

export function initialState(): PanelState {
  return {
    conn: 'connecting',
    phase: 'idle',
    pendingPrompt: null,
    ...freshRun(),
    audio: { mode: 'pending', loaded: 0, total: 0, instrumentsReady: false },
  };
}

// ───────────────────────────── Which call gets the big view ─────────────────────────────

const INTEREST: Partial<Record<CallType, number>> = {
  setup: 3, plan: 3, plan_revision: 3, theme_judge: 3, phrase_judge: 3, hold: 3, ending: 3,
  theme_note: 1, voice_leading: 1,
};

export function callInterest(type: CallType): number {
  return INTEREST[type] ?? 2;
}

/** How long a featured call keeps the big view before a routine call may replace it (ms). */
export function callDwell(type: CallType): number {
  const rank = callInterest(type);
  return rank >= 3 ? 2400 : rank === 2 ? 1200 : 600;
}

/**
 * Calls arrive about twice a second, faster than a room can read. Every call goes to the log;
 * the big view changes only when the one on screen has had its moment, or something more
 * important arrives. Verdicts and rules calls are never skipped.
 */
export function shouldFeature(current: CallView | null, incoming: CallView): boolean {
  if (!current) return true;
  if (incoming.questions.length === 0) return false;
  const now = callInterest(current.callType);
  const next = callInterest(incoming.callType);
  if (next > now) return true;
  if (next === now && next >= 3) return true;
  return incoming.at - current.at >= callDwell(current.callType);
}

// ───────────────────────────── Reducer ─────────────────────────────

function planChanged(a: PlanView, b: PlanView): boolean {
  if (a.totalPhrases !== b.totalPhrases || a.climaxPhrase !== b.climaxPhrase) return true;
  if (a.sections.length !== b.sections.length) return true;
  return a.sections.some((s, i) => {
    const t = b.sections[i];
    return s.role !== t.role || s.tension !== t.tension || s.departure !== t.departure
      || s.phrases[0] !== t.phrases[0] || s.phrases[1] !== t.phrases[1] || s.keyName !== t.keyName;
  });
}

function finishedPhase(s: PanelState): RunPhase {
  if (s.phase !== 'running') return s.phase;
  if (!s.serverDone) return s.phase;
  // Nothing was ever queued, or the engine has played the final phrase out.
  if (s.engineEnded || s.composedThrough < 0) return 'finished';
  return s.phase;
}

export function reduce(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    // ── local ──
    case 'local/conn': {
      if (state.conn === action.conn) return state;
      const live = state.phase === 'running' || state.phase === 'starting';
      // Losing the socket mid-run is worth saying out loud; the note clears when it returns.
      if (action.conn === 'reconnecting' && live && !state.error) {
        return { ...state, conn: action.conn, error: CONNECTION_LOST };
      }
      if (action.conn === 'open' && state.error === CONNECTION_LOST) {
        return { ...state, conn: action.conn, error: null };
      }
      return { ...state, conn: action.conn };
    }

    case 'local/audio':
      return { ...state, audio: { ...state.audio, mode: action.mode } };

    case 'local/compose':
      return {
        ...state,
        ...freshRun(),
        phase: 'starting',
        pendingPrompt: action.prompt,
        audio: { ...state.audio, loaded: 0, total: 0, instrumentsReady: false },
      };

    case 'local/stopped':
      if (state.phase === 'idle') return state;
      return { ...state, phase: 'stopped', hold: { ...state.hold, active: false } };

    case 'session':
      return {
        ...state,
        ...freshRun(),
        phase: 'running',
        pendingPrompt: null,
        session: {
          id: action.id, prompt: action.prompt, standin: action.standin,
          model: action.model, seed: action.seed,
        },
        audio: { ...state.audio, loaded: 0, total: 0, instrumentsReady: false },
      };

    default:
      break;
  }

  // Everything below belongs to a live run. Late events from a stopped or superseded run
  // (the server may still be flushing) must not leak into the next one.
  if (state.phase !== 'running') return state;

  switch (action.type) {
    case 'local/instruments':
      return {
        ...state,
        audio: { ...state.audio, loaded: action.loaded, total: action.total, instrumentsReady: action.ready },
      };

    case 'local/playback_started':
      return { ...state, playbackStarted: true };

    case 'local/engine': {
      const e = action.event;
      if (e.type === 'phrase_started') {
        return { ...state, nowIndex: e.index, hold: state.hold.active ? { ...state.hold, active: false } : state.hold };
      }
      if (e.type === 'hold_started') {
        return {
          ...state,
          hold: { active: true, afterIndex: e.afterIndex, updates: [], count: state.hold.count + 1 },
          holdsAfter: state.holdsAfter.includes(e.afterIndex) ? state.holdsAfter : [...state.holdsAfter, e.afterIndex],
        };
      }
      if (e.type === 'hold_ended') {
        return state.hold.active ? { ...state, hold: { ...state.hold, active: false } } : state;
      }
      const next = { ...state, engineEnded: true, hold: { ...state.hold, active: false } };
      return { ...next, phase: finishedPhase(next) };
    }

    case 'status': {
      const next = { ...state, stage: action.stage, message: action.message };
      if (action.stage === 'error') return { ...next, phase: 'error', error: state.error ?? action.message };
      // A non-fatal error stays on the status line until the composer reports what it did next.
      return state.error && state.error !== CONNECTION_LOST ? { ...next, error: null } : next;
    }

    case 'call': {
      const calls = state.calls.length >= CALL_LOG_LIMIT
        ? [...state.calls.slice(state.calls.length - CALL_LOG_LIMIT + 1), action.call]
        : [...state.calls, action.call];
      const featured = shouldFeature(state.featured, action.call) ? action.call : state.featured;
      return { ...state, calls, featured };
    }

    case 'rules':
      return { ...state, rules: action.rules };

    case 'plan': {
      const prev = state.plan;
      if (prev && (action.plan.revised || planChanged(prev, action.plan))) {
        return { ...state, plan: action.plan, previousPlan: prev, planRevisions: state.planRevisions + 1 };
      }
      return { ...state, plan: action.plan };
    }

    case 'backdrop':
      return { ...state, backdrop: { id: action.id, file: action.file, mood: action.mood } };

    case 'theme_drafts': {
      const round: DraftRound = {
        seq: state.roundSeq + 1, kind: 'theme', themeId: action.themeId, phrase: null,
        round: action.round, drafts: action.drafts, verdict: action.verdict,
        rejected: action.verdict.picked === null,
      };
      return {
        ...state,
        roundSeq: round.seq,
        themeRounds: [...state.themeRounds, round],
        focusRound: round,
        lastRejection: round.rejected ? round : state.lastRejection,
      };
    }

    case 'theme': {
      const others = state.themes.filter((t) => t.id !== action.theme.id);
      return { ...state, themes: [...others, action.theme] };
    }

    case 'phrase_drafts': {
      const round: DraftRound = {
        seq: state.roundSeq + 1, kind: 'phrase', themeId: null, phrase: action.phrase,
        round: action.round, drafts: action.drafts, verdict: action.verdict,
        rejected: action.verdict.picked === null,
      };
      const existing = state.phraseRounds[action.phrase] ?? [];
      return {
        ...state,
        roundSeq: round.seq,
        phraseRounds: { ...state.phraseRounds, [action.phrase]: [...existing, round] },
        focusRound: round,
        lastRejection: round.rejected ? round : state.lastRejection,
      };
    }

    case 'phrase': {
      const score = action.score;
      return {
        ...state,
        phrases: { ...state.phrases, [score.index]: score },
        composedThrough: Math.max(state.composedThrough, score.index),
      };
    }

    case 'hold_update': {
      const updates = [...state.hold.updates, action.update].slice(-HOLD_UPDATE_LIMIT);
      return { ...state, hold: { ...state.hold, updates } };
    }

    case 'stats':
      return {
        ...state,
        stats: {
          calls: action.calls, callsLastMinute: action.callsLastMinute, rejects: action.rejects,
          holds: action.holds, composed: action.composed,
        },
      };

    case 'error':
      return { ...state, error: action.message };

    case 'done': {
      const next = { ...state, serverDone: true };
      return { ...next, phase: finishedPhase(next) };
    }

    default:
      return state;
  }
}

// ───────────────────────────── Derived views (pure) ─────────────────────────────

/** Phrase indices that had at least one all-rejected judge round. */
export function rejectedPhrases(state: Pick<PanelState, 'phraseRounds'>): number[] {
  const out: number[] = [];
  for (const [k, rounds] of Object.entries(state.phraseRounds)) {
    if (rounds.some((r) => r.rejected)) out.push(Number(k));
  }
  return out.sort((a, b) => a - b);
}

/** Total all-rejected rounds seen this run (themes and phrases). */
export function rejectedRoundCount(state: Pick<PanelState, 'phraseRounds' | 'themeRounds'>): number {
  let n = state.themeRounds.filter((r) => r.rejected).length;
  for (const rounds of Object.values(state.phraseRounds)) n += rounds.filter((r) => r.rejected).length;
  return n;
}

export interface LineageEntry {
  index: number;
  lineage: string;
  role: string;
  key: string;
  sounding: boolean;
  /** Composed but not yet heard. */
  ahead: boolean;
}

/**
 * The derivation chain the lineage view shows: the phrase now sounding, the ones leading up to
 * it, and whatever has been composed ahead, newest first. Before playback it follows composition.
 */
export function lineageChain(
  state: Pick<PanelState, 'phrases' | 'nowIndex' | 'composedThrough'>,
  limit = 6,
): LineageEntry[] {
  const now = state.nowIndex;
  const top = state.composedThrough;
  if (top < 0) return [];
  const anchor = now ?? top;
  // Show up to two phrases ahead of the playhead, then walk back.
  const start = Math.min(top, anchor + 2);
  const out: LineageEntry[] = [];
  for (let i = start; i >= 0 && out.length < limit; i--) {
    const p = state.phrases[i];
    if (!p) continue;
    out.push({
      index: i,
      lineage: p.display.lineage,
      role: p.role,
      key: p.display.key,
      sounding: now === i,
      ahead: now === null ? false : i > now,
    });
  }
  return out;
}

/** The score the "now" views should describe: the sounding phrase, else the latest composed. */
export function soundingScore(state: Pick<PanelState, 'phrases' | 'nowIndex'>): PhraseScore | null {
  if (state.nowIndex === null) return null;
  return state.phrases[state.nowIndex] ?? null;
}
