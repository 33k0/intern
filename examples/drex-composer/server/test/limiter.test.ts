// At the rate limit, a priority request (a hold) is answered at once from the reserved budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('priority requests get through while ordinary ones are rate limited', async () => {
  process.env.STANDIN_LATENCY_MS = '0-0';
  process.env.STANDIN_RPM = '40';
  delete process.env.NACE_API_KEY;
  const { Gateway } = await import('../gateway/gateway.ts');
  const gw = new Gateway({ seed: 1 });
  const ask = (priority: boolean) => gw.ask({ callType: 'hold', title: 't', state: 's', picking: 'top', priority, quiet: true,
    questions: [{ id: 'q', type: 'noul', label: 'q', instructions: 'q?' }] });
  // Ordinary requests may use 90% of the budget: 36 of 40.
  let done = 0;
  const flood = Array.from({ length: 50 }, () => ask(false).then(() => done++));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, 36, 'ordinary requests stop at the budget minus the reserve');
  const t0 = Date.now();
  await ask(true);
  await ask(true);
  assert.ok(Date.now() - t0 < 500, 'priority requests are not queued behind the flood');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(done, 36, 'the flood is still waiting for the window to move on');
  gw.abort();
  await Promise.allSettled(flood.map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 50))])));
});
