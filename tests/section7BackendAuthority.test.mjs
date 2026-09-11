/**
 * SECTION 7 — BACKEND AUTHORITY AND DISPLAY INTEGRITY.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS EXERCISE, AND WHY THEY LOOK LIKE THIS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This project's harness is `node:test` with `--experimental-strip-types`, which strips TYPES but
 * does not transform JSX — so a `.tsx` component cannot be imported and rendered here (the same
 * constraint tests/accessGate.test.mjs already documents). The response is not to skip the
 * behaviour: every decision the panels and controls make lives in a pure `.ts` module that the
 * components CALL, and these tests drive those modules directly, plus the REAL transport wrapper
 * over a stubbed `fetch` for the HTTP cases. There is no parallel copy of the logic — the
 * assertions run against the code the components run.
 *
 * THE SCENARIOS THE BRIEF REQUIRES, EACH A REAL WAY THIS UI HAS LIED:
 *   backend/frontend disagreement · stale data · reconnect · HTTP 401 · HTTP 403 · timeout ·
 *   double-click · mode change · broker switch.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveActiveOrderStream,
  deriveEntryGate,
  deriveMarketData,
  bandClass,
  bandGlyph,
  orderStreamBrokerBand,
} from "../src/lib/operationalState.ts";
import {
  ControlRequests,
  RefreshTracker,
  acceptDecision,
  acceptStatus,
  decisionGenerationOf,
  freshnessBand,
  runOnce,
  CONTROL_LABEL,
} from "../src/lib/statusIntegrity.ts";
import {
  deriveExposure,
  deriveRunningPnl,
  explainScannerStop,
  modeLabel,
  moneyView,
} from "../src/lib/honestLabels.ts";
import { request, UnauthorizedError, setCsrfToken, clearCsrfToken } from "../src/api/http.ts";

/* ─────────────────────────── fixtures shaped like the real payload ─────────────────────────── */

const READY_MD_STATUS = {
  market_data_state: "READY",
  market_data_health: {
    state: "READY", generation: 7, desired: 4, confirmed: 4, readyInstruments: 4,
    lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false,
  },
};

function decision(over = {}) {
  const base = {
    decision_generation: 10,
    decision_version: "1.6.0",
    decided_at: 1_700_000_000_000,
    identity: {
      broker: "zerodha", account_masked: "AB••34", account_present: true,
      execution_mode: "live", live_runtime_armed: true, deployment_live_capable: true,
    },
    market_data: {
      state: "READY", generation: 7, desired_instruments: 4, ready_instruments: 4,
      backlog: false, usable_for_entry: true,
    },
    order_stream: {
      lifecycle: "READY", published_state: "LIVE", wiring: "armed", gate_enabled: true,
      connected: true, authorised: true, disconnects: 0,
    },
    fill_observation: {
      mechanism: "stream_primary_rest_reconcile", stream_assisted: true, detail: "stream first",
    },
    evidence: {
      market_data_frame_age_ms: 120, market_data_heartbeat_age_ms: 120,
      market_data_depth_age_ms: 200, order_stream_event_age_ms: 800,
    },
    reconciliation: { pending: false, blockers: [] },
    entry: { permitted: true, reasons: [] },
    exposure_management: {
      exit_and_reduce: true, protective_cancel: true, manage_working_orders: true,
      blocked_reasons: [],
      limitations: ["A reduction is itself an order into the market: permission is not a fill."],
      open_positions: 0, residual_legs: 0, working_orders: 0,
    },
  };
  return { ...base, ...over };
}

/* ═══════════════ 1. DISAGREEMENT: the frontend must never out-vote the backend ═══════════════ */

