import { memo, useEffect, useMemo, useState } from 'react';
import type { CallType } from '../../../shared/types';
import { useSel } from '../store';
import './theory.css';

interface Book {
  slug: string;
  title: string;
  author: string;
  year: number;
  url: string | null;
  pdf: boolean;
  rulesInPack: number;
  /** Set only for a book NDI has really parsed and extracted rules from. */
  ndi: { parsed: boolean; chapters: number; rules: number } | null;
}

interface TheoryRule {
  text: string;
  book: string | null;
  ref: string | null;
  /** Page of the scan PDF the rule cites, when the book has a scan. */
  page: number | null;
}

interface Theory {
  books: Book[];
  slices: Partial<Record<CallType, TheoryRule[]>>;
}

/** Rules listed before "Show all": the most-used ones. */
const TOP = 6;

const surname = (author: string): string => author.trim().split(/\s+/).pop() ?? author;

/** The theory Drex is handed before it answers: the four books, and how much each was used across the whole piece. */
export const TheoryPanel = memo(function TheoryPanel() {
  const style = useSel((s) => s.rules?.style ?? null);
  const calls = useSel((s) => s.calls);
  const [theory, setTheory] = useState<Theory | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Which rules a decision gets depends on the style of the piece, so refetch when that is known.
  useEffect(() => {
    let live = true;
    fetch(`/api/theory${style ? `?style=${encodeURIComponent(style)}` : ''}`)
      .then((res) => (res.ok ? (res.json() as Promise<Theory>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => { if (live) setTheory(data); })
      .catch(() => { if (live) setTheory(null); });
    return () => { live = false; };
  }, [style]);

  // Every decision so far carried the rules for its type. Add them up over the whole piece.
  const usage = useMemo(() => {
    const perType = new Map<CallType, number>();
    for (const c of calls) perType.set(c.callType, (perType.get(c.callType) ?? 0) + 1);
    const decisions = new Map<string, number>();
    const rules = new Map<string, { rule: TheoryRule; times: number }>();
    let withTheory = 0;
    for (const [type, n] of perType) {
      const slice = theory?.slices[type] ?? [];
      if (slice.length) withTheory += n;
      for (const slug of new Set(slice.map((r) => r.book).filter((b): b is string => b !== null))) {
        decisions.set(slug, (decisions.get(slug) ?? 0) + n);
      }
      for (const r of slice) {
        const hit = rules.get(r.text);
        if (hit) hit.times += n;
        else rules.set(r.text, { rule: r, times: n });
      }
    }
    return { decisions, withTheory, rules: [...rules.values()].sort((a, b) => b.times - a.times) };
  }, [calls, theory]);

  const bookBySlug = new Map((theory?.books ?? []).map((b) => [b.slug, b]));
  const total = calls.length;

  return (
    <section className="panel theory" aria-label="Theory sources">
      <div className="panel__head">
        <h2 className="panel__title">Theory books</h2>
        {total > 0 && (
          <span className="panel__meta">
            <b className="mono">{usage.rules.length}</b> rules used across <b className="mono">{total}</b> decisions
          </span>
        )}
      </div>
      <p className="panel__explain">Drex cannot recall music theory, so every question arrives with rules from these books.</p>

      {!theory ? (
        <div className="panel__empty">
          <strong>Theory sources unavailable</strong>
        </div>
      ) : (
        <>
          <ul className="theory__books">
            {/* Only the books this piece has actually drawn on. */}
            {theory.books.filter((b) => (usage.decisions.get(b.slug) ?? 0) > 0).map((b) => {
              const used = usage.decisions.get(b.slug) ?? 0;
              return (
                <li key={b.slug}>
                  <a
                    className="book"
                    href={b.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    title={`${b.title}, ${b.author}, ${b.year}. Opens the ${b.pdf ? 'PDF' : 'book'}.`}
                  >
                    <span className="book__title">{b.title}</span>
                    <span className="book__by">{surname(b.author)}, {b.year}</span>
                    <span className="book__used">
                      Used in <b className="mono">{used}</b> {used === 1 ? 'decision' : 'decisions'}
                    </span>
                    <span className="book__bar" aria-hidden="true">
                      <span style={{ transform: `scaleX(${total > 0 ? used / total : 0})` }} />
                    </span>
                    {b.ndi && (
                      <span className="book__ndi" title={`NDI parsed this PDF, classified ${b.ndi.chapters} chapters and extracted ${b.ndi.rules} rules.`}>
                        Parsed by NDI · <b className="mono">{b.ndi.rules}</b> rules extracted
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>

          {usage.rules.length > 0 && <h3 className="theory__sub">Most-used rules</h3>}
          {usage.rules.length > 0 ? (
            <ol className="theory__rules scroll">
              {(showAll ? usage.rules : usage.rules.slice(0, TOP)).map(({ rule: r, times }) => {
                const book = r.book ? bookBySlug.get(r.book) : undefined;
                const href = book?.url ? `${book.url}${book.pdf && r.page ? `#page=${r.page}` : ''}` : undefined;
                const isOpen = open === r.text;
                return (
                  <li key={r.text} className={`trule${isOpen ? ' is-open' : ''}`}>
                    <button type="button" className="trule__text" onClick={() => setOpen(isOpen ? null : r.text)} aria-expanded={isOpen} title={isOpen ? undefined : 'Click to read the whole rule'}>
                      {r.text}
                    </button>
                    {book ? (
                      <a className="trule__cite" href={href} target="_blank" rel="noreferrer" title={`${book.title}, ${r.ref}. Opens the passage.`}>
                        {surname(book.author)}{/p\.\s*\d+/.test(r.ref ?? '') ? `, ${/p\.\s*\d+/.exec(r.ref!)![0]}` : ''}
                      </a>
                    ) : (
                      <span className="trule__cite" />
                    )}
                    <span className="trule__times mono" title={`Sent to Drex with ${times} decisions`}>×{times}</span>
                  </li>
                );
              })}
              {usage.rules.length > TOP && (
                <li>
                  <button type="button" className="theory__more" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${usage.rules.length} rules`}
                  </button>
                </li>
              )}
            </ol>
          ) : (
            <p className="theory__none">Waiting for the first decision.</p>
          )}
        </>
      )}
    </section>
  );
});
