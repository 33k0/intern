# Rules for agents working in this repository

This file is read by Intern (Nace's agent harness) and by any other coding agent.

## What this project is

Drex Composer turns a text prompt into music. **Drex makes every musical decision.** Code plays notes,
measures facts and enforces what Drex chose. An agent must never make or change a musical decision, and
must never rewrite the prompt a person gave.

## Producing a piece

When asked to produce or commission a piece:

1. Check the server is up: `curl -s http://localhost:8787/api/health`. If it is not, stop and say so
   (a person starts it with `npm run dev`). Do not start it yourself.
2. Commission the piece. Pass the person's words exactly as given:
   `curl -s -X POST http://localhost:8787/api/commissions -H "Content-Type: application/json" -d '{"prompt": "<their words>"}'`
   If `COMPOSER_TOKEN` is set in the environment, add `-H "Authorization: Bearer $COMPOSER_TOKEN"`.
3. Poll the `status_url` from the reply every 20 seconds until `status` is `done` or `error`. A piece takes
   about a minute. A 429 means another piece is being composed: wait a minute and try again.
4. Measure the result: `npm run audit -- <id>`. This prints facts taken from the note data.
5. Write `eval/results/<id>/REPORT.md` with: the prompt, the `listen_url`, the `summary` from the server,
   and the audit output. Then reply with the listen link and the report path.

Rules for the report:

- You have not heard the piece. Report only what the server's summary and the audit state. Do not call
  the music good, beautiful, moving or anything else.
- If the audit shows something a listener may want to know (the climax is not the highest point, an
  instrument in the palette was never used, every phrase has the same length), list it under
  "Worth a listen" as a plain fact.
- One commission is one piece. Do not commission again to get a "better" one.

## Working on the code

- Node is at `~/.local/node-v26.13.1-darwin-arm64/bin`; put it first on `PATH`.
- Before finishing any change: `npm run typecheck` and `npm test` must pass.
- Never commit `.env`, anything matching `/*.mp3`, or a key that starts with `nace_sk_`.
- Work on the branch `live-drex-tuning`. Do not push to `main`.
- Composing with live Drex costs credit (about $0.20 a piece). Use the offline stand-in for tests
  (run without `NACE_API_KEY`).
