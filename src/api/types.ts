/**
 * StrikeEdge response types.
 *
 * Lifted from the CalSpread source `api.ts` (the Box + broker portions only), and kept
 * PURE — no browser globals, no fetch — so `node:test` can import this file directly under
 * Node 22's native type-stripping.
 *
 * ── ON IDENTIFIERS ──────────────────────────────────────────────────────────────────
 * Every `id` / `*_id` here is an OPAQUE STRING. StrikeEdge's authoritative store is now
 * PostgreSQL with MongoDB as an async reporting replica, so an id is whatever the backend
 * minted — it is NOT a Mongo ObjectId, NOT a UUID, and NOT parseable. The UI treats ids as
 * equality-comparable opaque tokens and nothing more.
 */

/* ============================ shared charge shapes ============================ */

/** One order's charges from the broker's virtual contract note. */
export interface TradeLegCharges {
  side: "BUY" | "SELL";
  tradingsymbol: string;
  quantity: number;
  price: number;
  value: number;
  brokerage: number;
  stt: number;
  stt_type: string;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
}

/**
 * Charges for one side of a trade (both legs), as billed by the active broker.
 *
 * `source` records WHICH broker priced it: Zerodha's and Dhan's fee schedules differ, so a
 * Dhan trade's costs must never be shown as if Zerodha priced them. `*_estimate` means the
 * charge was projected rather than confirmed against a real contract note.
 */
export interface TradeCharges {
  legs: TradeLegCharges[];
  value: number;
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  source: "kite" | "kite_estimate" | "dhan" | "dhan_estimate";
  at: string;
}

/* ================================ Box vocabulary ============================== */

export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";
export type BoxSide = "BUY" | "SELL";
export type BoxExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "MANUAL"
  | "EXPIRY_SAFETY";

/** Why a candidate was not eligible for an automatic paper entry. */
export type BoxRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_gross_prefilter"
  | "below_net_edge"
  | "below_expected_net_profit"
  | "execution_failed"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  | "market_closed"
  | "implausible_close";

/** Which way a box is traded. Absent on old data means a long box. */
export type BoxDirection = "LONG_BOX" | "SHORT_BOX";

/** How an entry is executed: three paper models, or real broker orders. */
export type BoxExecutionMode = "paper_touch" | "paper_latency" | "paper_legging" | "live";

/**
 * Which broker a record belongs to.
 *
 * Only ONE broker is ever active for new trades, but history from both coexists, so every
 * trade carries its own. Absent on data written before broker identity existed, which means
 * Zerodha — the only broker the app originally had.
 */
export type BrokerId = "zerodha" | "dhan";

/**
 * Where a charge figure came from.
 *
 * The `dhan` values exist because Dhan's brokerage differs from Zerodha's: a Dhan trade's
 * costs must never be displayed as if Zerodha had priced them.
 */
export type BoxChargeOrigin =
  | "local"
  | "kite"
  | "local_verified"
  | "dhan"
  | "dhan_estimate";

/** Per-leg liquidity/freshness detail behind an opportunity. */
export interface BoxLegEvaluation {
  role: BoxLegRole;
  side: BoxSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  /** Executable price for this side: ask for BUY, bid for SELL. */
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
}

export type BoxOpportunityStatus =
  | "WATCHING"
  | "INDICATIVE"
  | "UNPRICED"
  | "ELIGIBLE"
  | "PAPER_OPENED"
  | "OPEN"
  | "REJECTED";

export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  direction: BoxDirection;
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  execution_cost: number;
  safety_buffer: number;
  projected_net_edge: number | null;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  charge_origin: BoxChargeOrigin;
  entry_sides: { role: BoxLegRole; side: BoxSide; tradingsymbol: string }[];
  liquidity_ok: boolean;
  depth_ok: boolean;
  worst_age_ms: number | null;
  price_source: "touch" | "last_close";
  status: BoxOpportunityStatus;
  reject: BoxRejectReason | null;
  legs: BoxLegEvaluation[];
  updated_at: number;
}

