import { memo, useRef } from 'react';
import { engineRef } from '../engineBridge';
import { stageLabel } from '../format';
import { rejectedRoundCount } from '../state';
import { useSel } from '../store';
import { useFrame } from './useFrame';
import './status.css';

/** One line: what the composer is doing, and the running counts. */
export const StatusStrip = memo(function StatusStrip() {
  const stage = useSel((s) => s.stage);
  const message = useSel((s) => s.message);
  const error = useSel((s) => s.error);
  const phase = useSel((s) => s.phase);
  const holding = useSel((s) => s.hold.active);
  const stats = useSel((s) => s.stats);
  const total = useSel((s) => s.plan?.totalPhrases ?? null);
  const composed = useSel((s) => s.composedThrough + 1);
  const seenRejects = useSel(rejectedRoundCount);
  const seenHolds = useSel((s) => s.hold.count);
  const playing = useSel((s) => s.playbackStarted);
  const conn = useSel((s) => s.conn);

  let label = stageLabel(stage);
  let text = message;
  let tone: 'plain' | 'accent' | 'reject' = 'plain';
  if (error) {
    label = 'Error';
    text = error;
    tone = 'reject';
  } else if (phase === 'starting') {
    label = 'Starting';
    text = conn === 'open' || conn === 'mock'
      ? 'Sending the prompt to the composer'
      : 'Waiting for the composer server. The prompt will be sent as soon as it connects.';
  } else if (phase === 'stopped') {
    label = 'Stopped';
    text = 'Stopped by you. Start a new prompt whenever you like.';
  } else if (phase === 'finished') {
    label = 'Finished';
    text = 'The piece has played out.';
    tone = 'accent';
  } else if (holding) {
    label = 'Holding';
    tone = 'reject';
  } else if (stage === 'playing' || stage === 'composing') {
    tone = 'accent';
  }

  // The server's counts are authoritative; fall back to what this panel has seen itself.
  const rejects = Math.max(stats.rejects, seenRejects);
  const holds = Math.max(stats.holds, seenHolds);

  return (
    <footer className="status">
      <span className={`tag${tone === 'accent' ? ' tag--accent' : tone === 'reject' ? ' tag--reject' : ''}`}>{label}</span>
      <p key={text} className={`status__msg${tone === 'reject' ? ' is-reject' : ''}`} role="status" aria-live="polite">
        {text}
      </p>
      <dl className="status__stats" aria-label="Run counts: Drex calls, calls in the last minute, rejected rounds, holds, phrases composed">
        <Stat label="Calls" value={stats.calls} />
        <Stat label="Per minute" value={stats.callsLastMinute} />
        <Stat label="Rejected" value={rejects} tone={rejects > 0 ? 'reject' : undefined} />
        <Stat label="Holds" value={holds} tone={holds > 0 ? 'reject' : undefined} />
        <div className="stat">
          <dt>Phrases</dt>
          <dd className="mono">
            {Math.max(stats.composed, composed)}
            {total !== null && <span className="stat__of"> / {total}</span>}
          </dd>
        </div>
        {playing && <Buffer />}
      </dl>
    </footer>
  );
});

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'reject' }) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd key={value} className="mono">{value}</dd>
    </div>
  );
}

/** Accepted phrases queued ahead of the playhead, straight from the engine. */
const Buffer = memo(function Buffer() {
  const el = useRef<HTMLElement>(null);
  const last = useRef('');
  const frame = useRef(0);
  useFrame(() => {
    // Four updates a second is plenty for a readout.
    if (frame.current++ % 15 !== 0) return;
    const engine = engineRef.current;
    if (!el.current || !engine) return;
    let ahead = 0;
    try {
      ahead = engine.bufferedAhead();
    } catch {
      return;
    }
    const text = String(Math.max(0, Math.round(ahead)));
    if (text !== last.current) {
      last.current = text;
      el.current.textContent = text;
    }
  });
  return (
    <div className="stat" title="Accepted phrases queued ahead of the playhead">
      <dt>Ahead</dt>
      <dd ref={el} className="mono">0</dd>
    </div>
  );
});
