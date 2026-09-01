// Thin fetch wrapper. All requests carry the session cookie (credentials:
// 'include'); errors arrive as RFC 7807 problem+json, which we surface as ApiError.
// No secret ever flows through here — only ciphertext, metadata, and base64.

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
}

export async function api(path: string, opts: RequestOptions = {}): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
    credentials: 'include',
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return doFetch(path, init);
}

export async function apiJson<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const problem = (await res
    .json()
    .catch(() => ({ type: 'about:blank', title: res.statusText, status: res.status }))) as ProblemDetails;
  throw new ApiError(res.status, problem);
}