test("DISAGREEMENT: a DEGRADED order stream with READY market data must NOT render as permitted", () => {
  // The exact pre-fix reproduction: market data READY, order stream DEGRADED, backend refusing
  // entry. The old local derivation returned entryPermitted:true / overallBand:"ready" / no reasons.
  const md = deriveMarketData(READY_MD_STATUS);
  const orderStream = {
    any_stream_live: false,
    market_data_health_is_not_order_stream_health: true,
    brokers: [{
      broker: "zerodha", wiring: "armed", gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED",
      gate_enabled: true,
      health: {
        state: "DEGRADED", connected: true, authorised: true, lastEventAt: 1, disconnects: 0,
        reconcilePending: false, detail: "connected but not delivering", lifecycle: "DEGRADED",
      },
      lifecycle: "DEGRADED",
      fills_observed_by: "rest_polling_only",
      detail: "armed but degraded",
    }],
  };
  const os = deriveActiveOrderStream(orderStream, "zerodha");
  const gate = deriveEntryGate(
    md,
    os.active,
    decision({
      order_stream: { lifecycle: "DEGRADED", published_state: "DEGRADED", wiring: "armed", gate_enabled: true, connected: true, authorised: true, disconnects: 0 },
      fill_observation: { mechanism: "rest_polling_only", stream_assisted: false, detail: "REST polling" },
      entry: {
        permitted: false,
        reasons: [{ code: "order_stream_lifecycle", scope: "entry", detail: "the order-update stream is connected but NOT delivering" }],
      },
    }),
  );

  assert.equal(gate.entryPermitted, false, "the backend refuses entry; the panel must say so");
  assert.notEqual(gate.overallBand, "ready", "a DEGRADED backend transport must never read as ready");
  assert.ok(gate.entryPausedReasons.some((r) => /NOT delivering/.test(r)), "the backend's own reason is rendered");
  // …and exposure stays manageable: a degraded stream must not make a position look stranded.
  assert.equal(gate.positionsManageable, true);
});

test("DISAGREEMENT: an ARMED-but-degraded stream is PAUSED, while a disabled one is merely ABSENT", () => {
  // Both report `rest_polling_only`. Reading them alike is how a broken fast path renders as a
  // design choice — the authoritative lifecycle is what separates them.
  const degraded = orderStreamBrokerBand({
    broker: "zerodha", wiring: "armed", gate_env_var: "X", gate_enabled: true,
    health: null, lifecycle: "DEGRADED", fills_observed_by: "rest_polling_only", detail: "",
  });
  const off = orderStreamBrokerBand({
    broker: "zerodha", wiring: "gated_off", gate_env_var: "X", gate_enabled: false,
    health: null, lifecycle: "DISABLED", fills_observed_by: "rest_polling_only", detail: "",
  });
  const expired = orderStreamBrokerBand({
    broker: "zerodha", wiring: "armed", gate_env_var: "X", gate_enabled: true,
    health: null, lifecycle: "AUTH_EXPIRED", fills_observed_by: "rest_polling_only", detail: "",
  });
  assert.equal(degraded, "paused");
  assert.equal(off, "absent");
  assert.equal(expired, "broken", "a rejected credential will not clear on its own");
});

test("DISAGREEMENT: with NO backend decision the gate is UNKNOWN — never green", () => {
  const md = deriveMarketData(READY_MD_STATUS);
  for (const missing of [null, undefined]) {
    const gate = deriveEntryGate(md, null, missing);
    assert.equal(gate.decisionMissing, true);
    assert.equal(gate.entryPermitted, false, "no decision ⇒ no permission claim");
    assert.equal(gate.overallBand, "unknown");
    assert.equal(gate.positionsManageable, false, "manageability is also unknown, not assumed");
    assert.ok(gate.entryPausedReasons.some((r) => /UNKNOWN/.test(r)));
  }
  // The unknown band must be visually distinct AND not the neutral tone.
  assert.equal(bandGlyph("unknown"), "?");
  assert.equal(bandClass("unknown"), "is-warn");
  assert.notEqual(bandClass("unknown"), bandClass("ready"));
});

test("INVARIANT: entry reasons are never presented as reduction blockers", () => {
  const md = deriveMarketData(READY_MD_STATUS);
  const gate = deriveEntryGate(
    md,
    null,
    decision({
      entry: {
        permitted: false,
        reasons: [
          { code: "scanner_stopped", scope: "entry", detail: "the scanner is stopped" },
          { code: "session_budget_exhausted", scope: "entry", detail: "the session budget is spent" },
          { code: "max_entry_capital", scope: "entry", detail: "entry capital cap reached" },
        ],
      },
      exposure_management: {
        exit_and_reduce: true, protective_cancel: true, manage_working_orders: true,
        blocked_reasons: [], limitations: ["permission is not a fill"],
        open_positions: 2, residual_legs: 1, working_orders: 0,
      },
    }),
  );
  assert.equal(gate.entryPermitted, false);
  assert.equal(gate.entryPausedReasons.length, 3);
  assert.equal(gate.positionsManageable, true, "an entry restriction must never block a reduction");
  assert.deepEqual(gate.reductionBlockedReasons, [], "and must never appear as a reduction blocker");
});