export interface BoxConfigView {
  min_expected_net_profit: number;
  min_gross_edge: number;
  min_net_edge: number;
  execution_mode: BoxExecutionMode;
  simulated_decision_ms: number;
  simulated_latency_ms: number;
  expected_entry_slippage: number;
  expected_exit_slippage: number;
  enable_short_box: boolean;
  directions: BoxDirection[];
  min_captured_pct: number;
  reconcile_charges: boolean;
  charge_reconcile_warn_pct: number;
  require_priced_charges: boolean;
  safety_buffer: number;
  quote_max_age_ms: number;
  feed_max_age_ms: number;
  underlying_max_age_ms: number;
  strikes_each_side: number;
  strike_level: number;
  max_strikes: number;
  max_candidates_per_underlying: number;
  prefilter_gross_threshold: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  expiry_safety_minutes: number;
  max_subscribed_tokens: number;
  lots: number;
  universe: string;
  leg_execution_mode?: "parallel" | "sequential";
  leg_timeout_ms?: number;
  exit_use_realisable_net?: boolean;
  indicative_discovery?: boolean;
  closed_cache_enabled?: boolean;
  tunable?: {
    min_expected_net_profit: { min: number; max: number };
    safety_buffer: { min: number; max: number };
  };
}

export interface BoxStatus {
  running: boolean;
  state: "SCANNING" | "MARKET_CLOSED" | "STOPPED";
  monitoring: boolean;
  market_open: boolean;
  indicative_at: number | null;
  indicative_priced: number;
  indicative_session_day: string | null;
  indicative_stale_legs: number;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  brokers_with_open_positions?: BrokerId[];
  authenticated: boolean;
  db_enabled: boolean;
  started_at: number | null;
  stopped_at: number | null;
  universe_built_at: number | null;
  underlyings: number;
  candidates: number;
  monitored_tokens: number;
  subscribed_option_tokens: number;
  subscribed_spot_tokens: number;
  hub_subscribed: number;
  hub_connected: boolean;
  quotes: number;
  quote_updates: number;
  feed_age_ms: number | null;
  feed_healthy: boolean;
  exchange_lag_ms: {
    median_ms: number;
    p95_ms: number;
    last_ms: number;
    samples: number;
  } | null;
  strike_level: number;
  open_positions: number;
  day_pnl?: BoxDayPnl;
  skipped_for_budget: number;
  skipped_symbols: string[];
  skipped_indicative_cap?: number;
  skipped_indicative_symbols?: string[];
  indicative_max_underlyings?: number;
  scanner: {
    ticksApplied: number;
    evaluations: number;
    prefilterPasses: number;
    qualifyAttempts: number;
    executionsAttempted: number;
    entriesOpened: number;
    rejectedStale: number;
    rejectedLiquidity: number;
    rejectedNetProfit: number;
    rejectedExecution: number;
    rejectedDuplicate: number;
    lastEvaluationAt: number | null;
    simulated_entries_attempted: number;
    simulated_entries_filled: number;
    simulated_entries_failed: number;
    active_execution_pipelines: number;
  };
  monitor: {
    cycles: number;
    exitsTriggered: number;
    exitsSkippedLiquidity: number;
    exitsFailedExecution?: number;
    lastCycleAt: number | null;
    running: boolean;
  };
  charges: { calls: number; hits: number; misses: number; failures: number; inFlight: number };
  reconciliation?: {
    queued: number;
    completed: number;
    failed: number;
    skipped: number;
    warnings: number;
    max_abs_diff: number;
    last_abs_diff: number | null;
    last_pct_diff: number | null;
    pending: number;
    in_flight: number;
    enabled: boolean;
    warn_pct: number;
  };
  metrics?: BoxMetricsSnapshot;
  last_error: string | null;
  config: BoxConfigView;
}

