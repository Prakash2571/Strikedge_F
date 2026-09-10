/**
 * OPERATIONAL-STATE DERIVATION TESTS (item 10).
 *
 * These prove the load-bearing HONESTY properties of the operational panel, on the SAME pure
 * functions the component renders (no DOM needed):
 *
 *   1. Market-data health and order-update health are INDEPENDENT — a READY market-data feed does
 *      not make the order stream "live", and a live order stream does not make the feed READY.
 *   2. A reconnecting / degraded feed is the "paused-but-safe" band (positions still manageable),
 *      DISTINCT from a disconnected / expired feed which is "broken".
 *   3. Entry is permitted ONLY when the market-data feed is READY; the reasons are stated.
 *   4. The economic figures keep gross notional and margin as DISTINCT quantities.
 *   5. Funnel ratios carry their denominator and report an undefined ratio as null, never 0/1.
 *
 * It also validates against the retained box-status fixture so the derivations are exercised on a
 * real captured payload shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  bandClass,
  bandGlyph,
  deriveActiveOrderStream,
  deriveEconomicFigures,
  deriveEntryGate,
  deriveFunnel,
  deriveMarketData,
  marketDataBand,
  orderStreamBrokerBand,
  formatRatio,
} from "../src/lib/operationalState.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, "fixtures", "box-status.json"), "utf8"));

/* ─────────────────────────── market-data band classification ─────────────────────────── */

test("marketDataBand maps the eight states into the three operator bands (+absent)", () => {
  assert.equal(marketDataBand("READY"), "ready");
  assert.equal(marketDataBand("CONNECTING"), "paused");
  assert.equal(marketDataBand("AUTHENTICATING"), "paused");
  assert.equal(marketDataBand("SYNCHRONIZING"), "paused");
  assert.equal(marketDataBand("DEGRADED"), "paused");
  assert.equal(marketDataBand("DISCONNECTED"), "broken");
  assert.equal(marketDataBand("AUTH_EXPIRED"), "broken");
  assert.equal(marketDataBand("DISABLED"), "absent");
});

test("deriveMarketData surfaces per-instrument readiness and only READY is usable for entry", () => {
  const ready = deriveMarketData({
    market_data_state: "READY",
    market_data_health: {
      state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false,
    },
  });
  assert.equal(ready.band, "ready");
  assert.equal(ready.dataUsableForEntry, true);
  assert.equal(ready.readyInstruments, 4);
  assert.equal(ready.desiredInstruments, 4);

  const sync = deriveMarketData({
    market_data_state: "SYNCHRONIZING",
    market_data_health: {
      state: "SYNCHRONIZING", generation: 4, desired: 4, confirmed: 2, readyInstruments: 2,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: null, backlog: false,
    },
  });
  assert.equal(sync.band, "paused");
  assert.equal(sync.dataUsableForEntry, false, "a synchronizing feed is not usable for entry");
  assert.equal(sync.readyInstruments, 2);
});

/* ─────────────────────────── honesty rule #1: the two signals are independent ─────────────────────────── */

test("HONESTY #1: a READY market-data feed does NOT make the order stream live", () => {
  // Order stream is not wired for either broker → REST polling only, even though MD is READY.
  const orderStream = {
    any_stream_live: false,
    market_data_health_is_not_order_stream_health: true,
    brokers: [
      { broker: "zerodha", wiring: "not_wired", gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED",
        gate_enabled: false, health: null, fills_observed_by: "rest_polling_only", detail: "x" },
    ],
  };
  const os = deriveActiveOrderStream(orderStream, "zerodha");
  assert.equal(os.anyStreamLive, false, "market-data READY cannot fabricate a live order stream");
  assert.equal(os.active.streamObserved, false);
  assert.equal(os.active.mechanismLabel, "REST polling only");
  assert.equal(os.antiConflation, true, "the anti-conflation flag is carried to the UI");
});

test("HONESTY #1: a live order stream is reported independently of the feed state", () => {
  const orderStream = {
    any_stream_live: true,
    market_data_health_is_not_order_stream_health: true,
    brokers: [
      { broker: "dhan", wiring: "armed", gate_env_var: "DHAN_ORDER_STREAM_ENABLED",
        gate_enabled: true,
        health: { state: "LIVE", connected: true, authorised: true, lastEventAt: 10,
          disconnects: 0, reconcilePending: false, detail: "live" },
        fills_observed_by: "stream_primary_rest_reconcile", detail: "live" },
    ],
  };
  const os = deriveActiveOrderStream(orderStream, "dhan");
  assert.equal(os.active.streamObserved, true);
  assert.equal(orderStreamBrokerBand(orderStream.brokers[0]), "ready");
  assert.equal(os.active.mechanismLabel, "stream first, REST reconciles");
});

