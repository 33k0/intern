import { memo, useRef, useState } from 'react';
import { controller } from '../controller';
import { useFrame } from './useFrame';
import './seekbar.css';

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Play, pause and move through a saved run. Hidden while a piece is being composed live. */
export const SeekBar = memo(function SeekBar() {
  const [state, setState] = useState({ seekable: false, playing: false, total: 0 });
  const range = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  useFrame(() => {
    const p = controller.position();
    if (p.seekable !== state.seekable || p.playing !== state.playing || p.total !== state.total) {
      setState({ seekable: p.seekable, playing: p.playing, total: p.total });
    }
    if (!p.seekable) return;
    if (range.current && !dragging.current) range.current.value = String(p.sec);
    if (label.current) label.current.textContent = `${clock(p.sec)} / ${clock(p.total)}`;
  });

  if (!state.seekable) return null;
  return (
    <div className="seek" role="group" aria-label="Playback">
      <button type="button" className="seek__btn" onClick={() => controller.skip(-10)} aria-label="Back 10 seconds">−10 s</button>
      <button type="button" className="seek__btn seek__btn--main" onClick={() => controller.togglePlay()}>{state.playing ? 'Pause' : 'Play'}</button>
      <button type="button" className="seek__btn" onClick={() => controller.skip(10)} aria-label="Forward 10 seconds">+10 s</button>
      <input
        ref={range} className="seek__range" type="range" min={0} max={state.total} step={0.1} defaultValue={0}
        aria-label="Position in the piece"
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onChange={(e) => controller.seek(Number(e.currentTarget.value))}
      />
      <span ref={label} className="seek__time mono">0:00 / {clock(state.total)}</span>
    </div>
  );
});
