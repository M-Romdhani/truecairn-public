import type { SVGProps } from 'react';

// Lucide-flavored inline icons from the design reference. They draw in
// currentColor so they inherit the surrounding button/text color, and size
// via the design-system `svg` sizing rule unless a width/height is passed.

export function IconCheck(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3.5 8.5l3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconArrowRight(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconArrowLeft(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M13 8H3M7 4L3 8l4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Padlock for the passkey buttons on the auth screens (new design).
export function IconLock(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4Zm-2 6V6a2 2 0 1 1 4 0v2Z"
        fill="currentColor"
      />
    </svg>
  );
}
