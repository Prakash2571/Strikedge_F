/**
 * The StrikeEdge broker status panel.
 *
 * Replaces CalSpread's 464-line BrokerPanel with a focused, read-mostly status surface for
 * the DUAL-BROKER world: exactly one broker is active at a time, but BOTH stored sessions
 * are always shown so the operator can see standby readiness and every reason a switch is
 * refused.
 *
 * ABSOLUTE RULES
 *   • NEVER render a raw token, encrypted token, passcode or any encryption metadata. There
 *     is no "copy access token" affordance anywhere in this component.
 *   • Session vs feed are reported SEPARATELY, and neither is derived from the site
 *     passcode: "active" means the broker session is usable, not that someone unlocked the
 *     app.
 *   • Broker selection is guarded: it posts {"broker": …} and, on refusal, lists every
 *     blocker the backend returns.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchBrokerStatus,
  fetchBrokerSwitchBlockers,
  selectBroker,
} from "./api/box.ts";
import type {
  BrokerHealth,
  BrokerId,
  BrokerSession,
  BrokerStatus,
  BrokerSwitchBlocker,
  FeedHealthView,
} from "./api/types.ts";

/**
 * The exact sentence the specification requires when the morning Zerodha default was
 * blocked because Dhan still owns exposure or unresolved broker state. Rendered verbatim.
 */
const DHAN_HOLDS_EXPOSURE_MESSAGE =
  "Dhan remains active because it owns exposure or unresolved broker state. " +
  "Zerodha cannot become active until Dhan is safely flat and reconciled.";

/** A Zerodha token-state label, derived only from the readiness the backend reports. */
function zerodhaTokenState(session: BrokerSession, health: BrokerHealth): string {
  if (health.problems.some((p) => /config/i.test(p))) return "configuration_error";
  if (!session.authenticated) return "token waiting";
  if (session.token_expired) return "invalid";
  return "ready";
}

/** A Dhan token-state label. Dhan tokens expire, so it has an extra couple of states. */
function dhanTokenState(session: BrokerSession | null, health: BrokerHealth): string {
  if (health.problems.some((p) => /config/i.test(p))) return "configuration_error";
  if (!session || !session.authenticated) return "token waiting";
  if (session.token_expired) return "expired";
  if (session.token_expires_at === null) return "unknown expiry";
  return "ready";
}

function feedLabel(feed: FeedHealthView | undefined, active: boolean): string {
  if (!active) return "standby";
  if (!feed) return "—";
  return feed.state;
}