export interface BoxDayPnl {
  day: string;
  open_count: number;
  open_running_net_pnl: number;
  open_running_gross_pnl: number;
  closed_count: number;
  closed_realised_net_pnl: number;
  closed_realised_gross_pnl: number;
  total_net_pnl: number;
  total_gross_pnl: number;
  open_margin_used?: number;
  closed_margin_used?: number;
  /** @deprecated Identical to `cumulative_trade_margin`; kept for older dashboards. */
  total_margin_used?: number;
  cumulative_trade_margin?: number;
  peak_concurrent_margin?: number | null;
  margin_unknown_count?: number;
  cache_enabled: boolean;
  last_cached_at: string | null;
}

/** A rolling distribution summary from a bounded ring buffer. */
export interface RingSummary {
  samples: number;
  count: number;
  last: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface BoxMetricsSnapshot {
  execution: {
    attempted: number;
    completed: number;
    successful: number;
    partial_recovered: number;
    partial_unresolved: number;
    failed: number;
    aborted: number;
    retries: number;
    /** @deprecated Alias for `successful`, kept for older dashboards. */
    filled: number;
    failure_rate: number;
    success_rate: number;
    rejection_categories: Record<string, number>;
    /** @deprecated Alias for `rejection_categories`. */
    failures_by_reason: Record<string, number>;
    decision_deterioration: RingSummary | null;
    execution_slippage: RingSummary | null;
    /** @deprecated Legacy detection-touch comparison; prefer `execution_slippage`. */
    entry_slippage: RingSummary | null;
    exit_slippage: RingSummary | null;
    decision_to_fill_ms: RingSummary | null;
    qualification_to_fill_ms: RingSummary | null;
    latency: {
      detection_to_decision_ms: RingSummary | null;
      decision_to_order_send_ms: RingSummary | null;
      simulated_or_real_order_latency_ms: RingSummary | null;
      order_send_to_ack_ms: RingSummary | null;
      ack_to_fill_ms: RingSummary | null;
      detection_to_fill_ms: RingSummary | null;
    };
    terminal_conflicts: number;
  };
  latency: {
    receive_to_evaluation_ms: RingSummary | null;
    event_loop_lag_ms: RingSummary | null;
  };
  throughput: {
    evaluations_per_sec: number;
    ws_updates_per_sec: number;
    ticks_per_sec: number;
    evaluations_total: number;
    ws_updates_total: number;
  };
  charges: {
    reconciliations: number;
    failed_reconciliations: number;
    warnings: number;
    discrepancy_rupees: RingSummary | null;
    discrepancy_pct: RingSummary | null;
  };
  legging?: {
    outcomes: {
      "4_of_4": number;
      "3_of_4": number;
      "2_of_4": number;
      "1_of_4": number;
      "0_of_4": number;
      total: number;
      aborts: number;
    };
    fill_rate_4_of_4: number;
    failure_rate_3_of_4: number;
    failure_rate_2_of_4: number;
    failure_rate_1_of_4: number;
    legging_net_loss: RingSummary | null;
    first_to_last_fill_ms: RingSummary | null;
    most_failing_role: { role: string; count: number } | null;
    failing_roles: Record<string, number>;
    expected_vs_realised_net: RingSummary | null;
  };
}

/** A paper_legging execution attempt that did not open a box. */
export interface BoxExecutionAttempt {
  candidate_key: string;
  direction: BoxDirection;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: BoxExecutionMode;
  leg_execution_mode: "parallel" | "sequential" | null;
  detected_at: string;
  resolved_at: string;
  detected_gross_edge: number | null;
  expected_net_profit: number | null;
  filled_leg_count: number;
  failed_legs: string[];
  failure_reason: string | null;
  failure_detail: string | null;
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  gross_abort_pnl: number | null;
  net_abort_pnl: number | null;
}

/** One live open box position with its current exit arithmetic. */
export interface BoxOpenPosition {
  /** OPAQUE string id — do not parse. */
  id: string;
  key: string;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  opened_at: string;
  margin: number | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: number | null;
  estimated_exit_charges_at_entry: number | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
  entry_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    strike: number;
    instrument_type: "CE" | "PE";
    entry_price: number;
  }[];
  exit_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    price: number | null;
    bid: number;
    bid_qty: number;
    ask: number;
    ask_qty: number;
    age_ms: number | null;
    executable: boolean;
    fresh: boolean;
  }[];
  exit_box_value: number | null;
  gross_pnl: number | null;
  current_exit_charges: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  realisable_net_pnl: number | null;
  estimated_execution_cost: number;
  remaining_edge: number | null;
  entry_edge: number;
  captured_edge: number | null;
  captured_pct: number | null;
  time_in_trade_ms: number | null;
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  min_captured_pct: number;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  exit_rule_reason: BoxExitReason | null;
  blocked_reason: string | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  status: "open";
}

