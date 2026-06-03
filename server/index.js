/**
 * Express app entry for AI-Native Organization System.
 * Event intake, orchestration, and API for Leadership View (React client).
 */

const path = require('path');
const dotenv = require('dotenv');

// Load env first so DATABASE_URL is set before any store or DB code runs (required for Neon/Postgres).
dotenv.config({ path: path.join(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it in .env (e.g. DATABASE_URL=postgresql://...).');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const eventsRouter = require('./routes/events');
const workerRouter = require('./routes/worker');
const orgInsightsRouter = require('./routes/orgInsights');
const helpChatRouter = require('./routes/helpChat');
const workforceRouter = require('./routes/workforce');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Event intake and project state (Postgres only)
app.use('/events', eventsRouter);
app.use('/api/events', eventsRouter);

// Human Worker Portal API (separate frontend in worker/)
app.use('/worker', workerRouter);
app.use('/api/worker', workerRouter);

// Org-level metrics and AI insights (same Postgres store)
app.use('/org-insights', orgInsightsRouter);
app.use('/api/org-insights', orgInsightsRouter);

app.use('/help-chat', helpChatRouter);
app.use('/api/help-chat', helpChatRouter);

app.use('/workforce', workforceRouter);
app.use('/api/workforce', workforceRouter);

// Health/debug
const healthPayload = () => ({
  status: 'ok',
  service: 'ai-native-org',
  store: 'postgres',
});
app.get('/health', (req, res) => res.json(healthPayload()));
app.get('/api/health', (req, res) => res.json(healthPayload()));

async function start() {
  if (typeof eventsRouter.initStore === 'function') {
    await eventsRouter.initStore();
    console.log('Store ready (Postgres).');
  }
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
