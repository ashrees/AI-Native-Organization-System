# Orchestration loop (pseudocode)

The loop: Request → Orchestrator → Team Builder → Scheduler → Humans execute → Events → Project AI updates state → Leadership clarity → replan if needed.

---

## Main loop: ON new event received at intake

```
1. Validate event against base Event schema (id, type, timestamp, projectId, source, payload).

2. Persist event to event log (append-only).

3. Route by event.type:

   - "request":
       a. Call Orchestrator AI with request payload (+ context: project state if any).
       b. Orchestrator returns structured plan (tasks, risk, impact).
       c. Emit "plan_created" event (source: orchestrator, correlationId: request.id).
       d. For each task in plan, call Team Builder AI (skills, load, project) → assignments.
       e. Emit "assignment" event(s) (source: team_builder, correlationId: plan_created.id).
       f. Call Scheduler AI with task list + assignments → proposed dates.
       g. Emit "schedule_proposed" event(s) (source: scheduler).
       h. Project AI applies all new events to project state (see below).
       i. If risk/blockers warrant, optionally trigger replan (emit or re-call orchestrator with context).

   - "plan_created":
       Apply to project state via Project AI (create/update tasks, risk, dependencies).

   - "assignment" | "schedule_proposed":
       Apply to project state via Project AI (update tasks: assignees, schedule).

   - "execution":
       Apply to project state (task status; if status=blocked, add to blockers).

   - "decision":
       Apply to project state (e.g. status=killed, priority change); if reprioritize, may emit new request or replan.

4. After any apply: leadership view can read updated project state (read-only).
```

---

## Project AI apply logic (per event)

```
- Load current project state for event.projectId (or create from first event for that project).

- Switch on event.type and payload:
  - request: set project title from payload.title if new project; ensure status = active.
  - plan_created: merge tasks from payload into progress.tasks; set risk from payload; set dependencies if provided.
  - assignment: find task by payload.taskId, set assigneeId = payload.personId.
  - schedule_proposed: find task by payload.taskId, set scheduledStart/scheduledEnd.
  - execution: find task by payload.taskId, set status; if status=blocked, append to blockers from notes.
  - decision: if decisionType=kill_project (or similar), set status=killed; if reprioritize, set priority.

- Set lastUpdatedAt = event.timestamp, lastEventId = event.id.

- Persist project state.

- No direct writes to project state elsewhere; all mutations go through this apply.
```

---

## Replanning

When Project AI or a rule detects "blocker," "risk escalation," or "decision: reprioritize," the system emits a new `request` (or a dedicated `replan_request` type) with context. Orchestrator runs again; the rest of the loop is unchanged. One loop, no special-case code paths.
