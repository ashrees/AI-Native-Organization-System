# Platform reliability & scale

This document describes how the API stays **consistent** (Postgres + memory aligned), **reliable** (health, shutdown, idempotency), and ready to **scale** (within single-process limits).

## Single-process architecture (current)

The API keeps an in-memory `eventLog` and `projects` cache for speed. **Postgres is the source of truth** for persistence. Run **one API process** per environment unless you add distributed locks and shared pub/sub for SSE.

## Consistency

| Mechanism | Location |
|-----------|----------|
| Transactional event + project write | `postgresStore.persistEventAndState()` |
| DB-backed idempotency (`ON CONFLICT DO NOTHING RETURNING`) | `eventExistsById`, `POST /events` |
| Per-project orchestration queue | `lib/projectLock.js` — no overlapping replans |
| Replan deduplication (15 min window) | `projectAIActions.recentlyReplanned` |
| Startup: load `projects` snapshot from DB | `events.initStore` — replay only missing projects |

## Reliability

| Mechanism | Location |
|-----------|----------|
| Init store **before** HTTP listen | `server/index.js` |
| Unified health (`SELECT 1`, `storeReady`) | `GET /health`, `GET /api/health` |
| Graceful shutdown (`SIGTERM` / `SIGINT`) | `lib/platformLifecycle.js` |
| Global error handler | `lib/apiErrors.js` |
| SSE client cap | `SSE_MAX_CLIENTS` (default 200) |
| Postgres pool tuning + idle error handler | `server/db/index.js` |
| Leadership AI handler re-queue when busy | `leadershipNeedAutoHandler.js` |
| Staggered Project AI polling (3 projects/tick) | `projectAIEvaluator.js` |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PG_POOL_MAX` | `10` | Postgres pool size (max 20) |
| `PG_CONNECTION_TIMEOUT_MS` | `10000` | Connection timeout |
| `SSE_MAX_CLIENTS` | `200` | Max concurrent SSE connections |

Use Neon **pooler** URL in production (`-pooler` host) when available.

## Horizontal scale (future)

To run multiple API instances:

1. Externalize the LLM queue (job worker + distributed lock).
2. Replace in-memory orchestration locks with Redis/Postgres advisory locks.
3. Fan out SSE via Redis pub/sub or a dedicated gateway.
4. Optionally stop loading the full event log into memory; query by time window.

## Operations

```bash
# Readiness (returns 503 if DB down or still starting)
curl -s http://localhost:3000/api/health | jq

# Graceful stop (local)
kill -SIGTERM <pid>
```

After deploy, verify `status: "ok"` and `database: "up"` before sending traffic.
