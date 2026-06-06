# API Server

Express backend for the AI-Native Organization System — event intake, Postgres persistence, AI orchestration, worker portal API, workforce/revenue analytics, and operations monitor snapshots.

All frontends (`client/`, `worker/`, `monitor/`) talk to this server.

Full documentation: [README.md](../README.md).

---

## Run

From the **repository root** (loads `.env` from root):

```bash
npm install          # root + server deps
cd server && npm install && cd ..
npm start            # node server/index.js
```

Requires **`DATABASE_URL`** in `.env`. Tables are created on first start; demo people seed when empty.

Expected:

```text
Store ready (Postgres).
[Project AI] Status polling every 300s
Server listening on port 3000
```

---

## Routes (mounted in `index.js`)

| Prefix | Module | Purpose |
|--------|--------|---------|
| `/events`, `/api/events` | `routes/events.js` | Event CRUD, orchestration, SSE stream, projects, needs, LLM logs |
| `/worker`, `/api/worker` | `routes/worker.js` | Worker Portal — dashboard, requests, HR inbox |
| `/org-insights`, `/api/org-insights` | `routes/orgInsights.js` | Org metrics + Org AI |
| `/help-chat`, `/api/help-chat` | `routes/helpChat.js` | Leadership help chat |
| `/workforce`, `/api/workforce` | `routes/workforce.js` | Workforce analytics |
| `/revenue`, `/api/revenue` | `routes/revenue.js` | Budget analytics and mutations |
| `/preferences`, `/api/preferences` | `routes/preferences.js` | User UI preferences (Postgres) |
| `/ops`, `/api/ops` | `routes/opsMonitor.js` | `GET /monitor` — ops snapshot |
| `/health`, `/api/health` | inline | Health check |

---

## Core services

| Service | Role |
|---------|------|
| `services/orchestratorAI.js` | Plan from requests |
| `services/teamBuilderAI.js` | Assign tasks |
| `services/schedulerAI.js` | Propose schedules |
| `services/projectAIEvaluator.js` | Status checks, polling, risk |
| `services/projectAIActions.js` | Delegate to other agents |
| `services/projectAIDeliverables.js` | Budget/deliverable gap detection |
| `services/opsMonitor.js` | Agent streams + work boards for monitor UI |
| `services/financeService.js` | Revenue / budget analytics |
| `services/workerRequestEffects.js` | Approval side effects (leave, transfer, …) |
| `lib/llm.js` | Serialized LLM access + `llm_logs` |
| `lib/llmQueueDescribe.js` | Human-readable LLM queue labels |
| `store/postgresStore.js` | Postgres tables and queries |

---

## Postgres tables (main)

| Table | Purpose |
|-------|---------|
| `events` | Event log (source of truth) |
| `projects` | Materialized project state (`state` jsonb) |
| `people` | Directory |
| `needs` | Worker requests index |
| `llm_logs` | LLM request/response audit |
| `agent_activity` | Structured agent lines for ops monitor streams |
| `user_preferences` | Theme and UI prefs per person |

Events may include `payload.monitor` for normalized task/summary fields.

---

## Scripts

Run from repo root:

```bash
node server/scripts/postgres-diagnostic.js
node server/scripts/seed-mock-data.js
node server/scripts/sync-postgres-store.js
node server/scripts/backfill-agent-activity.js
node server/scripts/repair-marketing-new-products-project.js
```

See [Utility scripts](../README.md#utility-scripts) in the root README.

---

## Environment

Configured via **`.env` in the project root`** — see [`.env.example`](../.env.example) and [Environment variables](../README.md#environment-variables).
