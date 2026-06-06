/**
 * Leadership workforce analytics & hiring.
 * GET /workforce/analytics
 * POST /workforce/people/generate-mock
 * POST /workforce/people/hire
 * POST /workforce/people/hire-for-requirements
 */

const express = require('express');
const router = express.Router();
const { buildWorkforceAnalytics } = require('../services/workforceAnalytics');
const {
  normalizePersonInput,
  hireEmployee,
  previewMockEmployee,
  hireFromRequirements,
} = require('../services/hiringService');
const { PROFILES } = require('../lib/mockEmployeeGenerator');

function loadEventsRouter() {
  return require('./events');
}

function loadStore() {
  try {
    const eventsRouter = loadEventsRouter();
    const store = typeof eventsRouter.getStore === 'function' ? eventsRouter.getStore() : null;
    const people =
      typeof eventsRouter.loadPeople === 'function' ? eventsRouter.loadPeople() : [];
    if (store && Array.isArray(store.eventLog)) {
      return { eventsRouter, events: store.eventLog, projects: store.projects || {}, people };
    }
  } catch (err) {
    console.error('workforce: failed to load store', err.message);
  }
  return { eventsRouter: null, events: [], projects: {}, people: [] };
}

function buildHireCtx(eventsRouter) {
  if (!eventsRouter) return {};
  return {
    emitEvent: eventsRouter.emitEvent,
    getStore: eventsRouter.getStore,
    refreshPeopleCache: eventsRouter.refreshPeopleCache,
    recomputePeopleLoad: eventsRouter.recomputePeopleLoadFromProjects,
  };
}

router.get('/analytics', (_req, res) => {
  const analytics = buildWorkforceAnalytics(loadStore());
  res.json(analytics);
});

router.get('/hire-profiles', (_req, res) => {
  res.json({
    profiles: PROFILES.map((p) => ({
      id: p.id,
      department: p.department,
      teams: p.teams,
      roles: p.roles,
      skills: p.skills,
    })),
  });
});

/** POST /workforce/people/generate-mock — preview random employee (not saved) */
router.post('/people/generate-mock', async (req, res) => {
  try {
    const generated = await previewMockEmployee({
      ...req.body,
      matchRequirements: !!req.body?.matchRequirements,
    });
    res.json({
      preview: true,
      person: generated.person,
      matchScore: generated.matchScore,
      profileId: generated.profileId,
      requirements: generated.requirements,
    });
  } catch (err) {
    console.error('POST /workforce/people/generate-mock error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate employee' });
  }
});

/** POST /workforce/people/hire — leadership/HR hires a person (mock or custom body) */
router.post('/people/hire', async (req, res) => {
  try {
    const { eventsRouter } = loadStore();
    const normalized = normalizePersonInput(req.body);
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    const result = await hireEmployee(normalized.person, {
      ...buildHireCtx(eventsRouter),
      hiredBy: req.body?.hiredBy || 'leadership',
      hiredByName: req.body?.hiredByName || 'Leadership',
      source: req.body?.source || 'human',
      projectId: req.body?.projectId || null,
      correlationId: req.body?.correlationId || null,
      requirements: req.body?.requirements || null,
    });

    if (result.error) {
      const status = result.code === 'duplicate_id' || result.code === 'duplicate_name' ? 409 : 400;
      return res.status(status).json({ error: result.error });
    }

    res.status(201).json(result);
  } catch (err) {
    console.error('POST /workforce/people/hire error:', err);
    res.status(500).json({ error: err.message || 'Hire failed' });
  }
});

/** POST /workforce/people/hire-for-requirements — generate + hire matching requirements (AI/HR) */
router.post('/people/hire-for-requirements', async (req, res) => {
  try {
    const { eventsRouter } = loadStore();
    const {
      title,
      description,
      requirements,
      projectId,
      department,
      team,
      role,
      skills,
      profileId,
      source,
    } = req.body || {};

    const hasRequirementsText = !!(title || description || requirements);
    const hasStructured =
      !!(department || team || role || profileId || (Array.isArray(skills) && skills.length > 0));

    if (!hasRequirementsText && !hasStructured) {
      return res.status(400).json({
        error: 'Provide requirements text, a profile, or department/team/role/skills',
      });
    }

    const result = await hireFromRequirements(
      {
        title,
        description,
        requirements,
        department,
        team,
        role,
        skills,
        profileId,
        projectId,
      },
      {
        ...buildHireCtx(eventsRouter),
        source: source || 'ai',
        hiredBy: req.body?.hiredBy || 'org_ai',
        hiredByName: req.body?.hiredByName || 'Org AI',
        projectId: projectId || null,
        correlationId: req.body?.correlationId || null,
      }
    );

    if (result.error) return res.status(400).json({ error: result.error });

    res.status(201).json(result);
  } catch (err) {
    console.error('POST /workforce/people/hire-for-requirements error:', err);
    res.status(500).json({ error: err.message || 'Hire for requirements failed' });
  }
});

module.exports = router;
