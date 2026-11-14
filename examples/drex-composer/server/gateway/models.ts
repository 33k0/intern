// Which Drex model answers which call.
//
// Drex Max reads each question in full as its own sequence; the smaller models share one cached
// state. The plan is to test Max against drex-v2.0 per call type (npm run eval) and keep the
// better one. Until that has been run with a real key, every call uses DREX_MODEL.
// Calls that carry images must stay on a Max model.

import type { CallType } from '../../shared/types.ts';

const DEFAULT_MODEL = 'drex-max-v1.1';

/** Per-call overrides. Fill these in from `npm run eval -- --compare` results. */
export const MODEL_OVERRIDES: Partial<Record<CallType, string>> = {
  // voice_leading: 'drex-v2.0',
};

export function modelFor(callType: CallType, hasImages = false): string {
  const base = (process.env.DREX_MODEL ?? '').trim() || DEFAULT_MODEL;
  if (hasImages) return base.startsWith('drex-max') ? base : DEFAULT_MODEL;
  const env = process.env[`DREX_MODEL_${callType.toUpperCase()}`];
  return (env && env.trim()) || MODEL_OVERRIDES[callType] || base;
}
