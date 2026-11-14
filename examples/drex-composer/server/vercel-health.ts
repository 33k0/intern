// GET /api/health on Vercel: says whether the function can see the key and reach Drex, without showing the key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiKey, apiUrl } from './gateway/gateway.ts';
import { modelFor } from './gateway/models.ts';

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = apiKey();
  const raw = (process.env.NACE_API_KEY ?? '').trim();
  const out: Record<string, unknown> = {
    keyFound: !!key,
    keyProblem: key ? null : raw ? 'NACE_API_KEY is set but does not start with nace_sk_' : 'NACE_API_KEY is not set for this deployment (add it in Project Settings, Environment Variables, then redeploy)',
    model: modelFor('setup'), tier: process.env.DREX_TIER ?? '(not set: free-tier pacing)', apiUrl: apiUrl(),
  };
  if (key) {
    const hosts = [...new Set([apiUrl(), 'https://drex.nace.ai/v1/systemone'])];
    out.calls = [];
    for (const url of hosts) {
      const t0 = Date.now();
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelFor('setup'), state: 'A test.', questions: { ok: { type: 'noul', instructions: 'Is this a test?' } } }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        (out.calls as unknown[]).push({ url, status: r.status, ms: Date.now() - t0, reply: text.startsWith('{') ? text.slice(0, 200) : `not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)` });
      } catch (err) {
        (out.calls as unknown[]).push({ url, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
      }
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(out, null, 2));
}
