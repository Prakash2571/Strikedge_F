/**
 * OPERATIONAL-STATE DERIVATION — the pure half of the operational dashboard (item 10).
 *
 * WHY A SEPARATE PURE MODULE
 * The frontend test harness is `node:test` importing modules directly (no DOM, no JSX render).
 * So every non-trivial decision the operational panel makes — which health BAND a transport is
 * in, whether the two independent health signals may be shown together, why entry is paused,
 * whether existing positions remain manageable — lives here as a pure function and is unit-tested,
 * including the degraded/reconnecting cases. The component (`BoxOperationalState.tsx`) only maps
 * these results onto markup.
 *
 * THE TWO HONESTY RULES THIS MODULE ENCODES
 *   1. Market-data health and order-update health are INDEPENDENT facts. `deriveMarketData` and
 *      `deriveOrderStream` never read each other; a connected quote socket can be READY while the
 *      order stream is REST-polling, and vice-versa. Neither is allowed to imply the other.
 *   2. During reconnection, a PAUSED-ENTRY state with manageable exposure (`band: "paused"`) is a
 *      distinct band from a BROKEN state (`band: "broken"`). `entryPausedReasons` states exactly
 *      WHY entry is paused; `positionsManageable` states whether existing positions can still be
 *      managed (exit/cancel), so "paused but safe" never renders like "broken".
 *
 * GROSS NOTIONAL vs MARGIN: `economicFigureLabel` carries each of the five economic quantities
 * under its OWN label; this module never sums or relabels one as another.
 *
 * PURE: no browser globals, no fetch, no clock except an injected `now` where an age is computed.
 */

import type {
  BoxStatus,
  EconomicAdmission,
  EconomicFigure,
  ExecutionFunnelSnapshot,
  MarketDataHealth,
  MarketDataState,
  OrderStreamBrokerStatus,
  OrderStreamStatus,
} from "../api/types.ts";

/** A health BAND, ordered by severity. Rendered with DISTINCT wording, icon AND colour. */
export type HealthBand = "ready" | "paused" | "broken" | "absent";

/** A market-data readiness view for the ACTIVE broker's feed. */
export interface MarketDataView {
  state: MarketDataState;
  band: HealthBand;
  /** Short label, e.g. "Ready", "Reconnecting", "Disconnected". */
  label: string;
  /** Plain-language sentence stating what this state does and does not permit. */
  detail: string;
  /** True only in READY — usable depth per traded instrument in the current generation. */
  dataUsableForEntry: boolean;
  /** Per-instrument readiness gauge: ready of desired. */
  readyInstruments: number;
  desiredInstruments: number;
}

/**
 * The eight MarketDataState values collapsed into the three operator-facing bands, plus DISABLED
 * as `absent`. This is the mechanical basis for honesty rule #2: everything in `paused` keeps
 * exposure manageable; only `broken` (or an expired session) is unsafe.
 */
export function marketDataBand(state: MarketDataState): HealthBand {
  switch (state) {
    case "READY":
      return "ready";
    case "CONNECTING":
    case "AUTHENTICATING":
    case "SYNCHRONIZING":
    case "DEGRADED":
      return "paused";
    case "DISCONNECTED":
    case "AUTH_EXPIRED":
      return "broken";
    case "DISABLED":
      return "absent";
  }
}

const MARKET_DATA_LABEL: Record<MarketDataState, string> = {
  DISABLED: "Not configured",
  CONNECTING: "Connecting",
  AUTHENTICATING: "Authenticating",
  SYNCHRONIZING: "Synchronizing",
  READY: "Ready",
  DEGRADED: "Degraded",
  DISCONNECTED: "Disconnected",
  AUTH_EXPIRED: "Session expired",
};