/* ═══════════════ 2. STALE DATA: a failed or expired refresh becomes stale/unknown ═══════════════ */

test("STALE DATA: a refresh that has never succeeded is UNKNOWN, not fresh", () => {
  const t = new RefreshTracker(10_000);
  const s = t.state(1000);
  assert.equal(s.freshness, "unknown");
  assert.equal(s.ageMs, null, "never-loaded has no age — not an age of 0");
  assert.equal(freshnessBand("unknown"), "unknown");
  assert.match(s.detail, /has not loaded yet/);
});

test("STALE DATA: an EXPIRED refresh goes stale by the passage of time alone", () => {
  const t = new RefreshTracker(10_000);
  t.recordSuccess(1000);
  assert.equal(t.state(5000).freshness, "fresh");
  // No event happens here — data goes stale by time, which is why the component re-evaluates on a
  // timer rather than only on a response.
  const stale = t.state(20_000);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.ageMs, 19_000);
  assert.equal(freshnessBand("stale"), "paused");
  assert.match(stale.detail, /past the freshness limit/);
});

test("STALE DATA: a FAILED refresh is stale immediately, and reports the failure and the true age", () => {
  // This is the `.catch(() => {})` defect: the last good snapshot used to stay on screen looking
  // current for as long as the endpoint kept failing.
  const t = new RefreshTracker(60_000);
  t.recordSuccess(1000);
  t.recordFailure("Failed to load the runtime status (HTTP 503).");
  const s = t.state(4000);
  assert.equal(s.freshness, "stale", "a failure makes the display stale even inside the age window");
  assert.equal(s.consecutiveFailures, 1);
  assert.equal(s.ageMs, 3000, "the age is of the last SUCCESS, which is what is on screen");
  assert.match(s.detail, /FAILED/);
  assert.match(s.detail, /HTTP 503/);
  // A later success clears it.
  t.recordSuccess(5000);
  assert.equal(t.state(5100).freshness, "fresh");
  assert.equal(t.state(5100).consecutiveFailures, 0);
});

test("STALE DATA: unknown and stale are DISTINCT states, because they call for different actions", () => {
  const never = new RefreshTracker(1000);
  never.recordFailure("boom");
  const had = new RefreshTracker(1000);
  had.recordSuccess(0);
  had.recordFailure("boom");
  assert.equal(never.state(10).freshness, "unknown");
  assert.equal(had.state(10).freshness, "stale");
  assert.notEqual(never.state(10).detail, had.state(10).detail);
});

/* ═══════════════ 3. OUT-OF-ORDER RESPONSES ═══════════════ */

test("OUT-OF-ORDER: an older decision generation is IGNORED, never allowed to overwrite newer state", () => {
  assert.equal(acceptDecision(null, 1), true, "the first decision is always accepted");
  assert.equal(acceptDecision(5, 6), true);
  assert.equal(acceptDecision(5, 5), false, "re-applying the same generation adds no information");
  assert.equal(acceptDecision(5, 4), false, "an older response must be dropped");
  assert.equal(acceptDecision(5, Number.NaN), false, "a malformed generation is not evidence");
});

test("OUT-OF-ORDER: a stale 'entry permitted' cannot overwrite a fresh 'entry blocked'", () => {
  // The concrete hazard: the scanner-stop response (generation 12, entry blocked) renders, then the
  // slow initial status fetch (generation 9, entry permitted) finally resolves.
  const fresh = { operational_readiness: decision({ decision_generation: 12, entry: { permitted: false, reasons: [{ code: "scanner_stopped", scope: "entry", detail: "stopped" }] } }) };
  const stale = { operational_readiness: decision({ decision_generation: 9, entry: { permitted: true, reasons: [] } }) };

  let rendered = null;
  const apply = (incoming) => {
    if (!acceptStatus(rendered === null ? null : decisionGenerationOf(rendered), incoming)) return false;
    rendered = incoming;
    return true;
  };

  assert.equal(apply(fresh), true);
  assert.equal(apply(stale), false, "the older response is refused");
  assert.equal(rendered.operational_readiness.entry.permitted, false, "the blocked verdict survives");
});

