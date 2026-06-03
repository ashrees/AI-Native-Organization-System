# Worker Portal

Standalone frontend for **human workers** — separate from `client/` (Leadership View).

Workers sign in by name, manage assigned tasks, submit HR/ops requests, and (with the right role) review inbox items or authorize emergency return.

Full system documentation: [README.md](../README.md) · Worker API: [API reference](../README.md#worker-portal-worker-and-apiworker)

---

## Run locally

```bash
# Terminal 1 — API (from repo root)
npm start

# Terminal 2 — Worker Portal
cd worker && npm run dev
# or from root: npm run dev:worker
```

Open **http://localhost:5174** — sign in by name.

Vite proxies `/api/*` to `http://localhost:3000` (see `vite.config.js`).

---

## Tabs

| Tab | Purpose |
|-----|---------|
| **Overview** | Summary cards: open assignments, active projects, open requests; up-next task previews (status updates on **Tasks**) |
| **Tasks** | Filter and update assigned work: `in_progress`, `done`, `blocked` |
| **Requests** | Submit sick leave, vacation, workload, blockers, etc. (routing preview per kind) |
| **HR** | HR role only — inbox, approve/reject, emergency return |
| **Reviews** | Project lead / engineering mgmt — project-scoped request reviews |

---

## Build & deploy

```bash
cd worker
VITE_API_URL=https://your-api.example.com \
VITE_LEADERSHIP_URL=https://leadership.example.com \
npm run build
```

Deploy `dist/` to any static host. CORS must allow the Worker origin on the API.

---

## Environment (build time)

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `VITE_API_URL` | `/api` (proxied) | API base URL |
| `VITE_LEADERSHIP_URL` | `http://localhost:5173` | Link back to Leadership View |

---

## Demo logins

Use names from `GET /worker/people` (seeded demo roster), e.g.:

- **Sam Lee** — regular contributor with assigned tasks  
- **Hermione Granger** — HR (`person-5`) for inbox and emergency return  
- **Draco Malfoy** — example leave / emergency-return flows  

---

## API routes (shared server)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/worker/people` | Directory for login |
| `GET` | `/worker/dashboard` | Overview data (`?personId=`) |
| `GET` | `/worker/meta` | Request kinds and routing |
| `POST` | `/worker/status` | Update own task status |
| `POST` | `/worker/requests` | Submit request |
| `PATCH` | `/worker/requests/:id` | Reviewer updates status |
| `GET` | `/worker/hr/inbox` | HR queue |
| `GET` | `/worker/project/inbox` | Project reviews |
| `POST` | `/worker/hr/emergency-activate` | HR emergency work authorization |
| `POST` | `/worker/hr/emergency-end` | End emergency session |

Also available under `/api/worker/…` when using the Vite proxy.