/** One leg of a persisted box trade. */
export interface BoxTradeLeg {
  role: BoxLegRole;
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  side: BoxSide;
  entry_price: number;
  entry_bid: number;
  entry_bid_qty: number;
  entry_ask: number;
  entry_ask_qty: number;
  entry_quote_at: string | null;
  detected_price?: number | null;
  entry_slippage?: number | null;
  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: string | null;
  exit_detected_price?: number | null;
  exit_slippage?: number | null;
}

/** The verdict of an asynchronous broker charge reconciliation. */
export interface BoxChargeReconciliation {
  status: "pending" | "verified" | "failed";
  local_total: number | null;
  reconciled_total: number | null;
  abs_diff: number | null;
  pct_diff: number | null;
  at: string | null;
  error: string | null;
}

/** A persisted box trade (open or closed). */
export interface BoxTrade {
  /** OPAQUE string id — do not parse. */
  id: string;
  execution_mode: BoxExecutionMode;
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  status: "open" | "closed" | "error";
  legs: BoxTradeLeg[];
  box_width: number;
  margin: number | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: TradeCharges | null;
  estimated_exit_charges: TradeCharges | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
  entry_charge_reconciliation: BoxChargeReconciliation | null;
  exit_charge_reconciliation: BoxChargeReconciliation | null;
  opened_at: string;
  current_remaining_edge: number | null;
  current_captured_edge: number | null;
  current_captured_pct: number | null;
  exit_box_value: number | null;
  exit_charges: TradeCharges | null;
  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  realised_net_pnl?: number | null;
  closed_at: string | null;
  exit_reason: BoxExitReason | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  error: string | null;
}

/** One side of a strike row in the ATM±3 box chain. */
export interface BoxChainSide {
  token: number;
  tradingsymbol: string;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  marks: string[];
}

export interface BoxChain {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  quantity: number;
  atm_strike: number;
  strike_step: number;
  spot: number;
  spot_age_ms: number;
  strikes: {
    strike: number;
    is_atm: boolean;
    ce: BoxChainSide | null;
    pe: BoxChainSide | null;
  }[];
}

export interface BoxChainSymbol {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
}

/** Which tier of the backend's closed-trade store answered a history request. */
export type BoxHistorySource = "memory" | "redis" | "mongo" | "postgres" | "none";

export interface BoxHistoryResponse {
  dbEnabled: boolean;
  trades: BoxTrade[];
  scope?: "today" | "all";
  source?: BoxHistorySource;
  day?: string;
  cacheEnabled?: boolean;
  lite?: boolean;
}

/** What the backend returns after a successful Box trade deletion. */
export interface BoxDeleteResult {
  /** OPAQUE string id of the removed trade. */
  deleted_id: string;
  status: BoxStatus;
  open: BoxOpenPosition[];
  closed_today: {
    trades: BoxTrade[];
    source?: BoxHistorySource;
    day?: string;
    lite?: boolean;
  };
}

/** The payload of a `snapshot` frame on the box stream. */
export interface BoxSnapshot {
  status: BoxStatus;
  opportunities: BoxOpportunity[];
  open_trades: BoxOpenPosition[];
}

/* ============================ Box execution control =========================== */

/** Which execution model is selected. `live` is not runtime-selectable. */
export type BoxExecutionSelection =
  | "paper_latency"
  | "paper_legging"
  | "paper_legging_live_parity"
  | "live";