/* ─────────────────────────── honesty rule #2: paused-but-safe ≠ broken ─────────────────────────── */

test("HONESTY #2: a reconnecting/degraded feed is PAUSED with positions still manageable", () => {
  for (const state of ["CONNECTING", "AUTHENTICATING", "SYNCHRONIZING", "DEGRADED"]) {
    const md = deriveMarketData({
      market_data_state: state,
      market_data_health: {
        state, generation: 2, desired: 4, confirmed: 1, readyInstruments: 1,
        lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: null, backlog: false,
      },
    });
    const gate = deriveEntryGate(md, null);
    assert.equal(gate.entryPermitted, false, `${state}: entry must be paused`);
    assert.equal(gate.overallBand, "paused", `${state}: band is paused, not broken`);
    assert.equal(gate.positionsManageable, true, `${state}: positions remain manageable`);
    assert.ok(gate.entryPausedReasons.length > 0, `${state}: a reason is given`);
  }
});

test("HONESTY #2: a disconnected feed is BROKEN, and an expired session is broken + unmanageable", () => {
  const disc = deriveEntryGate(
    deriveMarketData({
      market_data_state: "DISCONNECTED",
      market_data_health: { state: "DISCONNECTED", generation: 2, desired: 4, confirmed: 0,
        readyInstruments: 0, lastHeartbeatAt: null, lastFrameAt: null, lastDepthAt: null, backlog: false },
    }),
    null,
  );
  assert.equal(disc.overallBand, "broken");
  assert.equal(disc.entryPermitted, false);
  assert.equal(disc.positionsManageable, true, "disconnected still permits exit/cancel");

  const expired = deriveEntryGate(
    deriveMarketData({
      market_data_state: "AUTH_EXPIRED",
      market_data_health: { state: "AUTH_EXPIRED", generation: 2, desired: 4, confirmed: 0,
        readyInstruments: 0, lastHeartbeatAt: null, lastFrameAt: null, lastDepthAt: null, backlog: false },
    }),
    null,
  );
  assert.equal(expired.overallBand, "broken");
  assert.equal(expired.positionsManageable, false, "an expired session is not freely manageable");
});

test("HONESTY #2: a reconnected order stream owing reconciliation pauses entry with a clear reason", () => {
  const md = deriveMarketData({
    market_data_state: "READY",
    market_data_health: { state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false },
  });
  const osBroker = {
    broker: "zerodha", wiring: "armed", gate_env_var: "ZERODHA_ORDER_STREAM_ENABLED", gate_enabled: true,
    health: { state: "RECONNECTED_PENDING_RECONCILE", connected: true, authorised: true, lastEventAt: 5,
      disconnects: 1, reconcilePending: true, detail: "reconnected" },
    fills_observed_by: "rest_polling_only", detail: "reconnected, reconciliation owed",
  };
  const os = deriveActiveOrderStream(
    { any_stream_live: false, market_data_health_is_not_order_stream_health: true, brokers: [osBroker] },
    "zerodha",
  );
  const gate = deriveEntryGate(md, os.active);
  assert.equal(gate.entryPermitted, false, "READY feed but reconciliation owed → entry still paused");
  assert.equal(gate.overallBand, "paused");
  assert.ok(
    gate.entryPausedReasons.some((r) => /reconcil/i.test(r)),
    "the reason names the owed reconciliation",
  );
  assert.equal(gate.positionsManageable, true);
});

test("entry is permitted ONLY when the feed is READY and no reconciliation is owed", () => {
  const md = deriveMarketData({
    market_data_state: "READY",
    market_data_health: { state: "READY", generation: 3, desired: 4, confirmed: 4, readyInstruments: 4,
      lastHeartbeatAt: 1, lastFrameAt: 1, lastDepthAt: 1, backlog: false },
  });
  const gate = deriveEntryGate(md, null);
  assert.equal(gate.entryPermitted, true);
  assert.deepEqual(gate.entryPausedReasons, []);
  assert.equal(gate.overallBand, "ready");
});

/* ─────────────────────────── gross notional ≠ margin ─────────────────────────── */