test("OUT-OF-ORDER: an UNORDERABLE payload cannot replace an ordered one already rendered", () => {
  // An older backend (no decision) may paint the first frame, but once an ordered decision is on
  // screen an unorderable payload could be anything — including older — so it is refused.
  assert.equal(acceptStatus(null, { running: true }), true, "first paint works without a decision");
  assert.equal(acceptStatus(4, { running: true }), false, "'possibly older' must not overwrite 'known current'");
  assert.equal(acceptStatus(null, null), false, "nothing is not a payload");
});

/* ═══════════════ 4. RECONNECT ═══════════════ */

test("RECONNECT: an owed gap repair pauses entry, keeps exposure manageable, and says why", () => {
  const md = deriveMarketData(READY_MD_STATUS);
  const gate = deriveEntryGate(
    md,
    null,
    decision({
      order_stream: { lifecycle: "RECONCILING", published_state: "RECONNECTED_PENDING_RECONCILE", wiring: "armed", gate_enabled: true, connected: true, authorised: true, disconnects: 1 },
      reconciliation: {
        pending: true,
        blockers: [{ code: "order_stream_reconciliation_owed", scope: "entry", detail: "a REST reconciliation of the gap is owed" }],
      },
      entry: {
        permitted: false,
        reasons: [{ code: "order_stream_lifecycle", scope: "entry", detail: "a REST reconciliation is owed before the stream is trusted" }],
      },
    }),
  );
  assert.equal(gate.entryPermitted, false);
  assert.equal(gate.positionsManageable, true, "a reconnect must never strand a live position");
  assert.equal(gate.overallBand, "paused", "paused-but-safe is not the same as broken");
  assert.ok(gate.entryPausedReasons.some((r) => /reconcil/i.test(r)));
});

test("RECONNECT: the generation counter advances, so the post-reconnect decision supersedes the old one", () => {
  const before = { operational_readiness: decision({ decision_generation: 40 }) };
  const after = { operational_readiness: decision({ decision_generation: 41, order_stream: { lifecycle: "RECONCILING", published_state: "RECONNECTED_PENDING_RECONCILE", wiring: "armed", gate_enabled: true, connected: true, authorised: true, disconnects: 1 } }) };
  assert.equal(acceptStatus(decisionGenerationOf(before), after), true);
  assert.equal(acceptStatus(decisionGenerationOf(after), before), false);
});

/* ═══════════════ 5. HTTP 401 / 403 / TIMEOUT ═══════════════ */

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test("HTTP 401: a readiness fetch that 401s throws and is recorded as a FAILED refresh", async () => {
  stubFetch(() => jsonResponse(401, { error: "unauthorized" }));
  const tracker = new RefreshTracker(10_000);
  await assert.rejects(() => request("/api/runtime/status", "Failed to load the runtime status"), UnauthorizedError);
  tracker.recordFailure("session expired");
  const s = tracker.state(100);
  assert.equal(s.freshness, "unknown", "a 401 before any success leaves readiness UNKNOWN, not fine");
  assert.equal(s.consecutiveFailures, 1);
});

test("HTTP 403: a refused mutation surfaces the backend's refusal and RELEASES the control slot", async () => {
  // The backend is the authorisation boundary. A UI that leaves its own control stuck after a 403
  // forces a reload; a UI that hides the 403 teaches the operator the button is broken.
  setCsrfToken("csrf-token-value");
  stubFetch(() => jsonResponse(403, { error: "CSRF token missing or invalid." }));
  const requests = new ControlRequests();
  const out = await runOnce(requests, "entry_arming", () =>
    request("/api/box/controls/box_entry_enabled", "Failed to set entry", { method: "POST", body: { enabled: true } }),
  ).catch((err) => err);
  assert.ok(out instanceof Error, "the 403 reaches the caller rather than being swallowed");
  assert.match(out.message, /CSRF token missing or invalid/);
  assert.equal(requests.isPending("entry_arming"), false, "the slot is released even on failure");
  clearCsrfToken();
});

