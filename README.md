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
6. **Project AI** monitors status continuously and **delegates** to other agents when needed  
7. **Project state** updates from events only  
8. **Leadership View** shows what changed and why  
9. **Replan** triggers on blockers or reprioritization  

**Persistence:** PostgreSQL ([Neon](https://neon.tech) or any Postgres). **Real-time:** SSE pushes updates to both frontends.

### Tech stack

| Layer | Technology |
|--------|------------|
| API | Node.js 18+, Express |
| Persistence | PostgreSQL via `pg` |
| AI | Google Gemini, OpenAI, DeepSeek, or Ollama Cloud / local (optional; stubs without keys) |
| Leadership UI | React 18, Vite 5 (`client/`, port 5173) |
| Worker UI | React 18, Vite 5 (`worker/`, port 5174) — separate deploy |
| Ops Monitor UI | React 18, Vite 5 (`monitor/`, port 5175) — separate deploy |
| Real-time | Server-Sent Events (SSE) |

---

## Applications

Four apps share one API; each can be hosted independently.

| App | Path | Port (dev) | Audience |
|-----|------|------------|----------|
| **API server** | `server/` | 3000 | All clients |
| **Leadership View** | `client/` | 5173 | Executives — overview, projects, workforce, revenue, actions, logs, help chat |
| **Worker Portal** | `worker/` | 5174 | Individual contributors — tasks, status, HR/ops requests |
| **Operations Monitor** | `monitor/` | 5175 | Ops — agent uptime streams, LLM queue, work boards (worked / active / queued / broken) |

Leadership View links to Worker Portal and Ops Monitor. Worker Portal and Ops Monitor link back to Leadership.

---

## Key features

### Leadership View (`client/`)

- **Overview** — org metrics and AI-generated insights (background refresh)  
- **Projects** — live state, tasks, assignees, blockers, risk; **What changed recently** (newest first, human + AI rationale)  
- **Workforce** — productivity matrix, health scores (0–100), department charts, per-person detail  
- **Revenue** — per-project budget, spend, utilization, 7-day burn, runway; set budget, record burn, budget requests  
- **Actions** — submit `request`, human `execution`, and `decision` events; assignment gap-fill checkbox  
- **Log** — orchestrator, team_builder, scheduler, project_ai, org_ai activity  
- **LLM Logs** — full prompts and responses per project  
- **Worker requests** — all human `need` events; leadership approve/reject/close  
- **Help chat** (floating) — full org snapshot + workforce analytics; routes to Org AI, Orchestrator, Project AI, Team Builder, Scheduler  
- **Dark / light theme**, SSE live refresh  

### Operations Monitor (`monitor/`)

- **Agent uptime streams** — clickable time bars per agent (default last 3h); pin a segment to read tasks, projects, and rationale  
- **LLM queue** — live lock state + model calls (agent, action, project); merges `llm_logs` and `agent_activity`  
- **Work boards** — worked, in progress, in line, broken/errors  
- **Live refresh** — SSE on events + 5s poll · `GET /api/ops/monitor`  
- See [`monitor/README.md`](monitor/README.md)

### Worker Portal (`worker/`)

- **Login by name** — directory search (`GET /worker/people`)  
- **Overview** — open assignments, active projects, open requests (no status-action buttons; use **Tasks** for updates)  
- **Tasks** — filter by status; update `in_progress`, `done`, `blocked` on assigned work  
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
| Budget request | Finance + project lead | `org_ai` |
| General (on a project) | Project lead + team | `org_ai` |
| Emergency return | HR only | `org_ai` |

Project-scoped items (e.g. workload on `proj-native-app`) go to **Project reviews**, not the HR inbox.

### Approval side effects (sick leave, transfer, etc.)

When HR or leadership **approves** a worker request, the system updates more than status:

- **Sick leave / vacation** — person marked `on_leave`; unassigned from all active project tasks (`unassignment` events); per-project **leave notice** in “What changed recently”; open review tasks for that employee cancelled  
- **Transfer / stop contribution** — removed from target project (or all projects for org-wide transfer)  
- **Role change** — updates the person’s **role in the directory**; **does not** remove them from project tasks  
- **On leave** — cannot submit new requests until HR authorizes **emergency return**  
- **Team Builder / review routing** — skips people on leave; includes people in `emergency_active`  
- **Startup reconciliation** — approved requests missing effects are backfilled once on server start  

### Essential project roles (new projects)

When the **first request** creates a project, the Orchestrator assigns **essential roles** separately from delivery tasks:

| Role | Purpose |
|------|---------|
| Project Lead | Delivery accountability, sponsor on project card |
| Technical Lead | Architecture and engineering quality |
| Delivery Owner | Milestones and execution tracking |
| HR Liaison | Project workforce / people contact |

Stored in `project.roles` (Postgres `projects.state`) via `decision (project_roles_assigned)`. Delivery tasks in the plan are **work only** — no “assign project lead” tasks.

### Personal HR partner

Every employee has `hr_person_id` in Postgres (assigned on startup, round-robin across HR staff). Worker requests route to **your personal HR** first. Shown on the Worker Portal header as “Your HR partner: …”.

### User preferences (Postgres)

Theme and UI prefs persist in `user_preferences` (not only browser localStorage):

- `GET/PATCH /api/preferences?personId=` — keys: `theme`, `lastProjectId`, `helpChatOpen`
- Leadership uses `personId=leadership`; workers use their `personId`

Run `node server/scripts/sync-postgres-store.js` to rebuild project state, loads, task index, and HR assignments from the event log.

### Emergency return to work

While on approved leave, HR can temporarily authorize urgent work:

1. Worker Portal → **HR** → **Emergency return to work**  
2. Select person, reason, optional project + task id  
3. Status becomes `emergency_active` — leave stays on record  
4. Optional immediate **assignment** to a task  
5. When done: **End emergency → back on leave** or **→ fully returned**  

API: `POST /worker/hr/emergency-activate`, `POST /worker/hr/emergency-end`.

### Project AI — status monitoring and agent coordination

**Project AI** runs asynchronously on project activity and on a **periodic timer** (default every 5 minutes):

- **Triggers:** human `execution`, `plan_created`, `assignment`, `schedule_proposed`, `need`, reprioritize decisions, periodic poll  
- **Assesses** risk from live metrics + RAG context  
- **Emits** `decision (project_ai)` with `project_assessment` and planned `agentActions`  
- **Delegates** to other agents when requirements demand it:

| Delegate to | Action | When |
|-------------|--------|------|
| **Team Builder** | `assign_unassigned` / `assign_task` | Open tasks without owners |
| **Scheduler** | `reschedule` | Assigned tasks missing schedule dates |
| **Orchestrator** | `replan` | Blockers or stalled progress need a new plan |
| **System** | `create_need` | Human input required (approval, unblock, capacity) |

- Updates project **risk level**; may mark **completed** when all tasks are done  
- **Deliverable gaps** — detects budget/report gaps from events; satisfied when budget tasks are done and finance needs are approved (avoids approval loops)  
- Visible under **What changed recently** and **Log**  

Env: `PROJECT_AI_DEBOUNCE_MS` (default 15s), `PROJECT_AI_POLL_INTERVAL_MS` (default 300000; `0` disables polling).

### Revenue & project budgets

Leadership **Revenue** tab and `GET /api/revenue/analytics`:

- Per-project budget, spend, remaining, utilization %, 7-day burn, runway  
- Department rollups and matrix view  
- `POST /api/revenue/projects/:id/budget` — set budget  
- `POST /api/revenue/projects/:id/burn` — record spend  
- `POST /api/revenue/projects/:id/budget-request` — request additional budget  

Finance state lives in `projects.state.finance` (event-sourced via decisions).

Blocked tasks still trigger **immediate Orchestrator replan** in addition to Project AI review.

### Assignment gap fill (Leadership Actions)

When leadership submits an **execution** and any of these apply, the server runs **Team Builder only** on unassigned (non-done) tasks — no full Orchestrator replan:

- Checkbox **“Request AI to assign unassigned tasks”** (`payload.requestAssignment: true`)
- Task set to **in progress** while still **unassigned**
- Notes mention assign / unassigned / ASAP (keyword match)

Emits `assignment` + `schedule_proposed` per task, then `decision (system)` with `assignment_gap_fill`. People on leave are skipped.

### Blockers

- Mark a task **Blocked** with notes → blocker recorded; replan may run  
- Mark **In progress** or **Done** → blocker for that task is **cleared** automatically  

### Workforce analytics (Leadership)

`GET /api/workforce/analytics` — per-worker indexes (0–100):

- **Productivity** — completion rate, 7d/30d throughput vs org  
- **Reliability** — blocker share, recency, load balance  
- **Engagement** — multi-project contribution, executions, review tasks  
- **Health** — availability, overload, open distress requests, stagnation  
- **Overall** — weighted blend; status bands: thriving / steady / watch / at_risk  

Includes department summary, distribution, and heatmap matrix. Same data is included in **Help chat** context.

### Help chat (Leadership)

`POST /api/help-chat` — conversational Q&A with a **full org snapshot**:

- All projects (tasks, assignees, blockers, needs, schedules)  
- All people (load, leave, availability)  
- **Workforce analytics** (indexes, signals, department summary, highlights)  
- All worker requests (routing, review status)  
- Unassigned tasks, recent events (`HELP_CHAT_EVENT_LIMIT`, default 250)  
- Recent agent activity, Org AI insights  

Optional `projectId` scopes focus detail. Agents: Auto, Org AI, Orchestrator, Project AI, Team Builder, Scheduler.

### Event types

Core types: `request`, `plan_created`, `assignment`, `unassignment`, `schedule_proposed`, `execution`, `decision`, `need`.  
See [`docs/event-model.md`](docs/event-model.md).

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
| **DeepSeek** | `DEEPSEEK_API_KEY` + `LLM_PROVIDER=deepseek` ([API keys](https://platform.deepseek.com/api_keys)) |
| **Ollama Cloud** (recommended) | `OLLAMA_API_KEY` + `https://ollama.com` |
| **Ollama local** | `http://localhost:11434` or local app proxy to Cloud |

Without an API key, agents use **deterministic stubs** so you can demo the full loop.

### Network / ports (local dev)

| Port | Service |
|------|---------|
| `3000` | Express API |
| `5173` | Leadership View |
| `5174` | Worker Portal |
| `5175` | Operations Monitor |

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
cd monitor && npm install && cd ..
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
[Project AI] Status polling every 300s
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

**Operations Monitor** (terminal 4):

```bash
npm run dev:monitor
# Open http://localhost:5175
```

Vite dev servers proxy `/api/*` to `http://localhost:3000`.

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
| `LLM_PROVIDER` | No | auto | `google`, `openai`, `deepseek`, or `ollama` |
| `DEEPSEEK_API_KEY` | No | — | [DeepSeek API](https://platform.deepseek.com/api_keys) |
| `DEEPSEEK_BASE_URL` | No | `https://api.deepseek.com` | DeepSeek API host (OpenAI-compatible) |
| `DEEPSEEK_MODEL` | No | `deepseek-chat` | `deepseek-chat` or `deepseek-reasoner` |
| `OLLAMA_API_KEY` | No* | — | Ollama Cloud ([settings/keys](https://ollama.com/settings/keys)) |
| `OLLAMA_BASE_URL` | No | `https://ollama.com` if key set | Ollama API host |
| `OLLAMA_MODEL` | No | `gpt-oss:120b,nemotron-3-super,gpt-oss:20b` | Comma-separated fallbacks (cloud) |
| `OLLAMA_TIMEOUT_MS` | No | `180000` (cloud) | Request timeout |
| `OLLAMA_NUM_PREDICT` | No | `8192` (cloud) | Max tokens for Ollama |
| `LLM_MAX_RETRIES` | No | `5` | LLM retries |
| `LLM_RETRY_DELAY_MS` | No | `3000` | Delay between retries |
| `AGENT_LLM_TIMEOUT_MS` | No | `25000` | Per-agent LLM timeout |
| `AGENT_STEP_RETRIES` | No | `3` | Retries per orchestration step |
| `AGENT_STEP_RETRY_DELAY_MS` | No | `1500` | Delay between step retries |
| `PROJECT_AI_DEBOUNCE_MS` | No | `15000` | Min gap between Project AI checks per project |
| `PROJECT_AI_POLL_INTERVAL_MS` | No | `300000` | Periodic status poll (`0` = off) |
| `OPS_MONITOR_STREAM_HOURS` | No | `3` | Ops Monitor agent stream window (1–24) |
| `HELP_CHAT_EVENT_LIMIT` | No | `250` | Max events in help chat context |
| `HELP_CHAT_ACTIVITY_LIMIT` | No | `40` | Max agent activity lines in help chat |
| `VITE_API_URL` | No | `/api` | Frontend API base (build time) |
| `VITE_WORKER_PORTAL_URL` | No | `http://localhost:5174` | Link in Leadership header |
| `VITE_MONITOR_PORTAL_URL` | No | `http://localhost:5175` | Link in Leadership header |
| `VITE_LEADERSHIP_URL` | No | `http://localhost:5173` | Link in Worker / Monitor portals |
| `CONFIRM_CLEAN` | No | — | Set `1` for `clean-database.js` |

Copy [`.env.example`](.env.example) for the full template.

**LLM order (auto):** Google → DeepSeek → OpenAI → Ollama → stubs.

---

## Running the application

### Development (four terminals)

| Terminal | Command | URL |
|----------|---------|-----|
| 1 | `npm start` (root) | API :3000 |
| 2 | `npm run dev:client` | Leadership :5173 |
| 3 | `npm run dev:worker` | Worker :5174 |
| 4 | `npm run dev:monitor` | Ops Monitor :5175 |

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
curl -s http://localhost:3000/api/health | jq
```

Expect `status: "ok"`, `storeReady: true`, and `database: "up"` before load balancers send traffic.

```bash
node server/scripts/postgres-diagnostic.js
```

```bash
curl -s http://localhost:3000/workforce/analytics | jq '.distribution, .departmentSummary'
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
4. **Workforce** tab — inspect productivity matrix and at-risk workers.  
5. **Help** (bottom-right) — ask about risk, workforce health, or open requests.  
6. **Worker requests** tab — review human needs from the portal.  

### Worker path

1. Open Worker Portal → log in as **Sam Lee** (`person-2`) or **Hermione Granger** (`person-5`, HR).  
2. **Tasks** tab → mark work `done` → Leadership shows `execution (human)` then `decision (project_ai)`.  
3. Submit **sick leave** → Hermione → **HR** → approve → employee unassigned and `on_leave`.  
4. **Emergency return** — Hermione authorizes **Draco Malfoy** (`person-12`) for urgent work.  

### Clear a blocker

Assignee or Leadership: set task status to **In progress** or **Done**. Blocker clears on refresh.

---

## Worker requests & HR workflows

### Submitting a request (Worker Portal)

1. **Requests** tab → choose type (shows **Forwards to: …**).  
2. Pick handling: **AI agents**, **Notify teams**, or **Self-manage**.  
3. Optional project, dates, description → **Submit**.  

### Reviewing

| Role | Where | Actions |
|------|--------|---------|
| HR | Worker → **HR** | Approve, reject, in review, close |
| Project lead / eng mgmt | Worker → **Reviews** | Project-scoped requests |
| Leadership | **Worker requests** tab | Approve / reject / close |

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
| `POST` | `/events` | Submit event. `type: request` → orchestration. Activity triggers Project AI status check. |
| `GET` | `/events` | Recent events (`?projectId=`, `?recentChanges=1`) |
| `GET` | `/events/stream` | SSE live updates |
| `GET` | `/events/projects` | All projects |
| `GET` | `/events/projects/:id` | One project |
| `GET` | `/events/agent-activity` | Agent log (`?projectId=`) |
| `GET` | `/events/llm-logs` | LLM traces (`?projectId=`, `?agent=`) |
| `GET` | `/events/needs` | Worker requests (`?status=`) |
| `PATCH` | `/events/needs/:id` | Update need status |
| `POST` | `/events/worker/status` | Legacy task status path |

### Org insights, workforce, revenue & help

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/org-insights` | Metrics + Org AI insights |
| `GET` | `/workforce/analytics` | Productivity matrix & health indexes |
| `GET` | `/revenue/analytics` | Budget/spend matrix and open budget requests |
| `POST` | `/revenue/projects/:id/budget` | Set project budget |
| `POST` | `/revenue/projects/:id/burn` | Record budget burn |
| `POST` | `/revenue/projects/:id/budget-request` | Request additional budget |
| `GET` | `/help-chat/meta` | Suggested questions + agents |
| `POST` | `/help-chat` | Help chat (`message`, `agent`, `projectId`, `messages`) |

### Operations monitor

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ops/monitor` | Agent streams, boards, LLM queue status |

### Preferences

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/preferences` | UI prefs (`?personId=`) |
| `PATCH` | `/preferences` | Update theme, last project, etc. |

### Worker Portal (`/worker` and `/api/worker`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/worker/people` | People for login (`?q=`) |
| `GET` | `/worker/dashboard` | Home data (`?personId=`) |
| `GET` | `/worker/meta` | Request kinds, handling modes, routing |
| `POST` | `/worker/status` | Update own task status |
| `POST` | `/worker/requests` | Submit worker request |
| `PATCH` | `/worker/requests/:id` | HR / reviewer updates status |
| `POST` | `/worker/requests/:id/tasks` | HR creates follow-up task |
| `GET` | `/worker/hr/inbox` | HR queue (`?personId=`) |
| `GET` | `/worker/project/inbox` | Project-scoped reviews (`?personId=`) |
| `GET` | `/worker/hr/on-leave` | People on leave / emergency |
| `POST` | `/worker/hr/emergency-activate` | HR authorizes emergency work |
| `POST` | `/worker/hr/emergency-end` | End emergency (`returnTo`: `leave` \| `active`) |

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
├── ProjectInsight.md           # Product vision & high-level overview
├── package.json
├── docs/
│   ├── principles.md
│   ├── architecture.md
│   ├── event-model.md
│   └── orchestration-loop.md
├── prompts/
│   ├── orchestrator.txt
│   ├── teamBuilder.txt
│   ├── scheduler.txt
│   ├── projectAI.txt           # Assessment + agentActions delegation
│   ├── orgAI.txt
│   └── helpChat.txt
├── server/
│   ├── README.md
│   ├── index.js
│   ├── constants/
│   │   ├── workerRequests.js
│   │   └── requestRouting.js
│   ├── routes/
│   │   ├── events.js
│   │   ├── worker.js
│   │   ├── orgInsights.js
│   │   ├── helpChat.js
│   │   ├── workforce.js
│   │   ├── revenue.js
│   │   ├── preferences.js
│   │   └── opsMonitor.js
│   ├── services/
│   │   ├── orchestratorAI.js
│   │   ├── teamBuilderAI.js
│   │   ├── schedulerAI.js
│   │   ├── projectAIEvaluator.js
│   │   ├── projectAIActions.js
│   │   ├── projectAIDeliverables.js
│   │   ├── opsMonitor.js
│   │   ├── financeService.js
│   │   ├── assignmentGapFill.js
│   │   ├── workforceAnalytics.js
│   │   ├── helpChatContext.js
│   │   ├── workerRequestHandler.js
│   │   ├── workerRequestEffects.js
│   │   ├── emergencyReturn.js
│   │   └── metrics.js
│   ├── lib/
│   │   ├── llm.js
│   │   ├── llmQueueDescribe.js
│   │   ├── agentActivityLog.js
│   │   └── eventPayload.js
│   ├── models/
│   └── store/postgresStore.js
├── client/                     # Leadership View
│   ├── README.md
│   ├── src/App.jsx
│   ├── src/HelpChat.jsx
│   ├── src/WorkforcePanel.jsx
│   ├── src/RevenuePanel.jsx
│   └── vite.config.js
├── worker/                     # Worker Portal
│   ├── README.md
│   ├── src/App.jsx
│   └── vite.config.js
└── monitor/                    # Operations Monitor
    ├── README.md
    ├── src/App.jsx
    ├── src/OpsMonitorPanel.jsx
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
| `node server/scripts/strip-assessment-event-bloat.js` | Remove oversized `_projectEventsForAssessment` from events |
| `node server/scripts/backfill-agent-activity.js` | Populate `agent_activity` from historical AI events (monitor streams) |
| `node server/scripts/repair-marketing-new-products-project.js` | Consolidate spam tasks / close duplicate needs on demo marketing project |
| `node server/scripts/sync-postgres-store.js` | Rebuild project state, loads, task index, HR assignments from event log |

---

## Documentation

| Doc | Contents |
|-----|----------|
| [`ProjectInsight.md`](ProjectInsight.md) | Product vision, loop, MVP scope |
| [`docs/principles.md`](docs/principles.md) | Product and ethics |
| [`docs/architecture.md`](docs/architecture.md) | Components and data flow |
| [`docs/event-model.md`](docs/event-model.md) | Event types and state |
| [`docs/orchestration-loop.md`](docs/orchestration-loop.md) | Orchestration + Project AI coordination |
| [`docs/reliability.md`](docs/reliability.md) | Health, transactions, locks, graceful shutdown |
| [`client/README.md`](client/README.md) | Leadership View setup and tabs |
| [`server/README.md`](server/README.md) | API server routes and services |
| [`worker/README.md`](worker/README.md) | Worker Portal setup and tabs |
| [`monitor/README.md`](monitor/README.md) | Operations Monitor streams and boards |

---

## Troubleshooting

### Server exits: `DATABASE_URL is required`

Create `.env` in the **project root** and run `npm start` from the root.

### Worker login returns **Not Found**

Restart the API after pulling — `/worker` routes must be loaded (`npm start` from root).

### Worker Portal white screen after login

Refresh once; ensure API is running. Dashboard loads after `personId` is set.

### Worker request stuck; no HR inbox

Workload / contribution on a project → **Reviews**, not HR. See routing in `GET /worker/meta`.

### Approved sick leave but person still on tasks

Restart API once — reconciliation applies unassignment for past approvals.

### Project AI / help chat always stubbed

Set `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or Ollama Cloud (`LLM_PROVIDER=ollama`, `OLLAMA_API_KEY`). For DeepSeek: `LLM_PROVIDER=deepseek` and a key from [platform.deepseek.com](https://platform.deepseek.com/api_keys). Check logs for `[LLM] Using DeepSeek`.

### Blocker will not clear

Set task to **In progress** or **Done** via Worker Portal or Leadership **Actions**.

### Project stuck: budget gap / repeated approvals

If all tasks are done but Project AI keeps creating budget needs, restart the API after pulling latest — deliverable gap logic treats **done budget tasks** and **approved budget requests** as satisfied. Run `node server/scripts/repair-marketing-new-products-project.js` for the demo marketing project if tasks were duplicated by replan loops.

### Ops Monitor: LLM queue shows busy but empty segment details

Restart API so `llm_logs` and live queue state merge into streams; pin the **rightmost** segment (“now”) for live lock info.

### `npm install` / `pg` not found

Run `npm install` at the **repository root**.

---

## Design principles & guardrails

- **AI owns information flow; humans own judgment.**  
- **Everything is an event** — state changes are traceable.  
- **Explainability** — rationales on agent and system events.  
- **No silent decisions** — humans approve requests and decisions.  
- **Leave is enforced** — emergency return is HR-gated and audited.  
- **Workforce indexes are operational signals**, not performance surveillance or HR scoring.  
- **Ethics** — AI does not evaluate human worth.

---

## Status

**MVP+** includes:

- Event-driven orchestration and Postgres persistence  
- Leadership View (overview, projects, workforce, **revenue**, actions, logs, LLM logs, worker requests, help chat)  
- Worker Portal (overview, tasks, requests, HR inbox, project reviews, emergency return)  
- Operations Monitor (agent uptime streams, LLM queue, work boards, `agent_activity` in Postgres)  
- Project AI status monitoring, deliverable-gap detection, periodic polls, agent delegation  
- Assignment gap fill, Org insights, workforce analytics, revenue/budget API, SSE, themes  
- Help chat with full org + workforce context  
- Ollama Cloud / DeepSeek / Gemini / OpenAI with serialized LLM queue  

**Not in MVP** — authentication, Slack/Jira/calendar integrations, email notifications.

---

## License

Private repository. All rights reserved unless otherwise specified by the project owner.
