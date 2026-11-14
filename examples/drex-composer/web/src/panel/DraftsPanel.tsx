import { memo, useEffect, useState, type CSSProperties } from 'react';
import type { DraftView } from '../../../shared/types';
import { pct } from '../format';
import type { DraftRound } from '../state';
import { useSel } from '../store';
import { Sparkline } from './Sparkline';
import './drafts.css';

const EXPLAIN = 'Drex writes a few versions of each part, then picks the best one or rejects them all.';

function roundSubject(r: DraftRound): string {
  return r.kind === 'theme' ? `Theme ${r.themeId ?? ''}`.trim() : `Phrase ${(r.phrase ?? 0) + 1}`;
}

function draftName(_id: string, position: number): string {
  return `Version ${position + 1}`;
}

/** The drafts for the latest judge round, and what the judge did with them. */
export const DraftsPanel = memo(function DraftsPanel() {
  const focus = useSel((s) => s.focusRound);
  const lastRejection = useSel((s) => s.lastRejection);
  const phraseRounds = useSel((s) => s.phraseRounds);
  const themeRounds = useSel((s) => s.themeRounds);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!lastRejection) setReviewing(false);
  }, [lastRejection]);

  const round = reviewing && lastRejection ? lastRejection : focus;

  if (!round) {
    return (
      <section className="panel drafts" aria-label="Drafts">
        <div className="panel__head">
          <h2 className="panel__title">Versions</h2>
        </div>
        <p className="panel__explain">{EXPLAIN}</p>
        <div className="panel__empty">
          <strong>No versions yet</strong>
        </div>
      </section>
    );
  }

  // Earlier rounds for the same theme or phrase: the rejections that led here.
  const siblings = round.kind === 'phrase' ? phraseRounds[round.phrase ?? -1] ?? [] : themeRounds.filter((r) => r.themeId === round.themeId);
  const earlier = siblings.filter((r) => r.seq < round.seq && r.rejected);
  const n = round.drafts.length;
  const dense = n > 4;
  // Wide, short cards read as a melody line; two across for up to four versions, three beyond.
  const columns = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const picked = round.drafts.findIndex((d) => d.id === round.verdict.picked);
  // Offer the last rejection only when it is not already on screen (as this round or in the list above).
  const offerReview = Boolean(lastRejection) && lastRejection !== focus && !earlier.includes(lastRejection!);

  return (
    <section className={`panel drafts${round.rejected ? ' is-rejected' : ''}`} aria-label="Drafts">
      <div className="panel__head">
        <h2 className="panel__title">Versions</h2>
        <span className="drafts__where">
          {reviewing && <span className="tag">Reviewing</span>}
          <span className="drafts__subject">
            {roundSubject(round)}
            {round.round > 1 && <>, try <span className="mono">{round.round}</span></>}
          </span>
          {round.rejected ? (
            <span key={round.seq} className="tag tag--reject">All {n} rejected</span>
          ) : (
            <span key={round.seq} className="tag tag--accent">Picked {picked >= 0 ? draftName(round.drafts[picked].id, picked) : ''}</span>
          )}
        </span>
      </div>
      <p className="panel__explain">{EXPLAIN}</p>

      {earlier.length > 0 && (
        <ol className="drafts__earlier">
          {earlier.map((r) => (
            <li key={r.seq}>
              <span className="drafts__earlier-tag">Try {r.round} rejected</span>
              <span className="drafts__earlier-reason">{r.verdict.reason}</span>
            </li>
          ))}
        </ol>
      )}

      <ol
        key={round.seq}
        className={`drafts__grid${dense ? ' is-dense' : ''}`}
        style={{ '--cols': columns } as CSSProperties}
      >
        {round.drafts.map((d, i) => (
          <DraftCard
            key={d.id}
            draft={d}
            position={i}
            state={round.rejected ? 'rejected' : d.id === round.verdict.picked ? 'picked' : 'passed'}
            probability={round.verdict.probabilities[d.id]}
          />
        ))}
      </ol>

{/* An accepted round always gives the same stock reason, so only a rejection is explained. */}
      {round.rejected && (
        <p key={`v${round.seq}`} className={`verdict${round.rejected ? ' verdict--reject' : ''}`}>
        <span className="verdict__who">{round.rejected ? 'Rejected all' : 'Why'}</span>
        <span className="verdict__reason">{round.verdict.reason}</span>
      </p>
      )}

      {(offerReview || reviewing) && lastRejection && (
        <div className="drafts__foot">
          <span>
            Last rejection: {roundSubject(lastRejection).toLowerCase()}, all {lastRejection.drafts.length} versions turned down
          </span>
          <button type="button" className="drafts__review" onClick={() => setReviewing((v) => !v)} aria-pressed={reviewing}>
            {reviewing ? 'Back to live' : 'Show it'}
          </button>
        </div>
      )}
    </section>
  );
});

interface CardProps {
  draft: DraftView;
  position: number;
  state: 'picked' | 'passed' | 'rejected';
  probability: number | undefined;
}

const DraftCard = memo(function DraftCard({ draft, position, state, probability }: CardProps) {
  const stamp = state === 'picked' ? 'Picked' : state === 'rejected' ? 'Rejected' : '';
  return (
    <li className={`draft is-${state}`} style={{ '--i': position } as CSSProperties}>
      <div className="draft__head">
        <span className="draft__id">{draftName(draft.id, position)}</span>
        <span className="draft__stamp">{stamp}</span>
        {probability !== undefined && <span className="draft__p mono" title="How much Drex liked this version">{pct(probability)}</span>}
      </div>
      <div className="draft__roll">
        <Sparkline notes={draft.notes} />
        <span className="draft__strike" aria-hidden="true" />
      </div>
    </li>
  );
});