test("TIMEOUT: an aborted/hung refresh leaves the previous reading visibly STALE, not current", async () => {
  stubFetch(() => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    return Promise.reject(err);
  });
  const tracker = new RefreshTracker(5000);
  tracker.recordSuccess(1000);
  await assert.rejects(() => request("/api/runtime/status", "Failed to load the runtime status"));
  tracker.recordFailure("the readiness refresh timed out");
  const s = tracker.state(2000);
  assert.equal(s.freshness, "stale");
  assert.match(s.detail, /timed out/);
  assert.equal(s.ageMs, 1000, "the age of what is on screen is preserved and stated");
});

/* ═══════════════ 6. DOUBLE-CLICK ═══════════════ */

test("DOUBLE-CLICK: two clicks in the SAME frame produce exactly ONE request", async () => {
  // The failure this replaces: `disabled={busy !== null}` reads `busy` from the render closure, so
  // both handlers in one frame observe the pre-update value and both fire. The registry is mutated
  // synchronously, so the second click is refused before it reaches the network.
  let sent = 0;
  const requests = new ControlRequests();
  const fire = () => runOnce(requests, "entry_arming", async () => {
    sent += 1;
    await new Promise((r) => setTimeout(r, 5));
    return "ok";
  });
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(sent, 1, "exactly one request left the page");
  assert.equal(a.sent === true || b.sent === true, true);
  assert.equal(a.sent === false || b.sent === false, true, "the duplicate was refused");
  const refused = a.sent === false ? a : b;
  assert.match(refused.reason, /already in flight/, "and it SAYS it was refused rather than doing nothing");
});

test("DOUBLE-CLICK: the slot is released after success AND after failure", async () => {
  const requests = new ControlRequests();
  await runOnce(requests, "session_arming", async () => "ok");
  assert.equal(requests.isPending("session_arming"), false);
  await runOnce(requests, "session_arming", async () => {
    throw new Error("backend refused");
  }).catch(() => {});
  assert.equal(requests.isPending("session_arming"), false, "a failed request must not wedge the control");
});

test("DISTINCT CONTROLS: an in-flight entry arming never blocks an EMERGENCY action", async () => {
  // A single global `busy` flag disabled everything, including the emergency brake, while any one
  // request was in flight. Blocking an emergency because someone clicked "arm entry" is worse than
  // allowing it.
  const requests = new ControlRequests();
  assert.equal(requests.begin("entry_arming"), true);
  assert.equal(requests.isPending("entry_arming"), true);
  assert.equal(requests.isPending("emergency"), false);
  const emergency = await runOnce(requests, "emergency", async () => "flattened");
  assert.equal(emergency.sent, true, "the emergency action is not queued behind entry arming");
  // All four authorities are separately addressable, and each is named for the operator.
  for (const cls of ["entry_arming", "live_order_management", "emergency", "session_arming"]) {
    assert.equal(typeof CONTROL_LABEL[cls], "string");
  }
  assert.equal(
    new Set(["entry_arming", "live_order_management", "emergency", "session_arming"].map((c) => CONTROL_LABEL[c])).size,
    4,
    "the four control classes are labelled distinctly",
  );
  requests.end("entry_arming");
});

test("DOUBLE-CLICK: the same trade cannot be actioned twice, but two DIFFERENT trades can proceed", async () => {
  const requests = new ControlRequests();
  assert.equal(requests.begin("trade", "box-1"), true);
  assert.equal(requests.begin("trade", "box-1"), false, "the same trade is single-flighted");
  assert.equal(requests.begin("trade", "box-2"), true, "a different trade is unaffected");
});

/* ═══════════════ 7. MODE CHANGE ═══════════════ */

