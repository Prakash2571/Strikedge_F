/**
 * The access gate's data contract and its single hardest invariant.
 *
 * The gate is UX; the backend is the boundary. What the FRONTEND must guarantee is:
 *   • an UNSET session reads as not-authenticated (the gate shows);
 *   • an INVALID passcode rejects and the gate stays closed (never "authenticated");
 *   • a VALID passcode reports authenticated (the dashboard mounts);
 *   • and, non-negotiably, NONE of these paths writes a session token to localStorage — the
 *     session lives only in the HttpOnly cookie the backend sets.
 *
 * AccessGate is a React component that needs a DOM to render, so these tests exercise the
 * access API it is built on and assert the localStorage invariant directly with a spy. The
 * passcode is only ever sent in the request body, never persisted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { verifyPasscode, accessStatus, logout } from "../src/api/access.ts";

/** Spy on localStorage so we can prove NOTHING is ever written during an access flow. */
function installLocalStorageSpy() {
  const writes = [];
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes.push({ k, v });
      store.set(k, v);
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return writes;
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    return handler(url, init);
  };
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("UNSET session: accessStatus reports not authenticated, writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(200, { authenticated: false }));
  const status = await accessStatus();
  assert.equal(status.authenticated, false);
  assert.equal(writes.length, 0, "no token written to localStorage");
});

test("INVALID passcode: verify rejects, gate stays closed, no localStorage write", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(401, { error: "That passcode was not accepted." }));
  await assert.rejects(() => verifyPasscode("wrong"), /not accepted/);
  assert.equal(writes.length, 0, "a rejected passcode never persists anything");
});

test("VALID passcode: verify reports authenticated, and STILL writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  const calls = stubFetch(() => jsonResponse(200, { authenticated: true }));
  const result = await verifyPasscode("s3cret");
  assert.equal(result.authenticated, true);
  // The session is the HttpOnly cookie the backend set — the client stores nothing.
  assert.equal(writes.length, 0, "a successful login writes NO session token to localStorage");
  // The passcode travels only in the request body, never anywhere else.
  assert.equal(calls[0].body, JSON.stringify({ passcode: "s3cret" }));
});

test("the passcode is never written to localStorage under any key", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(200, { authenticated: true }));
  await verifyPasscode("top-secret-passcode");
  const leaked = writes.some(
    (w) => String(w.v).includes("top-secret-passcode") || String(w.k).includes("passcode"),
  );
  assert.equal(leaked, false, "the passcode must never reach localStorage");
});

test("logout never rejects, even on a server error, and writes no localStorage", async () => {
  const writes = installLocalStorageSpy();
  stubFetch(() => jsonResponse(500, { error: "boom" }));
  await logout(); // must resolve, so the gate always closes locally
  assert.equal(writes.length, 0);
});

test("verify sends credentials:include so the cookie can be set", async () => {
  installLocalStorageSpy();
  const calls = stubFetch(() => jsonResponse(200, { authenticated: true }));
  await verifyPasscode("x");
  assert.equal(calls[0].init.credentials, "include");
});
