// How one Drex question is drawn: bars per option for a choice, a split bar for yes/no,
// a seven-step histogram for a score. Every number shown is a probability Drex returned.

import { memo, useMemo, type CSSProperties } from 'react';
import type { QuestionView } from '../../../shared/types';
import { humanize, pct, plainTerms } from '../format';

const MAX_CHOICE_ROWS = 5;

interface OptionRow {
  key: string;
  label: string;
  p: number;
  /** How many drafts went with this option (1 for a top pick, 0 if not picked). */
  picks: number;
}

function optionLabel(q: QuestionView, key: string): string {
  return plainTerms(q.options?.find((o) => o.key === key)?.label ?? humanize(key));
}

function optionRows(q: QuestionView): OptionRow[] {
  const keys: string[] = [];
  for (const o of q.options ?? []) keys.push(o.key);
  for (const k of Object.keys(q.probabilities)) if (!keys.includes(k)) keys.push(k);
  for (const k of q.picked) if (!keys.includes(k)) keys.push(k);
  const counts = new Map<string, number>();
  for (const k of q.picked) counts.set(k, (counts.get(k) ?? 0) + 1);
  return keys
    .map((key) => ({ key, label: optionLabel(q, key), p: q.probabilities[key] ?? 0, picks: counts.get(key) ?? 0 }))
    .sort((a, b) => b.p - a.p);
}

function yesProbability(q: QuestionView): number {
  const p = q.probabilities.yes ?? (q.probabilities.no !== undefined ? 1 - q.probabilities.no : 0);
  return Math.max(0, Math.min(1, p));
}

function PickingNote({ q }: { q: QuestionView }) {
  if (q.picking !== 'sampled') return null;
  const n = q.picked.length;
  return <span className="q__mode">sampled{n > 1 ? `, once per draft (${n})` : ''}</span>;
}

/** Height of a full-size question in rem (mirrors decision.css), used to decide how many fit. */
export function questionCost(q: QuestionView): number {
  if (q.type === 'noul') return 3.4;
  if (q.type === 'score') return 6.1;
  const n = Math.max(q.options?.length ?? 0, Object.keys(q.probabilities).length);
  return 1.6 + 1.78 * Math.min(MAX_CHOICE_ROWS, n) + (n > MAX_CHOICE_ROWS ? 1.3 : 0);
}

// ───────────────────────────── Full-size views ─────────────────────────────

export const QuestionFull = memo(function QuestionFull({ q }: { q: QuestionView }) {
  if (q.type === 'noul') return <NoulQuestion q={q} />;
  if (q.type === 'score') return <ScoreQuestion q={q} />;
  return <ChoiceQuestion q={q} />;
});

