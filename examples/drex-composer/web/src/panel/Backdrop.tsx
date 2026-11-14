import { memo, useEffect, useRef, useState } from 'react';
import { engineRef } from '../engineBridge';
import { backdropUrl } from '../format';
import { useSel } from '../store';
import { prefersReducedMotion, useFrame } from './useFrame';

interface Layer { key: number; url: string; shown: boolean }

/** Full-bleed image behind the desk. New images are decoded first, then cross-faded in. */
export const Backdrop = memo(function Backdrop() {
  const backdrop = useSel((s) => s.backdrop);
  const [layers, setLayers] = useState<Layer[]>([]);
  const seq = useRef(0);
  const scrim = useRef<HTMLDivElement>(null);
  const lift = useRef(0);
  const still = useRef(prefersReducedMotion());

  useEffect(() => {
    if (!backdrop) {
      // New run: fade whatever is showing back to the plain ground.
      setLayers((prev) => prev.map((l) => ({ ...l, shown: false })));
      const t = window.setTimeout(() => setLayers((prev) => prev.filter((l) => l.shown)), 2000);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    const url = backdropUrl(backdrop.file);
    const key = ++seq.current;
    const img = new Image();
    let cleanup = 0;
    img.onload = () => {
      if (cancelled) return;
      setLayers((prev) => [...prev, { key, url, shown: false }]);
      // Next frame: flip to shown so the opacity transition runs, and retire the older ones.
      requestAnimationFrame(() => {
        if (cancelled) return;
        setLayers((prev) => prev.map((l) => ({ ...l, shown: l.key === key })));
        cleanup = window.setTimeout(() => setLayers((prev) => prev.filter((l) => l.key === key)), 2200);
      });
    };
    img.onerror = () => {
      console.warn('[panel] backdrop image did not load:', url.slice(0, 80));
    };
    img.src = url;
    return () => {
      cancelled = true;
      window.clearTimeout(cleanup);
    };
  }, [backdrop]);

  useFrame(() => {
    if (still.current || !scrim.current) return;
    const engine = engineRef.current;
    let target = 0;
    if (engine) {
      try {
        target = Math.max(0, Math.min(1, engine.masterLevel()));
      } catch {
        target = 0;
      }
    }
    const next = lift.current + (target - lift.current) * 0.06;
    if (Math.abs(next - lift.current) < 0.002) return;
    lift.current = next;
    scrim.current.style.setProperty('--lift', next.toFixed(3));
  });

  return (
    <div className="backdrop" aria-hidden="true">
      {layers.map((l) => (
        <div
          key={l.key}
          className={`backdrop__image${l.shown ? ' is-in' : ''}`}
          style={{ backgroundImage: `url("${l.url}")` }}
        />
      ))}
      <div ref={scrim} className="backdrop__scrim" />
    </div>
  );
});
