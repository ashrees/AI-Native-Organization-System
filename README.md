# AI-Native Organization OS

An AI-first system that automates corporate coordination, not people.

AI-Native Organization OS rethinks how modern organizations operate by embedding AI directly into project teams as a context-owning member.  
Instead of meetings, status reports, and manual coordination, AI maintains system truth while humans focus on judgment and execution.

---

## 🚩 Problem

Modern organizations suffer from:

- Too many meetings for status alignment
- Fragmented tools (Jira, Slack, docs, tickets)
- Lost context between teams
- Slow leadership decision-making
- Manual triage of tasks, bugs, and priorities

Most AI tools today are bolted on top of these broken processes.

---

## 💡 Solution

**Rebuild corporate coordination from scratch using AI.**

This system introduces:

- An AI member per project that owns context and state
- Event-driven workflows instead of manual updates
- AI-owned information flow, human-owned judgment
- Leadership clarity without additional meetings

---

## 🔁 Core Loop (The Heart of the System)

1. **Request / Signal**
2. **Orchestrator AI** plans work
3. **Team Builder AI** assigns people
4. **Scheduler AI** proposes timelines
5. **Humans execute**
6. **Events emitted**
7. **Project AI** updates system truth
8. **Leadership has clarity**
9. **Replan automatically if needed**

> If a feature breaks this loop, it does not belong in the system.

---

## 🧠 Key Concepts

### AI as a Team Member

Each project has a dedicated AI that:

- Knows goals, decisions, tasks, risks, and dependencies
- Processes employee updates and customer issues
- Maintains live project truth

Humans never need to “bring the AI up to speed.”

### Meeting-Minimized by Design

- Meetings are not banned — they are compressed into signals.
- Meetings → decisions  
    AI → persistent system state  
    Leadership → clarity without follow-ups

### Event-Driven Everything

- Nothing is manually reported.
- Everything is an event:
    - Requests
    - Assignments
    - Execution updates
    - Decisions

Events are the single source of truth.

---

## 🏗️ System Components

1. **Event Intake Layer**  
     Receives structured events from:
     - Employees
     - Customers
     - Leadership

2. **Orchestrator AI**  
     - Breaks high-level requests into sub-tasks
     - Estimates risk and impact
     - Produces structured plans (JSON, not prose)

3. **Team Builder AI**  
     Assigns people based on:
     - Skills
     - Workload
     - Project relevance  
     Always provides rationale

4. **Scheduler AI**  
     - Proposes timelines and task ordering
     - Respects availability (mocked in MVP)

5. **Project AI (State Owner)**  
     Owns project truth:
     - Progress
     - Risk
     - Blockers
     - Dependencies  
     Updates state only via events

6. **Leadership View**  
     - Read-only
     - Shows:
         - What’s happening
         - Why it’s happening
         - What changed  
     Enables fast reprioritization or rollback

---

## 📦 MVP Scope

**Included**

- Event schemas
- AI orchestration logic
- Team selection & scheduling logic
- Project state tracking
- Leadership summary view
- Mock data & simulated workflows

**Explicitly Not Included**

- Authentication
- Real integrations (Slack, Jira, Calendars)
- Performance tracking of individuals
- Autonomous decision-making
- Surveillance features

---

## 🛠️ Tech Stack (MVP)

- **Backend:** Node.js + Express
- **AI:** Google Gemini API or OpenAI API, selected via a shared LLM helper (set one API key; see below)
- **State:** In-memory / JSON (MongoDB-ready)
- **Frontend:** React
- **Architecture:** Event-driven

---

## 📁 Project Structure

