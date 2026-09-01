// The API error shape: RFC 7807 problem details
// (https://www.rfc-editor.org/rfc/rfc7807). Every error response in Phase 3
// is a `application/problem+json` body of this shape. Endpoints throw an
// ApiError (or one of the helpers); the app's error handler renders it.
//
// Pattern established in 3.0 — do not invent a second error shape in later
// deliverables.

export interface ProblemDetails {
  // A URI reference identifying the problem type. "about:blank" when the
  // status code alone is the whole story.
  type: string;
  // Short, human-readable summary. Stable per type (not per occurrence).
  title: string;
  // HTTP status code.
  status: number;
  // Human-readable explanation specific to THIS occurrence. Must never carry
  // sensitive material (no passphrases, recovery codes, shares, ciphertext).
  detail?: string;
  // URI reference for this specific occurrence (we use the request id).
  instance?: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string;
  readonly extensions: Record<string, unknown> | undefined;

  // Positional args (not an options object) so an optional `detail` of
  // `undefined` is accepted under exactOptionalPropertyTypes.
  constructor(
    status: number,
    title: string,
    detail?: string,
    type = 'about:blank',
    extensions?: Record<string, unknown>,
  ) {
    super(title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = type;
    this.extensions = extensions;
  }

  // RFC 7807 §3.2 permits extension members; they are merged alongside the
  // standard fields (used by e.g. the step-up-required problem's `stepUp`).
  toProblem(instance?: string): ProblemDetails & Record<string, unknown> {
    const p: ProblemDetails & Record<string, unknown> = {
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.detail !== undefined) p.detail = this.detail;
    if (instance !== undefined) p.instance = instance;
    if (this.extensions !== undefined) Object.assign(p, this.extensions);
    return p;
  }
}

// Stable problem type URIs (PHASE3_1_AUTH_PROPOSAL §e). Machine-readable so
// clients branch on `type`, not on `detail`.
export const PROBLEM_TYPES = {
  rateLimited: 'https://truecairn.app/problems/rate-limited',
  accountLocked: 'https://truecairn.app/problems/account-locked',
} as const;

// Helpers for the common statuses. Endpoints throw these; the error handler
// formats them. Keep titles stable (clients may key off them).
export const badRequest = (detail?: string): ApiError => new ApiError(400, 'Bad Request', detail);
export const unauthorized = (detail?: string): ApiError =>
  new ApiError(401, 'Unauthorized', detail);
export const forbidden = (detail?: string): ApiError => new ApiError(403, 'Forbidden', detail);
export const notFound = (detail?: string): ApiError => new ApiError(404, 'Not Found', detail);
export const conflict = (detail?: string): ApiError => new ApiError(409, 'Conflict', detail);

// 429 with the §e wire shape: RFC 7807 body carrying a retryAfterSeconds
// extension. The Retry-After header itself is set by the limiter at the route
// (headers are transport, not body) — see auth/rate-limit.ts.
export const tooManyRequests = (retryAfterSeconds: number, detail?: string): ApiError =>
  new ApiError(429, 'Too Many Requests', detail, PROBLEM_TYPES.rateLimited, { retryAfterSeconds });

// 403 when account_status has flipped to 'locked' — a DISTINCT type from 429 so
// the client can tell "you are throttled, back off" from "your account is
// locked, recover it". Carries the unlock time as an extension.
export const accountLocked = (retryAfterSeconds: number, detail?: string): ApiError =>
  new ApiError(403, 'Account Locked', detail, PROBLEM_TYPES.accountLocked, { retryAfterSeconds });
