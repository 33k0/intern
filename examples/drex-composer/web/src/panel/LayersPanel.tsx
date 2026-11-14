import { memo, useRef } from 'react';
import type { LayerRole, LayerSummary, PhraseScore } from '../../../shared/types';
import { LAYER_ROLES, engineRef } from '../engineBridge';
import { LAYER_NAMES, LOUDNESS, capitalize, entryName, instrumentName } from '../format';
import { store, useSel } from '../store';
import { Fermata } from './Fermata';
import { useFrame } from './useFrame';
import './layers.css';

interface Props {
  onNewPrompt(): void;
}

/**
 * What is sounding right now. Composition runs two or three phrases ahead of playback, so this
 * panel is keyed off the engine's playhead, not the newest phrase.
 */
export const LayersPanel = memo(function LayersPanel({ onNewPrompt }: Props) {
  const nowIndex = useSel((s) => s.nowIndex);
  const score = useSel((s) => (s.nowIndex === null ? null : s.phrases[s.nowIndex] ?? null));
  const total = useSel((s) => s.plan?.totalPhrases ?? null);
  const holding = useSel((s) => s.hold.active);
  const phase = useSel((s) => s.phase);

  return (
    <section className={`panel layers${holding ? ' is-holding' : ''}`} aria-label="Now sounding">
      <div className="panel__head">
        <h2 className="panel__title">Playing now</h2>
        {nowIndex !== null && (
          <span className="panel__meta">
            phrase <b className="mono">{nowIndex + 1}</b>
            {total !== null && (
              <>
                {' '}of <span className="mono">{total}</span>
              </>
            )}
          </span>
        )}
      </div>

      {phase === 'finished' ? (
        <Finished onNewPrompt={onNewPrompt} />
      ) : phase === 'stopped' || phase === 'error' ? (
        <Preparing />
      ) : holding ? (
        <HoldMarker />
      ) : score ? (
        <NowHead score={score} />
      ) : (
        <Preparing />
      )}

      <p className="panel__explain rows__explain">Each line is one part of the band and the instrument playing it.</p>
      <LayerRows phrase={score?.index ?? -1} layers={score?.display.layers ?? null} />
    </section>
  );
});

// ───────────────────────────── Sounding phrase ─────────────────────────────

const NowHead = memo(function NowHead({ score }: { score: PhraseScore }) {
  // Same name the track at the bottom uses for this stretch of the piece.
  const part = useSel((s) => s.plan?.sections.find((sec) => score.index >= sec.phrases[0] && score.index <= sec.phrases[1])?.part);
  const progress = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const el = progress.current;
    const engine = engineRef.current;
    if (!el || !engine) return;
    const ph = engine.playhead();
    const frac = ph.index === score.index && ph.beats > 0 ? Math.max(0, Math.min(1, ph.beat / ph.beats)) : 0;
    el.style.transform = `scaleX(${frac.toFixed(4)})`;
  });

  return (
    <div className="now" key={score.index}>
      <div className="now__line">
        <span className="now__role">{capitalize(part ?? score.role)}</span>
        <span className="now__dyn" title="How loud this phrase is">{LOUDNESS[score.mix.dynamics]}</span>
      </div>
      <div className="now__facts">
        <span>{score.display.key}</span>
        <span className="now__chords">chords <span className="mono">{score.display.chords.join('  ')}</span></span>
      </div>
      <span className="now__progress" aria-hidden="true">
        <span ref={progress} />
      </span>
    </div>
  );
});

// ───────────────────────────── Hold ─────────────────────────────

const HoldMarker = memo(function HoldMarker() {
  const hold = useSel((s) => s.hold);
  const elapsed = useRef<HTMLSpanElement>(null);
  const since = useRef(performance.now());
  const last = useRef('');
  useFrame((t) => {
    if (!elapsed.current) return;
    const text = `${Math.max(0, (t - since.current) / 1000).toFixed(1)} s`;
    if (text !== last.current) {
      last.current = text;
      elapsed.current.textContent = text;
    }
  });

  const nextIndex = (hold.afterIndex ?? -1) + 1;
  const rejectedHere = useSel((s) => (s.phraseRounds[nextIndex] ?? []).some((r) => r.rejected));
  const latest = hold.updates[hold.updates.length - 1];
  const earlier = hold.updates.slice(0, -1).slice(-2);

  return (
    <div className="hold" role="status">
      <div className="hold__line">
        <Fermata className="hold__mark" />
        <span className="hold__word">Holding</span>
        <span className="hold__sub">{rejectedHere ? 'redrafting' : 'drafting'}</span>
        <span ref={elapsed} className="hold__time mono">0.0 s</span>
      </div>
      <p className="hold__why">
        {rejectedHere ? (
          <>
            Drex rejected every draft of phrase <b className="mono">{nextIndex + 1}</b>. The last chord is held while it redrafts.
          </>
        ) : (
          <>
            Phrase <b className="mono">{nextIndex + 1}</b> is not accepted yet. The last chord is held until it is.
          </>
        )}
      </p>
      <ol className="hold__evolution" aria-label="How the sustain is evolving">
        {earlier.map((u, i) => (
          <li key={`${u.action}-${i}`} className="is-past">{u.label}</li>
        ))}
        {latest ? (
          <li key={`${latest.action}-${hold.updates.length}`} className="is-current">
            <span>{latest.label}</span>

          </li>
        ) : (
          <li className="is-waiting">sustain unchanged so far</li>
        )}
      </ol>
    </div>
  );
});

