# AI-Native Organization OS

An AI-first system that automates **corporate coordination**, not people. AI maintains project truth and information flow; humans own judgment and execution.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

---

## Table of contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local)
- [Environment variables](#environment-variables)
- [Running the application](#running-the-application)
- [Verify your setup](#verify-your-setup)
- [Demo workflow](#demo-workflow)
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
6. **Project state** updates from events only  
7. **Leadership View** shows what changed and why  
8. **Replan** triggers on blockers or reprioritization  

The **Leadership View** (React) is read-only for executives: projects, risk, blockers, org insights, agent logs, and LLM traces. Humans submit requests and execution/decision events via the UI or API.

### Tech stack

| Layer | Technology |
|--------|------------|
| API | Node.js 18+, Express |
| Persistence | PostgreSQL ([Neon](https://neon.tech) or any Postgres) via `pg` |
| AI | Google Gemini, OpenAI, or Ollama (optional; stubs without keys) |
| Frontend | React 18, Vite 5 |
| Real-time | Server-Sent Events (SSE) |

---

## Requirements

### System

| Requirement | Version / notes |
|-------------|-----------------|
| **Node.js** | **18+** (20+ recommended for Google Gen AI SDK) |
| **npm** | 9+ (ships with Node 20+) |
| **PostgreSQL** | 14+ compatible database (hosted or local) |
| **Git** | To clone the repository |

### Optional (for full AI responses)

| Requirement | Purpose |
|-------------|---------|
| **Google Gemini API key** | `GOOGLE_API_KEY` or `GEMINI_API_KEY` — [Google AI Studio](https://aistudio.google.com/apikey) |
| **OpenAI API key** | `OPENAI_API_KEY` — [OpenAI platform](https://platform.openai.com/api-keys) |
| **Ollama** | Local models at `http://localhost:11434` — [ollama.com](https://ollama.com) |

Without an API key, agent services use **deterministic stubs** so you can run and demo the loop end-to-end.

### Network / ports (local dev)

| Port | Service |
|------|---------|
| `3000` | Express API (default `PORT`) |
| `5173` | Vite dev server (Leadership View) |

---

## Quick start (local)

### 1. Clone and install dependencies

Install at the **repository root** (provides `pg` for the database layer) and in **server** and **client**:

```bash
git clone <your-repo-url> AI-Native-Organization-System
cd AI-Native-Organization-System

npm install
cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set **`DATABASE_URL`** (required). See [Environment variables](#environment-variables).

**Neon (recommended for a free hosted DB):**

1. Create a project at [neon.tech](https://neon.tech).  
2. Copy the connection string (include `?sslmode=require` if prompted).  
3. Paste it as `DATABASE_URL` in `.env`.

**Local Postgres example:**

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_native_org
```

### 3. Start the API server

From the **project root** (loads `.env` from the root):

```bash
npm start
# or: node server/index.js
```

On success you should see:

```text
Store ready (Postgres).
Server listening on port 3000
```

Tables are created automatically on first start. Default **people** are seeded when the `people` table is empty.

### 4. Start the Leadership View

In a **second terminal**:

```bash
cd client
npm run dev
```

Open **http://localhost:5173**

The Vite dev server proxies `/api/*` to `http://localhost:3000` (see `client/vite.config.js`), so the UI talks to the API without CORS setup.

### 5. (Optional) Seed sample data

```bash
node server/scripts/seed-mock-data.js
```

Uses `mock-data/people.json` and `mock-data/events.json` if present; otherwise seeds default people from the store.

---

## Environment variables

All variables are read from **`.env` in the project root** when you start the server from the root.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **Yes** | — | Postgres connection string |
| `PORT` | No | `3000` | HTTP port for the API |
| `POSTGRES_SCHEMA` | No | `public` | Schema for tables (useful on Neon) |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | No | — | Google Gemini |
| `OPENAI_API_KEY` | No | — | OpenAI |
| `LLM_PROVIDER` | No | auto | Force `google`, `openai`, or `ollama` |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `llama3.1:8b` | Ollama model tag |
| `OLLAMA_TIMEOUT_MS` | No | — | Ollama request timeout (ms) |
| `OLLAMA_NUM_PREDICT` | No | `2048` | Max tokens for Ollama |
| `LLM_MAX_RETRIES` | No | `5` | Retries when LLM returns null |
| `LLM_RETRY_DELAY_MS` | No | `3000` | Delay between LLM retries (ms) |
| `AGENT_LLM_TIMEOUT_MS` | No | `2500` / `60000` (Ollama) | Per-agent LLM call timeout |
| `AGENT_STEP_RETRIES` | No | `3` | Orchestration step retries |
| `AGENT_STEP_RETRY_DELAY_MS` | No | `1500` | Delay between step retries |
| `VITE_API_URL` | No | `/api` | Client API base (production or custom backend) |
| `CONFIRM_CLEAN` | No | — | Set to `1` to allow `clean-database.js` without prompt |

Copy `.env.example` for a commented template.

**LLM selection order (when `LLM_PROVIDER` is unset):**

1. Google, if `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set  
2. Else OpenAI, if `OPENAI_API_KEY` is set  
3. Else Ollama (local), if reachable  
4. Else stub responses in agent services  

---

## Running the application

### Development (two terminals)

**Terminal 1 — API**

```bash
# from project root
npm start
```

**Terminal 2 — UI**

```bash
cd client
npm run dev
```

| URL | What |
|-----|------|
| http://localhost:5173 | Leadership View |
| http://localhost:3000/health | API health check |
| http://localhost:3000/events/projects | Project states (JSON) |

### Production-style client build

```bash
cd client
npm run build
npm run preview   # serves dist on port 4173 by default
```

Set `VITE_API_URL` to your deployed API origin if the UI is not served behind the same proxy.

### Exposing via ngrok (optional)

If you tunnel the Vite dev server, add your ngrok host to `allowedHosts` in `client/vite.config.js`. The API must still be reachable (proxy targets `localhost:3000`).

---

## Verify your setup

### Health check

```bash
curl -s http://localhost:3000/health | jq
```

Expected:

```json
{
  "status": "ok",
  "service": "ai-native-org",
  "store": "postgres"
}
```

### Postgres diagnostic

```bash
node server/scripts/postgres-diagnostic.js
```

### Submit a request event

Replace `<UUID>` and `<ISO8601>` (or use `uuidgen` and `date -u +%Y-%m-%dT%H:%M:%SZ`):

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<UUID>",
    "type": "request",
    "timestamp": "<ISO8601>",
    "projectId": "proj-demo-1",
    "source": "human",
    "payload": {
      "title": "Fix login bug",
      "description": "Users cannot sign in on mobile",
      "priority": "high"
    }
  }'
```

Then refresh the Leadership View **Projects** tab or:

```bash
curl -s http://localhost:3000/events/projects | jq
```

Orchestration runs asynchronously for `request` events (plan → assign → schedule).

---

## Demo workflow

1. Open the Leadership View → **Actions** → create a **New request** (project id + title).  
2. Watch **Projects** populate as orchestration emits events.  
3. Open **Log** or **LLM Logs** for agent activity (requires LLM key for rich LLM logs).  
4. Submit an **execution** or **decision** event from **Actions**.  
5. **Overview** loads org metrics and AI insights (best-effort; may use stubs).  

No status meetings required.

---

## API reference

Base URL in local dev: `http://localhost:3000`  
Routes are also mounted under `/api` (e.g. `/api/events`).

**Authentication:** none in MVP.

### Events & projects

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/events` | Submit an event. `type: request` triggers orchestration. |
| `GET` | `/events` | Recent events (`?projectId=` optional) |
| `GET` | `/events/stream` | SSE stream for live UI updates |
| `GET` | `/events/projects` | All project states |
| `GET` | `/events/projects/:id` | One project state |
| `GET` | `/events/agent-activity` | Agent activity log (`?projectId=` optional) |
| `GET` | `/events/llm-logs` | LLM prompts/responses (`?projectId=`, `?agent=` optional) |
| `GET` | `/events/needs` | Needs list (`?projectId=`, `?status=` optional) |
| `GET` | `/events/projects/:id/needs` | Needs for one project |
| `PATCH` | `/events/needs/:id` | Update need status (`open` \| `met` \| `cancelled`) |
| `POST` | `/events/worker/status` | Assignee updates task status |

### Org insights

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/org-insights` | Metrics + AI-generated org/project/people insights |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health |

Event schemas and state rules: [`docs/event-model.md`](docs/event-model.md).

---

## Project structure

```text
AI-Native-Organization-System/
├── .env.example              # Environment template
├── README.md
├── package.json              # Root: pg, dotenv; npm start runs server
├── docs/
│   ├── architecture.md
│   ├── event-model.md
│   ├── orchestration-loop.md
│   └── principles.md
├── prompts/                  # LLM system prompts
│   ├── orchestrator.txt
│   ├── teamBuilder.txt
│   ├── scheduler.txt
│   ├── projectAI.txt
│   └── orgAI.txt
├── mock-data/                # Optional seed JSON (people.json, events.json)
├── server/
│   ├── index.js              # Express entry
│   ├── db/                   # Postgres pool
│   ├── routes/
│   │   ├── events.js         # Event intake, SSE, orchestration
│   │   └── orgInsights.js
│   ├── services/             # orchestratorAI, teamBuilderAI, schedulerAI, …
│   ├── models/               # eventSchema, projectState
│   ├── store/postgresStore.js
│   ├── lib/                  # llm, agentActivityLog, …
│   └── scripts/              # seed, migrate, diagnostic, clean
└── client/                   # React Leadership View (Vite)
    ├── src/App.jsx
    ├── src/App.css
    └── vite.config.js        # Dev proxy /api → :3000
```

---

## Utility scripts

Run from the **project root** with `.env` configured.

| Command | Purpose |
|---------|---------|
| `node server/scripts/postgres-diagnostic.js` | Connection and table counts |
| `node server/scripts/seed-mock-data.js` | Seed people and optional events |
| `node server/scripts/clean-database.js` | Wipe tables (set `CONFIRM_CLEAN=1`) |
| `node server/scripts/migrate-to-postgres.js` | Legacy JSON → Postgres migration |
| `node server/scripts/test-rag-agents.js` | Exercise retrieval / agent context |

---

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/principles.md`](docs/principles.md) | Product and ethics principles |
| [`docs/architecture.md`](docs/architecture.md) | Components and core loop |
| [`docs/event-model.md`](docs/event-model.md) | Event types and project state |
| [`docs/orchestration-loop.md`](docs/orchestration-loop.md) | Orchestration pseudocode |

---

## Troubleshooting

### Server exits immediately: `DATABASE_URL is required`

- Create `.env` in the **project root** (not only under `server/`).  
- Start the server from the root: `npm start` or `node server/index.js`.

### `Failed to start server` / Postgres connection errors

- Confirm the connection string works with `psql` or Neon console.  
- For Neon, use `?sslmode=require` in `DATABASE_URL`.  
- Run `node server/scripts/postgres-diagnostic.js`.

### UI shows “Error” or empty data

- Ensure the API is running on port **3000**.  
- In dev, use `npm run dev` in `client/` (proxy expects API on 3000).  
- Check browser network tab: requests should go to `/api/...`.

### AI always uses stub plans

- Set `GOOGLE_API_KEY`, `OPENAI_API_KEY`, or run Ollama and optionally `LLM_PROVIDER=ollama`.  
- Check server logs for `[LLM]` lines.  
- Inspect **LLM Logs** tab after submitting a request.

### `npm install` / module not found (`pg`)

- Run `npm install` at the **repository root** (installs `pg`) in addition to `server/` and `client/`.

---

## Design principles & guardrails

- **AI owns information flow; humans own judgment.**  
- **Everything is an event** — no manual “reporting” path.  
- **Explainability** — agent outputs include rationale where applicable.  
- **No silent decisions** — humans can override via decision events.  
- **Ethics** — AI does not evaluate human worth; no surveillance features in MVP.

---

## Status

**MVP** — event schemas, Postgres persistence, orchestration loop, Leadership View (overview, projects, actions, agent log, LLM logs), org insights, SSE live updates, dark/light theme.

**Not in MVP** — authentication, Slack/Jira/calendar integrations, autonomous decisions without human events.

---

## License

Private repository. All rights reserved unless otherwise specified by the project owner.
