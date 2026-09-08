# API contract fixtures

These JSON files were **captured from a running StrikeEdge backend**, not hand-written.
`tests/apiContract.test.mjs` asserts the frontend's expectations against them, so a field
rename on either side fails the build instead of silently blanking the dashboard.

## Why they exist

The frontend and backend were built separately and their types for the new StrikeEdge
endpoints drifted badly without anything catching it:

| Endpoint | Frontend expected | Backend actually sends | Overlap |
| --- | --- | --- | --- |
| `GET /api/runtime/status` | `token_waiting`, `instruments_loading`, `websocket_connecting`, `depth_ready`, `postgres_available`, `live_entry_blocked`, `recovery_active`, `residual_exposure`, `detail` | `brokers[]`, `active_broker`, `pg_ready`, `migration_state`, `recovery_ready`, `live_entry{blocked,reasons}`, `recovery_pending`, `residual_exposure` | 1 of 9 |
| `GET /api/export/status` | `enabled`, `delayed`, `lag_seconds`, `last_export_at`, `detail` | `enabled`, `connected`, `backlog_count`, `oldest_pending_age_ms`, `last_success_at`, `last_error`, `dead_letter_count` | 1 of 5 |
| `GET /api/broker/status` | a single broker plus `dhan_configured`, `dhan_instruments`, `feed`, `last_margin_source` | `{active_broker, generation, brokers[]}` | structurally different |

Every drifted field was either optional or read off a cast `fetch` result, so TypeScript
could not see any of it. The app typechecked, built and passed its tests while every
readiness banner stayed dark and the broker panel rendered `undefined`. `last_margin_source`
did not exist anywhere in the backend — it was invented.

A green build proved nothing about the contract. That is what these fixtures fix.

## The existing Box endpoints are pinned too

`box-status.json`, `box-execution-control.json` and `box-config.json` cover the endpoints
ported near-verbatim from CalSpread. A mechanical diff confirmed those already matched — 81
required frontend fields across the three, none missing — so unlike the table above these
record a check that PASSED.

They are pinned anyway, for two reasons. "It was copied from a working system" is exactly
the reasoning that let the new endpoints drift undetected. And the persistence rewrite did
touch these code paths: the trades-history `source` tier really did change from
`memory|redis|mongo|none` to `memory|postgres|none`, which is asserted directly.

`box-execution-control.json` additionally pins the shipped safety default: the captured
response has `live_runtime_armed: false` and a non-`live` execution mode, so a fixture
re-captured from an armed process would fail the suite.

## Provenance

Captured on 2026-09-08 from `Strikedge_B` at commit `3e14d54` against a local PostgreSQL,
with no broker token present (so the token states are `configuration_error` — which is
useful, because it exercises the fatal-blocker path the old shape could not express).

`csrf_token` values are **scrubbed** to `FIXTURE-PLACEHOLDER-NOT-A-REAL-TOKEN`. Nothing
here is or ever was a production secret, and the contract test additionally asserts that no
response carries a token, passcode or encryption metadata field.

## Re-capturing

Fixtures are a recording, so they go stale if the backend changes and nobody re-runs this.
That is the known limitation of the approach. To refresh, from a built `Strikedge_B`:

```bash
# 1. a throwaway database
docker exec <pg> psql -U strikedge -d postgres -c "CREATE DATABASE ct;"

# 2. boot with a fake passcode and unreachable token providers
env NODE_ENV=development APP_TIMEZONE=Asia/Kolkata FRONTEND_URL=http://127.0.0.1:5173 \
    PORT=3212 SITE_ACCESS_SECRET=ct MONGO_EXPORT_ENABLED=false \
    DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/ct \
    BROKER_TOKEN_ENCRYPTION_KEY=<64 hex chars> \
    KITE_TOKEN_BROKER_URL=http://127.0.0.1:1/n DHAN_TOKEN_URL=http://127.0.0.1:1/n \
    KITE_TOKEN_BROKER_PASSCODE=x DHAN_TOKEN_BROKER_PASSCODE=x \
    node dist/index.js &

# 3. authenticate, then capture each endpoint
curl -s -c /tmp/ck -X POST -H 'Content-Type: application/json' \
     -H 'Origin: http://127.0.0.1:5173' -d '{"passcode":"ct"}' \
     http://127.0.0.1:3212/api/access/verify > access-verify.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/runtime/status  > runtime-status.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/export/status   > export-status.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/broker/status   > broker-status.json
curl -s -b /tmp/ck 'http://127.0.0.1:3212/api/broker/switch-blockers?broker=dhan' \
     > broker-switch-blockers.json
curl -s -b /tmp/ck http://127.0.0.1:3212/api/access/status   > access-status.json
```

Then re-scrub `csrf_token` in `access-verify.json` and `access-status.json` before
committing.
