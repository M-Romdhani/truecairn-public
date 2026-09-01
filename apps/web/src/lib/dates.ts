// All dates render in a FIXED locale (audit M11 / F-3): the app is English-only,
// so a French/German OS must not flip "Monday 22 June" into the visitor's locale,
// and date strings must stay reproducible across environments (a bare toLocale*()
// uses the runtime default, which also makes any string-based E2E/date assertion
// environment-dependent). Every screen formats dates through these helpers — never
// a bare toLocale*() call.
const DATE_LOCALE = 'en-US';

// Date + time (the default toLocaleString shape), pinned to en-US.
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(DATE_LOCALE);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

// "31 Jul 2026, 14:32" — day-first, month by name, 24-hour.
//
// Composed by hand rather than through toLocaleString, for two reasons. It is
// unambiguous across readers in a way 7/31/2026 is not, and it is byte-identical
// to `formatDateTime` in apps/mobile/lib/src/util/time_text.dart — the same
// moment reads the same whether the owner is looking at the phone that sent an
// item or the browser that files it. No locale can drift it, which is the point
// of the fixed-locale rule above taken one step further.
export function formatDayTime(value: string | number | Date): string {
  const d = new Date(value);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

// "2026-08-06 16:55:37" — sortable, column-aligned, unambiguous everywhere.
//
// The operations centre uses this instead of formatDateTime: "8/2/2026, 3:28:13 AM"
// is ambiguous to most of the world and its variable width will not align in a
// column of timestamps you are scanning for an outage.
export function formatTimestamp(value: string | number | Date): string {
  const d = new Date(value);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// "16:55:37" — the time alone, for the live indicator and the timeline axis.
export function formatClock(value: string | number | Date, seconds = true): string {
  const d = new Date(value);
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return seconds ? `${hm}:${p(d.getSeconds())}` : hm;
}

// Date only, with caller-chosen field selection (e.g. { month: 'short', day:
// 'numeric' }), pinned to en-US.
export function formatDate(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleDateString(DATE_LOCALE, options);
}
