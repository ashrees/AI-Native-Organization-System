# AI-Native Organization OS

An AI-first system that automates **corporate coordination**, not people. AI maintains project truth and information flow; humans own judgment and execution.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

---

## Table of contents

- [Overview](#overview)
- [Applications](#applications)
- [Key features](#key-features)
- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local)
- [Environment variables](#environment-variables)
- [Running the application](#running-the-application)
- [Verify your setup](#verify-your-setup)
- [Demo workflow](#demo-workflow)
- [Worker requests & HR workflows](#worker-requests--hr-workflows)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Utility scripts](#utility-scripts)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Design principles & guardrails](#design-principles--guardrails)

---

## Overview

Modern teams lose time to status meetings, fragmented tools, and manual triage. This project rebuilds coordination as an **event-driven loop**:

1. **Request / signal** enters the system  
2. **Orchestrator AI** plans work (structured JSON)  
3. **Team Builder AI** assigns people with rationale  
4. **Scheduler AI** proposes timelines  
5. **Humans execute** and emit events  
6. **Project AI** reevaluates risk after each human execution  
7. **Project state** updates from events only  
8. **Leadership View** shows what changed and why  
9. **Replan** triggers on blockers or reprioritization  

**Persistence:** PostgreSQL ([Neon](https://neon.tech) or any Postgres). **Real-time:** SSE pushes updates to both frontends.

### Tech stack

| Layer | Technology |
|--------|------------|
| API | Node.js 18+, Express |
| Persistence | PostgreSQL via `pg` |
| AI | Google Gemini, OpenAI, or Ollama (optional; stubs without keys) |
| Leadership UI | React 18, Vite 5 (`client/`, port 5173) |
| Worker UI | React 18, Vite 5 (`worker/`, port 5174) — separate deploy |
| Real-time | Server-Sent Events (SSE) |

---

## Applications

Three apps share one API; each can be hosted independently.

| App | Path | Port (dev) | Audience |
|-----|------|------------|----------|
| **API server** | `server/` | 3000 | All clients |
| **Leadership View** | `client/` | 5173 | Executives — overview, projects, actions, logs, help chat |
| **Worker Portal** | `worker/` | 5174 | Individual contributors — tasks, status, HR/ops requests |

Leadership View links to the Worker Portal via `VITE_WORKER_PORTAL_URL`. The Worker Portal links back via `VITE_LEADERSHIP_URL`.

---

## Key features

### Leadership View (`client/`)

- **Overview** — org metrics and AI-generated insights (background refresh)  
- **Projects** — live state, tasks, assignees, blockers, risk, “What changed recently”  
- **Actions** — submit work `request` events and human `execution` / `decision` events  
- **Log** — orchestrator, team_builder, scheduler, project_ai activity  
- **LLM Logs** — full prompts and responses per project  
- **Worker requests** — all human `need` events; leadership can approve/reject/close  
- **Help chat** (floating) — ask Org AI / Orchestrator / Project AI with live store context  
- **Dark / light theme**, SSE live refresh  

### Worker Portal (`worker/`)

- **Login by name** — directory search (`GET /worker/people`)  
- **Tasks** — update status (`in_progress`, `done`, `blocked`) on assigned work  
- **Requests** — sick leave, vacation, workload, transfer, blockers, etc.  
- **Handling modes** — AI agents (review tasks), notify teams, or self-manage  
- **Routing preview** — each request type shows who it forwards to  
- **HR inbox** (HR role) — approve/reject leave and HR-scoped requests  
- **Project reviews** — project leads / engineering mgmt review workload & contribution requests  
- **Emergency return** (HR) — authorize someone on leave to work temporarily  

### Worker request routing

Every request **kind** maps to specific **roles** and an **AI coordinating agent** (see `server/constants/requestRouting.js`):

| Kind | Typical forwards to | AI agent |
|------|---------------------|----------|
| Sick leave, vacation, training | HR | `org_ai` |
| Workload concern | Project lead + engineering mgmt | `orchestrator` |
| Stop / change contribution | Project lead + one team rep | `project_ai` |
| Blocker escalation | Project lead + team + engineering mgmt | `orchestrator` |
| Project transfer | HR + project + engineering mgmt | `orchestrator` |
| Equipment | DevOps + HR | `scheduler` |
| General (on a project) | Project lead + team | `org_ai` |
| Emergency return | HR only | `org_ai` |

Project-scoped items (e.g. workload on `proj-native-app`) go to **Project reviews**, not the HR inbox.

### Approval side effects (sick leave, transfer, etc.)

When HR or leadership **approves** a worker request, the system updates more than status:

- **Sick leave / vacation** — person marked `on_leave`; unassigned from all active project tasks (`unassignment` events); per-project **leave notice** in “What changed recently”; open review tasks for that employee cancelled  
- **Transfer / stop contribution** — removed from target project (or all projects)  
- **On leave** — cannot submit new requests until HR authorizes **emergency return**  
- **Team Builder** — skips people on leave; includes people in `emergency_active`  
- **Startup reconciliation** — approved requests missing effects are backfilled once on server start  

### Emergency return to work

While on approved leave, HR can temporarily authorize urgent work:

1. Worker Portal → **HR** → **Emergency return to work**  
2. Select person (e.g. Draco Malfoy), reason, optional project + task id  
3. Status becomes `emergency_active` — leave stays on record  
4. Optional immediate **assignment** to a task  
5. When done: **End emergency → back on leave** or **→ fully returned**  

API: `POST /worker/hr/emergency-activate`, `POST /worker/hr/emergency-end`.

### Project AI after human execution

Every **human** `execution` event (Worker Portal or Leadership Actions) triggers **Project AI** asynchronously:

- Reevaluates risk from live metrics + context  
- Emits `decision (project_ai)` with `project_assessment`  
- Updates project **risk level** on the card  
- May mark project **completed** when all tasks are done and no blockers  
- Visible under **What changed recently** and **Log**  

Blocked tasks still trigger **Orchestrator replan** as before.

### Blockers

- Mark a task **Blocked** with notes → blocker recorded; replan may run  
- Mark **In progress** or **Done** → blocker for that task is **cleared** automatically  

### Help chat (Leadership)

`POST /api/help-chat` — conversational Q&A with live project/org context. Agent picker: Auto, Org AI, Orchestrator, Project AI, Team Builder, Scheduler. Falls back to metrics-only answers if no LLM is configured.

### Event types

Core types: `request`, `plan_created`, `assignment`, `unassignment`, `schedule_proposed`, `execution`, `decision`, `need`.  
See [`docs/event-model.md`](docs/event-model.md). `unassignment` clears assignees when someone leaves a project or goes on leave.

---

## Requirements

### System

| Requirement | Version / notes |
|-------------|-----------------|
| **Node.js** | **18+** (20+ recommended for Google Gen AI SDK) |
| **npm** | 9+ |
| **PostgreSQL** | 14+ (Neon recommended) |
| **Git** | To clone the repository |

### Optional (for full AI responses)

| Requirement | Purpose |
|-------------|---------|
| **Google Gemini API key** | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| **OpenAI API key** | `OPENAI_API_KEY` |
| **Ollama** | Local models at `http://localhost:11434` |

Without an API key, agents use **deterministic stubs** so you can demo the full loop.

### Network / ports (local dev)

| Port | Service |
|------|---------|
| `3000` | Express API |
| `5173` | Leadership View |
| `5174` | Worker Portal |

---

## Quick start (local)

### 1. Clone and install dependencies

```bash
git clone <your-repo-url> AI-Native-Organization-System
cd AI-Native-Organization-System

npm install
cd server && npm install && cd ..
cd client && npm install && cd ..
cd worker && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Set **`DATABASE_URL`** (required). See [Environment variables](#environment-variables).

**Neon example:** create a project at [neon.tech](https://neon.tech), copy the connection string (often with `?sslmode=require`).

### 3. Start the API server

From the **project root**:

```bash
npm start
```

Expected:

```text
Store ready (Postgres).
Server listening on port 3000
```

Tables are created on first start. Default **people** (Harry Potter–themed demo roster) seed when empty.

### 4. Start the frontends

**Leadership View** (terminal 2):

```bash
npm run dev:client
# Open http://localhost:5173
```

**Worker Portal** (terminal 3):

```bash
npm run dev:worker
# Open http://localhost:5174
```

The Vite dev servers proxy `/api/*` to `http://localhost:3000`.

### 5. (Optional) Seed sample data

```bash
node server/scripts/seed-mock-data.js
```

---

## Environment variables

Read from **`.env` in the project root** when starting the server from the root.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **Yes** | — | Postgres connection string |
| `PORT` | No | `3000` | API port |
| `POSTGRES_SCHEMA` | No | `public` | Postgres schema |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | No | — | Google Gemini |
| `OPENAI_API_KEY` | No | — | OpenAI |
| `LLM_PROVIDER` | No | auto | `google`, `openai`, or `ollama` |
| `OLLAMA_*` | No | see `.env.example` | Ollama URL, model, timeouts |
| `LLM_MAX_RETRIES` | No | `5` | LLM retries |
| `VITE_API_URL` | No | `/api` | Frontend API base (build time) |
| `VITE_WORKER_PORTAL_URL` | No | `http://localhost:5174` | Link in Leadership header |
| `VITE_LEADERSHIP_URL` | No | `http://localhost:5173` | Link in Worker Portal |
| `CONFIRM_CLEAN` | No | — | Set `1` for `clean-database.js` |

Copy [`.env.example`](.env.example) for the full template.

**LLM order (auto):** Google → OpenAI → Ollama → stubs.

---

## Running the application

### Development (three terminals)

| Terminal | Command | URL |
|----------|---------|-----|
| 1 | `npm start` (root) | API :3000 |
| 2 | `npm run dev:client` | Leadership :5173 |
| 3 | `npm run dev:worker` | Worker :5174 |

### Production (separate hosts)

**Leadership View**

```bash
cd client
VITE_API_URL=https://your-api.example.com \
VITE_WORKER_PORTAL_URL=https://workers.example.com \
npm run build
# Serve client/dist/
```

**Worker Portal**

```bash
cd worker
VITE_API_URL=https://your-api.example.com \
VITE_LEADERSHIP_URL=https://leadership.example.com \
npm run build
# Serve worker/dist/
```

Enable CORS on the API for both frontend origins.

---

## Verify your setup

```bash
curl -s http://localhost:3000/health | jq
```

```bash
node server/scripts/postgres-diagnostic.js
```

Submit a demo request:

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "id": "00000000-0000-4000-8000-000000000001",
    "type": "request",
    "timestamp": "2026-06-03T12:00:00.000Z",
    "projectId": "proj-demo-1",
    "source": "human",
    "payload": {
      "title": "Fix login bug",
      "description": "Users cannot sign in on mobile",
      "priority": "high"
    }
  }'
```

---

## Demo workflow

### Leadership path

1. Open Leadership View → **Actions** → create a **New request**.  
2. Watch **Projects** as orchestration runs (plan → assign → schedule).  
3. Open **Log** / **LLM Logs** for agent traces (with LLM keys).  
4. Use **Help** (bottom-right) to ask about project status.  
5. **Worker requests** tab — review human needs from the portal.  

### Worker path

1. Open Worker Portal → log in as **Sam Lee** (`person-2`) or **Hermione Granger** (`person-5`, HR).  
2. **Tasks** → mark work `done` → Leadership **Projects** shows `execution (human)` then `decision (project_ai)`.  
3. Submit a **sick leave** request → log in as **Hermione** → **HR** → approve → employee unassigned and `on_leave`.  
4. **Emergency return** — Hermione authorizes **Draco Malfoy** (`person-12`) for urgent work while leave remains on record.  

### Clear a blocker

Assignee or Leadership: set task status to **In progress** or **Done** (not Blocked). The blocker line disappears on refresh.

---

## Worker requests & HR workflows

### Submitting a request (Worker Portal)

1. **Requests** tab → choose type (shows **Forwards to: …**).  
2. Pick handling: **AI agents**, **Notify teams**, or **Self-manage**.  
3. Optional project, dates, description → **Submit**.  

### Reviewing

| Role | Where | Actions |
|------|--------|---------|
| HR | Worker → **HR** | Approve, reject, in review, close; create HR tasks |
| Project lead / eng mgmt | Worker → **Reviews** | Same for project-scoped requests |
| Leadership | **Worker requests** tab | Approve / reject / close (no HR role required) |

### Request statuses

`open` → `in_review` → `approved` | `rejected` | `met` | `cancelled`

### People availability

| Status | Meaning |
|--------|---------|
| `active` | Normal work |
| `on_leave` | Approved sick leave / vacation; unassigned from tasks |
| `emergency_active` | HR-authorized temporary work during leave |

---

## API reference

Base URL: `http://localhost:3000` (also under `/api/…`).

**Authentication:** none in MVP.

### Events & projects

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/events` | Submit event. `type: request` → orchestration. Human `execution` → Project AI reevaluation. |
| `GET` | `/events` | Recent events (`?projectId=`) |
| `GET` | `/events/stream` | SSE live updates |
| `GET` | `/events/projects` | All projects (on-leave assignees hidden on card) |
| `GET` | `/events/projects/:id` | One project |
| `GET` | `/events/agent-activity` | Agent log (`?projectId=`) |
| `GET` | `/events/llm-logs` | LLM traces (`?projectId=`, `?agent=`) |
| `GET` | `/events/needs` | Worker requests / needs (`?status=`) |
| `PATCH` | `/events/needs/:id` | Update need: `open`, `in_review`, `approved`, `rejected`, `met`, `cancelled` |
| `POST` | `/events/worker/status` | Legacy task status path |

**PATCH body example:** `{ "status": "approved", "reviewedBy": "leadership", "reviewNotes": "…" }`

### Org insights & help

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/org-insights` | Metrics + AI insights |
| `GET` | `/help-chat/meta` | Suggested questions + agents |
| `POST` | `/help-chat` | Leadership help chat (`message`, `agent`, `projectId`, `messages`) |

### Worker Portal (`/worker` and `/api/worker`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/worker/people` | People for login (`?q=`) |
| `GET` | `/worker/dashboard` | Home data (`?personId=`) |
| `GET` | `/worker/meta` | Request kinds, handling modes, routing map |
| `POST` | `/worker/status` | Update own task status |
| `POST` | `/worker/requests` | Submit worker request |
| `PATCH` | `/worker/requests/:id` | HR / assigned reviewer updates status |
| `POST` | `/worker/requests/:id/tasks` | HR creates follow-up task |
| `GET` | `/worker/hr/inbox` | HR queue (`?personId=`) |
| `GET` | `/worker/project/inbox` | Project-scoped reviews (`?personId=`) |
| `GET` | `/worker/hr/on-leave` | People on leave / emergency (`?personId=` HR) |
| `POST` | `/worker/hr/emergency-activate` | HR authorizes emergency work |
| `POST` | `/worker/hr/emergency-end` | End emergency (`returnTo`: `leave` \| `active`) |

**Emergency activate body:**

```json
{
  "hrPersonId": "person-5",
  "targetPersonId": "person-12",
  "reason": "Production outage",
  "projectId": "proj-school-website",
  "taskId": "task-1"
}
```

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | `{ "status": "ok", "store": "postgres" }` |

Event schemas: [`docs/event-model.md`](docs/event-model.md).

---

## Project structure

```text
AI-Native-Organization-System/
├── .env.example
├── README.md
├── package.json              # Root: pg, dotenv; npm start
├── docs/
├── prompts/
│   ├── orchestrator.txt
│   ├── teamBuilder.txt
│   ├── scheduler.txt
│   ├── projectAI.txt         # Project assessment after human execution
│   ├── orgAI.txt
│   └── helpChat.txt
├── mock-data/
├── server/
│   ├── index.js
│   ├── constants/
│   │   ├── workerRequests.js
│   │   └── requestRouting.js # Per-kind role + AI agent routing
│   ├── routes/
│   │   ├── events.js
│   │   ├── worker.js
│   │   ├── orgInsights.js
│   │   └── helpChat.js
│   ├── services/
│   │   ├── orchestratorAI.js
│   │   ├── teamBuilderAI.js
│   │   ├── schedulerAI.js
│   │   ├── projectAIEvaluator.js
│   │   ├── workerRequestHandler.js
│   │   ├── workerRequestEffects.js
│   │   ├── emergencyReturn.js
│   │   └── metrics.js
│   ├── lib/
│   │   ├── llm.js
│   │   ├── hrRouting.js          # Re-exports requestRouting
│   │   ├── workerRequestLifecycle.js
│   │   ├── personAvailability.js
│   │   └── reconcileApprovedRequests.js
│   ├── models/
│   └── store/postgresStore.js
├── client/                   # Leadership View
│   ├── src/App.jsx
│   ├── src/HelpChat.jsx
│   └── vite.config.js
└── worker/                   # Worker Portal
    ├── src/App.jsx
    └── vite.config.js
```

---

## Utility scripts

| Command | Purpose |
|---------|---------|
| `node server/scripts/postgres-diagnostic.js` | DB connection and counts |
| `node server/scripts/seed-mock-data.js` | Seed people / events |
| `node server/scripts/clean-database.js` | Wipe tables (`CONFIRM_CLEAN=1`) |
| `node server/scripts/migrate-to-postgres.js` | Legacy JSON → Postgres |
| `node server/scripts/test-rag-agents.js` | Agent context / retrieval test |

---

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/principles.md`](docs/principles.md) | Product and ethics |
| [`docs/architecture.md`](docs/architecture.md) | Components and loop |
| [`docs/event-model.md`](docs/event-model.md) | Event types and state |
| [`docs/orchestration-loop.md`](docs/orchestration-loop.md) | Orchestration pseudocode |
| [`worker/README.md`](worker/README.md) | Worker app–only notes |

---

## Troubleshooting

### Server exits: `DATABASE_URL is required`

Create `.env` in the **project root** and run `npm start` from the root.

### Worker login returns **Not Found**

Restart the API after pulling changes — `/worker` routes must be loaded (`npm start` from root).

### Worker request stuck; no HR inbox

Check routing: workload / contribution on a project → **Reviews**, not HR. See `requiresHrInbox` in API responses.

### Approved sick leave but person still on tasks

Restart API once — reconciliation applies unassignment and leave notices for past approvals.

### Project AI / help chat always stubbed

Set `GOOGLE_API_KEY`, `OPENAI_API_KEY`, or run Ollama. Check server logs for `[LLM]`.

### Blocker will not clear

Set task to **In progress** or **Done** via Worker Portal or Leadership **Actions** → execution event.

### `npm install` / `pg` not found

Run `npm install` at the **repository root**, not only in `server/`.

---

## Design principles & guardrails

- **AI owns information flow; humans own judgment.**  
- **Everything is an event** — state changes are traceable.  
- **Explainability** — rationales on agent and system events.  
- **No silent decisions** — humans approve requests and decisions.  
- **Leave is enforced** — emergency return is HR-gated and audited.  
- **Ethics** — no surveillance; AI does not score human worth.

---

## Status

**MVP+** includes:

- Event-driven orchestration and Postgres persistence  
- Leadership View (overview, projects, actions, logs, LLM logs, worker requests, help chat)  
- Worker Portal (tasks, routed requests, HR inbox, project reviews, emergency return)  
- Worker request lifecycle (approve → side effects, unassignment, availability)  
- Project AI reevaluation on human execution  
- Org insights, SSE, themes  

**Not in MVP** — authentication, Slack/Jira/calendar integrations, email notifications.

---

## License

Private repository. All rights reserved unless otherwise specified by the project owner.
