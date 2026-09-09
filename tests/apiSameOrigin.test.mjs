/**
 * The same-origin API-origin contract.
 *
 * FIX 5 — the production localhost footgun. `src/api/http.ts` used to fall back to
 * "http://localhost:3001" when VITE_API_BASE_URL was absent, so a production build shipped
 * that literal string and every visitor's browser called ITS OWN localhost. The helper now
 * defaults to SAME-ORIGIN: an absent/empty value resolves to "" so `apiUrl("/api/...")`
 * yields the RELATIVE path "/api/..." with no origin prefix. An explicit value is validated
 * and normalised; a malformed / non-http(s) value THROWS at module load rather than silently
 * degrading (which would mask a deployment error).
 *
 * These run under `node --experimental-strip-types --test`, where `import.meta.env` is
 * undefined — so the module-level `API_ORIGIN` resolves to "" (same-origin), and the pure
 * `resolveApiOrigin(value)` helper is exercised directly with explicit arguments.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveApiOrigin, apiUrl, API_ORIGIN } from "../src/api/http.ts";
import { boxStreamUrl } from "../src/api/box.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/* -------------------------- same-origin default (absent/empty) ------------------------- */

test("a MISSING base URL resolves to same-origin (empty origin)", () => {
  assert.equal(resolveApiOrigin(undefined), "");
  assert.equal(resolveApiOrigin(null), "");
});

test("an EMPTY-STRING base URL resolves to same-origin (empty origin)", () => {
  assert.equal(resolveApiOrigin(""), "");
  assert.equal(resolveApiOrigin("   "), "", "whitespace-only is treated as absent");
});

test("same-origin produces exactly the relative /api/... paths, no origin prefix", () => {
  // In node:test import.meta.env is undefined, so the module resolves to same-origin.
  assert.equal(API_ORIGIN, "", "module-level origin defaults to same-origin under Node");
  assert.equal(apiUrl("/api/access/status"), "/api/access/status");
  assert.equal(apiUrl("/api/box/status"), "/api/box/status");
  assert.equal(apiUrl("/api/box/stream"), "/api/box/stream");
  // Relative: must NOT start with a scheme/origin and must NOT contain "localhost".
  for (const p of ["/api/access/status", "/api/box/status", "/api/box/stream"]) {
    const url = apiUrl(p);
    assert.ok(url.startsWith("/api/"), `${url} is a relative /api path`);
    assert.doesNotMatch(url, /^https?:\/\//, `${url} has no origin prefix`);
    assert.doesNotMatch(url, /localhost/, `${url} contains no localhost`);
  }
});

/* -------------------------------- normalisation ---------------------------------------- */

test("a trailing slash on the base URL is normalised away", () => {
  assert.equal(resolveApiOrigin("https://api.example.com/"), "https://api.example.com");
  assert.equal(resolveApiOrigin("https://api.example.com///"), "https://api.example.com");
});

test("an accidental trailing /api is stripped (no doubled /api/api/...)", () => {
  assert.equal(resolveApiOrigin("https://api.example.com/api"), "https://api.example.com");
  assert.equal(resolveApiOrigin("https://api.example.com/api/"), "https://api.example.com");
  // And the produced URL is single-/api, never /api/api/...
  const origin = resolveApiOrigin("https://api.example.com/api");
  assert.equal(`${origin}/api/box/status`, "https://api.example.com/api/box/status");
  assert.doesNotMatch(`${origin}/api/box/status`, /\/api\/api\//);
});

test("an explicit HTTPS origin is used verbatim (after normalisation)", () => {
  assert.equal(resolveApiOrigin("https://api.example.com"), "https://api.example.com");
  assert.equal(resolveApiOrigin("http://api.example.com:8080"), "http://api.example.com:8080");
  // Endpoints add their own /api prefix, producing a well-formed absolute URL.
  const origin = resolveApiOrigin("https://api.example.com");
  assert.equal(`${origin}/api/box/stream`, "https://api.example.com/api/box/stream");
});

/* --------------------------- reject malformed / unsafe config -------------------------- */

test("a malformed base URL is REJECTED (throws, does not degrade to same-origin)", () => {
  assert.throws(() => resolveApiOrigin("not a url"), /not a valid absolute URL/);
  assert.throws(() => resolveApiOrigin("://missing-scheme"), /not a valid absolute URL/);
  assert.throws(() => resolveApiOrigin("http//broken"), /not a valid absolute URL/);
});

test("a non-http(s) scheme is REJECTED", () => {
  assert.throws(() => resolveApiOrigin("javascript:alert(1)"), /must use http or https/);
  assert.throws(() => resolveApiOrigin("ftp://api.example.com"), /must use http or https/);
  assert.throws(() => resolveApiOrigin("file:///etc/passwd"), /must use http or https/);
  assert.throws(() => resolveApiOrigin("ws://api.example.com"), /must use http or https/);
});

/* ------------------------------- SSE URL, no token ------------------------------------- */

test("the same-origin SSE URL is relative and carries NO token / query string", () => {
  const url = boxStreamUrl();
  assert.equal(url, "/api/box/stream", "same-origin SSE URL is the bare relative path");
  assert.ok(url.startsWith("/api/"), "relative, no origin prefix");
  assert.doesNotMatch(url, /^https?:\/\//, "no origin prefix");
  assert.doesNotMatch(url, /\?/, "no query string at all");
  assert.doesNotMatch(url, /token|passcode|session|csrf/i, "no token-shaped value in the URL");
  assert.doesNotMatch(url, /localhost/, "no localhost");
});

/* ---------------------- built bundle carries no dev/localhost origin ------------------- */

test("the built production bundle contains no localhost:3001 / 127.0.0.1:3001", () => {
  const assetsDir = path.join(REPO_ROOT, "dist", "assets");
  if (!existsSync(assetsDir)) {
    // Building inside the unit-test run is impractical (needs the full Vite toolchain); the
    // real build+scan is asserted by CI and by the acceptance run. Fall back to scanning the
    // SOURCE so this test still fails if the footgun is reintroduced there.
    const httpSrc = readFileSync(path.join(REPO_ROOT, "src", "api", "http.ts"), "utf8");
    assert.doesNotMatch(httpSrc, /["']https?:\/\/localhost:3001/, "no localhost:3001 default in source");
    assert.doesNotMatch(httpSrc, /["']https?:\/\/127\.0\.0\.1:3001/, "no 127.0.0.1:3001 default in source");
    return;
  }
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 0, "the build emitted at least one JS asset");
  for (const file of jsFiles) {
    const src = readFileSync(path.join(assetsDir, file), "utf8");
    assert.ok(!src.includes("localhost:3001"), `${file} must not contain localhost:3001`);
    assert.ok(!src.includes("127.0.0.1:3001"), `${file} must not contain 127.0.0.1:3001`);
  }
});
