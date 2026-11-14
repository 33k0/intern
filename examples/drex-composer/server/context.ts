import type { ServerEvent } from '../shared/types.ts';
import type { Rng } from './core/rng.ts';
import type { Gateway } from './gateway/gateway.ts';
import type { Piece } from './piece.ts';

/** Everything a call needs: the gateway to Drex, the piece so far, a seeded random source, and the panel feed. */
export interface Ctx {
  gw: Gateway;
  piece: Piece;
  rng: Rng;
  emit: (event: ServerEvent) => void;
}

export const TENSION_LEVELS = [
  '1: still and bare, almost nothing',
  '2: quiet, intimate',
  '3: gently moving',
  '4: warm and full',
  '5: urgent, building',
  '6: intense, near the peak',
  '7: overwhelming, the top of the piece',
];

export const AMOUNT_LEVELS = ['none', 'a trace', 'a little', 'moderate', 'clear', 'strong', 'maximum'];
export const DYNAMIC_LEVELS = [
  'pp: barely there',
  'p: soft',
  'mp: gentle',
  'mf: full but relaxed',
  'f: strong',
  'ff: very strong',
  'fff: everything',
];

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
