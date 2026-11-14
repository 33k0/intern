import { memo, useState } from 'react';
import { modelBadge, titleFromPrompt } from '../format';
import { useSel } from '../store';
import './header.css';

interface Props {
  onStop(): void;
  onNewPrompt(): void;
  onSavedTracks(): void;
}

export const Header = memo(function Header({ onStop, onNewPrompt, onSavedTracks }: Props) {
  const session = useSel((s) => s.session);
  const pending = useSel((s) => s.pendingPrompt);
  const phase = useSel((s) => s.phase);
  const prompt = session?.prompt ?? pending ?? '';
  const live = phase === 'running' || phase === 'starting';
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <header className="top">
      <div className="top__brand">
        Drex <span>Composer</span>
      </div>
      <div className="top__piece">
        <h1 className="top__title title-text">{titleFromPrompt(prompt)}</h1>
        <button type="button" className="top__reveal" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}>
          {showPrompt ? 'Hide prompt' : 'Show prompt'}
        </button>
        {showPrompt && <p className="top__summary">“{prompt}”</p>}
      </div>
      <div className="top__right">
        <ModelBadge />
        <AudioBadge />
        {live && (
          <button type="button" className="btn" onClick={onStop}>
            Stop <kbd>Esc</kbd>
          </button>
        )}
        <button type="button" className="btn" onClick={onSavedTracks}>
          Saved tracks
        </button>
        <button type="button" className={`btn${live ? '' : ' btn--primary'}`} onClick={onNewPrompt}>
          New prompt
        </button>
      </div>
    </header>
  );
});

/** Who is answering. A stand-in is never dressed up as the real model. */
const ModelBadge = memo(function ModelBadge() {
  const session = useSel((s) => s.session);
  const mock = useSel((s) => s.conn === 'mock');
  if (!session) return null;
  if (mock) {
    return (
      <span className="badge badge--standin" role="status">
        <strong>Scripted</strong>
        <span>mock run, not Drex</span>
      </span>
    );
  }
  if (session.standin) {
    return (
      <span className="badge badge--standin" role="status">
        <strong>Stand-in</strong>
        <span>no Drex key</span>
      </span>
    );
  }
  return (
    <span className="badge badge--model">
      <strong>{modelBadge(session.model)}</strong>
    </span>
  );
});

const AudioBadge = memo(function AudioBadge() {
  const mode = useSel((s) => s.audio.mode);
  if (mode === 'real') return null;
  if (mode === 'pending') {
    return (
      <span className="badge">
        <span>Audio loading</span>
      </span>
    );
  }
  return (
    <span className="badge badge--standin" role="status" title="The audio engine could not start. The playhead is running on a timer.">
      <strong>Silent</strong>
      <span>no audio engine</span>
    </span>
  );
});

export const ConnBadge = memo(function ConnBadge() {
  const conn = useSel((s) => s.conn);
  const label = conn === 'open' ? 'Live' : conn === 'mock' ? 'Mock feed' : conn === 'replay' ? 'Saved run' : conn === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className={`conn conn--${conn}`} role="status">
      <i aria-hidden="true" />
      {label}
    </span>
  );
});
