/**
 * Broker-specific MARGIN PROVENANCE, as a short label suffix.
 *
 * WHY THIS IS NOT COSMETIC
 * `margin` is one number produced by one of several models that are not interchangeable:
 *
 *   kite_basket            Zerodha's basket-margin API — position-aware and netted.
 *   dhan_multi             Dhan's multi-order calculator — hedge-adjusted, preferred.
 *   dhan_per_leg_fallback  Dhan per-leg margins SUMMED. A conservative UPPER bound that
 *                          materially OVER-STATES a hedged four-leg Box.
 *   unavailable            A figure was requested and none was obtained.
 *
 * An operator reading an inflated per-leg sum as a real netted margin would badly
 * misjudge how much capital a Box actually blocks. The backend now persists the source
 * (`box_trades.margin_source`); this surfaces it, and calls out the fallback explicitly
 * rather than letting it look like any other number.
 *
 * `null`/absent means the trade predates provenance capture, which is deliberately
 * different from `unavailable` — so it renders as nothing rather than as a claim.
 */
export type MarginSource =
  | "kite_basket"
  | "dhan_multi"
  | "dhan_per_leg_fallback"
  | "unavailable"
  | null
  | undefined;

const MARGIN_SOURCE_LABEL: Record<string, string> = {
  kite_basket: " — Zerodha basket (netted)",
  dhan_multi: " — Dhan multi-order (netted)",
  dhan_per_leg_fallback: " — Dhan per-leg SUM, over-states a hedged box",
  unavailable: " — no figure available",
};

export function marginProvenanceSuffix(source: MarginSource): string {
  if (!source) return "";
  return MARGIN_SOURCE_LABEL[source] ?? ` — ${source}`;
}

/** True only for the model that over-states a hedged Box, for callers that want to warn. */
export function marginOverstatesHedge(source: MarginSource): boolean {
  return source === "dhan_per_leg_fallback";
}