```
AI-Native-Organization-System/
├── README.md
├── docs/
│   ├── principles.md
│   ├── architecture.md
│   ├── event-model.md          # Event schema + Project State (source of truth)
│   └── orchestration-loop.md   # Main loop pseudocode
├── server/
│   ├── index.js                # Express app + CORS
│   ├── routes/
│   │   └── events.js           # POST/GET /events, GET /events/projects
│   ├── services/
│   │   ├── orchestratorAI.js
│   │   ├── teamBuilderAI.js
│   │   ├── schedulerAI.js
│   │   └── projectAI.js
│   ├── models/
│   │   ├── eventSchema.js     # Validation + constants
│   │   └── projectState.js    # Apply events → state
│   └── store/                  # Postgres persistence
│       └── postgresStore.js    # events, projects, people tables
├── prompts/                    # AI prompt templates
│   ├── orchestrator.txt
│   ├── teamBuilder.txt
│   ├── scheduler.txt
│   └── projectAI.txt
└── client/                     # React Leadership View (Vite)
    ├── src/
    │   ├── App.jsx
    │   └── main.jsx
    └── index.html
```

---

## 🚀 Getting Started

**Prerequisites:** Node.js 18+ (Node 20+ recommended for Google Gen AI SDK)

1. **Install dependencies**
   ```bash
   cd server && npm install
   cd ../client && npm install
   ```

2. **(Required) Set DATABASE_URL** — Postgres is the only store (events, projects, people). Default people are seeded automatically when the people table is empty.
   ```bash
   export DATABASE_URL='postgresql://user:pass@host/db?sslmode=require'
   # or add to .env in project root
   ```

3. **(Optional) Set AI API key** — use Google Gemini or OpenAI; without a key, stub AI runs.
   ```bash
   export GOOGLE_API_KEY='your-gemini-api-key'   # from https://aistudio.google.com/apikey
   # or
   export OPENAI_API_KEY='your-openai-key'
   ```

4. **Run the API server** (port 3000)
   ```bash
   node server/index.js
   ```

5. **Run the Leadership View** (port 5173)
   ```bash
   cd client && npm run dev
   ```
   Open http://localhost:5173 — read-only view of projects, tasks, risk, blockers, and recent events.

6. **Submit a request event**
   ```bash
   curl -X POST http://localhost:3000/events \
     -H "Content-Type: application/json" \
     -d '{"id":"<UUID>","type":"request","timestamp":"<ISO8601>","projectId":"proj-1","source":"human","payload":{"title":"Fix login bug","priority":"high"}}'
   ```

**API (no auth in MVP)**

| Method | Path | Description |
|--------|------|-------------|
| POST   | /events | Submit an event (validate, persist, apply). If `type` is `request`, orchestration runs and derived events are emitted. |
| GET    | /events | List recent events (optional `?projectId=`). |
| GET    | /events/projects | List all project states. |
| GET    | /events/projects/:id | Get one project state. |
| GET    | /health | Health check. |

---

## 🎬 Demo Scenario

1. Customer reports a critical bug
2. Orchestrator AI breaks it into tasks
3. Team Builder assigns best-fit engineers
4. Scheduler proposes timeline
5. Execution events update project state
6. Leadership sees risk drop in real time

_No status meetings occurred_

---

## 🧭 Design Principles

- AI owns information flow
- Humans own judgment
- Everything is explainable
- Meetings are minimized structurally
- Clarity over features

---

## ⚠️ Ethics & Guardrails

- AI never evaluates human worth
- No silent decisions
- All AI outputs include rationale
- Humans can override at any point

---

## 🎯 Why This Project Matters

This project demonstrates:

- AI-native system design
- Strong systems thinking
- Organizational awareness
- Product + engineering maturity

_It is not a chatbot demo —  
it is a new operating model._

---

## 🚀 Status

🟢 **MVP in place**

- **Done:** Event schemas, Project State model, event intake, persistence (JSON store)
- **Done:** Orchestration loop — on `request` events: Orchestrator → Team Builder → Scheduler; plan_created, assignment, schedule_proposed emitted and applied
- **Done:** Project AI apply logic (state updated only via events)
- **Done:** Leadership View (React, read-only: what’s happening, why, what changed)
- **Done:** Prompts and mock data (people, sample events)
- **Next:** Wire AI services to OpenAI (or replaceable LLM); optional replan triggers; execution/decision events from UI

---

## 📌 Final Note

This project is not about replacing humans.  
It is about removing coordination friction so humans can do meaningful work.
