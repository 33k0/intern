import { memo, useEffect, useRef, useState, type FormEvent } from 'react';
import { titleFromPrompt } from '../format';
import { useSel } from '../store';
import { replayName } from '../transport';
import { ConnBadge } from './Header';
import './promptStage.css';

const EXAMPLES = [
  'rain on a tin roof at 3am, missing someone',
  'a robot learning to dance',
  'sunrise over a frozen lake',
  'boss fight in a neon arcade',
  'a kitten discovering snow',
];

interface Props {
  /** True when a run is still on the desk behind this (Esc returns to it). */
  overlay: boolean;
  /** Open with the saved-tracks list showing. */
  startWithSaved?: boolean;
  onSubmit(prompt: string): void;
  onOpenSaved(name: string, prompt: string): void;
  onClose(): void;
}

export const PromptStage = memo(function PromptStage({ overlay, startWithSaved, onSubmit, onOpenSaved, onClose }: Props) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const conn = useSel((s) => s.conn);
  const audio = useSel((s) => s.audio.mode);

  const replay = replayName();
  const [runs, setRuns] = useState<{ name: string; prompt: string }[]>([]);
  const [showSaved, setShowSaved] = useState(Boolean(startWithSaved));

  useEffect(() => {
    input.current?.focus();
  }, []);

  // The saved tracks. In replay mode this run's prompt is filled in, so Enter plays it.
  useEffect(() => {
    fetch('/api/replays')
      .then((res) => res.json() as Promise<{ runs: { name: string; prompt: string }[] }>)
      .then(({ runs: list }) => {
        setRuns(list);
        if (!replay) return;
        const mine = list.find((r) => r.name === replay);
        setValue((v) => v || mine?.prompt || replay);
      })
      .catch(() => { if (replay) setValue((v) => v || replay); });
  }, [replay]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (value.trim()) onSubmit(value);
  };

  const pick = (text: string): void => {
    setValue(text);
    input.current?.focus();
  };

  const note = conn === 'replay'
    ? 'This is a saved track. Press Play to hear it.'
    : conn === 'mock'
    ? 'Mock feed: a scripted run, not the real Drex.'
    : conn === 'open'
      ? null
      : 'Waiting for the composer server. Your prompt will be sent as soon as it connects.';

  return (
    <div className={`stage${overlay ? ' stage--overlay' : ''}`} role={overlay ? 'dialog' : undefined} aria-modal={overlay || undefined} aria-label="New prompt">
      <div className="stage__inner">
        <div className="stage__brand">
          Drex <span>Composer</span>
        </div>
        <h1 className="stage__title">{replay ? 'Saved track' : 'What should Drex compose?'}</h1>
        <p className="stage__lede">
          Drex cannot write a word. It only answers multiple-choice questions, and every answer becomes part of the music.
        </p>

        <form className="stage__form" onSubmit={submit}>
          <label htmlFor="prompt">Prompt</label>
          <div className="stage__row">
            <input
              ref={input}
              id="prompt"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="a mood, a place, a scene"
              autoComplete="off"
              spellCheck={false}
              maxLength={240}
              readOnly={Boolean(replay)}
            />
            <button type="submit" className="btn btn--primary stage__go" disabled={!value.trim()}>
              {replay ? 'Play' : 'Compose'} <kbd>Enter</kbd>
            </button>
          </div>
        </form>

        <div className="stage__tabs">
          <button type="button" className="btn" onClick={() => setShowSaved((v) => !v)} aria-expanded={showSaved}>
            {showSaved ? 'Hide saved tracks' : `Saved tracks${runs.length ? ` (${runs.length})` : ''}`}
          </button>
          {replay && <a className="btn" href="/">Compose something new</a>}
        </div>

        {showSaved ? (
          runs.length > 0 ? (
            <ul className="stage__saved scroll" aria-label="Saved tracks">
              {runs.map((r) => (
                <li key={r.name}>
                  <a
                    className="saved"
                    href={`?replay=${encodeURIComponent(r.name)}`}
                    aria-current={r.name === replay || undefined}
                    onClick={(e) => {
                      // Plain click: open and play right here. Modified clicks (new tab) keep the link.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onOpenSaved(r.name, r.prompt);
                    }}
                  >
                    <span className="saved__title">{titleFromPrompt(r.prompt || r.name)}</span>
                    <span className="saved__name">{r.name === replay ? 'open now' : r.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="stage__none">No saved tracks yet.</p>
          )
        ) : !replay && (
          <ul className="stage__chips" aria-label="Example prompts">
            {EXAMPLES.map((text) => (
              <li key={text}>
                <button type="button" className="chip" onClick={() => pick(text)}>
                  {text}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="stage__foot">
          <ConnBadge />
          {audio === 'pending' && <span>Audio engine loading</span>}
          {audio === 'silent' && <span className="stage__warn">Audio engine unavailable: the panel will run silently</span>}
          {note && <span>{note}</span>}
          {overlay && (
            <button type="button" className="btn stage__back" onClick={onClose}>
              Back to the desk <kbd>Esc</kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
