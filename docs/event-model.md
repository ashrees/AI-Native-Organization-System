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
