/**
 * The site-passcode access API.
 *
 * StrikeEdge is gated by a single site passcode. Verifying it establishes an HttpOnly
 * session cookie server-side; the browser never sees, stores or forwards a token. These
 * three calls are the entire surface the AccessGate needs.
 *
 * NOTHING here reads or writes the session in localStorage — the session lives only in the
 * cookie the backend sets and clears.
 */

import { request } from "./http.ts";

/** Whether a valid session currently exists, per the backend. */
export interface AccessStatus {
  /** True once a valid site session cookie is present. */
  authenticated: boolean;
  /** True when the deployment has a passcode configured at all. */
  passcode_configured?: boolean;
}

/**
 * Verify the site passcode.
 *
 * On success the backend sets the HttpOnly session cookie (and the readable CSRF cookie);
 * this returns the resulting status. On a wrong passcode the backend answers a non-2xx and
 * the promise rejects with the backend's message — the gate shows it and stays closed.
 *
 * The passcode is sent in the request body and is NEVER persisted anywhere on the client.
 */
export async function verifyPasscode(passcode: string): Promise<AccessStatus> {
  return request<AccessStatus>("/api/access/verify", "Failed to verify the passcode", {
    method: "POST",
    body: { passcode },
    // A 401 here means "wrong passcode", NOT "session expired": surface the backend's
    // message and keep the gate closed, rather than firing the session-expiry teardown.
    suppressUnauthorized: true,
  });
}

/** Ask the backend whether the current cookie is a valid session. */
export async function accessStatus(): Promise<AccessStatus> {
  return request<AccessStatus>("/api/access/status", "Failed to load the access status");
}

/**
 * End the session.
 *
 * Never rejects and never claims success on an error status: pressing "Lock" must always
 * return the UI to the gate locally, even if the network call fails, so a failure is logged
 * rather than surfaced.
 */
export async function logout(): Promise<void> {
  try {
    await request<{ ok?: boolean }>("/api/access/logout", "Failed to log out", {
      method: "POST",
    });
  } catch (err) {
    // The gate closes locally regardless; a failed logout must not trap the user inside.
    console.warn("[access] logout request failed; clearing locally anyway.", err);
  }
}
