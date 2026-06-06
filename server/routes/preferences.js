/**
 * User preferences — persisted in Postgres (replaces localStorage for theme/UI settings).
 * GET/PATCH /preferences?personId=
 */

const express = require('express');
const router = express.Router();
const postgresStore = require('../store/postgresStore');

const ALLOWED_KEYS = new Set(['theme', 'lastProjectId', 'helpChatOpen', 'aiHandlerAutomatic']);

router.get('/', async (req, res) => {
  const personId = typeof req.query.personId === 'string' ? req.query.personId.trim() : '';
  if (!personId) {
    return res.status(400).json({ error: 'personId is required' });
  }
  try {
    const preferences = await postgresStore.loadUserPreferences(personId);
    return res.json({ personId, preferences });
  } catch (err) {
    console.error('GET /preferences error:', err);
    return res.status(500).json({ error: 'Failed to load preferences' });
  }
});

router.patch('/', async (req, res) => {
  const personId = typeof req.body?.personId === 'string' ? req.body.personId.trim() : '';
  const updates = req.body?.preferences;
  if (!personId) {
    return res.status(400).json({ error: 'personId is required' });
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'preferences object is required' });
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      await postgresStore.upsertUserPreference(personId, key, value);
    }
    const preferences = await postgresStore.loadUserPreferences(personId);

    if (
      personId === 'leadership' &&
      (updates.aiHandlerAutomatic === true || updates.aiHandlerAutomatic === 'true')
    ) {
      setImmediate(() => {
        try {
          const eventsRouter = require('./events');
          const { processPendingLeadershipNeedsNow } = require('../services/leadershipNeedAutoHandler');
          if (typeof eventsRouter.buildLeadershipAutoCtx === 'function') {
            processPendingLeadershipNeedsNow(eventsRouter.buildLeadershipAutoCtx(), {
              broadcastNeeds: eventsRouter.broadcastNeedsSummary,
            }).catch((err) => console.warn('[AI Handler] Preference trigger failed:', err.message));
          }
        } catch (err) {
          console.warn('[AI Handler] Preference trigger failed:', err.message);
        }
      });
    }

    return res.json({ personId, preferences });
  } catch (err) {
    console.error('PATCH /preferences error:', err);
    return res.status(500).json({ error: 'Failed to save preferences' });
  }
});

module.exports = router;
