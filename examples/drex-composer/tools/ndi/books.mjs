// books.mjs — shared description of the four source books: which raw files they have, how
// their cleaned text.txt is built, what NDI should be given, and each book's own table of
// contents (chapter number, title, printed start page), transcribed from the book.
// Used by build-text.mjs, local-fallback.mjs and ingest.mjs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACK = join(ROOT, 'context-pack');
export const BOOKS_DIR = join(PACK, 'books');
export const NDI_DIR = join(PACK, 'ndi');

const toc = (rows) => rows.map(([n, title, page]) => ({ n, title, page }));

export const BOOKS = {
  'rimsky-orchestration': {
    title: 'Principles of Orchestration',
    author: 'Nikolay Rimsky-Korsakov',
    build: { kind: 'gutenberg-html', html: 'pg33900-images.html' },
    // No page images exist for this book (Project Gutenberg transcription), so NDI is given
    // the cleaned text, which already carries the printed page numbers as "[p. N]" lines.
    ndi: { mode: 'text', file: 'text.txt', uploadPath: 'drex-composer/rimsky-orchestration/text.txt' },
    chapterHeading: /^## Chapter [IVX]+/,
    paragraphNumber: null,
    refHint: 'Ch. II, "Melody in stringed instruments", p. 36',
    toc: toc([
      ['I', 'General review of orchestral groups', 6],
      ['II', 'Melody', 36],
      ['III', 'Harmony', 63],
      ['IV', 'Composition of the orchestra', 97],
      ['V', 'Combination of the human voice with orchestra. The stage band', 119],
      ['VI', '(Supplementary) Voices', 132],
    ]),
  },
  'goetschius-melody': {
    title: 'Exercises in Melody-Writing',
    author: 'Percy Goetschius',
    build: {
      kind: 'djvu-xml',
      xml: 'exercisesinmelod00goet_djvu.xml',
      pages: 'exercisesinmelod00goet_page_numbers.json',
      runningHead: /^(\d+\s+)?EXER\S*\s+\S{1,3}\s+MEL\S+(\s+\S{1,10}){0,2}$/i,
    },
    ndi: { mode: 'paged', file: 'exercisesinmelod00goet.pdf', uploadPath: 'drex-composer/goetschius-melody/exercisesinmelod00goet.pdf', url: 'https://archive.org/download/exercisesinmelod00goet/exercisesinmelod00goet.pdf' },
    chapterHeading: /^CHAPTER\s+[IVXLYinr1]+\.?/,
    paragraphNumber: /^(\d{1,3})\. /,
    refHint: 'par. 34, p. 20',
    toc: toc([
      ['I', 'Major. The Scale-line, Regular', 5], ['II', 'The Scale-line, Exceptional', 10], ['III', 'The Chord-line', 12],
      ['IV', 'The Chord-line, Continued', 19], ['V', 'Minor', 28], ['VI', 'Diversity of Rhythm, Regular', 31],
      ['VII', 'The Period-form', 34], ['VIII', 'Irregular Rhythm', 36], ['IX', 'Exceptional Semicadences', 40],
      ['X', 'Syntax of Melody', 41], ['XI', 'Melodic Syntax, Continued', 44], ['XII', 'Melodic Syntax, Continued', 49],
      ['XIII', 'Altered Scale-steps, Major', 51], ['XIV', 'Altered Scale-steps, Minor', 55], ['XV', 'Modulation, or Changes of Key', 58],
      ['XVI', 'Modulation, Continued', 62], ['XVII', 'Modulation, Continued', 63], ['XVIII', 'Modulation, Chromatic', 65],
      ['XIX', 'Overlapping Scale-lines', 66], ['XX', 'Modulation in Sequences, and at Cadences', 68], ['XXI', 'Chromatic Melody', 70],
      ['XXII', 'The Double-period', 72], ['XXIII', 'Essential and Unessential Tones', 75], ['XXIV', 'The Anticipation', 79],
      ['XXV', 'The Passing-note (single)', 81], ['XXVI', 'Passing-notes, Continued', 83], ['XXVII', 'Neighboring-notes', 87],
      ['XXVIII', 'Neighboring-notes, Continued', 92], ['XXIX', 'Neighboring-note as Appoggiatura', 96], ['XXX', 'Double-appoggiatura', 100],
      ['XXXI', 'Appoggiaturas, Continued', 105], ['XXXII', 'Evolution of Melodic Germs', 109], ['XXXIII', 'Melodic Evolution, Continued', 115],
      ['XXXIV', 'Melodic Expression. Conclusion', 121],
    ]),
    endPage: 124, // contents list starts on p. 125
  },
  'tchaikovsky-harmony': {
    title: 'Guide to the Practical Study of Harmony',
    author: 'P. I. Tchaikovsky',
    build: {
      kind: 'djvu-xml',
      xml: 'tchaikovsky-harmony-textbook-optimized_djvu.xml',
      pages: 'tchaikovsky-harmony-textbook-optimized_page_numbers.json',
      runningHead: null,
    },
    ndi: { mode: 'paged', file: 'tchaikovsky-harmony-textbook-optimized.pdf', uploadPath: 'drex-composer/tchaikovsky-harmony/tchaikovsky-harmony-textbook-optimized.pdf', url: 'https://archive.org/download/tchaikovsky-harmony-textbook/Tchaikovsky%20-%20Harmony%20Textbook%2C%20Optimized.pdf' },
    chapterHeading: /^CHAPTER\s+[IVXL1J\\]+[.,\\]?$/,
    paragraphNumber: /^§ ?(\d{1,3})\b/,
    refHint: 'Ch. XXII, § 62, p. 77',
    toc: toc([
      ['Introduction', 'Intervals', 7],
      ['I', 'The Triads of the Major Scale', 11], ['II', 'The Connection of the Triads of the Major Scale', 12],
      ['III', 'Connection of Triads showing no External Agreement', 15], ['IV', 'Deviations from Rules governing the Connection of Related Triads', 17],
      ['V', 'Harmonic Sequences', 20], ['VI', 'The Harmony of the Minor Scale', 21], ['VII', 'Open Position', 25],
      ['VIII', 'The Inversions of the Triad', 26], ['IX', 'The Inversions of the Diminished and Augmented Triads', 30],
      ['X', 'The Dominant Chord', 33], ['XI', 'Free Voice-Leading', 38], ['XII', 'The Chord of the Ninth', 40],
      ['XIII', 'Chords of the Minor and Diminished Seventh', 41], ['XIV', 'The Connection of Dissonant Harmonies resolving into the Tonic Triad', 44],
      ['XV', 'Chords of Sequence', 47], ['XVI', 'Chords of Sequence in Minor', 52], ['XVII', 'The Harmonization of a Given Melody', 54],
      ['XVIII', 'Direct Modulation', 63], ['XIX', 'Transient Modulation', 68], ['XX', 'Harmonization of Given Melodies with Modulations', 72],
      ['XXI', 'The Enharmonic Properties of the Chord of the Diminished Seventh', 75], ['XXII', 'The Organ-point', 77],
      ['XXIII', 'Suspensions', 82], ['XXIV', 'Anticipation', 91], ['XXV', 'Passing-notes', 94],
      ['XXVI', 'Chords of the Augmented Fifth', 100], ['XXVII', 'Chords of the Augmented Sixth', 106], ['XXVIII', 'Changing-notes', 111],
      ['XXIX', 'Strict Part-writing', 116], ['XXX', 'The Further Development of Voice-leading', 126], ['XXXI', 'Harmonic Figuration', 130],
      ['XXXII', 'The Free Prelude', 134], ['XXXIII', 'Deviations from the Laws of Harmony', 135], ['XXXIV', 'Cadences (Closes)', 136],
    ]),
  },
  'prout-form': {
    title: 'Musical Form',
    author: 'Ebenezer Prout',
    build: {
      kind: 'djvu-xml',
      xml: '15emusicalform00prouuoft_djvu.xml',
      pages: '15emusicalform00prouuoft_page_numbers.json',
      // "Chap. III.] THE MOTIVE. 33"  /  "34 MUSICAL FORM. [Chap. III."
      runningHead: /^(\d+\s+)?(MUSICAL\s+FORM\.?\s*)?\[?Chap\.\s*[IVXLl1]+\.?\]?.{0,60}$|^\d+\s+MUSICAL\s+FORM\.?.{0,20}$/i,
    },
    ndi: { mode: 'paged', file: '15emusicalform00prouuoft.pdf', uploadPath: 'drex-composer/prout-form/15emusicalform00prouuoft.pdf', url: 'https://archive.org/download/15emusicalform00prouuoft/15emusicalform00prouuoft.pdf' },
    chapterHeading: /^CHAPTER\s+[IVXLl1]+\.?$/,
    paragraphNumber: /^(\d{1,3})\. /,
    refHint: '§ 96, p. 44',
    toc: toc([
      ['I', 'Introduction', 1], ['II', 'Rhythm: Sentences and Phrases', 6], ['III', 'The Subdivisions of a Musical Sentence: Sections and Motives', 23],
      ['IV', 'Modulation: Key-Relationship', 37], ['V', 'The Means of Modulation: Modulation by Means of Triads', 44],
      ['VI', 'The Means of Modulation (continued)', 57], ['VII', 'The Construction of Simple Sentences with Regular Rhythm', 78],
      ['VIII', 'Irregular and Complex Rhythms', 102], ['IX', 'The Simple Binary Form', 151], ['X', 'The Simple Ternary Form', 184],
    ]),
    endPage: 244, // analytical index follows
  },
};

export const SLUGS = Object.keys(BOOKS);
export const bookDir = (slug) => join(BOOKS_DIR, slug);
export const ndiDir = (slug) => join(NDI_DIR, slug);
