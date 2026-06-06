# AI-Native Organization OS — Prototype Demo

> **One-line pitch:** AI runs coordination — planning, routing, monitoring — humans keep judgment and execution.

| | |
| --- | --- |
| **Target length** | 5–7 minutes (3-min cutdown included) |
| **Audience** | Exec + technical stakeholders |
| **Apps** | Leadership (5173) · Worker (5174) · Ops Monitor (5175) |

---

## Pre-demo checklist

- [ ] API running: `npm start` (port 3000)
- [ ] Leadership View: `npm run dev:client` → http://localhost:5173
- [ ] Worker Portal: `npm run dev:worker` → http://localhost:5174
- [ ] Ops Monitor: `npm run dev:monitor` → http://localhost:5175
- [ ] Seed data (if empty): `node server/scripts/seed-mock-data.js`
- [ ] Tabs pre-opened: Leadership Overview, Worker Portal, Ops Monitor
- [ ] Optional: enable **AI Handler** in Leadership preferences
- [ ] **Before demo:** set `MOCK_WORKER_ENABLED=false` in `.env` (or run repair script) so NPCs don’t flood the org with leave requests
- [ ] If tasks show “(on leave)”: `node server/scripts/repair-project-assignments.js`

**Demo logins**

| Role | Person | Notes |
| --- | --- | --- |
| Worker | Sam Lee (`person-2`) | Has assigned tasks |
| HR | Hermione Granger (`person-5`) | Approve leave, emergency return |
| Leadership | Leadership View | No login — exec dashboard |

---

## Demo flow at a glance

| Act | Where | Time | Show |
| --- | --- | --- | --- |
| 1. The problem | Leadership → Overview | ~45s | Fragmented coordination, no shared “why” |
| 2. AI coordinates | Leadership → Actions → Projects | ~90s | Request → plan → assign → schedule |
| 3. Human executes | Worker Portal → Tasks | ~60s | Task done → Leadership updates live |
| 4. Request hits org | Worker → Requests + Leadership | ~90s | Routing, approve, real side effects |
| 5. Transparency | Ops Monitor + Help chat | ~60s | Agent streams, boards, ask the org |

---

## System diagram

```
Request / Signal
       ↓
Orchestrator AI → Team Builder → Scheduler
       ↓
Humans Execute (Worker Portal)
       ↓
Project AI Monitors
       ↓
Leadership View + Ops Monitor

Worker Requests → HR / Leads / AI Handler → same event log
```

**Core idea:** One event-sourced log in Postgres. The UI is a lens on that truth.

---

# Act 1 — Opening (~45s)

**Screen:** Leadership → **Overview**

### Script

> Most teams don’t fail on execution — they fail on **coordination**. Status meetings, Slack threads, spreadsheets. Nobody has one place that knows what’s true, what changed, and **why**.
>
> This is an **AI-Native Organization OS** — not AI replacing people, but AI owning the **coordination loop**: plan, assign, schedule, monitor, route requests. Humans still own judgment and the actual work.
>
> Everything you’ll see is **event-sourced** — one log of truth in Postgres. The UI is just a lens on that.

### Point at

- Org metrics on Overview
- Project count
- Any AI-generated insights

---

# Act 2 — AI coordinates (~90s)

**Screen:** Leadership → **Actions** → **Projects**

### Do

1. **Actions** → **New request**
   - Title: *Customer onboarding checklist for Q3*
   - Priority: **High**
   - Submit
2. Switch to **Projects** → open the new or updated project
3. *(Optional)* Peek at **Log** or **LLM Logs** if API keys are configured

### Script

> Let’s kick off work the way leadership actually would — a **request**, not a Jira ticket forest.
>
> Watch what happens without me touching assignment or dates. The **Orchestrator** turns the request into a plan. **Team Builder** assigns people with rationale. **Scheduler** proposes timelines. **Project AI** keeps watching in the background.
>
> I didn’t run a standup. The system propagated truth.

### Point at

- Tasks with assignees
- **What changed recently** — each line has human or AI rationale
- Risk level on the project card

---

# Act 3 — Human executes (~60s)

**Screen:** Worker Portal → **Tasks** → back to Leadership → **Projects**

### Do

1. Worker Portal → log in as **Sam Lee**
2. **Tasks** → pick an assigned task → **In progress** → **Done**
3. Flip to Leadership → **Projects** → same project

### Script

> Coordination is AI. **Execution is human.**
>
> One status update from the worker. Leadership immediately sees an **execution** event, then **Project AI** reassesses risk and progress. No one retyped this into a dashboard.

### Point at

- **What changed recently** updating in real time (SSE live refresh)

---

# Act 4 — Worker request + org effects (~90s)

**Screen:** Worker Portal → **Requests** → HR or Leadership **Worker requests**

### Do