test("deriveEconomicFigures keeps gross notional and planned margin as DISTINCT labelled quantities", () => {
  const admission = {
    allowed: true,
    reasons: [],
    detail: null,
    controls: { gross_cap_enabled: true, funds_check_enabled: true, margin_evidence_required: false },
    picture: {
      available_funds: { value_rupees: 500000, provenance: "broker_confirmed", observed_at: 1, age_ms: 10, usable: true, note: "funds" },
      planned_margin: { value_rupees: 42000, provenance: "broker_confirmed", observed_at: 1, age_ms: 10, usable: true, note: "netted margin" },
      peak_legging_exposure: { value_rupees: 210000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "peak" },
      gross_notional: { value_rupees: 210000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "gross" },
      worst_case_entry: { value_rupees: 215000, provenance: "estimate", observed_at: 1, age_ms: 10, usable: false, note: "worst" },
    },
  };
  const figs = deriveEconomicFigures(admission);
  const byKey = Object.fromEntries(figs.map((f) => [f.key, f]));
  assert.equal(byKey.gross_notional.label, "Gross notional");
  assert.equal(byKey.planned_margin.label, "Planned margin (netted)");
  assert.notEqual(byKey.gross_notional.value, byKey.planned_margin.value, "gross notional and margin are different numbers");
  assert.equal(byKey.planned_margin.value, "₹42,000");
  assert.equal(byKey.gross_notional.value, "₹2,10,000");
  // A margin-confirmed figure is usable; an estimated gross-notional is shown but not authority.
  assert.equal(byKey.planned_margin.usable, true);
  assert.equal(byKey.gross_notional.usable, false);
});

/* ─────────────────────────── funnel honesty ─────────────────────────── */

test("formatRatio reports an undefined ratio as null-basis, never 0% or 100%", () => {
  assert.equal(formatRatio({ rate: null, numerator: 0, denominator: 0 }), "— (0/0)");
  assert.equal(formatRatio({ rate: 0.5, numerator: 1, denominator: 2 }), "50% (1/2)");
});

test("deriveFunnel exposes the nested chain, both ratio kinds, and never hides exposure/recovery", () => {
  const snap = {
    candidates_evaluated: 100, qualified_opportunities: 20, attempts_admitted: 10,
    attempts_submitted: 6, four_leg_completed_entries: 4,
    zero_post_refusals: 4, zero_post_by_reason: {}, submitted_failures: 2, submitted_failures_by_reason: {},
    no_fill_cancellations: 1, partial_entry_recoveries: 1, unresolved_exposure_open: 1,
    unresolved_exposure_total: 3, completed_exits: 2, realised_net_pnl: -1500,
    recovery_costs_included: 900, economically_profitable: 2, economically_unprofitable: 2,
    ratios: {
      admission_rate: { numerator: 10, denominator: 20, rate: 0.5, basis: "admitted / qualified" },
      submission_rate: { numerator: 6, denominator: 10, rate: 0.6, basis: "submitted / admitted" },
      execution_completion_rate: { numerator: 4, denominator: 6, rate: 0.6667, basis: "completed / submitted" },
      economic_success_rate: { numerator: 2, denominator: 4, rate: 0.5, basis: "profitable / completed" },
      unresolved_exposure_rate: { numerator: 3, denominator: 10, rate: 0.3, basis: "unresolved / admitted" },
    },
  };
  const v = deriveFunnel(snap);
  assert.equal(v.chain.length, 5);
  assert.equal(v.chain[0].count, 100);
  assert.equal(v.chain[4].count, 4);
  // Economic success is a SEPARATE ratio kind from execution completion.
  const econ = v.ratios.find((r) => r.kind === "economic");
  assert.ok(econ && /economic/i.test(econ.label));
  const exec = v.ratios.filter((r) => r.kind === "execution");
  assert.equal(exec.length, 4);
  // Exposure and recovery are surfaced, not hidden.
  assert.equal(v.exposure.unresolvedOpen, 1);
  assert.equal(v.exposure.zeroPostRefusals, 4);
  assert.equal(v.exposure.recoveryCostsIncluded, "₹900");
  assert.equal(v.exposure.realisedNetPnl, "−₹1,500", "a loss renders with a real minus sign, not hidden");
});

/* ─────────────────────────── colour-not-alone + fixture exercise ─────────────────────────── */

test("every band has a distinct text glyph so signalling is never colour-alone", () => {
  const glyphs = ["ready", "paused", "broken", "absent"].map(bandGlyph);
  assert.equal(new Set(glyphs).size, 4, "each band has a unique glyph");
  assert.equal(bandClass("ready"), "is-good");
  assert.equal(bandClass("paused"), "is-warn");
  assert.equal(bandClass("broken"), "is-bad");
});

test("the derivations run on the retained box-status fixture (stopped/paper baseline)", () => {
  const md = deriveMarketData(fixture);
  assert.equal(md.state, "DISABLED");
  assert.equal(md.band, "absent");
  const os = deriveActiveOrderStream(fixture.order_stream, fixture.broker);
  assert.equal(os.anyStreamLive, false);
  assert.equal(os.active.streamObserved, false);
  const funnel = deriveFunnel(fixture.execution_funnel);
  assert.equal(funnel.chain[0].count, 0);
  // economic_admission is null in the paper baseline — the component must not fabricate figures.
  assert.equal(fixture.economic_admission, null);
});
