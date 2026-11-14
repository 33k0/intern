// The real Drex client, checked against the documented request and response shapes with fetch stubbed.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DrexError, Gateway, type Question } from '../gateway/gateway.ts';

const questions: Question[] = [
  { id: 'style', type: 'choice', label: 'Style', instructions: 'Which style?', options: [{ key: 'a', label: 'A', criteria: 'first' }, { key: 'b', label: 'B', criteria: 'second' }] },
  { id: 'use_piano', type: 'noul', label: 'Piano', instructions: 'Use the piano?', yes: 'fits', no: 'does not fit' },
  { id: 'tension', type: 'score', label: 'Tension', instructions: 'How tense?', levels: ['low', 'mid', 'high'] },
];
const okBody = {
  model: 'drex-max-v1.1',
  answers: {
    style: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
    use_piano: { type: 'noul', noul: 0.8, confidence: 0.8 },
    tension: { type: 'score', score: 1.6, legend: ['low', 'mid', 'high'], probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.7 },
  },
  usage: { input_tokens: 10, output_tokens: 0 },
  evaluation_time_ms: 5,
  request_id: 'req_0',
};

const realFetch = globalThis.fetch;
const savedKey = process.env.NACE_API_KEY;
beforeEach(() => {
  process.env.NACE_API_KEY = `nace_sk_${'x'.repeat(43)}`;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.NACE_API_KEY;
  else process.env.NACE_API_KEY = savedKey;
});

test('sends the documented body and reads all three answer shapes', async () => {
  let sent: any = null;
  let headers: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://console.nace.ai/v1/systemone');
    sent = JSON.parse(init.body);
    headers = init.headers;
    return new Response(JSON.stringify(okBody), { status: 200 });
  }) as typeof fetch;
  const gw = new Gateway({ seed: 1 });
  assert.equal(gw.standin, false);
  const res = await gw.ask({ callType: 'setup', title: 't', state: 'STATE', questions, picking: 'top' });

  assert.equal(headers.Authorization, `Bearer nace_sk_${'x'.repeat(43)}`);
  assert.equal(sent.model, 'drex-max-v1.1');
  assert.equal(sent.state, 'STATE');
  assert.deepEqual(sent.questions.style, { type: 'choice', instructions: 'Which style?', criteria: { a: 'first', b: 'second' } });
  assert.deepEqual(sent.questions.use_piano, { type: 'noul', instructions: 'Use the piano?', criteria: { true: 'fits', false: 'does not fit' } });
  assert.deepEqual(sent.questions.tension, { type: 'score', instructions: 'How tense?', criteria: ['low', 'mid', 'high'] });
  assert.ok(!JSON.stringify(sent).includes('prior'), 'stand-in priors never leave the machine');

  assert.equal(res.picks[0].style, 'b');
  assert.equal(res.picks[0].use_piano, 'yes');
  assert.equal(res.picks[0].tension, '2', 'score top pick is the expected level, rounded');
  assert.equal(res.values.use_piano, 0.8);
  assert.equal(res.standin, false);
});

test('retries 429 honouring retry-after-ms, and never retries 422', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many concurrent requests for this account.' }, request_id: 'req_1' }), { status: 429, headers: { 'retry-after-ms': '20' } });
    }
    return new Response(JSON.stringify(okBody), { status: 200 });
  }) as typeof fetch;
  const gw = new Gateway({ seed: 1 });
  await gw.ask({ callType: 'setup', title: 't', state: 's', questions, picking: 'top' });
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad', issues: [{ path: 'questions.a.criteria', message: 'must be a string' }] }, request_id: 'req_2' }), { status: 422 });
  }) as typeof fetch;
  await assert.rejects(() => gw.ask({ callType: 'setup', title: 't', state: 's', questions, picking: 'top' }), (err: unknown) => {
    assert.ok(err instanceof DrexError);
    assert.equal(err.status, 422);
    assert.match(err.message, /questions\.a\.criteria/);
    return true;
  });
  assert.equal(calls, 1);
});

test('sampled picking draws one set of picks per draft from the returned probabilities', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch;
  const gw = new Gateway({ seed: 3 });
  const res = await gw.ask({ callType: 'phrase_direction', title: 't', state: 's', questions, picking: 'sampled', draws: 200 });
  assert.equal(res.picks.length, 200);
  const b = res.picks.filter((p) => p.style === 'b').length;
  assert.ok(b > 150 && b < 200, `about 90% should be b, got ${b}`);
});

test('without a key the stand-in answers and says so', async () => {
  delete process.env.NACE_API_KEY;
  process.env.STANDIN_LATENCY_MS = '0-0';
  globalThis.fetch = (() => assert.fail('the stand-in must not touch the network')) as unknown as typeof fetch;
  const gw = new Gateway({ seed: 1 });
  assert.equal(gw.standin, true);
  const res = await gw.ask({ callType: 'setup', title: 't', state: 's', questions: [{ ...questions[0], options: [{ key: 'a', label: 'A', criteria: 'x', prior: 3 }, { key: 'b', label: 'B', criteria: 'y', prior: 0 }] } as Question], picking: 'top' });
  assert.equal(res.standin, true);
  assert.equal(res.picks[0].style, 'a');
});
