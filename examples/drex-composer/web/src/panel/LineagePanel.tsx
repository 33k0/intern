import { memo, useMemo } from 'react';
import { lineageChain } from '../state';
import { useSel } from '../store';
import { Sparkline } from './Sparkline';
import './lineage.css';

/** Where each recent phrase came from, newest first, down to the themes they derive from. */
export const LineagePanel = memo(function LineagePanel() {
  const phrases = useSel((s) => s.phrases);
  const nowIndex = useSel((s) => s.nowIndex);
  const composedThrough = useSel((s) => s.composedThrough);
  const themes = useSel((s) => s.themes);

  const chain = useMemo(
    () => lineageChain({ phrases, nowIndex, composedThrough }, 5),
    [phrases, nowIndex, composedThrough],
  );

  return (
    <section className="panel lineage" aria-label="Lineage">
      <div className="panel__head">
        <h2 className="panel__title">Lineage</h2>
        <span className="panel__meta">every phrase is derived from a theme</span>
      </div>
      <div className="lineage__body">
        <ol className="lineage__chain scroll">
          {chain.map((e) => (
            <li key={e.index} className={`lin${e.sounding ? ' is-sounding' : ''}${e.ahead ? ' is-ahead' : ''}`}>
              <span className="lin__n">
                phrase <b className="mono">{e.index + 1}</b>
              </span>
              <span className="lin__eq" aria-hidden="true">=</span>
              <span className="lin__text" title={e.lineage}>{e.lineage}</span>
              <span className="lin__state">{e.sounding ? 'sounding' : e.ahead ? 'ahead' : ''}</span>
            </li>
          ))}
        </ol>
        {themes.length > 0 && (
          <ul className="lineage__themes">
            {themes.map((t) => (
              <li key={t.id} className="theme">
                <span className="theme__id">{t.id}</span>
                <span className="theme__roll">
                  <Sparkline notes={t.notes} />
                </span>
                <span className="theme__meta">
                  <span className="theme__kind">{t.kind === 'main' ? 'main theme' : `${t.kind} theme`}</span>
                  <span className="theme__notation mono" title={t.notation}>{t.notation}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
});