function whenDate(ts: number | null): string {
  if (ts === null) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

/**
 * Redact a client identity to a short, non-identifying tail. NEVER shows the whole account
 * number. e.g. "…4821".
 */
function redactIdentity(id: string | null): string {
  if (!id) return "—";
  const trimmed = id.trim();
  if (trimmed.length <= 4) return `…${trimmed}`;
  return `…${trimmed.slice(-4)}`;
}

export function BrokerStatusPanel() {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<BrokerId | null>(null);
  const [blockers, setBlockers] = useState<Record<BrokerId, BrokerSwitchBlocker[]>>({
    zerodha: [],
    dhan: [],
  });

  const load = useCallback(async () => {
    try {
      const s = await fetchBrokerStatus();
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the broker status.");
    }
  }, []);

  // Pre-fetch the switch blockers for the INACTIVE broker(s) so the panel can pre-warn
  // WITHOUT the operator having to attempt a refused switch first.
  const loadBlockers = useCallback(async (active: BrokerId) => {
    const others: BrokerId[] = (["zerodha", "dhan"] as BrokerId[]).filter((b) => b !== active);
    const results = await Promise.allSettled(others.map((b) => fetchBrokerSwitchBlockers(b)));
    setBlockers((prev) => {
      const next = { ...prev };
      results.forEach((r, i) => {
        if (r.status === "fulfilled") next[others[i]] = r.value.blockers;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (status) void loadBlockers(status.broker);
  }, [status, loadBlockers]);

  const onSelect = useCallback(
    async (broker: BrokerId) => {
      setSwitching(broker);
      setError(null);
      try {
        const next = await selectBroker(broker);
        setStatus(next);
        await loadBlockers(next.broker);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to select ${broker}.`);
        // Refresh the blockers so the panel shows WHY it was refused.
        if (status) void loadBlockers(status.broker);
      } finally {
        setSwitching(null);
      }
    },
    [loadBlockers, status],
  );

  if (!status) {
    return (
      <section className="box-broker-panel">
        <h3 className="box-broker-panel-h">Brokers</h3>
        {error ? (
          <p className="box-broker-panel-msg box-broker-panel-msg--error">{error}</p>
        ) : (
          <p className="box-broker-panel-msg">
            <span className="spinner" /> Loading broker status…
          </p>
        )}
      </section>
    );
  }

  const active = status.broker;
  const session = status.session;
  const health = status.health;

  // Zerodha view is the active-broker session when active === zerodha, otherwise a stored
  // standby summarised from health.
  const zerodhaActive = active === "zerodha";
  const dhanActive = active === "dhan";

  const zerodhaState = zerodhaActive
    ? zerodhaTokenState(session, health)
    : session.broker === "zerodha"
      ? zerodhaTokenState(session, health)
      : "token waiting";

  // Dhan session detail is only in the active session record; when Dhan is standby, derive
  // the state from configuration + the dhan_* fields on the status.
  const dhanSession = dhanActive ? session : null;
  const dhanState = dhanTokenState(
    dhanSession,
    dhanActive
      ? health
      : {
          broker: "dhan",
          authenticated: status.dhan_configured && status.dhan_instruments > 0,
          token_expires_at: null,
          token_expired: false,
          data_ready: false,
          trading_ready: false,
          static_ip_configured: status.dhan_static_ip?.ready ?? null,
          feed_connected: false,
          feed_age_ms: null,
          problems: status.dhan_configured ? [] : ["Dhan is not configured"],
        },
  );

  // "Ready — standby": a valid non-active token that could take over. Shown per spec when a
  // valid Dhan token exists while Zerodha is active.
  const dhanStandbyReady = !dhanActive && dhanState === "ready";
  const zerodhaStandbyReady = !zerodhaActive && zerodhaState === "ready";

  // The mandated exposure message: shown when Dhan is active AND a switch to Zerodha is
  // blocked by exposure/unresolved state.
  const zerodhaBlockedByDhanExposure =
    dhanActive &&
    blockers.zerodha.some((b) =>
      /exposure|unresolved|flat|reconcil|open|residual/i.test(`${b.reason} ${b.detail}`),
    );

  return (
    <section className="box-broker-panel">
      <h3 className="box-broker-panel-h">
        Brokers
        <span className="box-dim"> — exactly one active at a time</span>
      </h3>

      {error && <p className="box-broker-panel-msg box-broker-panel-msg--error">{error}</p>}

      {zerodhaBlockedByDhanExposure && (
        <p className="box-broker-panel-msg box-broker-panel-msg--warn">
          {DHAN_HOLDS_EXPOSURE_MESSAGE}
        </p>
      )}

      <div className="box-broker-cards">
        {/* ── Zerodha ── */}
        <BrokerCard
          broker="zerodha"
          active={zerodhaActive}
          tokenState={zerodhaState}
          standbyReady={zerodhaStandbyReady}
          loginOrExpiry={`Login ${session.broker === "zerodha" ? session.login_day ?? "—" : "—"}`}
          identity={redactIdentity(session.broker === "zerodha" ? session.client_id : null)}
          feed={feedLabel(status.feed, zerodhaActive)}
          marginProvenance={zerodhaActive ? status.last_margin_source ?? null : null}
          selectable={!zerodhaActive}
          switching={switching === "zerodha"}
          blockers={blockers.zerodha}
          onSelect={() => void onSelect("zerodha")}
        />

        {/* ── Dhan ── */}
        <BrokerCard
          broker="dhan"
          active={dhanActive}
          tokenState={dhanState}
          standbyReady={dhanStandbyReady}
          loginOrExpiry={
            dhanActive && session.broker === "dhan"
              ? `Expires ${whenDate(session.token_expires_at)}`
              : status.dhan_static_ip?.configured_ip
                ? "Static IP configured"
                : "Expiry unknown until active"
          }
          identity={redactIdentity(dhanActive ? session.client_id : null)}
          feed={feedLabel(status.feed, dhanActive)}
          marginProvenance={dhanActive ? status.last_margin_source ?? null : null}
          selectable={!dhanActive && status.dhan_configured}
          switching={switching === "dhan"}
          blockers={blockers.dhan}
          onSelect={() => void onSelect("dhan")}
        />
      </div>
    </section>
  );
}

function BrokerCard({
  broker,
  active,
  tokenState,
  standbyReady,
  loginOrExpiry,
  identity,
  feed,
  marginProvenance,
  selectable,
  switching,
  blockers,
  onSelect,
}: {
  broker: BrokerId;
  active: boolean;
  tokenState: string;
  standbyReady: boolean;
  loginOrExpiry: string;
  identity: string;
  feed: string;
  marginProvenance: string | null;
  selectable: boolean;
  switching: boolean;
  blockers: BrokerSwitchBlocker[];
  onSelect: () => void;
}) {
  const label = broker === "dhan" ? "Dhan" : "Zerodha";
  const stateClass =
    tokenState === "ready"
      ? "is-ready"
      : tokenState.includes("waiting") || tokenState.includes("unknown")
        ? "is-wait"
        : "is-bad";

  return (
    <div className={`box-broker-card${active ? " box-broker-card--active" : ""}`}>
      <div className="box-broker-card-head">
        <span className={`box-broker box-broker--${broker}`}>{label.toUpperCase()}</span>
        {active ? (
          <span className="box-broker-active-tag">ACTIVE</span>
        ) : standbyReady ? (
          <span className="box-broker-standby-tag">Ready — standby</span>
        ) : null}
      </div>

      <dl className="box-broker-card-grid">
        <div>
          <dt>Token</dt>
          <dd className={`box-broker-token ${stateClass}`}>{tokenState}</dd>
        </div>
        <div>
          <dt>{broker === "dhan" ? "Expiry / IP" : "Login"}</dt>
          <dd>{loginOrExpiry}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd className="mono" title="Redacted — a raw client id or token is never shown">
            {identity}
          </dd>
        </div>
        <div>
          <dt>Feed</dt>
          <dd>{feed}</dd>
        </div>
        {active && (
          <div>
            <dt>Margin source</dt>
            <dd title="Which broker priced the most recent margin call">
              {marginProvenance ?? "—"}
            </dd>
          </div>
        )}
        <div>
          <dt>Charges</dt>
          <dd title="Charge provenance follows the active broker's own fee schedule">
            {label} schedule
          </dd>
        </div>
      </dl>

      {selectable && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={switching || blockers.length > 0}
          onClick={onSelect}
          title={
            blockers.length > 0
              ? "This switch is currently refused — see the blockers below"
              : `Make ${label} the active broker`
          }
        >
          {switching ? "Switching…" : `Make ${label} active`}
        </button>
      )}

      {!active && blockers.length > 0 && (
        <>
          <p className="box-broker-blockers-h">Switch refused:</p>
          <ul className="box-broker-blockers">
            {blockers.map((b) => (
              <li key={`${b.reason}-${b.detail}`}>
                <strong>{b.reason}</strong> — {b.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
