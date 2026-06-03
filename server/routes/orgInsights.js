/**
 * Org insights route: builds deterministic metrics from the event log +
 * project state, then (optionally) asks Org AI to produce structured
 * insights and suggested requests for humans to review.
 *
 * GET /org-insights
 * Response:
 * {
 *   metrics: { projects: [...] },
 *   insights: { projectInsights: [...], peopleInsights: [...] } | null
 * }
 */

const express = require('express');
const router = express.Router();

const { buildAllProjectMetrics } = require('../services/metrics');
const { buildAgentContext } = require('../services/retrieval');
const { readPrompt, complete } = require('../lib/llm');
const agentActivityLog = require('../lib/agentActivityLog');

function toMaxTwoSentences(text) {
  if (text == null || typeof text !== 'string') return '';
  const t = text.trim();
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 2) return t;
  return sentences.slice(0, 2).join(' ');
}

// Org AI insights are computed in the background so the UI never waits on LLM latency.
let latestInsights = null;
let latestInsightsAt = null;
let backgroundRunning = false;

function loadStore() {
  try {
    const eventsRouter = require('./events');
    const store = typeof eventsRouter.getStore === 'function' ? eventsRouter.getStore() : null;
    if (store && Array.isArray(store.eventLog)) {
      return { events: store.eventLog, projects: store.projects || {} };
    }
  } catch (err) {
    console.error('orgInsights: failed to load store', err.message);
  }
  return { events: [], projects: {} };
}

function buildStubInsights(metrics) {
  const seen = new Set();
  const projectInsights = (metrics.projects || []).filter((m) => {
    const id = m?.projectId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((m) => {
    const overloaded =
      m.tasks.blocked > 0 ||
      (m.tasks.in_progress >= 5 && m.timeline.lastEventAgeHours != null && m.timeline.lastEventAgeHours > 24);

    const summaryParts = [];
    summaryParts.push(
      `Total tasks ${m.tasks.total}, in progress ${m.tasks.in_progress}, done ${m.tasks.done}, blocked ${m.tasks.blocked}.`
    );
    if (m.timeline.lastEventAgeHours != null) {
      summaryParts.push(
        `Last change about ${Math.round(m.timeline.lastEventAgeHours)}h ago; completed ${
          m.timeline.completedLast7Days
        } tasks in last 7 days.`
      );
    }
    if (m.blockers.count > 0) {
      summaryParts.push(`There are ${m.blockers.count} recorded blockers.`);
    }

    const suggestedRequests = [];
    if (m.tasks.blocked > 0) {
      suggestedRequests.push({
        kind: 'unblock',
        projectId: m.projectId,
        title: `Unblock work on ${m.title || m.projectId}`,
        rationale:
          'Automatic heuristic: project has blocked tasks; recommend a focused unblock request for a human to review.',
      });
    }

    return {
      projectId: m.projectId,
      status: m.status,
      riskLevel: m.risk.level,
      summary: summaryParts.join(' '),
      suggestedRequests,
    };
  });

  const peopleInsights = [];

  return { projectInsights, peopleInsights };
}

async function computeInsightsOnce() {
  if (backgroundRunning) return;
  backgroundRunning = true;
  try {
    const { events, projects } = loadStore();
    const metrics = buildAllProjectMetrics(projects, events);
    const orgPrompt = readPrompt('orgAI');
    if (!orgPrompt) {
      latestInsights = buildStubInsights(metrics);
      latestInsightsAt = new Date().toISOString();
      agentActivityLog.push({
        source: 'org_ai',
        projectId: null,
        message: 'Stub org insights (no LLM): metrics only.',
      });
      return;
    }

    const agentContext = buildAgentContext('org_ai', null, { metrics, projects }, {
      eventLog: events,
      projects,
      people: [],
      metrics,
    });
    const input = {
      agentContext,
      projects: metrics.projects,
    };
    // LLM receives only agentContext; projectInsights must reference only metrics.projects.
    const result = await complete(orgPrompt, JSON.stringify(input), { timeoutMs: 180000 });
    if (result && typeof result === 'object') {
      const rawProject = Array.isArray(result.projectInsights) ? result.projectInsights : [];
      const validProjectIds = new Set((metrics.projects || []).map((m) => m.projectId));
      const seen = new Set();
      const projectInsights = rawProject.filter((p) => {
        const id = p?.projectId ?? p?.project_id;
        if (!id || !validProjectIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const rawPeople = Array.isArray(result.peopleInsights) ? result.peopleInsights : [];
      latestInsights = { projectInsights, peopleInsights: rawPeople };
      latestInsightsAt = new Date().toISOString();
      agentActivityLog.push({
        source: 'org_ai',
        projectId: null,
        message: toMaxTwoSentences(`Produced org insights for ${projectInsights.length} projects and ${rawPeople.length} people.`),
      });
    } else {
      // Keep last known insights; if none, fall back to stub.
      if (!latestInsights) {
        latestInsights = buildStubInsights(metrics);
        latestInsightsAt = new Date().toISOString();
      }
    }
  } catch (err) {
    console.error('Org AI background insights error:', err.message);
  } finally {
    backgroundRunning = false;
  }
}

// Background loop: refresh insights periodically.
const refreshMs = 30000;
setTimeout(() => {
  computeInsightsOnce();
  setInterval(computeInsightsOnce, refreshMs);
}, 1000);

router.get('/', async (req, res) => {
  const { events, projects } = loadStore();
  const metrics = buildAllProjectMetrics(projects, events);

  const baseInsights = latestInsights || buildStubInsights(metrics);

  // Ensure we never show insights for projects that no longer exist in the store.
  const validProjectIds = new Set((metrics.projects || []).map((m) => m.projectId));
  let filteredInsights = baseInsights;
  if (baseInsights && Array.isArray(baseInsights.projectInsights)) {
    const seen = new Set();
    const projectInsights = baseInsights.projectInsights.filter((p) => {
      const id = p?.projectId ?? p?.project_id;
      if (!id || !validProjectIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    filteredInsights = { ...baseInsights, projectInsights };
  }

  res.json({ metrics, insights: filteredInsights, insightsGeneratedAt: latestInsightsAt });
});

function getLatestInsights() {
  return latestInsights;
}

router.getLatestInsights = getLatestInsights;

module.exports = router;