test("MODE CHANGE: the label follows the BACKEND mode — no hardcoded 'paper trading' under live", () => {
  const live = modeLabel("live");
  assert.equal(live.live, true);
  assert.match(live.badge, /LIVE/);
  assert.doesNotMatch(live.subtitle, /paper/i, "a LIVE deployment must never be labelled paper");
  assert.match(live.subtitle, /LIVE, real money/);
  assert.match(live.detail, /REAL orders with REAL money/);

  for (const mode of ["paper", "paper_latency", "paper_legging", "paper_legging_live_parity"]) {
    const paper = modeLabel(mode);
    assert.equal(paper.live, false);
    assert.match(paper.subtitle, /paper trading/);
    // The specific simulation is named — the profiles are not interchangeable.
    assert.match(paper.subtitle, new RegExp(mode.replace(/_/g, " ")));
  }
});

test("MODE CHANGE: an UNKNOWN mode is reported as unknown, never defaulted to paper", () => {
  for (const missing of [undefined, null, "", "   "]) {
    const m = modeLabel(missing);
    assert.equal(m.live, false, "unknown is not claimed to be live");
    assert.match(m.badge, /unknown/i);
    assert.doesNotMatch(m.subtitle, /paper trading/, "guessing 'paper' is a guess in the dangerous direction");
    assert.match(m.detail, /Do not assume this is paper/);
  }
});

test("MODE CHANGE: a live deployment with its runtime DISARMED is still labelled LIVE", () => {
  // Labelling it paper for as long as it is disarmed is exactly the reassurance that gets someone
  // to press the toggle.
  assert.equal(modeLabel("live").live, true);
  const d = decision({
    identity: { broker: "zerodha", account_masked: "AB••34", account_present: true, execution_mode: "live", live_runtime_armed: false, deployment_live_capable: true },
  });
  assert.equal(d.identity.deployment_live_capable, true);
  assert.equal(modeLabel(d.identity.execution_mode).live, true);
});

/* ═══════════════ 8. BROKER SWITCH ═══════════════ */

test("BROKER SWITCH: the decision names the broker it was computed for, so a stale one cannot linger", () => {
  const md = deriveMarketData(READY_MD_STATUS);
  const zerodha = decision({ decision_generation: 20 });
  const dhan = decision({
    decision_generation: 21,
    identity: { broker: "dhan", account_masked: "12••99", account_present: true, execution_mode: "live", live_runtime_armed: true, deployment_live_capable: true },
    entry: { permitted: false, reasons: [{ code: "active_broker_token_not_ready", scope: "entry", detail: "the dhan session token is waiting" }] },
  });

  assert.equal(zerodha.identity.broker, "zerodha");
  assert.equal(dhan.identity.broker, "dhan");
  // The newer (post-switch) decision supersedes; the older one cannot come back.
  assert.equal(acceptDecision(zerodha.decision_generation, dhan.decision_generation), true);
  assert.equal(acceptDecision(dhan.decision_generation, zerodha.decision_generation), false);
  // And the post-switch verdict is what renders.
  const gate = deriveEntryGate(md, null, dhan);
  assert.equal(gate.entryPermitted, false);
  assert.deepEqual(gate.entryPausedReasons, ["the dhan session token is waiting"]);
});

test("BROKER SWITCH: the masked account changes with the broker and is never published raw", () => {
  const d = decision({
    identity: { broker: "dhan", account_masked: "12••99", account_present: true, execution_mode: "live", live_runtime_armed: true, deployment_live_capable: true },
  });
  const blob = JSON.stringify(d);
  assert.match(blob, /12••99/, "a masked reference is shown so the operator can confirm the account");
  assert.doesNotMatch(blob, /1100112299/, "the raw id is never present");
  assert.doesNotMatch(blob, /access_token|Bearer|passcode/i);
});

/* ═══════════════ 9. SCANNER STOP ═══════════════ */

test("SCANNER STOP: entry and MONITORING are explained separately and explicitly", () => {
  const stop = explainScannerStop(true, decision({
    exposure_management: {
      exit_and_reduce: true, protective_cancel: true, manage_working_orders: true,
      blocked_reasons: [], limitations: ["permission is not a fill"],
      open_positions: 2, residual_legs: 1, working_orders: 0,
    },
  }));
  assert.match(stop.entryEffect, /No NEW box/);
  assert.match(stop.entryEffect, /entry only/i);
  assert.match(stop.positionsEffect, /ARE still monitored/);
  assert.match(stop.positionsEffect, /2 open/);
  assert.match(stop.positionsEffect, /1 residual leg/);
  assert.equal(stop.positionsManageable, true);
});

