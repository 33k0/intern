// Writes the static files the Vercel build serves in place of the local server's theory routes:
// dist/theory/<style>.json (and default.json) and dist/books/<slug>.<ext>.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pack, ROOT } from '../server/pack.ts';
import { bookPath, bookSources, theoryData } from '../server/theory.ts';

const dist = join(ROOT, 'dist');
mkdirSync(join(dist, 'theory'), { recursive: true });
mkdirSync(join(dist, 'books'), { recursive: true });
const url = (slug: string, file: string) => `/books/${slug}${extname(file)}`;
for (const style of [undefined, ...pack.sheets.map((s) => s.id)]) {
  writeFileSync(join(dist, 'theory', `${style ?? 'default'}.json`), JSON.stringify(theoryData(style, url)));
}
let copied = 0;
for (const b of bookSources()) {
  const path = bookPath(b.slug);
  if (!path) continue;
  copyFileSync(path, join(dist, 'books', `${b.slug}${extname(path)}`));
  copied++;
}
console.log(`theory: ${pack.sheets.length + 1} files, ${copied} books`);
