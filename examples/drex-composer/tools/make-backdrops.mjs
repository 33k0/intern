// Writes placeholder backdrops (abstract SVGs) and the manifest Drex picks from.
// These stand in until the real Adobe Firefly images are made: drop `<id>.jpg` (or .png/.webp)
// into assets/backdrops/ and it replaces the placeholder with the same id automatically.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../assets/backdrops');
mkdirSync(out, { recursive: true });

const moods = [
  { id: 'rain-night', mood: 'Rain on glass at night: blurred city lights, deep blue-black, lonely and tender', tags: { valence: -0.6, energy: 0.3, darkness: 0.6, water: 0.6 },
    colours: ['#05070f', '#0d1a33', '#27456e', '#c58f5a'], freq: 0.011, firefly: 'Rain streaking down a window at night, blurred amber and blue city lights beyond, shallow depth of field, moody cinematic still, deep navy and black palette, soft bokeh, no people, no text' },
  { id: 'deep-water', mood: 'Underwater light: shafts of pale light through dark teal water, weightless and submerged', tags: { valence: -0.2, energy: 0.2, darkness: 0.5, water: 1 },
    colours: ['#021016', '#063340', '#0f6a73', '#bfe9df'], freq: 0.006, firefly: 'Underwater view looking up through a still swimming pool at night, shafts of pale light through dark teal water, caustics, drifting particles, cinematic, dreamlike, no people, no text' },
  { id: 'frozen-dawn', mood: 'Sunrise over a frozen lake: pale pink and ice blue, still, wide, hopeful', tags: { valence: 0.5, energy: 0.2, darkness: 0.1, water: 0.3 },
    colours: ['#e9eef5', '#b9cbe0', '#f3c9c0', '#f6e3b4'], freq: 0.004, firefly: 'Sunrise over a vast frozen lake, pale pink and ice-blue sky, low mist, soft pastel light, minimalist wide landscape photograph, serene, no people, no text' },
  { id: 'neon-arcade', mood: 'Neon arcade: magenta and cyan glow on black, electric, fast, synthetic', tags: { valence: 0.1, energy: 0.9, darkness: 0.5, electronic: 1 },
    colours: ['#07020f', '#3a0b5e', '#ff2bd1', '#19e3ff'], freq: 0.02, firefly: 'Abstract neon arcade interior, glowing magenta and cyan light trails on black, reflective floor, synthwave, long exposure, high contrast, no people, no text' },
  { id: 'golden-meadow', mood: 'Sunlit meadow: warm gold and green, light, open air, carefree', tags: { valence: 0.9, energy: 0.5, darkness: 0, playful: 0.6 },
    colours: ['#fff3c9', '#ffd56b', '#9bcf6a', '#f7a1a1'], freq: 0.009, firefly: 'Sunlit summer meadow with wildflowers, warm golden backlight, soft focus, floating pollen, bright cheerful storybook colours, no people, no text' },
  { id: 'storm-front', mood: 'Storm front over the sea: charcoal cloud, a slash of light, vast and threatening', tags: { valence: -0.5, energy: 0.8, darkness: 0.9, water: 0.4 },
    colours: ['#0a0a0d', '#23262e', '#4a5160', '#d8d2c4'], freq: 0.008, firefly: 'Enormous storm front rolling over a dark sea, charcoal clouds with one slash of cold light on the horizon, dramatic, epic scale, cinematic matte painting, no people, no text' },
  { id: 'paper-toys', mood: 'Paper toys and confetti: bright primary shapes, bouncy, silly, handmade', tags: { valence: 0.8, energy: 0.7, darkness: 0, playful: 1 },
    colours: ['#fdf6e3', '#ff6b6b', '#4dabf7', '#ffd43b'], freq: 0.03, firefly: 'Playful paper-craft scene of bright geometric toys and floating confetti, primary colours on cream, soft studio light, handmade, whimsical, no people, no text' },
  { id: 'hall-dusk', mood: 'Empty concert hall at dusk: warm wood, velvet shadow, a single light, solemn and grand', tags: { valence: -0.1, energy: 0.3, darkness: 0.5 },
    colours: ['#120b08', '#3b2216', '#7a4a2a', '#e8c48a'], freq: 0.005, firefly: 'Empty concert hall at dusk seen from the stage, warm wood and red velvet in deep shadow, a single shaft of light on a grand piano, reverent, cinematic, no people, no text' },
];

let seed = 1;
for (const m of moods) {
  const [a, b, c, d] = m.colours;
  seed += 7;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></linearGradient>
    <radialGradient id="g1" cx="0.72" cy="0.3" r="0.6"><stop offset="0" stop-color="${c}" stop-opacity="0.85"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0.2" cy="0.78" r="0.5"><stop offset="0" stop-color="${d}" stop-opacity="0.5"/><stop offset="1" stop-color="${d}" stop-opacity="0"/></radialGradient>
    <filter id="flow" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="${m.freq} ${m.freq * 2.2}" numOctaves="3" seed="${seed}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="260" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="28"/>
    </filter>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed + 3}"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.09 0"/></filter>
  </defs>
  <rect width="1920" height="1080" fill="url(#base)"/>
  <g filter="url(#flow)">
    <rect width="1920" height="1080" fill="url(#g1)"/>
    <rect width="1920" height="1080" fill="url(#g2)"/>
    <ellipse cx="1180" cy="620" rx="520" ry="150" fill="${c}" opacity="0.28"/>
    <ellipse cx="520" cy="300" rx="380" ry="110" fill="${d}" opacity="0.16"/>
  </g>
  <rect width="1920" height="1080" filter="url(#grain)"/>
</svg>
`;
  writeFileSync(join(out, `${m.id}.svg`), svg);
}
writeFileSync(join(out, 'backdrops.json'), JSON.stringify(moods.map(({ id, mood, tags }) => ({ id, file: `${id}.svg`, mood, tags })), null, 2) + '\n');
writeFileSync(join(out, 'FIREFLY.md'), `# Backdrops

Drex picks one backdrop per piece from \`backdrops.json\` (the Backdrop call, a single choice question).

The SVG files here are **placeholders** generated by \`tools/make-backdrops.mjs\`. The plan is one Adobe Firefly image
per mood, made in advance. To swap one in, generate it in Firefly (16:9, 1920×1080 or larger) and save it in this folder
as \`<id>.jpg\` (or \`.png\` / \`.webp\`). A raster file with the same id is used instead of the placeholder automatically;
nothing else needs editing. To add a mood, add an entry to \`backdrops.json\` (the \`mood\` text is what Drex reads).

| id | Mood Drex reads | Firefly prompt |
|---|---|---|
${moods.map((m) => `| \`${m.id}\` | ${m.mood} | ${m.firefly} |`).join('\n')}
`);
console.log(`wrote ${moods.length} placeholder backdrops to ${out}`);
