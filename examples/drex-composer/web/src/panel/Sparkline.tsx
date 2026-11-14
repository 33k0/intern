import { memo, useMemo } from 'react';

interface Note { midi: number; t: number; dur: number }

const W = 100;
const H = 40;
const PAD_Y = 5;

/** A small piano roll: one bar per note, pitch up the page, joined by a faint contour line. */
export const Sparkline = memo(function Sparkline({ notes, className }: { notes: Note[]; className?: string }) {
  const shape = useMemo(() => {
    if (notes.length === 0) return null;
    const sorted = [...notes].sort((a, b) => a.t - b.t);
    const start = Math.min(...sorted.map((n) => n.t));
    const end = Math.max(...sorted.map((n) => n.t + Math.max(0.05, n.dur)));
    const lo = Math.min(...sorted.map((n) => n.midi));
    const hi = Math.max(...sorted.map((n) => n.midi));
    // Never zoom in further than a fifth, so a nearly flat line does not look like a leap.
    const span = Math.max(7, hi - lo);
    const floor = (lo + hi) / 2 - span / 2;
    const x = (t: number): number => ((t - start) / Math.max(0.001, end - start)) * W;
    const y = (m: number): number => H - PAD_Y - ((m - floor) / span) * (H - PAD_Y * 2);
    const thick = Math.max(2.4, Math.min(4.6, (H - PAD_Y * 2) / span));
    const bars = sorted.map((n) => ({
      x: x(n.t),
      w: Math.max(1.2, x(n.t + n.dur) - x(n.t) - 0.9),
      y: y(n.midi) - thick / 2,
    }));
    const contour = sorted
      .map((n, i) => `${i === 0 ? 'M' : 'L'}${x(n.t).toFixed(2)},${y(n.midi).toFixed(2)} L${x(n.t + n.dur).toFixed(2)},${y(n.midi).toFixed(2)}`)
      .join(' ');
    return { bars, contour, thick };
  }, [notes]);

  return (
    <svg className={`spark${className ? ` ${className}` : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {shape && (
        <>
          <path className="spark__contour" d={shape.contour} fill="none" vectorEffect="non-scaling-stroke" />
          {shape.bars.map((b, i) => (
            <rect key={i} className="spark__note" x={b.x} y={b.y} width={b.w} height={shape.thick} rx={0.6} />
          ))}
        </>
      )}
    </svg>
  );
});
