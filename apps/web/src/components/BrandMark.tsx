// The cairn brand mark (stacked stones) from the design reference. Decorative —
// aria-hidden; the adjacent "truecairn" wordmark carries the accessible name.
export function BrandMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <ellipse cx="14" cy="22" rx="9" ry="2.2" fill="#0F172A" />
      <ellipse cx="14" cy="16.5" rx="7.2" ry="2" fill="#1E293B" />
      <ellipse cx="14" cy="11.4" rx="5.4" ry="1.8" fill="#334155" />
      <ellipse cx="14" cy="6.8" rx="3.6" ry="1.5" fill="#475569" />
      <ellipse cx="14" cy="3" rx="2" ry="1" fill="#64748B" />
    </svg>
  );
}