function ChoiceQuestion({ q }: { q: QuestionView }) {
  const { shown, hidden, hiddenP } = useMemo(() => {
    const all = optionRows(q);
    const top = all.slice(0, MAX_CHOICE_ROWS);
    // A sampled pick can sit below the cut: it is still shown.
    const extra = all.slice(MAX_CHOICE_ROWS).filter((r) => r.picks > 0);
    const visible = [...top, ...extra];
    const rest = all.filter((r) => !visible.includes(r));
    return { shown: visible, hidden: rest.length, hiddenP: rest.reduce((a, r) => a + r.p, 0) };
  }, [q]);

  return (
    <section className="q q--choice">
      <h3 className="q__label">
        {plainTerms(q.label)}
        <PickingNote q={q} />
      </h3>
      <ol className="bars">
        {shown.map((r, i) => (
          <li key={r.key} className={`bar${r.picks > 0 ? ' is-picked' : ''}`} style={{ '--i': i } as CSSProperties}>
            <span className="bar__label" title={r.label}>
              {r.label}
              {q.picking === 'sampled' && r.picks > 0 && (
                <span className="bar__picks mono" aria-label={`picked for ${r.picks} drafts`}>
                  {q.picked.length > 1 ? `×${r.picks}` : 'drawn'}
                </span>
              )}
            </span>
            <span className="bar__track" aria-hidden="true">
              <span className="bar__fill" style={{ transform: `scaleX(${Math.max(0.004, r.p)})` }} />
            </span>
            <span className="bar__p mono">{pct(r.p)}</span>
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <p className="q__rest">
          {hidden} more {hidden === 1 ? 'option' : 'options'}, <span className="mono">{pct(hiddenP)}</span> between them
        </p>
      )}
    </section>
  );
}

function NoulQuestion({ q }: { q: QuestionView }) {
  const yes = yesProbability(q);
  const yesPicks = q.picked.filter((k) => k === 'yes').length;
  const saidYes = q.picked.length > 0 ? yesPicks * 2 >= q.picked.length : yes >= 0.5;
  return (
    <section className="q q--noul">
      <h3 className="q__label">
        {plainTerms(q.label)}
        <PickingNote q={q} />
      </h3>
      <div className={`yn ${saidYes ? 'is-yes' : 'is-no'}`}>
        <span className="yn__side yn__side--yes">
          Yes <b className="mono">{pct(yes)}</b>
        </span>
        <span className="yn__bar" aria-hidden="true">
          <span className="yn__yes" style={{ transform: `scaleX(${yes})` }} />
          <span className="yn__no" style={{ transform: `scaleX(${1 - yes})` }} />
        </span>
        <span className="yn__side yn__side--no">
          <b className="mono">{pct(1 - yes)}</b> No
        </span>
      </div>
    </section>
  );
}

function ScoreQuestion({ q }: { q: QuestionView }) {
  const levels = useMemo(() => {
    const n = q.options?.length ?? Math.max(7, Object.keys(q.probabilities).length);
    const out = Array.from({ length: n }, (_, i) => {
      const key = q.options?.[i]?.key ?? String(i);
      return { key, label: q.options?.[i]?.label ?? String(i + 1), p: q.probabilities[key] ?? 0, picked: q.picked.includes(key) };
    });
    const max = Math.max(0.0001, ...out.map((l) => l.p));
    return out.map((l) => ({ ...l, h: l.p / max }));
  }, [q]);
  const picked = levels.find((l) => l.picked);

  return (
    <section className="q q--score">
      <h3 className="q__label">
        {plainTerms(q.label)}
        <PickingNote q={q} />
        {picked && (
          <span className="q__answer">
            {picked.label} <b className="mono">{pct(picked.p)}</b>
          </span>
        )}
      </h3>
      <ol className="hist">
        {levels.map((l, i) => (
          <li key={l.key} className={`hist__col${l.picked ? ' is-picked' : ''}`} style={{ '--i': i } as CSSProperties}>
            <span className="hist__bar" aria-hidden="true">
              <span className="hist__fill" style={{ transform: `scaleY(${Math.max(0.02, l.h)})` }} />
            </span>
            <span className="hist__label">{l.label}</span>
            <span className="visually-hidden">{pct(l.p)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ───────────────────────────── One-line summary ─────────────────────────────

/** A question reduced to "label, what Drex went with, how sure". */
export const QuestionCompact = memo(function QuestionCompact({ q }: { q: QuestionView }) {
  const { answer, p, extra } = useMemo(() => summarise(q), [q]);
  return (
    <li className="qc">
      <span className="qc__label" title={plainTerms(q.label)}>{plainTerms(q.label)}</span>
      <span className="qc__answer" title={answer}>
        {answer}
        {extra && <span className="qc__extra">{extra}</span>}
      </span>
      <span className="qc__p mono">{pct(p)}</span>
      <span className="qc__bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.max(0.004, p)})` }} />
      </span>
    </li>
  );
});

function summarise(q: QuestionView): { answer: string; p: number; extra: string | null } {
  if (q.type === 'noul') {
    const yes = yesProbability(q);
    const yesPicks = q.picked.filter((k) => k === 'yes').length;
    const saidYes = q.picked.length > 0 ? yesPicks * 2 >= q.picked.length : yes >= 0.5;
    return { answer: saidYes ? 'Yes' : 'No', p: saidYes ? yes : 1 - yes, extra: null };
  }
  const rows = optionRows(q);
  const picked = rows.filter((r) => r.picks > 0).sort((a, b) => b.picks - a.picks || b.p - a.p);
  const lead = picked[0] ?? rows[0];
  if (!lead) return { answer: 'no answer', p: 0, extra: null };
  const others = picked.length - 1;
  return { answer: lead.label, p: lead.p, extra: others > 0 ? `+${others} more` : null };
}
