# Design Principles

Design principles for the AI-Native Organization System. These guide every feature and implementation.

---

## 1. AI owns information flow

- **Classification** — AI categorizes incoming requests and signals.
- **Routing** — AI directs work to the right people and projects.
- **Summarization** — AI produces concise, actionable summaries.
- **State updates** — AI maintains project truth from events; no manual status reporting.

## 2. Humans own judgment

- **Approvals** — Humans approve plans, assignments, or schedule changes when required.
- **Overrides** — Humans can override any AI suggestion with a reason.
- **Ethical decisions** — Only humans make ethical or policy decisions.
- **Project kill / reprioritization** — Starting, stopping, or reprioritizing work is a human decision.

## 3. Event-driven architecture

- **Everything is an event** — Requests, assignments, execution updates, and decisions are all events.
- **No manual status reporting** — State is derived from the event stream.
- **Single source of truth** — The event log is authoritative; project state is materialized from it.

## 4. Meeting-minimized by design

- **Meetings exist only for judgment** — When a decision is needed, humans meet (or decide async).
- **AI converts decisions into state** — Once a decision is made, it is recorded as an event and becomes persistent system state.
- **No status meetings** — Leadership gets clarity from the system, not from recurring syncs.

## 5. Transparency and traceability

- **Every AI decision includes rationale** — Assignments, schedules, and risk levels must explain "why."
- **All state is explainable from events** — Any field in project state can be traced back to specific events.
- **No silent changes** — Data is never mutated without an event that justifies it.

## 6. Minimal surface area

- **Simple UI** — Only what leadership and doers need; no dashboards for the sake of dashboards.
- **No unnecessary integrations** — Add Slack, Jira, or calendars only when they clearly serve the loop.
- **No overengineering** — Prefer clarity and explicitness over abstraction in the MVP.

## 7. Workforce signals, not surveillance

- **Workforce analytics** (productivity, reliability, engagement, health indexes) are **explainable operational signals** derived from tasks, events, and requests — not hidden scores of human worth.
- Leadership uses them for coordination (overload, stagnation, at-risk bands), not automated HR decisions.
- Help chat and the Workforce tab expose the same underlying metrics for questions like “who is overloaded?” or “which department is struggling?”

---

_If a feature breaks the core loop or violates these principles, it should not be implemented._
