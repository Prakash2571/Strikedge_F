/**
 * API CONTRACT TEST — the frontend's types must match what the backend actually sends.
 *
 * WHY THIS EXISTS
 * The frontend and backend were built separately, and the types for the new StrikeEdge
 * endpoints drifted badly without anything noticing:
 *
 *   GET /api/runtime/status  — the frontend declared `token_waiting`, `instruments_loading`,
 *     `websocket_connecting`, `depth_ready`, `postgres_available`, `live_entry_blocked`,
 *     `recovery_active`, `detail`. The backend sends `brokers[]`, `active_broker`,
 *     `pg_ready`, `migration_state`, `recovery_ready`, `live_entry{blocked,reasons}`,
 *     `recovery_pending`, `residual_exposure`. Exactly ONE name overlapped.
 *
 *   GET /api/export/status  — frontend declared `delayed`, `lag_seconds`, `last_export_at`,
 *     `detail`; backend sends `connected`, `backlog_count`, `oldest_pending_age_ms`,
 *     `last_success_at`, `last_error`, `dead_letter_count`. One name overlapped.
 *
 *   GET /api/broker/status  — frontend declared a SINGLE broker with `dhan_configured`,
 *     `dhan_instruments`, `feed`, `last_margin_source`; the backend returns
 *     `{active_broker, generation, brokers[]}` and has no margin-source field at all.
 *
 * Every drifted field was optional or was read off a cast `fetch` result, so TypeScript
 * could not see it: the app typechecked, built, and passed its tests while every readiness
 * banner stayed dark and the broker panel rendered `undefined`. A green build proved
 * nothing about the contract.
 *
 * HOW THIS TEST WORKS
 * The JSON in `tests/fixtures/` was CAPTURED FROM A RUNNING StrikeEdge BACKEND (see
 * tests/fixtures/README.md), not hand-written. These assertions check the frontend's
 * expectations against those recordings, so a rename on either side fails here instead of
 * silently blanking the dashboard.
 *
 * WHAT IT CANNOT DO: it is a recording, so it goes stale if the backend changes and nobody
 * re-captures. That is a real limitation and is why the fixture README documents the
 * capture command. It is still far stronger than the nothing that preceded it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/** Assert every key the UI reads is present, and report ALL missing at once. */
function requireKeys(obj, keys, label) {
  const missing = keys.filter((k) => !(k in obj));
  assert.deepEqual(missing, [], `${label}: backend response is missing ${missing.join(", ")}`);
}

test("GET /api/runtime/status carries every field the banners read", () => {
  const d = fixture("runtime-status");
  requireKeys(
    d,
    [
      "brokers",
      "active_broker",
      "pg_ready",
      "migration_state",
      "recovery_ready",
      "live_entry",
      "recovery_pending",
      "residual_exposure",
    ],
    "runtime status",
  );

  assert.ok(Array.isArray(d.brokers), "brokers must be an array so both can be rendered");
  assert.equal(d.brokers.length, 2, "both Zerodha and Dhan must always be reported");

  requireKeys(d.migration_state, ["applied", "pending"], "migration_state");
  requireKeys(d.live_entry, ["blocked", "reasons"], "live_entry");
  assert.ok(
    Array.isArray(d.live_entry.reasons),
    "live_entry.reasons must be an array — 'blocked' without a cause is not actionable",
  );

  for (const b of d.brokers) {
    requireKeys(
      b,
      [
        "broker",
        "token_state",
        "ist_day",
        "last_attempt_at",
        "last_success_at",
        "last_error",
        "feed_connected",
        "wanted_token_count",
        "subscribed_token_count",
        "last_depth_age_ms",
        "reconnect_count",
      ],
      `runtime status broker ${b.broker}`,
    );
    assert.ok(
      ["waiting", "polling", "ready", "invalid", "configuration_error"].includes(b.token_state),
      `unexpected token_state "${b.token_state}" — the banners switch on this exact set`,
    );
  }
});

test("GET /api/export/status carries every field the reporting banners read", () => {
  const d = fixture("export-status");
  requireKeys(
    d,
    [
      "enabled",
      "connected",
      "backlog_count",
      "oldest_pending_age_ms",
      "last_success_at",
      "last_error",
      "dead_letter_count",
    ],
    "export status",
  );
  assert.equal(typeof d.backlog_count, "number");
  assert.equal(typeof d.dead_letter_count, "number", "dead-lettered rows must be reportable");
});

test("GET /api/broker/status returns BOTH brokers, which is what makes standby renderable", () => {
  const d = fixture("broker-status");
  requireKeys(d, ["active_broker", "generation", "brokers"], "broker status");
  assert.ok(Array.isArray(d.brokers));
  assert.equal(d.brokers.length, 2, "both brokers must be present so standby can be shown");
  assert.equal(typeof d.generation, "number", "the durable broker generation must be surfaced");

  for (const entry of d.brokers) {
    requireKeys(entry, ["broker", "session", "health"], `broker entry ${entry.broker}`);
    requireKeys(
      entry.session,
      ["broker", "connected", "state", "account_label", "established_at", "expires_at"],
      `session ${entry.broker}`,
    );
    requireKeys(
      entry.health,
      ["broker", "authenticated", "data_ready", "trading_ready", "problems"],
      `health ${entry.broker}`,
    );
    assert.ok(
      ["waiting", "ready", "standby", "expired"].includes(entry.session.state),
      `unexpected session.state "${entry.session.state}" — the panel switches on this set`,
    );
    assert.ok(Array.isArray(entry.health.problems));
  }
});

test("GET /api/broker/switch-blockers returns machine-readable string reasons", () => {
  const d = fixture("broker-switch-blockers");
  requireKeys(d, ["broker", "blockers"], "switch blockers");
  assert.ok(Array.isArray(d.blockers));
  for (const b of d.blockers) {
    assert.equal(typeof b, "string", "blockers are strings, not {reason, detail} objects");
  }
});

test("the access endpoints return what the gate needs and nothing sensitive", () => {
  for (const name of ["access-verify", "access-status"]) {
    const d = fixture(name);
    requireKeys(d, ["authenticated", "role", "csrf_token", "expires_at"], name);
    assert.equal(d.role, "full", "the site passcode grants the full operator role");
  }
});

test("NO endpoint response carries a broker token, passcode or encryption metadata", () => {
  // The load-bearing security assertion: these payloads are rendered in a browser.
  const forbidden = [
    "access_token",
    "encrypted_access_token",
    "encryption_iv",
    "encryption_auth_tag",
    "passcode",
    "api_secret",
    "site_access_secret",
    "database_url",
    "mongodb_uri",
  ];
  const names = [
    "runtime-status",
    "export-status",
    "broker-status",
    "broker-switch-blockers",
    "access-verify",
    "access-status",
  ];
  for (const name of names) {
    const raw = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
    for (const key of forbidden) {
      assert.ok(
        !new RegExp(`"${key}"`, "i").test(raw),
        `${name}.json must not contain a "${key}" field`,
      );
    }
  }
});
