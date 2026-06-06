/**
 * Operations monitor API — agent uptime, human activity, kanban-style work boards.
 */

const express = require('express');
const { buildOpsMonitorSnapshot } = require('../services/opsMonitor');

const router = express.Router();

function buildCtx() {
  const eventsRouter = require('./events');
  return {
    getStore: eventsRouter.getStore,
    getEventLog: eventsRouter.getEventLog,
    loadPeople: eventsRouter.loadPeople,
  };
}

/**
 * GET /monitor — full ops snapshot for Operations Monitor app (monitor/).
 */
router.get('/monitor', async (req, res) => {
  try {
    const snapshot = await buildOpsMonitorSnapshot(buildCtx());
    res.json(snapshot);
  } catch (err) {
    console.error('GET /monitor error:', err);
    res.status(500).json({ error: 'Failed to build monitor snapshot' });
  }
});

module.exports = router;
