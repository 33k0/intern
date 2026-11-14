import { memo } from 'react';
import {
  ENDING_NAMES, FORM_NAMES, HARMONY_NAMES, KEYPLAN_NAMES, MODE_NAMES, WORLD_NAMES, clock,
  instrumentName,
} from '../format';
import { useSel } from '../store';
import './rules.css';

/** The rules Drex set for this piece, laid out like the head of a score. */
export const RulesStrip = memo(function RulesStrip() {
  const rules = useSel((s) => s.rules);
  const sessionId = useSel((s) => s.session?.id ?? 'none');

  if (!rules) {
    return (
      <section className="rules rules--empty panel" aria-label="Rules">
        <span className="panel__title">Rules</span>
        <span className="rules__waiting">Drex is choosing style, tempo, meter and key</span>
        <span className="rules__ghost" aria-hidden="true" />
      </section>
    );
  }

  return (
    // Keyed by session so a new prompt replays the reveal: different rules are the point.
    <section key={sessionId} className="rules panel" aria-label="Rules chosen by Drex">
      <Field label="Style" lead>{rules.styleName}</Field>

      <Field label="Tempo" lead>{rules.bpm} bpm</Field>
      <Field label="Key" lead>{rules.keyName.split(' ')[0]} {MODE_NAMES[rules.mode]}</Field>
      <Field label="Harmony">{HARMONY_NAMES[rules.harmonicLanguage]}</Field>
      <Field label="Sound world">{WORLD_NAMES[rules.soundWorld]}</Field>
      <Field label="Form">{FORM_NAMES[rules.form]}</Field>
      <Field label="Key plan">{KEYPLAN_NAMES[rules.keyPlan]}</Field>
      <Field label="Ending">{ENDING_NAMES[rules.ending]}</Field>
      <Field label="Length">
{clock(rules.lengthSec)}
      </Field>

      <div className="rules__field rules__palette">
        <span className="rules__label">Instruments</span>
        <span className="rules__value">{rules.palette.map(instrumentName).join(', ')}</span>
      </div>
    </section>
  );
});

function Field({ label, lead, children }: { label: string; lead?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rules__field${lead ? ' rules__field--lead' : ''}`}>
      <span className="rules__label">{label}</span>
      <span className="rules__value">{children}</span>
    </div>
  );
}
