# Leadership View

React frontend for **executives and program leadership** — org overview, projects, workforce, revenue, actions, logs, and help chat.

Separate from `worker/` (contributors) and `monitor/` (operations). Full system docs: [README.md](../README.md).

---

## Run locally

```bash
# Terminal 1 — API (from repo root)
npm start

# Terminal 2 — Leadership View
cd client && npm run dev
# or from root: npm run dev:client
```

Open **http://localhost:5173**.

Vite proxies `/api/*` to `http://localhost:3000` (see `vite.config.js`).

---

## Tabs

| Tab | Purpose |
|-----|---------|
| **Overview** | Org metrics, AI-generated insights, quick health |
| **Projects** | Live project state, tasks, assignees, blockers, risk, **What changed recently** |
| **Actions** | Submit `request`, human `execution`, and `decision` events; assignment gap-fill option |
| **Log** | Agent activity (orchestrator, team builder, scheduler, project AI, org AI) |
| **LLM Logs** | Full prompts and responses per project |
| **Workforce** | Productivity matrix, health scores, department charts |
| **Revenue** | Per-project budget, spend, utilization, burn, open budget requests |
| **Worker requests** | Human `need` events — approve, reject, close |

**Help chat** (floating) — org snapshot + workforce analytics; routes to Org AI, Orchestrator, Project AI, Team Builder, Scheduler.

Header links: **Worker Portal** (5174), **Ops Monitor** (5175).

---

## Build & deploy

```bash
cd client
VITE_API_URL=https://your-api.example.com \
VITE_WORKER_PORTAL_URL=https://workers.example.com \
VITE_MONITOR_PORTAL_URL=https://monitor.example.com \
npm run build
```

Deploy `dist/` to any static host. Enable CORS on the API for the Leadership origin.

---

## Environment (build time)

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `VITE_API_URL` | `/api` (proxied) | API base URL |
| `VITE_WORKER_PORTAL_URL` | `http://localhost:5174` | Worker Portal link |
| `VITE_MONITOR_PORTAL_URL` | `http://localhost:5175` | Operations Monitor link |

Theme and `lastProjectId` persist via `GET/PATCH /api/preferences?personId=leadership`.

---

## Key source files

| File | Role |
|------|------|
| `src/App.jsx` | Main shell, tabs, SSE refresh |
| `src/WorkforcePanel.jsx` | Workforce analytics UI |
| `src/RevenuePanel.jsx` | Budget / revenue matrix |
| `src/HelpChat.jsx` | Leadership help chat |

---

## API (via proxy)

Uses shared server routes under `/api/events`, `/api/workforce`, `/api/revenue`, `/api/help-chat`, etc. See [API reference](../README.md#api-reference).
