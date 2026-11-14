// Composing on Vercel: one function call composes one piece and streams every event to the browser as
// it happens (one JSON object per line). The Nace key stays in the project's environment variables.
// Bundled into api/compose.js by `npm run build:api`; the bundle is committed so Vercel finds it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types.ts';
import { Session } from './session.ts';

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'POST a JSON body with a "prompt".' }));
    return;
  }
  const body = await readBody(req);
  const prompt = String(body.prompt ?? '').trim().slice(0, 600) || 'a quiet piece';
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (e: ServerEvent) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
  };
  // The browser cannot report its playhead to a function, so the piece is composed straight through.
  const session = new Session({ prompt, seed: typeof body.seed === 'number' ? body.seed : undefined, paced: false, send });
  res.on('close', () => session.stop());
  await session.run();
  res.end();
}