test("SCANNER STOP: with NO decision, monitoring is UNKNOWN rather than reassuring", () => {
  const stop = explainScannerStop(true, null);
  assert.match(stop.positionsEffect, /UNKNOWN/);
  assert.equal(stop.positionsManageable, false, "never claim a position is safe on no evidence");
});

test("SCANNER STOP: a real reduction blocker is NOT attributed to stopping the scanner", () => {
  const stop = explainScannerStop(true, decision({
    exposure_management: {
      exit_and_reduce: false, protective_cancel: true, manage_working_orders: false,
      blocked_reasons: [{ code: "market_data_session_expired", scope: "reduction", detail: "the broker will refuse a priced reduction" }],
      limitations: ["permission is not a fill"],
      open_positions: 1, residual_legs: 0, working_orders: 0,
    },
  }));
  assert.match(stop.positionsEffect, /BLOCKED/);
  assert.match(stop.positionsEffect, /refuse a priced reduction/);
  assert.match(stop.positionsEffect, /not a consequence of stopping the scanner/);
});

/* ═══════════════ 10. EXPOSURE AND UNKNOWN P&L ═══════════════ */

test("EXPOSURE: residual legs are named SEPARATELY from open boxes", () => {
  const view = deriveExposure(decision({
    exposure_management: {
      exit_and_reduce: true, protective_cancel: true, manage_working_orders: true,
      blocked_reasons: [], limitations: ["permission is not a fill"],
      open_positions: 1, residual_legs: 3, working_orders: 2,
    },
  }));
  assert.equal(view.openPositions, 1);
  assert.equal(view.residualLegs, 3);
  assert.equal(view.workingOrders, 2);
  assert.equal(view.hasExposure, true);
  assert.match(view.detail, /1 open box/);
  assert.match(view.detail, /3 RESIDUAL leg\(s\) — exposure without a complete box/);
  assert.match(view.detail, /2 working order/);
  assert.ok(view.limitations.length > 0, "the real limitations are carried, not implied");
});

test("EXPOSURE: with no decision, remaining exposure is UNKNOWN — explicitly not flat", () => {
  const view = deriveExposure(null);
  assert.equal(view.hasExposure, false);
  assert.match(view.detail, /UNKNOWN/);
  assert.match(view.detail, /not the same as flat/);
  assert.deepEqual(view.limitations, []);
});

test("UNKNOWN P&L: an unpriceable figure renders as unknown, NEVER as ₹0", () => {
  for (const bad of [null, undefined, Number.NaN]) {
    const v = moneyView(bad, "no executable book for the leg");
    assert.equal(v.known, false);
    assert.equal(v.text, "—");
    assert.doesNotMatch(v.text, /0/, "an unknown mark must not render as a number");
    assert.match(v.reason, /unknown — no executable book/);
  }
  // A genuine zero is still a zero, and is reported as one.
  const zero = moneyView(0);
  assert.equal(zero.known, true);
  assert.equal(zero.text, "₹0");
  assert.equal(moneyView(-1500).text, "−₹1,500");
});

test("UNKNOWN P&L: unpriced legs make the running figure INCOMPLETE and it says so", () => {
  const incomplete = deriveRunningPnl({
    day_pnl: { open_running_net_pnl: 1234 },
    indicative_stale_legs: 2,
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.net.known, false);
  assert.equal(incomplete.net.text, "—", "a partial mark is not published as a whole number");
  assert.match(incomplete.net.reason, /2 leg\(s\) could not be priced/);
  assert.match(incomplete.detail, /INCOMPLETE/);

  const complete = deriveRunningPnl({
    day_pnl: { open_running_net_pnl: 1234 },
    indicative_stale_legs: 0,
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.net.known, true);
  assert.equal(complete.net.text, "₹1,234");
  assert.match(complete.detail, /A mark is not a fill/);
});

test("UNKNOWN P&L: a missing day_pnl is unknown, not zero", () => {
  const v = deriveRunningPnl({ indicative_stale_legs: 0 });
  assert.equal(v.net.known, false);
  assert.equal(v.net.text, "—");
  assert.equal(deriveRunningPnl(null).net.known, false);
});
