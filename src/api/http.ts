/**
 * The one HTTP transport for the whole StrikeEdge frontend.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The CalSpread source carried a 2,623-line `api.ts` whose transport read and wrote a
 * bearer token in `localStorage` and appended it to the SSE query string. StrikeEdge's
 * session is an HttpOnly cookie the browser attaches automatically, so NONE of that
 * exists here. There is no token to read, store, log or leak — the wrapper simply sends
 * `credentials: "include"` on every request and lets the same-origin cookie do its job.
 *
 * THE FOUR THINGS THIS WRAPPER GUARANTEES
 *   1. Same-origin credentials: the session cookie rides on every call, incl. the SSE.
 *   2. Honest JSON errors: a proxy's HTML 502 no longer surfaces as a JSON parse error.
 *   3. A CSRF token header on every MUTATING request (POST/PUT/PATCH/DELETE), read from a
 *      non-HttpOnly `csrf` cookie the backend sets alongside the session.
 *   4. A single 401 handler: any 401 notifies every subscriber exactly once so the app can
 *      tear down the SSE, drop authenticated state and return to the gate — from one place,
 *      rather than each caller re-implementing session-expiry handling.
 */

/**
 * Backend origin. Endpoints add their own "/api/..." prefix, so this must be the ORIGIN
 * ONLY. A trailing slash or a trailing "/api" is stripped so a misconfigured value cannot
 * produce doubled "/api/api/..." URLs.
 */
function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

/**
 * Read VITE_API_BASE_URL defensively.
 *
 * `import.meta.env` is injected by Vite in the browser build but is `undefined` under Node's
 * native type-stripping (where the tests run). Reading it through a guarded cast lets this
 * module be imported directly by `node:test` without a bundler.
 */
function readApiBaseUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env;
    return env?.VITE_API_BASE_URL ?? "http://localhost:3001";
  } catch {
    return "http://localhost:3001";
  }
}

export const API_ORIGIN = normalizeBaseUrl(readApiBaseUrl());

/** Build an absolute URL for an "/api/..." path. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/* ------------------------------- 401 subscribers ------------------------------ */

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribe to session-expiry (HTTP 401). Returns an unsubscribe function.
 *
 * The AccessGate and the SSE effect both subscribe: one 401 anywhere means the session is
 * gone, so the SSE must close and the app must return to the passcode screen.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Fire the 401 handlers once. Exported so the SSE path can share the same notification. */
export function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) {
    try {
      listener();
    } catch {
      /* a listener must never break the notification of the others */
    }
  }
}

/* ---------------------------------- CSRF token -------------------------------- */

/** Name of the non-HttpOnly cookie the backend sets carrying the CSRF token. */
const CSRF_COOKIE = "strikedge_csrf";
/** Header the backend expects the CSRF token echoed back in on a mutating request. */
const CSRF_HEADER = "x-csrf-token";

/**
 * Read the CSRF token from the readable `csrf` cookie.
 *
 * This is NOT the session — the session is HttpOnly and unreadable by JS by design. The
 * CSRF token is a separate, deliberately-readable value whose only job is to be echoed in a
 * header so a cross-site form POST (which cannot set headers) is rejected.
 */
export function readCsrfToken(): string | null {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/* ----------------------------------- request ---------------------------------- */

export interface RequestOptions {
  method?: string;
  /** A JSON-serialisable body. Set automatically as JSON with the right Content-Type. */
  body?: unknown;
  /** Extra headers, merged after the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * When true, a 401 does NOT fire the global unauthorized handler and does NOT throw an
   * UnauthorizedError — it surfaces the backend's error message like any other failure.
   *
   * This is for the LOGIN call: a 401 from `/api/access/verify` means "wrong passcode", not
   * "your session expired". Routing that through the session-expiry teardown would be wrong,
   * and there is no session to tear down yet.
   */
  suppressUnauthorized?: boolean;
}

/**
 * Parse a JSON response, or throw an error that names what actually happened.
 *
 * Reading the body as text and parsing it ourselves means a non-JSON failure (an nginx 502
 * HTML page, a gateway timeout) still reports its status instead of surfacing an opaque
 * `Unexpected token '<'` parse error.
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text().catch(() => "");
  let body: (T & { error?: string }) | null = null;
  try {
    body = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    // Not JSON — fall through to the status-based message below.
  }
  if (!res.ok) throw new Error(body?.error ?? `${what} (HTTP ${res.status}).`);
  if (body === null) throw new Error(`${what}: the server sent an unreadable reply.`);
  return body;
}

/**
 * The single fetch wrapper.
 *
 * - Sends `credentials: "include"` so the HttpOnly session cookie is attached.
 * - Sets `Content-Type: application/json` and serialises a JSON body when one is given.
 * - Attaches the CSRF header on every mutating request.
 * - On HTTP 401 it notifies the unauthorized subscribers ONCE and then throws, so the
 *   caller's own error handling still runs but the session teardown is centralised.
 *
 * `what` is a bare description ("Failed to load the box status"); the HTTP status is
 * appended by `readJson` so every endpoint phrases a failure identically.
 */
export async function request<T>(
  path: string,
  what: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (MUTATING.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const res = await fetch(apiUrl(path), {
    method,
    headers,
    credentials: "include",
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // A 401 means the session is gone. Notify the app ONCE from here, then throw so the
  // caller still sees the failure. Every /api/box/* call funnels through this wrapper, so
  // this is the single place session-expiry is detected. The login call opts out
  // (suppressUnauthorized): a wrong passcode is not an expired session.
  if (res.status === 401 && !options.suppressUnauthorized) {
    notifyUnauthorized();
    throw new UnauthorizedError(what);
  }

  return readJson<T>(res, what);
}

/** Thrown on any HTTP 401 so callers can branch on session expiry if they need to. */
export class UnauthorizedError extends Error {
  constructor(what: string) {
    super(`${what}: your session has expired (HTTP 401).`);
    this.name = "UnauthorizedError";
  }
}
