// Fetch every raw source into <project>/.cache/raw/. Re-runnable: finished steps are skipped.
// Usage: node download.mjs [piano] [vsco] [vcsl] [drumkit] [openair]   (no args = all)
// Nothing from the downloaded archives is ever executed; they are only read as audio/text.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAW, ensureDir, pool, midiToName } from './lib.mjs';

const want = new Set(process.argv.slice(2));
const on = (k) => want.size === 0 || want.has(k);

async function fetchTo(url, dest, { optional = false } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'cached';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (r.status === 404 && optional) return 'missing';
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return 'ok';
    } catch (e) {
      if (attempt === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

// ---------------------------------------------------------------- piano
// Salamander Grand Piano V3 (Alexander Holm, CC BY 3.0) as re-hosted for @tonejs/piano.
async function piano() {
  const base = 'https://tambien.github.io/Piano/audio/';
  const dir = path.join(RAW, 'piano-tonejs');
  ensureDir(dir);
  const files = [];
  const VELS = [1, 4, 8, 12, 16];
  for (let m = 21; m <= 108; m += 3) {
    for (const v of VELS) files.push({ f: `${midiToName(m)}v${v}.mp3` });
    files.push({ f: `harmS${midiToName(m)}.mp3`, optional: true }); // only exists up to ~Ds7
  }
  for (let k = 1; k <= 88; k++) files.push({ f: `rel${k}.mp3` });
  for (const p of ['pedalD1', 'pedalD2', 'pedalU1', 'pedalU2']) files.push({ f: `${p}.mp3` });
  const res = await pool(files, 8, (x) => fetchTo(base + x.f, path.join(dir, x.f), x));
  const count = (s) => res.filter((r) => r === s).length;
  console.log(`piano: ${count('ok')} downloaded, ${count('cached')} cached, ${count('missing')} not on host`);
}

// ---------------------------------------------------------------- VSCO 2 CE
// The repository is ~2.3 GB and a shallow clone is slow, so only the folders we convert are fetched,
// file by file, from raw.githubusercontent.com at a pinned commit (tree listing via one GitHub API call).
// `node download.mjs vsco-clone` does the full shallow clone instead (same folder layout).
const VSCO_COMMIT = '440300901dfe9275fd84e0b7763af1f8443ae62e'; // master, 2020-08-05
const VSCO_WANT = [
  /^(LICENSE|README\.md|Readme\.txt)$/,
  /^Strings\/(Violin Section|Viola Section|Cello Section)\//,
  /^Strings\/Solo Contrabass\/(SusVib|Spic|Pizz|Trem)\//,
  /^Strings\/Solo Violin\//,
  /^Strings\/Harp\//,
  /^Woodwinds\/Flute\/(susvib|stac)\//,
  /^Woodwinds\/Oboe\//,
  /^Woodwinds\/Clarinet\//,
  /^Brass\/F Horn\/(sus|stac)\//,
  /^Percussion\/Timpani\//,
  /^Percussion\/(BDrumNewhit|cymbal-crash|susCymb1-(cresc|hit_)|gongHit)[^/]*$/,
  /^VSCO 1 Percussion\/varMetal\/Cymbals\/susp\/susp_hit_softmall[^/]*$/,
];
async function vsco() {
  const dir = path.join(RAW, 'vsco2');
  ensureDir(dir);
  const treeFile = path.join(dir, '.tree.json');
  if (!fs.existsSync(treeFile)) {
    await fetchTo(`https://api.github.com/repos/sgossner/VSCO-2-CE/git/trees/${VSCO_COMMIT}?recursive=1`, treeFile);
  }
  const tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
  if (tree.truncated) throw new Error('GitHub tree listing truncated; use `node download.mjs vsco-clone`');
  const files = tree.tree.filter((t) => t.type === 'blob' && VSCO_WANT.some((re) => re.test(t.path)));
  const total = files.reduce((a, t) => a + (t.size || 0), 0);
  console.log(`vsco2: ${files.length} files, ${(total / 1e6).toFixed(0)} MB wanted`);
  let done = 0;
  const res = await pool(files, 12, async (t) => {
    const dest = path.join(dir, t.path);
    ensureDir(path.dirname(dest));
    if (fs.existsSync(dest) && fs.statSync(dest).size === t.size) return 'cached';
    if (fs.existsSync(dest)) fs.rmSync(dest);
    const url = `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${VSCO_COMMIT}/` + t.path.split('/').map(encodeURIComponent).join('/');
    const r = await fetchTo(url, dest);
    if (fs.statSync(dest).size !== t.size) throw new Error(`size mismatch for ${t.path}`);
    if (++done % 100 === 0) console.log(`  vsco2: ${done} fetched`);
    return r;
  });
  console.log(`vsco2: ${res.filter((r) => r === 'ok').length} downloaded, ${res.filter((r) => r === 'cached').length} cached`);
}
function vscoClone() {
  const dir = path.join(RAW, 'vsco2');
  if (fs.existsSync(path.join(dir, '.git'))) return console.log('vsco2: clone present');
  git(['clone', '--depth', '1', 'https://github.com/sgossner/VSCO-2-CE', dir]);
}

// ---------------------------------------------------------------- VCSL (sparse)
function vcsl() {
  const dir = path.join(RAW, 'vcsl');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', 'https://github.com/sgossner/VCSL', dir]);
  }
  git(['sparse-checkout', 'init', '--no-cone'], dir);
  git(
    [
      'sparse-checkout', 'set', '--no-cone',
      '/LICENSE', '/README.md',
      '/Idiophones/Struck Idiophones/Glockenspiel/',
      '/Idiophones/Struck Idiophones/Vibraphone/',
      '/Idiophones/Struck Idiophones/Suspended Cymbal 1/',
      '/Idiophones/Struck Idiophones/Gong 1/',
      '/Idiophones/Struck Idiophones/Clash Cymbals 1/',
    ],
    dir,
  );
  git(['checkout'], dir);
}

// ---------------------------------------------------------------- Salamander Drumkit
// The GitHub repo (endolith) only carries the .sfz maps + readme; the samples live on archive.org.
async function drumkit() {
  const sfz = path.join(RAW, 'salamander-drumkit');
  if (!fs.existsSync(path.join(sfz, '.git'))) git(['clone', '--depth', '1', 'https://github.com/endolith/Salamander-Drumkit', sfz]);
  const dir = path.join(RAW, 'salamander-drumkit-samples');
  ensureDir(dir);
  const tar = path.join(dir, 'salamanderDrumkit.tar.bz2');
  if (!fs.existsSync(tar)) {
    const r = spawnSync('curl', ['-L', '--fail', '--retry', '3', '-o', tar + '.part',
      'https://archive.org/download/SalamanderDrumkit/salamanderDrumkit.tar.bz2'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('drumkit download failed');
    fs.renameSync(tar + '.part', tar);
  }
  const out = path.join(dir, 'extracted');
  if (!fs.existsSync(path.join(out, 'OH'))) {
    ensureDir(out);
    const r = spawnSync('tar', ['-xjf', tar, '-C', out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('drumkit extract failed');
  }
  console.log('drumkit: ready (expected md5 of tarball: af8e2067668a7f438e7d981877fb771f)');
}

// ---------------------------------------------------------------- OpenAIR impulse responses
// www.openair.hosted.york.ac.uk had an expired TLS certificate when this was written (Nov 2026);
// the IR archives themselves are served from webfiles.york.ac.uk (valid TLS). The descriptive pages
// (licence + attribution) are kept from web.archive.org snapshots.
async function openair() {
  const base = 'https://webfiles.york.ac.uk/OPENAIR/IRs/';
  const items = [
    { slug: 'jack-lyons-concert-hall-university-york', dir: 'jack-lyons', page: 571, snap: '20260125111616' },
    { slug: 'arthur-sykes-rymer-auditorium-university-york', dir: 'rymer', page: 425, snap: '20250427102628' },
  ];
  for (const it of items) {
    const dir = path.join(RAW, 'openair', it.dir);
    ensureDir(dir);
    await fetchTo(`${base}${it.slug}/${it.slug}.zip`, path.join(dir, `${it.slug}.zip`));
    await fetchTo(`${base}${it.slug}/Read%20Me.txt`, path.join(dir, 'ReadMe.txt'), { optional: true });
    await fetchTo(`${base}${it.slug}/Data%20Tables/${it.slug}-1.png`, path.join(dir, 'params.png'), { optional: true });
    await fetchTo(
      `https://web.archive.org/web/${it.snap}id_/https://www.openair.hosted.york.ac.uk/?page_id=${it.page}`,
      path.join(dir, 'openair-page-archived.html'),
      { optional: true },
    ).catch((e) => console.warn('  (archived page not fetched: ' + e.message + ')'));
    const out = path.join(dir, 'extracted');
    if (!fs.existsSync(out)) {
      ensureDir(out);
      const r = spawnSync('unzip', ['-q', '-o', path.join(dir, `${it.slug}.zip`), '-d', out], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('unzip failed for ' + it.slug);
    }
    console.log(`openair: ${it.dir} ready`);
  }
}

// ---------------------------------------------------------------- VSCO 2 CE SFZ mappings
// The SFZ branch of the same repository holds the library's own key maps (pitch_keycenter, velocity
// ranges, per-region volume). build.mjs reads them for the MIDI key of every sample: the wav names use an
// octave-low convention for most instruments (e.g. "VlnEns_susVib_G2" is G3 = MIDI 55) and the timpani
// files carry no pitch at all.
const VSCO_SFZ_COMMIT = '6dd651d55dde97fd4028699be9d4481f26917891'; // branch SFZ, 2019-01-17
const VSCO_SFZ = [
  'ViolinEnsSusVib', 'ViolinEnsSpic', 'ViolinEnsPizz', 'ViolinEnsTrem', 'ViolaEnsSusVib', 'ViolaEnsSpic', 'ViolaEnsPizz', 'ViolaEnsTrem',
  'CelloEnsSusVib', 'CelloEnsSpic', 'CelloEnsPizz', 'CelloEnsTrem', 'ContrabassSusVB', 'ContrabassSpic', 'ContrabassPizz', 'ContrabassTrem',
  'SViolinVib', 'SViolinSpic', 'SViolinPizz', 'SViolinTrem', 'FluteSusVib', 'FluteStac', 'OboeSusVib', 'OboeSusNV', 'OboeStac',
  'ClarinetSus', 'ClarinetStac', 'FHornSus', 'FHornStac', 'Harp', 'Timpani', 'TimpaniRolls', 'GM-StylePerc', 'Glockenspiel',
];
async function vscoSfz() {
  const dir = path.join(RAW, 'vsco2-sfz');
  ensureDir(dir);
  const res = await pool(VSCO_SFZ, 6, (n) => fetchTo(`https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${VSCO_SFZ_COMMIT}/${n}.sfz`, path.join(dir, `${n}.sfz`)));
  console.log(`vsco2-sfz: ${res.filter((r) => r === 'ok').length} downloaded, ${res.filter((r) => r === 'cached').length} cached`);
}

ensureDir(RAW);
if (on('piano')) await piano();
if (on('drumkit')) await drumkit();
if (on('openair')) await openair();
if (on('vcsl')) vcsl();
if (on('vsco')) {
  await vscoSfz();
  await vsco();
}
if (want.has('vsco-clone')) vscoClone();
console.log('download: done');
