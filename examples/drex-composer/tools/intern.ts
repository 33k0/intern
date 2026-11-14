// Hand a commission to Intern, Nace's agent harness (github.com/nace-ai/intern).
//   npm run intern -- "swimming alone at night"
// Intern runs headlessly in this repository and follows AGENTS.md: it commissions the piece from the
// running server, waits, measures the result with `npm run audit`, and writes a report. It makes no
// musical choice. Its System 2 (any chat model) does the work; its System 1 (Drex, by default, from
// NACE_API_KEY) watches every turn.
import { spawn, spawnSync } from 'node:child_process';

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  console.error('usage: npm run intern -- "<what the piece should be about>"');
  process.exit(1);
}
if (spawnSync('intern', ['--version'], { stdio: 'ignore' }).error) {
  console.error('The `intern` command is not installed. Install it with:\n  uv tool install "intern-agent @ git+https://github.com/nace-ai/intern"');
  process.exit(1);
}
const system2 = (process.env.INTERN_SYSTEM2 ?? '').trim();
if (!system2) {
  console.error('Set INTERN_SYSTEM2 in .env to the model that does Intern\'s work, for example\n  INTERN_SYSTEM2=deepinfra/Qwen/Qwen3-235B-A22B-Instruct   (needs DEEPINFRA_API_KEY)\n`intern models` lists what your keys can reach.');
  process.exit(1);
}
const port = Number(process.env.PORT) || 8787;
const task = [
  `Produce a commissioned piece with the Drex Composer, following the "Producing a piece" section of AGENTS.md exactly.`,
  `The commission, to be passed on word for word: ${JSON.stringify(prompt)}`,
  `The composer server is at http://localhost:${port}.`,
].join('\n');
const child = spawn('intern', ['-p', '--system2', system2, task], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));
