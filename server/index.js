/**
 * Express app entry for AI-Native Organization System.
 * Event intake, orchestration, and API for Leadership View (React client).
 */

const path = require('path');
const dotenv = require('dotenv');

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
const revenueRouter = require('./routes/revenue');
const preferencesRouter = require('./routes/preferences');
const opsMonitorRouter = require('./routes/opsMonitor');
const {
  setStoreReady,
  isStoreReady,
  isShuttingDown,
  buildHealthPayload,
  onShutdown,
  registerSignalHandlers,
} = require('./lib/platformLifecycle');
const { notFoundHandler, errorHandler } = require('./lib/apiErrors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (isShuttingDown()) {
    return res.status(503).json({
      error: { code: 'SHUTTING_DOWN', message: 'Server is shutting down' },
    });
  }
  if (isStoreReady()) return next();
  if (req.path === '/health' || req.path === '/api/health') return next();
  res.status(503).json({
    error: { code: 'NOT_READY', message: 'Server is starting up. Retry in a few seconds.' },
    retryAfter: 5,
  });
});

app.use('/events', eventsRouter);
app.use('/api/events', eventsRouter);
app.use('/worker', workerRouter);
app.use('/api/worker', workerRouter);
app.use('/org-insights', orgInsightsRouter);
app.use('/api/org-insights', orgInsightsRouter);
app.use('/help-chat', helpChatRouter);
app.use('/api/help-chat', helpChatRouter);
app.use('/workforce', workforceRouter);
app.use('/api/workforce', workforceRouter);
app.use('/revenue', revenueRouter);
app.use('/api/revenue', revenueRouter);
app.use('/preferences', preferencesRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/ops', opsMonitorRouter);
app.use('/api/ops', opsMonitorRouter);

async function healthHandler(req, res) {
  const payload = await buildHealthPayload();
  const statusCode = payload.status === 'ok' ? 200 : payload.database === 'down' ? 503 : 503;
  res.status(statusCode).json(payload);
}

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use(notFoundHandler);
app.use(errorHandler);

registerSignalHandlers();

onShutdown(async () => {
  setStoreReady(false);
  if (typeof eventsRouter.shutdown === 'function') {
    await eventsRouter.shutdown();
  }
});

async function start() {
  if (typeof eventsRouter.initStore === 'function') {
    try {
      await eventsRouter.initStore();
      setStoreReady(true);
      console.log('Store ready (Postgres).');
    } catch (err) {
      console.error('Store init failed:', err);
      process.exit(1);
    }
  } else {
    setStoreReady(true);
  }

  const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  onShutdown(
    () =>
      new Promise((resolve) => {
        server.close(() => {
          console.log('[Shutdown] HTTP server closed.');
          resolve();
        });
      })
  );
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