const MARKET_DATA_DETAIL: Record<MarketDataState, string> = {
  DISABLED: "Market data is not armed. No pricing basis for any decision.",
  CONNECTING: "A connection attempt is in flight. New entry is paused; open positions stay manageable.",
  AUTHENTICATING: "Socket open, session handshake not yet accepted. A route is not readiness. New entry is paused.",
  SYNCHRONIZING:
    "Authenticated; subscriptions restoring and fresh depth per instrument still owed. New entry is paused; exit and cancel continue.",
  READY: "Authenticated, subscribed, and fresh usable depth is being observed for the traded instruments.",
  DEGRADED:
    "Connected but the data cannot be trusted for entry (heartbeat gap, stale book, partial subscription or a processing backlog). New entry is paused; a reduction can still be priced off a current single-leg book.",
  DISCONNECTED: "The socket is closed or half-open. New entry is stopped; exposure management and protective cancel continue.",
  AUTH_EXPIRED: "The session/token was rejected or expired. Reconnecting with it is pointless — the broker will refuse everything but a cancel.",
};

/** Derive the market-data readiness view. This never reads order-stream health (honesty rule #1). */
export function deriveMarketData(status: Pick<BoxStatus, "market_data_state" | "market_data_health">): MarketDataView {
  const state = status.market_data_state;
  const health: MarketDataHealth | undefined = status.market_data_health;
  return {
    state,
    band: marketDataBand(state),
    label: MARKET_DATA_LABEL[state],
    detail: MARKET_DATA_DETAIL[state],
    dataUsableForEntry: state === "READY",
    readyInstruments: health?.readyInstruments ?? 0,
    desiredInstruments: health?.desired ?? 0,
  };
}

/** The order-update view for one broker: the mechanism ACTUALLY observing a fill. */
export interface OrderStreamBrokerView {
  broker: OrderStreamBrokerStatus["broker"];
  band: HealthBand;
  wiringLabel: string;
  /** The mechanism currently responsible for observing a fill — the field a human should read. */
  mechanismLabel: string;
  streamObserved: boolean;
  reconcilePending: boolean;
  detail: string;
}

const WIRING_LABEL: Record<OrderStreamBrokerStatus["wiring"], string> = {
  not_built: "not implemented",
  not_wired: "not wired",
  gated_off: "not armed",
  armed: "armed",
};

export function orderStreamBrokerBand(b: OrderStreamBrokerStatus): HealthBand {
  if (b.fills_observed_by === "stream_primary_rest_reconcile") return "ready";
  // A wired-but-idle stream, or one that is armed yet reconnecting, is "paused" — fills are still
  // observed by REST polling, so exposure remains manageable, but it is NOT the fast path.
  if (b.wiring === "not_built" || b.wiring === "gated_off") return "absent";
  return "paused";
}

export function mechanismLabel(m: OrderStreamBrokerStatus["fills_observed_by"]): string {
  return m === "stream_primary_rest_reconcile" ? "stream first, REST reconciles" : "REST polling only";
}

export function deriveOrderStreamBroker(b: OrderStreamBrokerStatus): OrderStreamBrokerView {
  return {
    broker: b.broker,
    band: orderStreamBrokerBand(b),
    wiringLabel: WIRING_LABEL[b.wiring],
    mechanismLabel: mechanismLabel(b.fills_observed_by),
    streamObserved: b.fills_observed_by === "stream_primary_rest_reconcile",
    reconcilePending: b.health?.reconcilePending ?? false,
    detail: b.detail,
  };
}

/** The ACTIVE broker's order-stream view, plus the anti-conflation flag surfaced from the payload. */
export function deriveActiveOrderStream(
  orderStream: OrderStreamStatus,
  activeBroker: OrderStreamBrokerStatus["broker"] | undefined,
): { active: OrderStreamBrokerView | null; anyStreamLive: boolean; antiConflation: true } {
  const activeRaw =
    (activeBroker && orderStream.brokers.find((b) => b.broker === activeBroker)) || null;
  return {
    active: activeRaw ? deriveOrderStreamBroker(activeRaw) : null,
    anyStreamLive: orderStream.any_stream_live,
    // The payload asserts this; the UI carries it so an operator is told, not left to infer.
    antiConflation: orderStream.market_data_health_is_not_order_stream_health,
  };
}

