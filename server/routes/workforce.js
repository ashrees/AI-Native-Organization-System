/**
 * Leadership workforce analytics — productivity matrix & health scores.
 * GET /workforce/analytics
 */

const express = require('express');
const router = express.Router();
const { buildWorkforceAnalytics } = require('../services/workforceAnalytics');

function loadStore() {
  try {
    const eventsRouter = require('./events');
    const store = typeof eventsRouter.getStore === 'function' ? eventsRouter.getStore() : null;
    const people =
      typeof eventsRouter.loadPeople === 'function' ? eventsRouter.loadPeople() : [];
    if (store && Array.isArray(store.eventLog)) {
      return { events: store.eventLog, projects: store.projects || {}, people };
    }
  } catch (err) {
    console.error('workforce: failed to load store', err.message);
  }
  return { events: [], projects: {}, people: [] };
}

router.get('/analytics', (_req, res) => {
  const analytics = buildWorkforceAnalytics(loadStore());
  res.json(analytics);
});

module.exports = router;