export interface BoxExecutionBlocker {
  code: string;
  detail: string;
}

export type BoxSessionState =
  | "IDLE"
  | "ARMED"
  | "ENTRY_IN_PROGRESS"
  | "POSITION_OPEN"
  | "EXIT_IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "RECOVERY";

export interface BoxSessionView {
  enforcing: boolean;
  write_failed: boolean;
  state: BoxSessionState;
  /** OPAQUE string id or null. */
  session_id: string | null;
  armed: boolean;
  armed_at: number | null;
  armed_by: string | null;
  max_completed_trades: number;
  completed_trades: number;
  consumed_cycles: number;
  remaining_trades: number | null;
  /** OPAQUE string id or null. */
  current_trade_id: string | null;
  in_flight_trade_ids: string[];
  aborted_attempts: number;
  arm_count: number;
  block_reason: string | null;
  readable: boolean;
}

export interface BoxActiveUnderlying {
  underlying: string;
  kinds: string[];
}

export interface BoxExecutionControl {
  execution_mode: "paper_touch" | "paper_latency" | "paper_legging" | "live";
  paper_execution_profile: "standard" | "live_parity" | "stress";
  broker: BrokerId;
  deployment_live_capable: boolean;
  live_capability_detail: string;
  live_runtime_armed: boolean;
  entry_enabled: boolean;
  emergency_flatten_enabled: boolean;
  mode: {
    selection: BoxExecutionSelection;
    label: string;
    runtime_selectable: BoxExecutionSelection[];
    live_requires_restart: boolean;
    transition_blockers: BoxExecutionBlocker[];
  };
  session: BoxSessionView;
  risk: {
    max_box_capital_rupees: number;
    max_box_capital_metric: string;
    paper_max_box_capital_rupees: number;
    max_box_capital_enforced: boolean;
    capital: {
      enabled: boolean;
      configured_max_rupees: number;
      last_calculated_rupees: number | null;
      last_stage: string | null;
      last_allowed: boolean | null;
      last_at: number | null;
    };
    one_active_box_per_underlying: boolean;
    active_underlyings: BoxActiveUnderlying[];
    claimed_underlyings: string[];
    max_open_boxes: number;
    open_boxes: number;
    residual_legs: number;
    daily_loss_limit: number;
    realised_pnl_today: number | null;
  };
  execution: {
    live_entry_submit_concurrency: number;
    max_concurrent_executions: number;
    effective_broker_min_interval_ms: number;
    effective_broker_order_min_interval_ms: number;
    broker_order_interval_floor_ms: number;
    broker_order_interval_source: string;
    broker_pacing_rationale: string;
    pacing_source_of_truth: "adapter" | "config_projection";
    four_leg_burst_pacing_budget_ms: number;
    entry_burst: {
      configured_entry_submit_concurrency: number;
      base_concurrency: number;
      peak_entry_submissions_in_flight: number;
      burst_slot_grants: number;
      base_in_flight: number;
      burst_in_flight: number;
      /** OPAQUE string id or null. */
      entry_attempt_in_flight: string | null;
    } | null;
    queued: number;
    in_flight: number;
    circuit: string;
    artificial_latency_applied_to_live: boolean;
    paper_only_simulated_decision_ms: number;
    paper_only_simulated_latency_ms: number;
  };
  arm: {
    preconditions: Record<string, boolean | number>;
    entry: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    exposure_management: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    emergency_flatten: { ok: boolean; blockers?: BoxExecutionBlocker[] };
  };
  block_reason: string | null;
  block_detail: string | null;
}

/** The verdict of a requested execution-mode change, WITHOUT applying it. */
export type BoxModeTransitionVerdict =
  | { outcome: "allowed"; from: BoxExecutionSelection; to: BoxExecutionSelection }
  | {
      outcome: "restart_required";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      detail: string;
      envChanges: string[];
      blockers: BoxExecutionBlocker[];
    }
  | {
      outcome: "refused";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      blockers: BoxExecutionBlocker[];
    };

