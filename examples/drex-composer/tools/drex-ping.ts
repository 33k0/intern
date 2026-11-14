// First live check: one tiny request to Drex, raw response printed, then the same questions through
// the project's gateway so its parsing is checked against what the API actually returns.
//   npm run ping
// Costs a few hundred input tokens.

import { apiKey, Gateway } from '../server/gateway/gateway.ts';
import { modelFor } from '../server/gateway/models.ts';

const key = apiKey();
if (!key) {
  console.error('No NACE_API_KEY in .env (it must start with nace_sk_). Paste your key from console.nace.ai, then run again.');
  process.exit(1);
}

const model = modelFor('setup');
const state = 'PROMPT  "a quiet piece about swimming alone at night"';
const body = {
  model,
  state,
  questions: {
    style: {
      type: 'choice',
      instructions: 'Which style sheet suits this prompt?',
      criteria: {
        bittersweet_orchestral: 'Bittersweet orchestral: piano and strings, slow, quiet start to a huge climax',
        beat_driven: 'Beat-driven: steady 4/4 pulse, sub bass, filter builds and drops',
        playful: 'Playful: bright modes, pizzicato, bouncing rhythms, sudden stops',
      },
    },
    water: { type: 'noul', instructions: 'Should the water-and-wave noise texture be part of the palette?' },
    tension: { type: 'score', instructions: 'How much tension should the opening carry?', criteria: ['still', 'gentle', 'moving', 'urgent'] },
  },
};

const url = (process.env.DREX_API_URL ?? '').trim() || 'https://console.nace.ai/v1/systemone';
console.log(`POST ${url}  model=${model}`);
const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Nace-Legend': 'array' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(65_000),
});
const text = await res.text();
console.log(`HTTP ${res.status} in ${Date.now() - t0} ms`);
for (const h of ['x-request-id', 'retry-after-ms', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests']) {
  const v = res.headers.get(h);
  if (v) console.log(`  ${h}: ${v}`);
}
let json: any;
try {
  json = JSON.parse(text);
} catch {
  console.log(text);
  process.exit(1);
}
console.log(JSON.stringify(json, null, 2));
if (!res.ok) process.exit(1);

// Same questions through the project's gateway (the code path every musical decision uses).
const gw = new Gateway({ seed: 1 });
const ans = await gw.ask({
  callType: 'setup', title: 'ping', state, picking: 'top',
  questions: [
    { id: 'style', type: 'choice', label: 'style', instructions: body.questions.style.instructions,
      options: Object.entries(body.questions.style.criteria).map(([k, criteria]) => ({ key: k, label: k, criteria })) },
    { id: 'water', type: 'noul', label: 'water', instructions: body.questions.water.instructions },
    { id: 'tension', type: 'score', label: 'tension', instructions: body.questions.tension.instructions, levels: body.questions.tension.criteria },
  ],
});
console.log('\nThrough the gateway:', JSON.stringify({ model: ans.model, standin: ans.standin, picks: ans.picks[0], values: ans.values }, null, 2));
if (ans.standin) {
  console.error('The gateway fell back to the stand-in: the key was not picked up.');
  process.exit(1);
}
console.log(`\nOK. Billed input tokens for the raw call: ${json.usage?.input_tokens ?? 'not reported'}`);
