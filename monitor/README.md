# Operations Monitor

Standalone frontend for **operations visibility** — separate from `client/` (Leadership) and `worker/` (Worker Portal).

Shows **agent uptime streams**, live **LLM queue** status, and four **work boards**: worked, in progress, queued, and broken/errors.

Full system docs: [README.md](../README.md) · API: `GET /api/ops/monitor`

---

## What you see

### Agent uptime streams

- One row per agent: Orchestrator, Team Builder, Scheduler, Project AI, Org AI, AI Handler, Worker NPCs, **LLM queue**
- Bar = activity over the last N hours (default **3h**, configurable on server)
- **Click a segment** to pin details below — tasks, projects, agent, and rationale (scrollable panel)
- **LLM queue** rows include model calls from `llm_logs` plus live lock state (who is running, queue depth)

### Summary & boards

- Chips: agents busy/up, issues, in progress, queued
- **Worked** — recently completed items
- **In progress** — active tasks
- **In line** — queued work
- **Broken** — errors and blockers

### Live refresh

- SSE on `/api/events/stream` (`monitor` + `event` events)
- Poll `GET /api/ops/monitor` every **5 seconds**

---

## Postgres (structured monitor data)

| Store | Purpose |
|-------|---------|
| `agent_activity` | Agent lines + mirrored AI events — `agent_id`, `project_id`, `task_id`, `summary`, `rationale`, `is_error` |
| `events.payload.monitor` | Normalized fields on each event for stream buckets |
| `llm_logs` | Completed model calls merged into LLM queue stream |

Backfill historical activity once:

```bash
node server/scripts/backfill-agent-activity.js
```

Server env: `OPS_MONITOR_STREAM_HOURS` (1–24, default `3`).

---

## Run locally

```bash
# Terminal 1 — API (from repo root)
npm start

# Terminal 2 — Operations Monitor
cd monitor && npm install && npm run dev
# or from root: npm run dev:monitor
```

Open **http://localhost:5175**.

Vite proxies `/api/*` to `http://localhost:3000`.

---

## Build & deploy

```bash
cd monitor
VITE_API_URL=https://your-api.example.com \
VITE_LEADERSHIP_URL=https://leadership.example.com \
VITE_WORKER_PORTAL_URL=https://worker.example.com \
npm run build
```

Deploy `dist/` to any static host. CORS must allow the Monitor origin on the API.

---

## Environment (build time)

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `VITE_API_URL` | `/api` (proxied) | API base URL |
| `VITE_LEADERSHIP_URL` | `http://localhost:5173` | Link to Leadership View |
| `VITE_WORKER_PORTAL_URL` | `http://localhost:5174` | Link to Worker Portal |

---

## Source layout

| File | Role |
|------|------|
| `src/App.jsx` | Shell, theme, portal links |
| `src/OpsMonitorPanel.jsx` | Streams, boards, pinned segment details |
| `src/OpsMonitor.css` | Monitor styles |

Backend: `server/services/opsMonitor.js`, `server/routes/opsMonitor.js`.
