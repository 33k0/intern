import { useCallback, useEffect, useState } from 'react';
import { controller } from '../controller';
import { store, useSel } from '../store';
import { DecisionPanel } from './DecisionPanel';
import { Header } from './Header';
import { LayersPanel } from './LayersPanel';
import { PromptStage } from './PromptStage';
import { RulesStrip } from './RulesStrip';
import { Timeline } from './Timeline';
import { TheoryPanel } from './TheoryPanel';
import { Track } from './Track';
import './app.css';

type Overlay = null | 'prompt' | 'saved';

export function App() {
  const phase = useSel((s) => s.phase);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [pinnedId, setPinnedId] = useState<number | null>(null);

  const idle = phase === 'idle';
  const stageOpen = idle || overlay !== null;

  const compose = useCallback((prompt: string) => {
    controller.compose(prompt);
    setOverlay(null);
  }, []);
  const openSavedTrack = useCallback((name: string, prompt: string) => {
    controller.openSaved(name, prompt);
    setOverlay(null);
  }, []);
  const openPrompt = useCallback(() => setOverlay('prompt'), []);
  const openSaved = useCallback(() => setOverlay('saved'), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const stop = useCallback(() => controller.stop(), []);

  // Esc closes the prompt overlay if a run is behind it; otherwise it stops the run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const current = store.getState().phase;
      if (overlay && current !== 'idle') {
        setOverlay(null);
        e.preventDefault();
      } else if (current === 'running' || current === 'starting') {
        controller.stop();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  return (
    <div className="app" data-phase={phase}>
      {!idle && (
        <div className="desk" aria-hidden={overlay ? true : undefined} inert={overlay ? true : undefined}>
          <Header onStop={stop} onNewPrompt={openPrompt} onSavedTracks={openSaved} />
          <RulesStrip />
          <main className="desk__main">
            <DecisionPanel pinnedId={pinnedId} setPinnedId={setPinnedId} />
            <TheoryPanel />
            <LayersPanel onNewPrompt={openPrompt} />
          </main>
          <Timeline />
          <Track />
        </div>
      )}
      {stageOpen && (
        <PromptStage
          key={overlay ?? 'idle'}
          overlay={!idle}
          startWithSaved={overlay === 'saved'}
          onSubmit={compose}
          onOpenSaved={openSavedTrack}
          onClose={closeOverlay}
        />
      )}
    </div>
  );
}
