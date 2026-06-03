# Orchestration loop (pseudocode)

The loop: Request → Orchestrator → Team Builder → Scheduler → Humans execute → Events → Project AI coordinates → Leadership clarity → replan if needed.

---

## Main loop: ON new event received at intake

```
1. Validate event against base Event schema.

2. Persist event to event log (Postgres + in-memory).

3. Broadcast SSE to connected clients.

4. Route by event.type:

   - "request" (and project status != killed):
       a. Orchestrator AI → plan (tasks, risk, impact, needs)
       b. Emit "plan_created" (source: orchestrator)
       c. Emit "need" events for orchestrator needs[]
       d. For each task: Team Builder AI → assignment events
       e. Scheduler AI → schedule_proposed events
       f. Each emit triggers Project AI status check (debounced)

   - "execution" (human):
       g. Apply execution (status, blockers)
       h. Project AI status check
       i. Optional assignment gap fill (requestAssignment / keywords / unassigned in_progress)
       j. If blocked + active project: emit system replan request → handleRequestFlow

   - "decision" (reprioritize):
       k. Apply decision; may emit replan request

   - Other types (assignment, schedule_proposed, need, unassignment, plan_created):
       l. Apply via projectState.applyEvent
       m. Project AI status check if shouldScheduleStatusCheck(event)

5. Leadership / Worker views read updated state (SSE refresh).
```

---

## Agent hierarchy (request pipeline)

Serialized LLM access; tier order:

| Tier | Agent | Output events |
|------|-------|----------------|
| 1 | orchestrator | `plan_created`, `need` |
| 2 | team_builder | `assignment` (per task) |
| 3 | scheduler | `schedule_proposed` (per task) |

Retries: `AGENT_STEP_RETRIES` with `AGENT_STEP_RETRY_DELAY_MS`. Stubs only after retries exhaust or no LLM.

---

## Project AI status check (parallel to pipeline)

```
ON shouldScheduleStatusCheck(event) OR periodic poll:

1. Debounce per projectId (PROJECT_AI_DEBOUNCE_MS).

2. Build metrics + RAG agentContext.

3. LLM or stub → assessment:
   { summary, riskLevel, riskReason, recentChanges, suggestProjectCompleted, agentActions[] }

4. Emit decision (source: project_ai, decisionType: project_assessment).

5. FOR EACH agentAction:
   - team_builder / assign_unassigned → fillAssignmentGaps
   - team_builder / assign_task → assignOneTask + optional reschedule
   - scheduler / reschedule → proposeSchedule for tasks missing dates
   - orchestrator / replan → system request + handleRequestFlow (skip if recent replan)
   - create_need → need event (source: project_ai)

6. Apply assessment decision to project state (risk, optional complete).
```

---

## Project AI apply logic (per event)

Same as `projectState.applyEvent`:

```
- request: title, org fields, ensure active
- plan_created: merge tasks, risk
- assignment: assignee on task
- unassignment: clear assignee; may reset in_progress → pending
- schedule_proposed: scheduledStart/scheduledEnd on task
- execution: task status; blocked → add blocker; else remove blocker for task
- decision:
    kill → killed, clear assignees
    complete → completed
    project_assessment → risk level; maybe completed if all tasks done
- need: merge into state.needs[]

- lastUpdatedAt, lastEventId updated
```

---

## Assignment gap fill (subset loop)

```
ON leadership execution with gap-fill trigger:

1. listUnassignedTasks(project) — not done, no assignee

2. FOR EACH task: Team Builder → assignment event, increment load

3. Scheduler on newly assigned tasks → schedule_proposed

4. Emit decision (system, assignment_gap_fill)
```

No Orchestrator replan.

---

## Replanning

| Trigger | Mechanism |
|---------|-----------|
| execution.status = blocked | Immediate system `request` + handleRequestFlow |
| decision reprioritize | system `request` + handleRequestFlow |
| Project AI agentActions.replan | system `request` if no replan in last ~15 min |

One pipeline for all replans — no separate code path.

---

## Help chat & workforce (read-only)

```
ON POST /help-chat:

1. Load store (events, projects, people)
2. buildFullHelpContext → metrics, workforce, worker requests, events, orgInsights
3. LLM completeText with helpChat.txt prompt
4. Return answer (or stub fallback with workforce summary)
```

Workforce data is computed live via `buildWorkforceAnalytics` — same source as `GET /workforce/analytics`.