// ───────────────────────────── Before playback, after the end ─────────────────────────────

const Preparing = memo(function Preparing() {
  const audio = useSel((s) => s.audio);
  const composed = useSel((s) => s.composedThrough + 1);
  const hasRules = useSel((s) => s.rules !== null);
  const phase = useSel((s) => s.phase);

  let headline = 'Nothing sounding yet';
  let detail = 'Playback starts once the instruments are loaded and two phrases are ready.';
  if (phase === 'stopped') {
    headline = 'Stopped';
    detail = 'Start a new prompt to hear another piece.';
  } else if (phase === 'error') {
    headline = 'The run ended early';
    detail = 'See the message at the bottom. Start a new prompt to try again.';
  } else if (hasRules && !audio.instrumentsReady) {
    headline = 'Loading instruments';
    detail = audio.mode === 'pending' ? 'Waiting for the audio engine.' : 'Fetching samples for the palette Drex chose.';
  } else if (audio.instrumentsReady) {
    headline = 'Buffering';
    detail = composed >= 2 ? 'Starting playback.' : `Waiting for two accepted phrases. ${composed} so far.`;
  }

  const showLoad = hasRules && audio.total > 0 && phase === 'running';
  const frac = audio.total > 0 ? audio.loaded / audio.total : 0;

  return (
    <div className="prep" role="status">
      <strong>{headline}</strong>
      <span>{detail}</span>
      {showLoad && (
        <div className="prep__load">
          <span className="prep__bar" aria-hidden="true">
            <span style={{ transform: `scaleX(${frac})` }} />
          </span>
          <span className="mono">{Math.round(frac * 100)}%</span>
        </div>
      )}
      {audio.mode === 'silent' && <span className="prep__warn">Audio engine unavailable: running a silent playhead.</span>}
    </div>
  );
});

const Finished = memo(function Finished({ onNewPrompt }: Props) {
  // Read once: the run is over, these no longer change.
  const s = store.getState();
  const phrases = s.composedThrough + 1;
  return (
    <div className="finished" role="status">
      <strong>Finished</strong>
      <span>
        Drex wrote <b className="mono">{phrases}</b> phrases by making <b className="mono">{s.stats.calls}</b> decisions.
      </span>
      <button type="button" className="btn btn--primary" onClick={onNewPrompt}>
        New prompt
      </button>
    </div>
  );
});

// ───────────────────────────── The nine layers ─────────────────────────────

const SEGMENTS = 24;

const LayerRows = memo(function LayerRows({ phrase, layers }: { phrase: number; layers: LayerSummary[] | null }) {
  const meters = useRef<Partial<Record<LayerRole, HTMLSpanElement | null>>>({});
  const shown = useRef<Partial<Record<LayerRole, number>>>({});

  useFrame(() => {
    const engine = engineRef.current;
    if (!engine) return;
    let levels: Record<LayerRole, number>;
    try {
      levels = engine.levels();
    } catch {
      return;
    }
    for (const role of LAYER_ROLES) {
      const el = meters.current[role];
      if (!el) continue;
      const target = Math.max(0, Math.min(1, levels[role] ?? 0));
      const prev = shown.current[role] ?? 0;
      // Fast up, slow down, like a desk meter; snapped to whole segments.
      const next = target > prev ? target : Math.max(target, prev - 0.035);
      shown.current[role] = next;
      const lit = Math.round(next * SEGMENTS);
      if (el.dataset.lit !== String(lit)) {
        el.dataset.lit = String(lit);
        el.style.clipPath = `inset(0 ${(100 - (lit / SEGMENTS) * 100).toFixed(2)}% 0 0)`;
      }
    }
  });

  const byRole = new Map<LayerRole, LayerSummary>();
  for (const l of layers ?? []) byRole.set(l.role, l);

  return (
    <ol className="rows">
      {LAYER_ROLES.map((role) => {
        const l = byRole.get(role);
        const active = Boolean(l && l.inst);
        const entering = active && l!.entry !== 'continues';
        return (
          // A layer that enters in this phrase is remounted so its entry highlight plays once.
          <li key={entering ? `${role}@${phrase}` : role} className={`row${active ? ' is-active' : ''}${entering ? ' is-entering' : ''}`}>
            <span className="row__role">{LAYER_NAMES[role]}</span>
            {active ? (
              <>
                <span className="row__inst">{instrumentName(l!.inst!)}</span>
                <span className="row__entry">{entering ? entryName(l!.entry) : ''}</span>
              </>
            ) : (
              <span className="row__tacet">silent</span>
            )}
            <span className="row__meter" aria-hidden="true">
              <span ref={(el) => { meters.current[role] = el; }} className="row__lit" />
            </span>
          </li>
        );
      })}
    </ol>
  );
});
