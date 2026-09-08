# StrikeEdge — frontend

StrikeEdge is a focused, standalone dashboard for the **Box arbitrage** trading system: it
scans F&O stock and index option chains for mispriced four-leg boxes, shows every candidate
with its full expected-net-profit arithmetic, streams open and closed positions live, and
gives an operator the controls to run the scanner, tune the entry gate, arm a trading
session and switch the active broker — all behind a single site passcode.

This repository is **only the frontend**: a React 18 + TypeScript + Vite single-page app. It
does no trading itself and holds no market logic. Every number it shows is a report from the
**StrikeEdge backend**, which remains the sole trading authority.

## What it needs to run

StrikeEdge is not usable on its own. It requires:

1. **The StrikeEdge backend** running and reachable. All data — box opportunities, open and
   closed trades, execution control, broker status, the live SSE stream — comes from the
   backend's `/api/*` endpoints. PostgreSQL is the backend's authoritative operational store;
   MongoDB Atlas is an async reporting replica.
2. **A site passcode.** The whole app is gated: an unauthenticated visitor sees only a
   minimal passcode screen. Verifying the passcode establishes an **HttpOnly session cookie**
   server-side — the frontend never sees, stores or forwards a token — and the dashboard then
   mounts. Any `401` from the backend closes the live stream, clears authenticated state and
   returns to the passcode screen.

One broker is active at a time. Both **Zerodha** and **Dhan** are supported; the broker panel
shows both stored sessions, guards broker switches, and lists every reason a switch is
refused.

## Configuration

| Env var              | Purpose                                                        | Default                 |
| -------------------- | -------------------------------------------------------------- | ----------------------- |
| `VITE_API_BASE_URL`  | Backend **origin** (no trailing `/api`), e.g. `https://api.…`  | `http://localhost:3001` |

There are **no secrets** in this repo or its build. Do not add any: the passcode, tokens and
encryption metadata all live on the backend.

## Develop

```bash
npm ci            # install exact locked dependencies
npm run dev       # Vite dev server on http://localhost:5173
```

Point `VITE_API_BASE_URL` at a running StrikeEdge backend (create a local `.env` — it is
git-ignored and must never be committed).

## Build & test

```bash
npm run build     # tsc -b && vite build  (strict typecheck + production bundle)
npm test          # node --test against the pure TS modules (Node 22 strips types natively)
npm run preview   # serve the production build locally
```

CI (`.github/workflows/ci.yml`) runs `npm ci` (which also enforces the lockfile is in sync),
`npm run build` and `npm test` on Node 22.

## What is inside

- **`/` is the only route** — the Box dashboard. No calendar board, no admin page, no charts.
- **Passcode gate** (`src/auth/AccessGate.tsx`) — UX in front of the backend's real boundary.
- **Focused API layer** (`src/api/`) — a single fetch wrapper with same-origin cookie
  credentials, a CSRF header on mutating requests and one central `401` handler; plus access,
  box and broker calls, and the lifted response types.
- **Reconnecting SSE** (`src/lib/boxStream.ts`) — reconnects after a transient drop with
  capped backoff, and does **not** reconnect after a `401`.
- **Dual-broker panel** (`src/BrokerStatusPanel.tsx`) — both sessions, redacted identities,
  feed/margin/charge provenance, guarded selection and switch-blockers. It never renders a
  raw token, encrypted token, passcode or encryption metadata.
- **Box UI** ported from CalSpread — opportunities, open positions, closed history, the ATM±3
  chain, execution/session/risk control panels, day P&L, execution health, sounds and the
  dark/light theme.

See `docs/FRONTEND_EXTRACTION.md` for the exact file-by-file provenance and every behaviour
change from the CalSpread source.
