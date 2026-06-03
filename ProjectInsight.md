# AI-Native Organization OS — Product insight

An AI-first system that automates **corporate coordination**, not people.

AI-Native Organization OS embeds AI into project teams as context-owning coordinators. Instead of meetings, status reports, and manual triage, AI maintains system truth while humans focus on judgment and execution.

For setup, API, and environment variables, see the main [README.md](README.md).

---

## Problem

Modern organizations suffer from:

- Too many meetings for status alignment
- Fragmented tools (Jira, Slack, docs, tickets)
- Lost context between teams
- Slow leadership decision-making
- Manual triage of tasks, bugs, and priorities

Most AI tools are bolted on top of these broken processes.

---

## Solution

**Rebuild corporate coordination from scratch using AI.**

- An AI layer per project that owns context and coordinates other agents
- Event-driven workflows instead of manual updates
- AI-owned information flow, human-owned judgment
- Leadership clarity without additional meetings
- Workforce visibility from explainable metrics (not surveillance)

---

## Core loop

1. **Request / signal**
2. **Orchestrator AI** plans work
3. **Team Builder AI** assigns people
4. **Scheduler AI** proposes timelines
5. **Humans execute**
6. **Events emitted**
7. **Project AI** monitors status and delegates to other agents as needed
8. **Leadership has clarity** (projects, workforce, help chat)
9. **Replan automatically** when blockers or reprioritization occur

> If a feature breaks this loop, it does not belong in the system.

### Replanning triggers

- **Execution → blocked** — system `request` + full orchestration pipeline
- **Decision → reprioritize** — same replan loop
- **Project AI → replan** — when assessment recommends Orchestrator (if no recent replan)

### Project AI coordination

Project AI is not only a risk assessor — it **coordinates** the other agents:

| Action | Target agent | Purpose |
|--------|--------------|---------|
| `assign_unassigned` | Team Builder | Fill assignment gaps |
| `reschedule` | Scheduler | Dates for assigned work |
| `replan` | Orchestrator | New plan for blockers / scope gaps |
| `create_need` | System | Record human input requirements |

Runs on project events (debounced) and periodic polls (`PROJECT_AI_POLL_INTERVAL_MS`).

---

## Key concepts

### AI as coordination layer

Each active project has **Project AI** that:

- Knows goals, tasks, risk, blockers, and dependencies (from events only)
- Reevaluates status after activity and on a timer
- Tasks Orchestrator, Team Builder, and Scheduler when metrics show gaps
- Emits `project_assessment` decisions with rationale

Specialized agents:

- **Orchestrator** — plans from requests
- **Team Builder** — assigns people with rationale
- **Scheduler** — proposes timelines
- **Org AI** — org-wide insights and suggested leadership requests

### Meeting-minimized by design

- Meetings → decisions → events → persistent state
- Leadership → clarity from Leadership View + Help chat, not status syncs

### Event-driven everything

Everything is an event: requests, plans, assignments, unassignments, schedules, executions, decisions, needs. The event log is the source of truth; project state is materialized from it.

---

## System components

| Component | Role |
|-----------|------|
| **Event intake** | Validate, persist, route, SSE broadcast |
| **Orchestrator AI** | Structured plans (tasks, risk, needs) |
| **Team Builder AI** | Assignments with rationale; respects leave |
| **Scheduler AI** | Proposed start/end per task |
| **Project AI** | Status assessment + agent delegation |
| **Org AI** | Org insights and suggested requests |
| **Workforce analytics** | Explainable 0–100 indexes (productivity, reliability, engagement, health) |
| **Help chat** | Leadership Q&A with full org + workforce snapshot |
| **Leadership View** | Overview, projects, workforce, actions, logs, worker requests |
| **Worker Portal** | Tasks, requests, HR inbox, project reviews, emergency return |
| **Postgres store** | Events, project state, people, needs |

---

## Applications

| App | Port (dev) | Users |
|-----|------------|--------|
| API (`server/`) | 3000 | All clients |
| Leadership (`client/`) | 5173 | Executives |
| Worker Portal (`worker/`) | 5174 | Individual contributors |

---

## MVP+ scope

**Included**

- Event schemas and Postgres persistence
- Full orchestration loop + replanning
- Project AI monitoring, polling, and agent delegation
- Assignment gap fill (Leadership Actions)
- Worker request routing, HR workflows, leave side effects, emergency return
- Leadership View: workforce tab, help chat, what-changed-recently
- Worker Portal: overview, tasks, requests, HR/reviews
- Org insights, workforce analytics, SSE, LLM logs
- Ollama Cloud / Gemini / OpenAI (stubs without keys)

**Not included**

- Authentication
- Real integrations (Slack, Jira, calendars)
- Autonomous approval of work
- Surveillance or individual “worth” scoring

---

## Tech stack

| Layer | Technology |
|--------|------------|
| Backend | Node.js + Express |
| Database | PostgreSQL (Neon-compatible) |
| AI | Gemini, OpenAI, Ollama Cloud/local via `server/lib/llm.js` |
| Leadership UI | React + Vite |
| Worker UI | React + Vite (separate app) |
| Real-time | Server-Sent Events |

---

## Demo scenario

1. Leadership submits a **request** for a new initiative
2. Orchestrator creates tasks; Team Builder assigns; Scheduler proposes dates
3. Workers update task status in the Worker Portal
4. Project AI reassesses risk and may assign unassigned work or replan on blockers
5. Leadership sees **What changed recently**, **Workforce** health, and asks **Help chat** about at-risk projects or people
6. No status meeting occurred

---

## Design principles

- AI owns information flow; humans own judgment
- Everything is explainable from events and rationales
- Meetings are minimized structurally
- Workforce metrics are operational signals, not HR surveillance
- Clarity over feature sprawl

---

## Ethics & guardrails

- AI never evaluates human worth
- No silent decisions on worker requests or project kill
- All AI outputs include rationale where applicable
- Humans can override via decisions and request review
- Leave and emergency return are audited and HR-gated

---

## Status

**MVP+ in place** — event loop, dual frontends, HR/worker workflows, Project AI coordination, workforce analytics, help chat with workforce context.

**Next (optional)** — auth, external integrations, richer notifications — only if they serve the core loop.

---

## Final note

This project is not about replacing humans. It is about removing coordination friction so humans can do meaningful work.