/* =============================== Broker status =============================== */

/** One reason a broker switch was refused. */
export interface BrokerSwitchBlocker {
  reason: string;
  detail: string;
}

/** Session state of one broker. NEVER contains a token. */
export interface BrokerSession {
  broker: BrokerId;
  authenticated: boolean;
  /** A redacted client identity, never the raw account number. */
  client_id: string | null;
  client_name: string | null;
  token_expires_at: number | null;
  token_expired: boolean;
  login_day: string | null;
  login_at: number | null;
}

export interface BrokerHealth {
  broker: BrokerId;
  authenticated: boolean;
  token_expires_at: number | null;
  token_expired: boolean;
  data_ready: boolean;
  trading_ready: boolean;
  /** null for brokers with no such requirement (Zerodha) — not false. */
  static_ip_configured: boolean | null;
  feed_connected: boolean;
  feed_age_ms: number | null;
  problems: string[];
}

export interface DhanStaticIpState {
  ready: boolean;
  declared: boolean;
  configured_ip: string | null;
  api_verified: boolean | null;
  primary_ip: string | null;
  secondary_ip: string | null;
  checked_at: number | null;
  error: string | null;
}

export interface FeedHealthView {
  state: "DOWN" | "CONNECTING" | "CONNECTED_NO_SUBSCRIPTIONS" | "LIVE" | "STALE";
  connected: boolean;
  subscribed: number;
  universe: number | null;
  feed_age_ms: number | null;
  last_tick_at: number | null;
  detail: string;
}

export interface BrokerStatus {
  broker: BrokerId;
  generation?: number;
  feed?: FeedHealthView;
  subscriptions?: {
    browser: number;
    scanner: number;
    strategy: number;
    analytics: number;
    tokens: number;
    leases: number;
  };
  instruments?: number;
  instruments_loaded_at?: number | null;
  session: BrokerSession;
  health: BrokerHealth;
  dhan_configured: boolean;
  dhan_instruments: number;
  dhan_instruments_loaded_at: number | null;
  dhan_static_ip?: DhanStaticIpState;
  /** Which broker priced the most recent margin call — margin provenance. */
  last_margin_source?: string | null;
}

/* ======================= Runtime + export status readouts ===================== */

/**
 * The whole-system readiness readout (GET /api/runtime/status).
 *
 * Every field is optional and defensively typed: it drives the plain-language state
 * banners the operator sees ("waiting for today's token", "instruments loading",
 * "PostgreSQL persistence unavailable", …) and must degrade gracefully on an older backend
 * that omits a field. NO secret name or value ever appears here.
 */
export interface RuntimeStatus {
  /** Today's broker token has not yet been acquired for the active broker. */
  token_waiting?: boolean;
  /** Token acquired, but the instrument master is still loading. */
  instruments_loading?: boolean;
  /** The market-data WebSocket is mid-connect. */
  websocket_connecting?: boolean;
  /** Connected, but executable depth is not yet ready across the universe. */
  depth_ready?: boolean;
  /** PostgreSQL — the authoritative operational store — is reachable and writable. */
  postgres_available?: boolean;
  /** Live entry is currently blocked (by risk, session, feed or persistence). */
  live_entry_blocked?: boolean;
  /** A recovery is in progress or residual exposure exists. */
  recovery_active?: boolean;
  residual_exposure?: boolean;
  detail?: string | null;
}

/**
 * The async reporting-replica status (GET /api/export/status).
 *
 * MongoDB Atlas is now a NON-authoritative reporting replica fed asynchronously from
 * PostgreSQL, so a lag here is expected and non-fatal — the UI reports it without alarm.
 */
export interface ExportStatus {
  /** Whether the Mongo reporting replica is configured at all. */
  enabled?: boolean;
  /** True when the async export is behind — reporting is delayed, operations unaffected. */
  delayed?: boolean;
  /** Seconds the replica is behind the authoritative store, if known. */
  lag_seconds?: number | null;
  last_export_at?: string | null;
  detail?: string | null;
}
