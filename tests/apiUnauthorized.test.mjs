/**
 * The transport's session-expiry contract.
 *
 * Every /api/box/* call funnels through the one `request` wrapper. The critical properties:
 *   • a 401 notifies every unauthorized subscriber EXACTLY once, so the app can tear down
 *     the SSE and return to the gate from a single place;
 *   • a 401 rejects the calling promise (with an UnauthorizedError), so per-call error
 *     handling still runs;
 *   • the wrapper sends credentials:"include" and a CSRF header on mutating requests only;
 *   • a non-JSON error body still surfaces its HTTP status rather than a parse error.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  request,
  onUnauthorized,
  notifyUnauthorized,
  UnauthorizedError,
} from "../src/api/http.ts";

/** Install a fake global fetch that returns a chosen response, capturing the call. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
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

function textResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

test("a 401 notifies every unauthorized subscriber exactly once", async () => {
  stubFetch(() => jsonResponse(401, { error: "unauthorized" }));
  let firedA = 0;
  let firedB = 0;
  const offA = onUnauthorized(() => firedA++);
  const offB = onUnauthorized(() => firedB++);

  await assert.rejects(() => request("/api/box/status", "Failed"), UnauthorizedError);

  assert.equal(firedA, 1, "subscriber A fired once");
  assert.equal(firedB, 1, "subscriber B fired once");
  offA();
  offB();
});

test("a 401 rejects the caller with an UnauthorizedError", async () => {
  stubFetch(() => jsonResponse(401, { error: "nope" }));
  const off = onUnauthorized(() => {});
  await assert.rejects(
    () => request("/api/box/trades/abc/close", "Failed to close", { method: "POST" }),
    (err) => err instanceof UnauthorizedError,
  );
  off();
});

test("unsubscribing stops a listener from firing on a later 401", async () => {
  stubFetch(() => jsonResponse(401, {}));
  let fired = 0;
  const off = onUnauthorized(() => fired++);
  off();
  await assert.rejects(() => request("/api/box/status", "Failed"), UnauthorizedError);
  assert.equal(fired, 0, "an unsubscribed listener never fires");
});

test("notifyUnauthorized can be fired directly (shared by the SSE path)", () => {
  let fired = 0;
  const off = onUnauthorized(() => fired++);
  notifyUnauthorized();
  assert.equal(fired, 1);
  off();
});

test("a mutating request sends credentials:include and JSON content-type", async () => {
  const calls = stubFetch(() => jsonResponse(200, { ok: true }));
  await request("/api/box/start", "Failed", { method: "POST", body: { a: 1 } });
  const { init } = calls[0];
  assert.equal(init.credentials, "include", "cookie credentials always sent");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.body, JSON.stringify({ a: 1 }));
});

test("a GET does not carry a CSRF header (only mutating requests do)", async () => {
  const calls = stubFetch(() => jsonResponse(200, {}));
  await request("/api/box/status", "Failed");
  const { init } = calls[0];
  assert.equal(init.method, "GET");
  assert.equal(init.headers["x-csrf-token"], undefined, "no CSRF header on a read");
  assert.equal(init.credentials, "include");
});

test("a non-JSON error body still surfaces the HTTP status, not a parse error", async () => {
  stubFetch(() => textResponse(502, "<html>Bad Gateway</html>"));
  await assert.rejects(
    () => request("/api/box/status", "Failed to load the box status"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 502/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    },
  );
});

test("a JSON error body's message is preferred", async () => {
  stubFetch(() => jsonResponse(409, { error: "Dhan still owns exposure" }));
  await assert.rejects(
    () => request("/api/broker/select", "Failed to select", { method: "POST", body: {} }),
    (err) => {
      assert.equal(err.message, "Dhan still owns exposure");
      return true;
    },
  );
});
