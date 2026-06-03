# Worker Portal

Standalone frontend for **human workers** — not part of `client/` (Leadership View).

## Run locally

```bash
# API (from repo root)
npm start

# Worker Portal
npm run dev
```

Open http://localhost:5174 — sign in by name, manage tasks, submit HR/ops requests.

## Build & deploy

```bash
VITE_API_URL=https://your-api.example.com npm run build
```

Deploy the `dist/` folder to any static host. Set `VITE_LEADERSHIP_URL` if the leadership app lives on another URL.

## API

All routes are on the shared server under `/worker` (and `/api/worker` in dev via proxy). See the root [README](../README.md#api-reference).
