# Event model and Project State

Source of truth for event schema and project state. Server `models/` implement or re-export these definitions.

---

## Base Event schema

Events are the single source of truth. Every state change comes from an event. Design supports classification, routing, and traceability.

### Required fields (every event)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (UUID) | Unique; idempotency and reference |
| `type` | enum | Drives routing and Project AI logic |
| `timestamp` | ISO 8601 | Ordering and audit |
| `projectId` | string | Which project this belongs to |
| `source` | enum | Who/what produced the event |
| `payload` | object | Type-specific body (see below) |

### Event type enum

- `request`
- `plan_created`
- `assignment`
- `schedule_proposed`
- `execution`
- `decision`

### Source enum

- `human`
- `orchestrator`
- `team_builder`
- `scheduler`
- `project_ai`
- `system`

### Optional but recommended

| Field | Type | Purpose |
|-------|------|---------|
| `correlationId` | string | Link related events (e.g. request → plan → assignments) |
| `rationale` | string | Required for AI-generated events; explains "why" |

---

## Event types and payload shape

### `request`

Incoming work or signal.

**payload:**

- `title` (string, required)
- `description` (string, optional)
- `priority` (string, optional)
- `requestedBy` (string, optional)

### `plan_created`

Output of Orchestrator AI.

**payload:**

- `tasks` (array of `{ id, title?, description? }`, required) — full task details
- `taskIds` (array of string, optional) — if tasks are stored elsewhere
- `summary` (string, optional)
- `riskLevel` (string, optional: `low` | `medium` | `high`)
- `impactLevel` (string, optional)
- `rationale` (string, optional; prefer on envelope for AI events)

### `assignment`

Output of Team Builder AI or human override.

**payload:**

- `taskId` (string, required)
- `personId` (string, required)
- `person` (object, optional) — snapshot of the assignee at assignment time:
  - `id` (string)
  - `name` (string)
  - `department` (string)
  - `team` (string)
  - `role` (string)
- `rationale` (string, optional)

### `schedule_proposed`

Output of Scheduler AI.

**payload:**

- `taskId` (string, required)
- `proposedStart` (ISO 8601, required)
- `proposedEnd` (ISO 8601, required)
- `rationale` (string, optional)

### `execution`

Human execution update (replaces manual status reports).

**payload:**

- `taskId` (string, required)
- `status` (string: `in_progress` | `done` | `blocked`, required)
- `outcome` (string, optional)
- `notes` (string, optional)

### `decision`

Human judgment (approve, reject, reprioritize, kill project).

**payload:**

- `decisionType` (string, required: e.g. `approve` | `reject` | `reprioritize` | `kill_project`)
- `targetId` (string, optional)
- `reason` (string, optional)
- `newPriority` (string, optional)

---

## Stored event envelope

What gets persisted (append-only log):

- `id`, `type`, `timestamp`, `projectId`, `source`, `payload`
- `correlationId` (optional), `rationale` (optional)

Project AI and leadership views read from this log (and from materialized project state for speed).

---

## Project State model

Project state is **owned by Project AI** and updated **only by applying events**. Every field should be derivable from the event stream (or snapshot + subsequent events).

### Structure (one object per project)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Project id |
| `title` | string | From initial request or decision |
| `department` | string | Owning department (from request or project catalog) |
| `team` | string | Owning team |
| `sponsor` | string | Project sponsor or owner |
| `status` | enum | `active` \| `completed` \| `killed` (from `decision` events) |
| `progress` | object | See below |
| `risk` | object | See below |
| `blockers` | array | See below |
| `dependencies` | array | See below |
| `lastUpdatedAt` | string (ISO 8601) | Timestamp of last event applied |
| `lastEventId` | string | Id of last applied event (replay and debugging) |

### progress

- `tasks` (array): each task `{ id, title?, assigneeId?, status?, scheduledStart?, scheduledEnd? }`
- Optional: `percentComplete` or counts (derived from tasks)

### risk

- `level` (string): `low` \| `medium` \| `high`
- `reasons` (array of string): from rationale or events

### blockers

- Array of `{ taskId, description, raisedAt }` — from execution events (e.g. status `blocked` + notes)

### dependencies

- Array of `{ fromTaskId, toTaskId }` — task ordering from plan or later events

---

## Invariants

- State is **never** edited directly; only **event handlers** (in Project AI / model layer) compute new state from previous state + next event.
- All AI-generated state (e.g. risk level) must be traceable to an event that contains a `rationale`.

More event types (e.g. `blocker_raised`, `dependency_added`) can be added later without breaking the envelope.
