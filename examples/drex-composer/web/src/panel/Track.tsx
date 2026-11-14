import { memo, useMemo, useRef, useState } from 'react';
import { controller } from '../controller';
import { engineRef } from '../engineBridge';
import { clock } from '../format';
import { useSel } from '../store';
import { useFrame } from './useFrame';
import './track.css';

/** The piece laid out in time: its sections, how much is written, where the music is, and the controls to move around. */
export const Track = memo(function Track() {
  const plan = useSel((s) => s.plan);
  const phrases = useSel((s) => s.phrases);
  const composedThrough = useSel((s) => s.composedThrough);
  const nowIndex = useSel((s) => s.nowIndex);
  const phase = useSel((s) => s.phase);
  const error = useSel((s) => s.error);
  const holding = useSel((s) => s.hold.active);
  const [ui, setUi] = useState({ seekable: false, playing: false });

  const total = plan ? Math.max(1, plan.totalPhrases, composedThrough + 1) : 0;
  // Laid out by time, not phrase count. Phrases not yet written take the planned length.
  const { edges, seconds } = useMemo(() => {
    const secs = Array.from({ length: total }, (_x, i) => {
      const p = phrases[i];
      return p ? (p.beats * 60) / p.bpm : plan?.phraseSec ?? 1;
    });
    const sum = secs.reduce((a, b) => a + b, 0) || 1;
    const out = [0];
    for (const x of secs) out.push(out[out.length - 1] + x / sum);
    return { edges: out, seconds: sum };
  }, [total, phrases, plan]);
  const edge = (i: number): number => edges[Math.max(0, Math.min(total, i))] ?? 0;

  const fill = useRef<HTMLSpanElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const lastTime = useRef('');

  useFrame(() => {
    const p = controller.position();
    if (p.seekable !== ui.seekable || p.playing !== ui.playing) setUi({ seekable: p.seekable, playing: p.playing });

    let frac = 0;
    let length = seconds;
    if (p.seekable && p.total > 0) {
      frac = p.sec / p.total;
      length = p.total;
    } else {
      const ph = engineRef.current?.playhead();
      if (ph && ph.index >= 0 && total > 0) {
        const within = ph.beats > 0 ? Math.max(0, Math.min(1, ph.beat / ph.beats)) : 0;
        frac = edge(ph.index) + within * (edge(ph.index + 1) - edge(ph.index));
      }
    }
    frac = Math.max(0, Math.min(1, frac));
    if (fill.current) fill.current.style.transform = `scaleX(${frac.toFixed(4)})`;
    if (head.current) head.current.style.left = `${(frac * 100).toFixed(3)}%`;
    const text = total > 0 ? `${clock(frac * length)} / ${clock(length)}` : '0:00';
    if (time.current && text !== lastTime.current) {
      lastTime.current = text;
      time.current.textContent = text;
    }
  });

  const seekTo = (clientX: number, box: DOMRect): void => {
    const p = controller.position();
    if (!p.seekable) return;
    controller.seek(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * p.total);
  };

  let status = 'Composing';
  if (error) status = 'Error';
  else if (phase === 'starting') status = 'Starting';
  else if (phase === 'stopped') status = 'Stopped';
  else if (phase === 'finished') status = 'Finished';
  else if (holding) status = 'Waiting for Drex';
  else if (ui.seekable) status = ui.playing ? 'Playing' : 'Paused';
  else if (nowIndex !== null) status = plan && composedThrough + 1 >= plan.totalPhrases ? 'Playing' : 'Playing while Drex composes';
  const tone = error || holding ? ' tag--reject' : status.startsWith('Playing') || status === 'Finished' ? ' tag--accent' : '';

  return (
    <section className="panel track" aria-label="Track">
      <div className="track__controls" role="group" aria-label="Playback">
        {ui.seekable ? (
          <>
            <button type="button" className="track__btn" onClick={() => controller.skip(-10)} aria-label="Back 10 seconds"><Skip back /></button>
            <button type="button" className="track__btn track__btn--main" onClick={() => controller.togglePlay()}>
              {ui.playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="track__btn" onClick={() => controller.skip(10)} aria-label="Forward 10 seconds"><Skip /></button>
          </>
        ) : (
          <span className={`tag${tone}`}>{status}</span>
        )}
      </div>

      <div className="track__body">
        <div
          className={`track__lane${ui.seekable ? ' is-seekable' : ''}`}
          onClick={(e) => seekTo(e.clientX, e.currentTarget.getBoundingClientRect())}
          title={ui.seekable ? 'Click to jump' : undefined}
        >
          {!plan && <span className="track__waiting">{error ?? 'Drex is planning the piece…'}</span>}
          {/* Not written yet: dimmed until Drex composes it. */}
          {plan && composedThrough + 1 < total && (
            <span className="track__unwritten" style={{ left: `${edge(composedThrough + 1) * 100}%` }} />
          )}
          <span ref={fill} className="track__fill" />
          <span ref={head} className="track__head" />
        </div>
        {error && plan && <p className="track__error" role="alert">{error}</p>}
      </div>

      <span ref={time} className="track__time mono">0:00</span>
    </section>
  );
});

/** A double arrow: back or forward ten seconds. */
function Skip({ back }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" style={back ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M2 1.5 9 7l-7 5.5zM11 1.5 18 7l-7 5.5z" fill="currentColor" />
    </svg>
  );
}
