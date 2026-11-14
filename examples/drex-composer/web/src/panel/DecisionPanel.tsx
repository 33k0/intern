import { memo, useEffect, useMemo } from 'react';
import type { CallView } from '../../../shared/types';
import { atClock, callLabel, isJudgeCall, plainTerms } from '../format';
import { useSel } from '../store';
import { QuestionFull } from './Questions';
import './decision.css';

/** The question Drex is answering now, at reading size, and a log of the calls around it. */
interface Props {
  /** The decision held on screen, shared with the theory panel so both show the same one. */
  pinnedId: number | null;
  setPinnedId(id: number | null): void;
}

export const DecisionPanel = memo(function DecisionPanel({ pinnedId, setPinnedId }: Props) {
  const live = useSel((s) => s.featured);
  const calls = useSel((s) => s.calls);

  const pinned = pinnedId === null ? null : calls.find((c) => c.id === pinnedId) ?? null;
  useEffect(() => {
    // The pinned call scrolled out of the log, or a new run began.
    if (pinnedId !== null && !pinned) setPinnedId(null);
  }, [pinnedId, pinned, setPinnedId]);

  const call = pinned ?? live;
  // The whole history, newest first.
  const recent = useMemo(() => [...calls].reverse(), [calls]);
  const total = useSel((s) => s.stats.calls);

  return (
    <section className="panel decision" aria-label="Drex decisions">
      <div className="panel__head">
        <h2 className="panel__title">Drex's decision</h2>
        {pinned ? (
          <button type="button" className="tag tag--accent decision__unpin" onClick={() => setPinnedId(null)}>
            Back to live
          </button>
        ) : (
          total > 0 && <span className="panel__meta"><b className="mono">{total}</b> decisions so far</span>
        )}
      </div>
      <p className="panel__explain">Drex answers a question for every musical choice.</p>

      <div className="decision__slot">
        {call ? (
          <CallCard key={call.id} call={call} />
        ) : (
          <div className="panel__empty">
            <strong>Waiting for the first question</strong>
          </div>
        )}
      </div>

      <div className="ticker">
        <div className="ticker__head">
          <span className="panel__title">History</span>
          <span className="panel__meta">click to keep one on screen</span>
        </div>
        <ol className="ticker__list scroll">
          {recent.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`tick${c.id === call?.id ? ' is-shown' : ''}${isJudgeCall(c.callType) ? ' is-judge' : ''}`}
                aria-pressed={c.id === pinnedId}
                onClick={() => setPinnedId(c.id === pinnedId ? null : c.id)}
              >
                <span className="tick__at mono">{atClock(c.at)}</span>
                <span className="tick__type">{callLabel(c.callType)}</span>
                <span className="tick__title">{plainTerms(c.title)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
});

interface CallCardProps {
  call: CallView;
}

const CallCard = memo(function CallCard({ call }: CallCardProps) {
  // In a real-Drex session, a call the local stand-in answered must say so.
  const flagStandin = useSel((s) => call.standin && s.session?.standin === false);

  return (
    <div className="call">
      <div className="call__head">
        <h3 className="call__title" title={plainTerms(call.title)}>{plainTerms(call.title)}</h3>
        {flagStandin && <span className="tag tag--reject call__standin">stand-in answer</span>}
      </div>

      <div className="call__body scroll">
        {/* Only the main question: the follow-up "why" questions are detail nobody needs at a glance. */}
        {call.questions[0] && <QuestionFull q={call.questions[0]} />}
        {call.questions.length === 0 && <p className="call__none">This call carried no questions.</p>}
      </div>
    </div>
  );
});
