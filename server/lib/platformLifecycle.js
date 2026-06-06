/**
 * Process lifecycle — readiness, graceful shutdown hooks.
 */

const { pool } = require('../db');

let storeReady = false;
let shuttingDown = false;
const shutdownHooks = [];

function setStoreReady(ready) {
  storeReady = !!ready;
}

function isStoreReady() {
  return storeReady;
}

function isShuttingDown() {
  return shuttingDown;
}

function onShutdown(fn) {
  if (typeof fn === 'function') shutdownHooks.push(fn);
}

async function pingDatabase() {
  if (!pool) return { ok: false, reason: 'no_pool' };
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function buildHealthPayload() {
  const db = await pingDatabase();
  const ready = storeReady && db.ok && !shuttingDown;
  return {
    status: ready ? 'ok' : shuttingDown ? 'shutting_down' : db.ok ? 'starting' : 'degraded',
    service: 'ai-native-org',
    store: 'postgres',
    storeReady,
    database: db.ok ? 'up' : 'down',
    databaseError: db.ok ? undefined : db.reason,
    shuttingDown,
    uptimeSec: Math.round(process.uptime()),
  };
}

async function runGracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} — draining (${shutdownHooks.length} hooks)…`);

  for (const hook of shutdownHooks) {
    try {
      await Promise.race([
        Promise.resolve(hook()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('shutdown hook timeout')), 15000)
        ),
      ]);
    } catch (err) {
      console.warn('[Shutdown] hook failed:', err.message);
    }
  }

  if (pool) {
    try {
      await pool.end();
      console.log('[Shutdown] Postgres pool closed.');
    } catch (err) {
      console.warn('[Shutdown] pool.end failed:', err.message);
    }
  }

  console.log('[Shutdown] complete.');
  process.exit(0);
}

function registerSignalHandlers() {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      runGracefulShutdown(sig).catch((err) => {
        console.error('[Shutdown] fatal:', err);
        process.exit(1);
      });
    });
  }
}

module.exports = {
  setStoreReady,
  isStoreReady,
  isShuttingDown,
  onShutdown,
  pingDatabase,
  buildHealthPayload,
  registerSignalHandlers,
};