/**
 * WHY ENTRY IS PAUSED — a combined, operator-readable reason list derived from the two INDEPENDENT
 * transports, plus whether existing positions remain manageable.
 *
 * Mirrors the intent of the backend `permissionBlocks` / permission matrix: NEW ENTRY needs the
 * most evidence (both transports READY); EXIT and PROTECTIVE CANCEL need far less, so a paused feed
 * still leaves a live position manageable. This is what makes "paused-but-safe" visually and
 * semantically distinct from "broken".
 */
export interface EntryGate {
  /** True only when BOTH transports permit new entry (market data READY; order stream not broken). */
  entryPermitted: boolean;
  /** One sentence per reason entry is paused/blocked. Empty when entry is permitted. */
  entryPausedReasons: string[];
  /** True when existing positions can still be exited/reduced/cancelled despite a paused feed. */
  positionsManageable: boolean;
  /** The worse of the two transport bands — drives the headline tone. */
  overallBand: HealthBand;
}

export function deriveEntryGate(md: MarketDataView, os: OrderStreamBrokerView | null): EntryGate {
  const reasons: string[] = [];

  // Market data must be READY for entry.
  if (md.band !== "ready") {
    if (md.state === "DISABLED") reasons.push("market data is not configured");
    else if (md.band === "paused") reasons.push(`market data is ${md.label.toLowerCase()} (fresh depth per traded instrument not yet proven)`);
    else reasons.push(`market data is ${md.label.toLowerCase()}`);
  }

  // The order stream blocks entry only when it is genuinely broken/reconnecting. A DISABLED or
  // gated-off stream is NOT a fault — REST polling is the documented fallback — so it does not
  // pause entry by itself; it is reported as a slower fill path, not a block.
  if (os) {
    if (os.reconcilePending) {
      reasons.push("the order-update stream reconnected and a REST reconciliation is owed");
    }
  }

  // A market-data feed that is broken (disconnected / session expired) is the case where existing
  // positions may NOT be freely manageable: an expired session means the broker refuses all but a
  // cancel, and a disconnected feed cannot price a reduction. DEGRADED / reconnecting still permit
  // exit and cancel, so positions remain manageable there.
  const positionsManageable = md.state !== "AUTH_EXPIRED";

  const overallBand: HealthBand =
    md.band === "broken" || (os?.band === "broken") ? "broken"
      : md.band === "paused" || os?.reconcilePending ? "paused"
      : md.band === "absent" ? "absent"
      : "ready";

  return {
    entryPermitted: reasons.length === 0 && md.band === "ready",
    entryPausedReasons: reasons,
    positionsManageable,
    overallBand,
  };
}

/* ─────────────────────────── economic figures: gross notional ≠ margin ─────────────────────────── */

