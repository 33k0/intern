/** The fermata: the notation sign for "hold this". An arc over a dot, nothing more. */
export function Fermata({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.5 18 A13.5 13.5 0 0 1 29.5 18" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="16" cy="14.6" r="2.7" fill="currentColor" />
    </svg>
  );
}
