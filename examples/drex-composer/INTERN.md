# Intern in this project

[Intern](https://github.com/nace-ai/intern) is Nace's open-source agent harness. Its brain has two parts:
System 2, any chat model, does the work; System 1, a decision model (Drex by default), watches every
turn, catches loops and checks risky tool calls.

## Its role here: the producer

Drex composes. Intern produces: it takes a commission, gets the piece made, measures it and writes it up.

```bash
npm run intern -- "swimming alone at night"
```

Intern then, following [AGENTS.md](AGENTS.md):

1. commissions the piece from the running server (`POST /api/commissions`), passing the words on unchanged;
2. waits until Drex has composed it (about a minute);
3. measures it with `npm run audit -- <id>`: sections, loudness, instruments, where the climax falls;
4. writes `eval/results/<id>/REPORT.md` with the link to listen and those facts.

Intern makes no musical choice and never rewrites the prompt, so a piece it produces is exactly the piece
the app would compose on its own. Drex is used twice: to compose the music, and as Intern's System 1.

## Setup

```bash
uv tool install "intern-agent @ git+https://github.com/nace-ai/intern"   # installs the `intern` command
```

In `.env`:

```bash
NACE_API_KEY=nace_sk_...                 # already there: Drex is Intern's System 1 by default
INTERN_SYSTEM2=<provider>/<model>        # the model that does Intern's work; `intern models` lists them
ANTHROPIC_API_KEY=...                    # or the key for whichever provider INTERN_SYSTEM2 names
```

Then `npm run dev` in one terminal and `npm run intern -- "<prompt>"` in another.

## The pieces

| File | What it is |
|---|---|
| `AGENTS.md` | The rules Intern follows in this repository |
| `tools/intern.ts` | `npm run intern`: hands a commission to Intern, headless |
| `tools/audit.ts` | `npm run audit`: measured facts about a saved piece |
| `server/index.ts` | `POST /api/commissions`, `GET /api/commissions/:id`: the door an agent uses |

**Status:** run for real on 2026-11-14 with Claude Haiku 5.5 as System 2 and Drex as System 1. Intern
commissioned "swimming alone at night", waited, audited the piece and wrote the report: 16 turns, with
42 checks by Drex along the way.