/** A rupee amount with its provenance, formatted honestly (never a fabricated zero). */
export function formatRupees(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "−" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

/** The five economic quantities, each under its OWN label — gross notional and margin are distinct. */
export const ECONOMIC_FIGURE_LABEL = {
  available_funds: "Available funds",
  planned_margin: "Planned margin (netted)",
  gross_notional: "Gross notional",
  peak_legging_exposure: "Peak legging exposure",
  worst_case_entry: "Worst-case entry cost",
} as const;

export type EconomicFigureKey = keyof typeof ECONOMIC_FIGURE_LABEL;

export interface EconomicFigureView {
  key: EconomicFigureKey;
  label: string;
  value: string;
  provenance: EconomicFigure["provenance"];
  usable: boolean;
  note: string;
}

export function deriveEconomicFigures(admission: EconomicAdmission): EconomicFigureView[] {
  const keys: EconomicFigureKey[] = [
    "available_funds",
    "planned_margin",
    "gross_notional",
    "peak_legging_exposure",
    "worst_case_entry",
  ];
  return keys.map((key) => {
    const fig = admission.picture[key];
    return {
      key,
      label: ECONOMIC_FIGURE_LABEL[key],
      value: formatRupees(fig.value_rupees),
      provenance: fig.provenance,
      usable: fig.usable,
      note: fig.note,
    };
  });
}

/* ─────────────────────────── execution funnel: denominator-carrying, honest ─────────────────────────── */

/** Format a funnel ratio as a percentage, or "— (n/d)" when the denominator is 0. */
export function formatRatio(r: { rate: number | null; numerator: number; denominator: number }): string {
  if (r.rate === null) return `— (${r.numerator}/${r.denominator})`;
  return `${Math.round(r.rate * 1000) / 10}% (${r.numerator}/${r.denominator})`;
}

export interface FunnelView {
  /** The nested chain, top to bottom, each with its count. */
  chain: { label: string; count: number }[];
  /** The denominator-carrying ratios, each with its basis. */
  ratios: { label: string; value: string; basis: string; kind: "execution" | "economic" }[];
  /** Exposure and recovery figures that must never be hidden to flatter a success rate. */
  exposure: {
    unresolvedOpen: number;
    unresolvedTotal: number;
    zeroPostRefusals: number;
    submittedFailures: number;
    recoveryCostsIncluded: string;
    realisedNetPnl: string;
  };
}

export function deriveFunnel(f: ExecutionFunnelSnapshot): FunnelView {
  return {
    chain: [
      { label: "Candidates evaluated", count: f.candidates_evaluated },
      { label: "Qualified opportunities", count: f.qualified_opportunities },
      { label: "Attempts admitted", count: f.attempts_admitted },
      { label: "Attempts submitted (≥1 broker POST)", count: f.attempts_submitted },
      { label: "Four-leg completed entries", count: f.four_leg_completed_entries },
    ],
    ratios: [
      { label: "Admission rate", value: formatRatio(f.ratios.admission_rate), basis: f.ratios.admission_rate.basis, kind: "execution" },
      { label: "Submission rate", value: formatRatio(f.ratios.submission_rate), basis: f.ratios.submission_rate.basis, kind: "execution" },
      { label: "Execution completion", value: formatRatio(f.ratios.execution_completion_rate), basis: f.ratios.execution_completion_rate.basis, kind: "execution" },
      { label: "Economic success", value: formatRatio(f.ratios.economic_success_rate), basis: f.ratios.economic_success_rate.basis, kind: "economic" },
      { label: "Unresolved exposure", value: formatRatio(f.ratios.unresolved_exposure_rate), basis: f.ratios.unresolved_exposure_rate.basis, kind: "execution" },
    ],
    exposure: {
      unresolvedOpen: f.unresolved_exposure_open,
      unresolvedTotal: f.unresolved_exposure_total,
      zeroPostRefusals: f.zero_post_refusals,
      submittedFailures: f.submitted_failures,
      recoveryCostsIncluded: formatRupees(f.recovery_costs_included),
      realisedNetPnl: formatRupees(f.realised_net_pnl),
    },
  };
}

/** CSS severity class for a band (text + colour; the component also adds a text/icon label). */
export function bandClass(band: HealthBand): string {
  switch (band) {
    case "ready":
      return "is-good";
    case "paused":
      return "is-warn";
    case "broken":
      return "is-bad";
    case "absent":
      return "";
  }
}

/** A short text glyph per band, so the signal is never colour-ALONE (accessibility). */
export function bandGlyph(band: HealthBand): string {
  switch (band) {
    case "ready":
      return "●";
    case "paused":
      return "◐";
    case "broken":
      return "○";
    case "absent":
      return "—";
  }
}
