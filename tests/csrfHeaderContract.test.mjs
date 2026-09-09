/**
 * CSRF header is SINGLE-SOURCED from the vendored backend contract — the transport must send
 * exactly the header name the contract declares.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The CSRF request-header name used to be hardcoded independently in the backend
 * (`src/access/csrf.ts`) and the frontend (`src/api/http.ts`), and each repo tested only its
 * OWN literal. A one-sided rename therefore passed its own CI while silently breaking auth.
 * The backend now owns the name in `contract/protocol.json` (`csrf_header`), covered by the
 * contract digest; the frontend VENDORS that file and the `contract:types` generator emits it
 * as `CSRF_HEADER` into `src/api/contract.generated.ts`, which `src/api/http.ts` imports.
 *
 * This test closes the loop by asserting three things line up on the frontend side:
 *   (1) the header the REAL transport (`request()`) actually puts on a mutating request equals
 *       the `csrf_header` value read straight from the vendored `contract/protocol.json`;
 *   (2) the generated `CSRF_HEADER` constant equals that same contract value (so the generator
 *       faithfully carried the contract into the bundle-safe module the transport imports);
 *   (3) `src/api/http.ts` does NOT contain an independent hardcoded `"x-csrf-token"` literal —
 *       it must obtain the name via the import, so a rename cannot be shipped one-sided.
 *
 * A backend rename of `csrf_header` that the frontend re-vendors changes protocol.json, hence
 * CSRF_HEADER, hence the header the transport sends — and (1)+(2) still agree. A rename the
 * frontend has NOT adopted (stale generated file, or a re-introduced hardcoded literal) makes
 * (1)/(2)/(3) disagree and this test FAILS — which is exactly the one-sided-rename tripwire.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { request, setCsrfToken, clearCsrfToken } from "../src/api/http.ts";
import { CSRF_HEADER } from "../src/api/contract.generated.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The vendored contract's declared CSRF header name — the single source of truth. */
const protocol = JSON.parse(
  readFileSync(join(HERE, "..", "contract", "protocol.json"), "utf8"),
);
const CONTRACT_CSRF_HEADER = protocol.csrf_header;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, headers: init?.headers ?? {} });
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

test("the vendored protocol.json declares a non-empty string csrf_header", () => {
  assert.equal(typeof CONTRACT_CSRF_HEADER, "string");
  assert.ok(CONTRACT_CSRF_HEADER.length > 0, "csrf_header must be a non-empty string");
});

test("the transport sends the CSRF token under exactly the contract's csrf_header name", async () => {
  clearCsrfToken();
  setCsrfToken("TOK-CONTRACT-HEADER");
  const calls = stubFetch(() => jsonResponse(200, { ok: true }));

  await request("/api/box/start", "Failed", { method: "POST" });
  const mutation = calls.find((c) => String(c.url).includes("/api/box/start"));

  // The header KEY the transport actually used must be the contract's csrf_header — read from
  // the vendored protocol.json, NOT a literal repeated in this test.
  assert.ok(
    Object.prototype.hasOwnProperty.call(mutation.headers, CONTRACT_CSRF_HEADER),
    `the mutation must carry the "${CONTRACT_CSRF_HEADER}" header (the vendored contract's csrf_header)`,
  );
  assert.equal(
    mutation.headers[CONTRACT_CSRF_HEADER],
    "TOK-CONTRACT-HEADER",
    "the token is echoed under the contract-declared header name",
  );

  // And no OTHER header carries the token (a stale literal would show up as a second key).
  const headerKeysCarryingToken = Object.keys(mutation.headers).filter(
    (k) => mutation.headers[k] === "TOK-CONTRACT-HEADER",
  );
  assert.deepEqual(
    headerKeysCarryingToken,
    [CONTRACT_CSRF_HEADER],
    "the token rides on the contract header name and no other",
  );
  clearCsrfToken();
  delete globalThis.fetch;
});

test("the generated CSRF_HEADER constant equals the vendored contract csrf_header", () => {
  // The generator (contract:types) must have carried protocol.json.csrf_header into the
  // bundle-safe generated module verbatim. A stale generated file breaks this (and CI's
  // regenerate-and-diff step also catches it).
  assert.equal(
    CSRF_HEADER,
    CONTRACT_CSRF_HEADER,
    "generated CSRF_HEADER must equal contract/protocol.json csrf_header",
  );
});

test("http.ts obtains the header via import, with no independent hardcoded literal", () => {
  const src = readFileSync(join(HERE, "..", "src", "api", "http.ts"), "utf8");
  // It must import CSRF_HEADER from the generated contract module.
  assert.match(
    src,
    /import\s*\{[^}]*\bCSRF_HEADER\b[^}]*\}\s*from\s*["']\.\/contract\.generated(?:\.ts)?["']/,
    "http.ts must import CSRF_HEADER from ./contract.generated",
  );
  // It must NOT re-hardcode the header value as its own literal (that would allow a one-sided
  // rename to pass). The value only legitimately appears in the generated file and the contract.
  assert.doesNotMatch(
    src,
    new RegExp(`["']${CONTRACT_CSRF_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`),
    `http.ts must not contain the hardcoded literal "${CONTRACT_CSRF_HEADER}"`,
  );
});
