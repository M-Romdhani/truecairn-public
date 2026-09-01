// The "TrueCairn" wordmark. The "ai" in Cairn is highlighted (brand accent
// #002FD7) as a nod to the AI guardian — see docs/AI.md. Rendered as one text
// node so it reads as a single accessible name "TrueCairn"; the accent is a
// class (design-system.css `.wm-ai`) rather than an inline style so it survives
// the SPA's class-only CSP.
export function Wordmark(): JSX.Element {
  return (
    <span className="wordmark">
      TrueC<span className="wm-ai">ai</span>rn
    </span>
  );
}
