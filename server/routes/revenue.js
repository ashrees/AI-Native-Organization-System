/**
 * Revenue / project budget API.
 * GET  /revenue/analytics
 * POST /revenue/projects/:id/budget
 * POST /revenue/projects/:id/burn
 * POST /revenue/projects/:id/budget-request
 * POST /revenue/budget-requests/:needId/approve
 */

const express = require('express');
const router = express.Router();
const {
  buildRevenueAnalytics,
  setProjectBudget,
  recordBudgetBurn,
  requestAdditionalBudget,
  approveBudgetRequest,
  loadStoreFromEventsRouter,
} = require('../services/financeService');

function financeCtx() {
  const eventsRouter = require('./events');
  return {
    getStore: eventsRouter.getStore,
    getEventLog: eventsRouter.getEventLog,
    emitEvent: eventsRouter.emitEvent,
    updateWorkerRequest: eventsRouter.updateWorkerRequest,
    loadPeople: eventsRouter.loadPeople,
  };
}

router.get('/analytics', (_req, res) => {
  try {
    const store = loadStoreFromEventsRouter();
    res.json(buildRevenueAnalytics(store));
  } catch (err) {
    console.error('GET /revenue/analytics error:', err);
    res.status(500).json({ error: err.message || 'Failed to load revenue analytics' });
  }
});

router.post('/projects/:id/budget', async (req, res) => {
  try {
    const result = await setProjectBudget(req.params.id, req.body || {}, financeCtx());
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /revenue/projects/:id/budget error:', err);
    res.status(500).json({ error: err.message || 'Failed to set budget' });
  }
});

router.post('/projects/:id/burn', async (req, res) => {
  try {
    const result = await recordBudgetBurn(req.params.id, req.body || {}, financeCtx());
    if (result.error) {
      const status = result.code === 'over_budget' ? 409 : 400;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /revenue/projects/:id/burn error:', err);
    res.status(500).json({ error: err.message || 'Failed to record burn' });
  }
});

router.post('/projects/:id/budget-request', async (req, res) => {
  try {
    const result = await requestAdditionalBudget(req.params.id, req.body || {}, financeCtx());
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /revenue/projects/:id/budget-request error:', err);
    res.status(500).json({ error: err.message || 'Failed to request budget' });
  }
});

router.post('/budget-requests/:needId/approve', async (req, res) => {
  try {
    const result = await approveBudgetRequest(req.params.needId, req.body || {}, financeCtx());
    if (result.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /revenue/budget-requests/:needId/approve error:', err);
    res.status(500).json({ error: err.message || 'Failed to approve budget' });
  }
});

module.exports = router;
