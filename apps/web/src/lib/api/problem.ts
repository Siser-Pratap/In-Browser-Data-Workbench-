/**
 * The API's error shape, turned into something throwable.
 *
 * The backend answers every failure with RFC 7807 problem+json
 * (`apps/api/src/app/core/problem.py`), which carries more than a status code:
 * a human-facing `title`, a `detail`, and a `request_id` that appears in the
 * server logs. Keeping all of it on the error means a toast can show the title
 * while a bug report can still quote the request id.
 *
 * `ApiError.message` is deliberately the *human* string rather than
 * `"HTTP 409"`, because almost every catch site in the UI ends up rendering it
 * directly.
 */

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  request_id?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  readonly requestId: string | null;

  constructor(status: number, problem: Problem) {
    super(problem.detail || problem.title || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.requestId = problem.request_id ?? null;
  }

  /** 401/403 — the caller may want to prompt for sign-in rather than toast. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** 409 — a concurrent write; the sync layer prompts instead of retrying. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** 429 — rate limited or over the AI token budget. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** 503 — a feature that needs server config the server doesn't have. */
  get isUnavailable(): boolean {
    return this.status === 503;
  }
}

/**
 * Build an `ApiError` from a failed response.
 *
 * Tolerant of a non-JSON body on purpose: a proxy 502 or an nginx error page
 * is exactly when you most want a usable message, and that is exactly when the
 * body isn't problem+json.
 */
export async function toApiError(response: Response): Promise<ApiError> {
  let problem: Problem = {};
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') problem = body as Problem;
  } catch {
    // Non-JSON body; fall back to the status line below.
  }
  if (!problem.title && !problem.detail) {
    problem.title = response.statusText || `Request failed (${response.status})`;
  }
  return new ApiError(response.status, problem);
}

/** A network-level failure (server down, DNS, CORS) rather than an HTTP error. */
export function offlineError(cause: unknown): ApiError {
  return new ApiError(0, {
    title: 'Cannot reach the server',
    detail:
      cause instanceof Error && cause.message
        ? `Cannot reach the server: ${cause.message}`
        : 'Cannot reach the server. Your local workbench is unaffected.',
  });
}
