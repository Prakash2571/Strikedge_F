/**
 * Plain-language readiness banners for the Box dashboard.
 *
 * Surfaces the whole-system state the specification enumerates — WITHOUT ever exposing a
 * secret. Every line is a report of a boolean the backend published on /api/runtime/status
 * and /api/export/status; nothing here reveals a token, a passcode or any credential.
 *
 * The states, in the order they matter operationally:
 *   • waiting for today's CalSpread/broker token
 *   • token acquired, instruments still loading
 *   • market-data WebSocket connecting
 *   • connected, but executable depth not ready
 *   • PostgreSQL persistence unavailable  (authoritative store — this is serious)
 *   • Mongo reporting export delayed       (async replica — expected, non-fatal)
 *   • live entry blocked
 *   • recovery in progress / residual exposure exists
 */

import type { ExportStatus, RuntimeStatus } from "./api/types.ts";

export function RuntimeStatusBanners({
  runtime,
  exportStatus,
}: {
  runtime: RuntimeStatus | null;
  exportStatus: ExportStatus | null;
}) {
  const banners: { key: string; kind: "info" | "warn" | "error"; text: string }[] = [];

  if (runtime) {
    if (runtime.token_waiting) {
      banners.push({
        key: "token",
        kind: "info",
        text: "Waiting for today's broker token — market data cannot flow until the active broker is connected.",
      });
    } else if (runtime.instruments_loading) {
      banners.push({
        key: "instruments",
        kind: "info",
        text: "Token acquired — loading the instrument master. Opportunities appear once instruments are ready.",
      });
    } else if (runtime.websocket_connecting) {
      banners.push({
        key: "ws",
        kind: "info",
        text: "Market-data WebSocket is connecting…",
      });
    } else if (runtime.depth_ready === false) {
      banners.push({
        key: "depth",
        kind: "warn",
        text: "Connected, but executable depth is not ready across the universe yet — entries wait for a full four-leg one-lot book.",
      });
    }

    // PostgreSQL is the authoritative operational store: its loss is an ERROR, not a note.
    if (runtime.postgres_available === false) {
      banners.push({
        key: "pg",
        kind: "error",
        text: "PostgreSQL persistence is unavailable — the authoritative operational store cannot be written, so no new box can be recorded and live entry fails closed.",
      });
    }

    if (runtime.live_entry_blocked) {
      banners.push({
        key: "entry",
        kind: "warn",
        text: "Live entry is currently blocked. Open positions are still monitored and can still exit.",
      });
    }

    if (runtime.recovery_active || runtime.residual_exposure) {
      banners.push({
        key: "recovery",
        kind: "warn",
        text: runtime.residual_exposure
          ? "Residual exposure exists — a partial fill left legs outstanding and is being reconciled. New entry stays closed until it is flat."
          : "A recovery is in progress — exposure is quarantined pending reconciliation. Reduction continues; new entry is closed.",
      });
    }
  }

  // The Mongo reporting replica is now non-authoritative and fed asynchronously, so a lag
  // is expected and reported calmly — never as a failure of the operational store.
  if (exportStatus?.delayed) {
    const lag =
      exportStatus.lag_seconds != null
        ? ` (about ${Math.round(exportStatus.lag_seconds)}s behind)`
        : "";
    banners.push({
      key: "mongo",
      kind: "info",
      text: `Mongo reporting export is delayed${lag}. This is the async reporting replica only — operational data in PostgreSQL is unaffected.`,
    });
  }

  if (banners.length === 0) return null;

  return (
    <>
      {banners.map((b) => (
        <div key={b.key} className={`banner banner--${b.kind}`}>
          {b.text}
        </div>
      ))}
    </>
  );
}
