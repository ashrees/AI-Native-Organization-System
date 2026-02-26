# Event Model Specification

## Why Events?

Events create:

- **Traceability**
- **Replayability**
- **AI-friendly inputs**

---

## Base Event Structure

```json
{
    "id": "uuid",
    "type": "employee_update | customer_issue",
    "source": "employee | customer",
    "timestamp": "ISO-8601",
    "payload": {},
    "projectId": "optional"
}
```

---

## Employee Update Event

```json
{
    "type": "employee_update",
    "payload": {
        "employeeId": "string",
        "updateType": "task_update | availability_change | note",
        "content": "text"
    }
}
```

**AI Actions:**

- Update project state
- Detect blockers
- Notify affected stakeholders

---

## Customer Issue Event

```json
{
    "type": "customer_issue",
    "payload": {
        "customerId": "string",
        "message": "text"
    }
}
```

**AI Actions:**

- Classify issue
- Assign severity
- Route to project
- Escalate if repeated

---

# 📄 Demo Walkthrough Script (`docs/demo-script.md`)

## Scenario Overview

Demonstrate how AI replaces meetings by owning information flow.

---

### Step 1: Employee Update

An employee submits a task update.

**AI Response:**

- Processes update
- Updates project progress
- Flags potential delay

_No status meeting required._

---

### Step 2: Customer Issue

A customer reports a critical bug.

**AI Response:**

- Classifies as critical bug
- Routes to Payments Project AI
- Increases project risk level

_No triage meeting required._

---

### Step 3: Leadership View

Leadership opens dashboard and immediately sees:

- Project health
- Customer impact
- Risk escalation

_No status meeting required._

---

### Step 4: Human Decision

Leadership decides whether to:

- Reprioritize
- Allocate more resources
- Pause other work

_AI provides context — humans decide._

---

## Key Message to Audience

> “AI replaces coordination, not people.”