1. Worker Portal → **Requests**
2. Submit **Sick leave** or **Workload concern**
   - Show **Forwards to: …** routing preview
   - Note handling mode: AI / Notify / Self
3. Approve via one path:
   - **HR:** Hermione Granger → **HR** → approve leave
   - **Leadership:** **Worker requests** tab → approve

### Script

> Real orgs aren’t only tasks — people get sick, workloads spike, transfers happen. This system treats those as **first-class events**, not side email.
>
> Every request type has defined routing — HR, project lead, engineering mgmt — and a coordinating AI agent. No one wonders who owns the inbox.
>
> Approval isn’t a checkbox. Approve sick leave and the person is marked **on leave**, unassigned from active work, and project leads get a **leave notice**. The org state actually moves.

### Optional add-on (~15s)

> Hermione can authorize **emergency return** for someone on leave — urgent work without losing leave records.

---

# Act 5 — Ops transparency (~60s)

**Screen:** Ops Monitor → Leadership **Help chat**

### Do

1. Open **Ops Monitor** (http://localhost:5175)
2. Leadership → **Help chat** (bottom-right) — ask one question aloud, then type it

**Suggested questions**

- *Which projects are at risk?*
- *Who is overloaded this week?*
- *What open worker requests need leadership?*

### Script

> Executives ask: *Is the AI actually doing anything, or is this theater?*
>
> **Agent uptime streams** — Orchestrator, Team Builder, Scheduler, Project AI, AI Handler — when they ran and what they did. **Work boards**: worked, in progress, in line, broken. **LLM queue** when models are in play.
>
> Help chat has the **full org snapshot** — projects, people, workforce health, requests — and routes to the right agent. Ask in plain English; get an answer grounded in live state.

### Optional extras (~10s each)

- **Workforce** tab — productivity matrix, health scores (0–100)
- **Revenue** tab — budget, burn, runway per project

---

# Closing (~30s)

### Script

> What you saw in five minutes:
>
> - **One event log** as source of truth
> - **Specialized AI agents** for planning, assignment, scheduling, monitoring, and HR routing
> - **Three surfaces** — leadership, worker, ops — for different roles
> - **Humans stay in the loop** for judgment; AI removes coordination tax
>
> This is a prototype, but the architecture is the product: **automate coordination, not people.**
>
> Happy to go deeper on workforce analytics, revenue, or how we’d plug this into your stack.

---

# 3-minute cutdown

Use this if time is tight.

| Step | Screen | Time |
| --- | --- | --- |
| 1 | Overview — problem + pitch | 30s |
| 2 | Actions → Projects — new request, watch AI | 60s |
| 3 | Worker — complete one task | 30s |
| 4 | Ops Monitor — agent streams + boards | 30s |
| 5 | Help chat — one question | 30s |

**Skip:** Revenue deep-dive, Workforce matrix, emergency return, LLM logs.

---

# Demo tips

| Tip | Why |
| --- | --- |
| Name the agents aloud | Orchestrator, Team Builder, Project AI — memorable |
| Always show **What changed recently** | Rationale is the differentiator |
| Don’t apologize for demo roster | Harry Potter names are fine for a prototype |
| If AI is slow | Say “agents run async” → show Log or Monitor streams |
| If something breaks | Broken column in Monitor is a feature — failures are visible |

---

# Key features reference

### Leadership View (`client/` — port 5173)

- Overview — org metrics, AI insights
- Projects — live state, tasks, blockers, **What changed recently**
- Workforce — productivity matrix, health scores
- Revenue — budget, spend, burn, runway
- Actions — submit requests, execution, decisions
- Worker requests — approve / reject human needs
- Help chat — full org snapshot Q&A

### Worker Portal (`worker/` — port 5174)

- Login by name
- Tasks — update in progress / done / blocked
- Requests — sick leave, vacation, workload, transfer, etc.
- HR inbox — approve leave (HR role)
- Project reviews — project-scoped requests

### Ops Monitor (`monitor/` — port 5175)

- Agent uptime streams (last 3h default)
- LLM queue — live model calls
- Work boards — worked / active / in line / broken

---

# Design principles

1. **AI automates coordination, not people**
2. **Event-sourced truth** — state derived from events only
3. **Specialized agents** — each owns one coordination job
4. **Humans own judgment** — approve, reject, execute
5. **Transparency** — every change has rationale; ops can audit agents

---

# Troubleshooting during demo

| Issue | Fix |
| --- | --- |
| Empty projects | Run `node server/scripts/seed-mock-data.js` |
| No AI responses | Works with stubs without API keys; add `GOOGLE_API_KEY` or `DEEPSEEK_API_KEY` for live LLM |
| Stale UI | Hard refresh; SSE should auto-update |
| Server not running | `npm start` from project root |
| Worker can’t log in | Check `GET /worker/people` — server must be up |

---

*AI-Native Organization OS · Prototype demo guide · Import this file into Notion via Settings → Import → Markdown*
