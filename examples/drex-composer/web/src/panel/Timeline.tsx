import { memo, useMemo, useRef, type CSSProperties } from 'react';
import type { PlanView, SectionView } from '../../../shared/types';
import { controller } from '../controller';
import { engineRef } from '../engineBridge';
import { useSel } from '../store';
import { Fermata } from './Fermata';
import { useFrame } from './useFrame';
import './timeline.css';

const VB_W = 1000;
const VB_H = 100;

/** Tension 1..7 to a y position in the 0..100 plot (7 near the top). */
function tensionY(t: number): number {
  const clamped = Math.max(1, Math.min(7, t));
  return VB_H - (9 + ((clamped - 1) / 6) * 80);
}

function sectionOf(plan: PlanView, phrase: number): SectionView | undefined {
  return plan.sections.find((s) => phrase >= s.phrases[0] && phrase <= s.phrases[1]);
}

/**
 * The planned tension as one smooth line: flat through each section, eased between them.
 * The path always has one segment per phrase, so a revised plan can morph into place.
 */
function curvePath(plan: PlanView, edges: number[]): { line: string; area: string } {
  const total = Math.max(1, plan.totalPhrases);
  const mid = (i: number) => ((edges[i] ?? i / total) + (edges[i + 1] ?? (i + 1) / total)) / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < total; i++) {
    const t = sectionOf(plan, i)?.tension ?? 1;
    pts.push([mid(i) * VB_W, tensionY(t)]);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  let d = `M0,${first[1].toFixed(2)} L${first[0].toFixed(2)},${first[1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mid = (x0 + x1) / 2;
    d += ` C${mid.toFixed(2)},${y0.toFixed(2)} ${mid.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  d += ` L${VB_W},${last[1].toFixed(2)}`;
  return { line: d, area: `${d} L${VB_W},${VB_H} L0,${VB_H} Z` };
}

function sectionChanged(a: SectionView | undefined, b: SectionView): boolean {
  if (!a) return true;
  return a.role !== b.role || a.tension !== b.tension || a.departure !== b.departure || a.keyName !== b.keyName
    || a.phrases[0] !== b.phrases[0] || a.phrases[1] !== b.phrases[1];
}

/** The whole piece at a glance: sections, planned tension, the climax, and where we are in it. */
export const Timeline = memo(function Timeline() {
  const plan = useSel((s) => s.plan);
  const previous = useSel((s) => s.previousPlan);
  const revisions = useSel((s) => s.planRevisions);
  const composedThrough = useSel((s) => s.composedThrough);
  const nowIndex = useSel((s) => s.nowIndex);
  const phrases = useSel((s) => s.phrases);
  const phraseRounds = useSel((s) => s.phraseRounds);
  const holdsAfter = useSel((s) => s.holdsAfter);
  const holding = useSel((s) => s.hold.active);

  const total = plan ? Math.max(1, plan.totalPhrases, composedThrough + 1) : 0;
  // The plot runs on time, not on phrase count: a six-bar phrase is drawn wider than a three-bar one.
  // Phrases not yet composed are drawn at the nominal length.
  const edges = useMemo(() => {
    const secs = Array.from({ length: total }, (_x, i) => {
      const p = phrases[i];
      return p ? (p.beats * 60) / p.bpm : plan?.phraseSec ?? 1;
    });
    const sum = secs.reduce((a, b) => a + b, 0) || 1;
    const out = [0];
    for (const x of secs) out.push(out[out.length - 1] + x / sum);
    return out;
  }, [total, phrases, plan]);
  const edge = (i: number) => edges[Math.max(0, Math.min(total, i))] ?? 0;
  const curve = useMemo(() => (plan ? curvePath(plan, edges) : null), [plan, edges]);
  const ghost = useMemo(() => (previous ? curvePath(previous, edges) : null), [previous, edges]);

  const nowMarker = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const el = nowMarker.current;
    const engine = engineRef.current;
    if (!el || !engine || total === 0) return;
    const ph = engine.playhead();
    if (ph.index < 0) return;
    const within = ph.beats > 0 ? Math.max(0, Math.min(1, ph.beat / ph.beats)) : 0;
    const frac = Math.max(0, Math.min(1, edge(ph.index) + within * (edge(ph.index + 1) - edge(ph.index))));
    el.style.transform = `translateX(${(frac * 100).toFixed(3)}%)`;
  });

  if (!plan || !curve) {
    return (
      <section className="panel tl tl--empty" aria-label="Tension plan">
        <div className="panel__head">
          <h2 className="panel__title">Tension plan</h2>
        </div>
        <div className="tl__waiting">
          <span>The plan follows the rules</span>
          <span>Sections, a tension from 1 to 7 for each, and where the climax falls.</span>
        </div>
      </section>
    );
  }

  const rejectedCount = (i: number): number => (phraseRounds[i] ?? []).filter((r) => r.rejected).length;
  const climaxX = ((edge(plan.climaxPhrase) + edge(plan.climaxPhrase + 1)) / 2) * 100;
  const climaxY = tensionY(sectionOf(plan, plan.climaxPhrase)?.tension ?? 7);
  const labelEvery = total > 48 ? 4 : total > 28 ? 2 : 1;
  const nowSection = nowIndex === null ? null : sectionOf(plan, nowIndex)?.index ?? null;

  return (
    <section className={`panel tl${holding ? ' is-holding' : ''}`} aria-label="Tension plan">
      <div className="panel__head">
        <h2 className="panel__title">Tension plan</h2>
        <ul className="tl__legend" aria-label="Legend">
          <li><i className="lg lg--plan" aria-hidden="true" />planned tension</li>
          {ghost && <li><i className="lg lg--ghost" aria-hidden="true" />before revision</li>}
          <li><i className="lg lg--dot" aria-hidden="true" />composed</li>
          <li><i className="lg lg--now" aria-hidden="true" />now</li>
          <li><i className="lg lg--ahead" aria-hidden="true" />composed up to</li>
          <li><b className="lg-x mono" aria-hidden="true">×</b>rejected round</li>
          <li><Fermata className="lg-fermata" />hold</li>
        </ul>
        <span className="tl__right">
          {revisions > 0 && (
            <span key={revisions} className="tag tag--accent tl__revised">
              Plan revised{revisions > 1 ? ` ×${revisions}` : ''}
            </span>
          )}
          <span className="panel__meta">
            <b className="mono">{composedThrough + 1}</b> of <span className="mono">{plan.totalPhrases}</span> phrases composed
          </span>
        </span>
      </div>

      {/* In a saved run, a click jumps to that phrase. */}
      <div
        className="tl__plot"
        onClick={(e) => {
          if (!controller.position().seekable) return;
          const box = e.currentTarget.getBoundingClientRect();
          const x = (e.clientX - box.left) / box.width;
          controller.seekToPhrase(Math.max(0, edges.findIndex((v, i) => i > 0 && x < v) - 1));
        }}
      >
        {/* Section bands: role and key on top, a tint for departures. */}
        {plan.sections.map((s) => {
          const left = edge(s.phrases[0]) * 100;
          const width = (edge(s.phrases[1] + 1) - edge(s.phrases[0])) * 100;
          const changed = revisions > 0 && sectionChanged(previous?.sections.find((p) => p.index === s.index), s);
          return (
            <div
              key={s.index}
              className={`band${s.departure ? ' is-departure' : ''}${nowSection === s.index ? ' is-now' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`Section ${s.index + 1}: ${s.part ?? s.role}, planned tension ${s.tension} of 7, ${s.keyName}`}
            >
              <span key={changed ? `c${revisions}` : 'same'} className={`band__label${changed ? ' is-changed' : ''}`}>
                <span className="band__role">{s.part ?? s.role}</span>
                {/* The key is only worth naming where the piece leaves home. */}
                {s.keyName !== plan.sections[0]?.keyName && <span className="band__key">{s.keyName}</span>}
              </span>
            </div>
          );
        })}

        <div className="tl__curve">
          <span className="tl__axis tl__axis--hi mono" aria-hidden="true">7</span>
          <span className="tl__axis tl__axis--lo mono" aria-hidden="true">1</span>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="tl-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line className="tl__grid" x1="0" x2={VB_W} y1={tensionY(7)} y2={tensionY(7)} vectorEffect="non-scaling-stroke" />
            <line className="tl__grid" x1="0" x2={VB_W} y1={tensionY(4)} y2={tensionY(4)} vectorEffect="non-scaling-stroke" />
            <line className="tl__grid" x1="0" x2={VB_W} y1={tensionY(1)} y2={tensionY(1)} vectorEffect="non-scaling-stroke" />
            {ghost && (
              <path key={revisions} className="tl__ghost" d={ghost.line} fill="none" vectorEffect="non-scaling-stroke" />
            )}
            <path className="tl__area" d={curve.area} style={{ d: `path("${curve.area}")` } as CSSProperties} fill="url(#tl-fill)" />
            <path className="tl__line" d={curve.line} style={{ d: `path("${curve.line}")` } as CSSProperties} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>

          {/* What was actually composed, phrase by phrase. */}
          {Array.from({ length: Math.min(total, composedThrough + 1) }, (_, i) => {
            const p = phrases[i];
            if (!p) return null;
            return (
              <span
                key={i}
                className={`tl__dot${nowIndex !== null && i <= nowIndex ? ' is-played' : ''}${i === nowIndex ? ' is-now' : ''}`}
                style={{ left: `${((edge(i) + edge(i + 1)) / 2) * 100}%`, top: `${tensionY(p.display.tension)}%` }}
              />
            );
          })}

          <div className="tl__climax" style={{ left: `${climaxX}%` }}>
            <span className="tl__climax-mark" style={{ top: `${climaxY}%` }} aria-hidden="true" />
            <span className="tl__climax-label">climax</span>
          </div>
        </div>

        {/* One cell per phrase. */}
        <ol className="tl__ticks">
          {Array.from({ length: total }, (_, i) => {
            const composed = i <= composedThrough && Boolean(phrases[i]);
            const played = nowIndex !== null && i < nowIndex;
            const rejected = rejectedCount(i);
            const held = holdsAfter.includes(i);
            return (
              <li
                key={i}
                className={`tick-cell${composed ? ' is-composed' : ''}${played ? ' is-played' : ''}${i === nowIndex ? ' is-now' : ''}`}
                style={{ left: `${edge(i) * 100}%`, width: `${(edge(i + 1) - edge(i)) * 100}%` }}
              >
                <span className="tick-cell__bar" aria-hidden="true" />
                {(i % labelEvery === 0 || i === nowIndex) && <span className="tick-cell__n mono">{i + 1}</span>}
                {rejected > 0 && (
                  <span className="tick-cell__rej mono" title={`${rejected} rejected ${rejected === 1 ? 'round' : 'rounds'}`}>
                    ×{rejected > 1 ? rejected : ''}
                  </span>
                )}
                {held && <Fermata className="tick-cell__hold" />}
              </li>
            );
          })}
        </ol>

        {/* How far composing has got. */}
        {composedThrough >= 0 && (
          <div className="tl__marker tl__marker--ahead" style={{ transform: `translateX(${Math.min(100, edge(composedThrough + 1) * 100)}%)` }}>
            <span className="tl__marker-line" />
          </div>
        )}

        {/* Where the music is: driven per frame from the engine playhead. */}
        {nowIndex !== null && (
          <div
            ref={nowMarker}
            className="tl__marker tl__marker--now"
            style={{ transform: `translateX(${Math.min(100, edge(nowIndex) * 100).toFixed(3)}%)` }}
          >
            <span className="tl__marker-line" />
            <span className={`tl__marker-head${holding ? ' is-holding' : ''}`}>
              {holding && <Fermata className="tl__marker-fermata" />}
            </span>
          </div>
        )}
      </div>
    </section>
  );
});
