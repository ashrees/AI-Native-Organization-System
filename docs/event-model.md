# Event model and Project State

Source of truth for event schema and project state. Server `models/` implement these definitions.

---

## Base Event schema

Events are the single source of truth. Every state change comes from an event.

### Required fields (every event)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (UUID) | Unique; idempotency and reference |
| `type` | enum | Drives routing and apply logic |
| `timestamp` | ISO 8601 | Ordering and audit |
| `projectId` | string | Which project this belongs to |
| `source` | enum | Who/what produced the event |
| `payload` | object | Type-specific body (see below) |

### Event type enum

- `request`
- `plan_created`
- `assignment`
- `unassignment`
- `schedule_proposed`
- `execution`
- `decision`
- `need`

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
| `rationale` | string | Explains "why" (required for AI-generated events in practice) |

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

- `tasks` (array of `{ id, title?, description?, requiredDepartments? }`, required)
- `summary` (string, optional)
- `riskLevel` (`low` | `medium` | `high`, optional)
- `impactLevel` (optional)

Orchestrator may also emit related `need` events for plan dependencies.

### `assignment`

Output of Team Builder AI or human override.

**payload:**

- `taskId` (string, required)
- `personId` (string, required)
- `person` (object, optional) — assignee snapshot: `id`, `name`, `department`, `team`, `role`
- `assignmentGapFill` (boolean, optional) — targeted fill without full replan

### `unassignment`

Removes assignee (e.g. leave approval, transfer).

**payload:**

- `taskId` (string, required)
- `personId` (string, optional)
- `reason` (string, optional)

### `schedule_proposed`

Output of Scheduler AI.

**payload:**

- `taskId` (string, required)
- `proposedStart` (ISO 8601, required)
- `proposedEnd` (ISO 8601, required)
- `projectAIDelegated` (boolean, optional)

### `execution`

Human execution update.

**payload:**

- `taskId` (string, required)
- `status` (`in_progress` | `done` | `blocked`, required)
- `personId` (string, optional) — worker who updated (Worker Portal)
- `notes` (string, optional)
- `requestAssignment` (boolean, optional) — triggers assignment gap fill

**Side effects:**

- `blocked` → blocker recorded; may trigger replan
- `in_progress` / `done` → blocker for task cleared
- Triggers **Project AI** status check (debounced)

### `decision`

Human or AI judgment.

**payload (common `decisionType` values):**

| decisionType | Source | Effect |
|--------------|--------|--------|
| `kill_project` / `kill` | human | `status = killed`; assignees cleared |
| `complete` / `completed` | human | `status = completed` |
| `project_assessment` | project_ai | Updates `risk`; may complete project if all tasks done |
| `assignment_gap_fill` | system | Audit summary after gap-fill run |
| `reprioritize` | human | May trigger replan |
| `emergency_active` / `emergency_return_end` | system | Person availability |
| `worker_request_*` | system | Request lifecycle audit |

**project_assessment** additionally includes:

- `riskLevel`, `riskReason`, `summary`, `recentChanges`
- `suggestProjectCompleted` (boolean)
- `agentActions` (array) — planned delegations to other agents

### `need`

Worker or AI-recorded requirement.

**payload:**

- `kind` (string, required)
- `description` (string, required)
- `title` (string, optional)
- `taskId` (string, optional)
- `status` (`open` | `in_review` | `approved` | `rejected` | `met` | `cancelled`, optional)
- `personId`, `handlingMode`, routing fields — worker request envelope

Human `need` events (`source: human`) are worker requests. Persisted to the `needs` table for querying.

---

## Stored event envelope

Append-only log:

- `id`, `type`, `timestamp`, `projectId`, `source`, `payload`
- `correlationId` (optional), `rationale` (optional)

Leadership views and AI agents read from this log and from materialized project state.

---

## Project State model

Updated **only by applying events** (`server/models/projectState.js`).

### Structure (one object per project)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Project id |
| `title` | string | From request or plan |
| `department`, `team`, `sponsor` | string | Org metadata |
| `status` | enum | `active` \| `completed` \| `killed` |
| `progress` | object | `{ tasks: [...] }` |
| `risk` | object | `{ level, reasons[] }` |
| `blockers` | array | `{ taskId, description, raisedAt }` |
| `dependencies` | array | Task ordering |
| `needs` | array | Open/resolved needs on project |
| `lastUpdatedAt`, `lastEventId` | string | Replay / debugging |

### progress.tasks

Each task may include:

- `id`, `title`, `description`, `status`
- `assigneeId`, `assignee` (snapshot)
- `scheduledStart`, `scheduledEnd`

### Invariants

- State is never edited directly; only `applyEvent` / `applyEvents`.
- AI agents cannot create new projects (project must exist from human/system first).
- AI-generated risk and assessments trace to `decision` or `plan_created` events with rationale.

---

## AI agent rules

| Agent | May emit |
|-------|----------|
| orchestrator | `plan_created`, `need` |
| team_builder | `assignment` |
| scheduler | `schedule_proposed` |
| project_ai | `decision` (`project_assessment`), `need` (via delegation) |
| system | `request` (replan), `decision` (gap fill, emergency) |
| human | any type including `request`, `execution`, `decision`, `need` |

See [orchestration-loop.md](orchestration-loop.md) and [architecture.md](architecture.md).
