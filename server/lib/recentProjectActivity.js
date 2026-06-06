/**
 * Which events appear under "What changed recently" on project cards.
 */

const RECENT_CORE_TYPES = new Set(['execution', 'decision', 'unassignment']);

const RECENT_AI_EVENT_TYPES = new Set(['plan_created', 'assignment', 'schedule_proposed']);

const AI_AGENT_SOURCES = new Set([
  'orchestrator',
  'team_builder',
  'scheduler',
  'project_ai',
  'org_ai',
  'system',
]);

/** Sources merged from agentActivityLog (not always in event log). */
const AGENT_ACTIVITY_SOURCES = new Set([
  'orchestrator',
  'team_builder',
  'scheduler',
  'org_ai',
  'project_ai',
]);

function isRecentProjectActivityEvent(event) {
  if (!event || !event.type) return false;
  if (RECENT_CORE_TYPES.has(event.type)) return true;
  if (event.type === 'need') return true;
  if (RECENT_AI_EVENT_TYPES.has(event.type) && AI_AGENT_SOURCES.has(event.source)) {
    return true;
  }
  if (event.type === 'agent_activity' && AGENT_ACTIVITY_SOURCES.has(event.source)) {
    return true;
  }
  return false;
}

function agentActivityEntryToEvent(entry) {
  if (!entry?.message) return null;
  return {
    id: entry.id || `al-${entry.timestamp}`,
    type: 'agent_activity',
    timestamp: entry.timestamp,
    projectId: entry.projectId,
    source: entry.source || 'org_ai',
    rationale: entry.message,
    payload: {},
  };
}

/**
 * Merge event-log rows with agent activity for leadership recent-changes feed.
 */
function buildRecentProjectActivityFeed(eventLog, agentEntries, { limit = 300 } = {}) {
  const fromLog = (eventLog || []).filter(isRecentProjectActivityEvent);

  const seenActivity = new Set();
  for (const e of fromLog) {
    if (e.type === 'decision' && e.source === 'project_ai') {
      const key = `${e.projectId}:${(e.rationale || '').slice(0, 80)}`;
      seenActivity.add(key);
    }
  }

  const fromActivity = [];
  for (const entry of agentEntries || []) {
    if (!entry.projectId) continue;
    if (!AGENT_ACTIVITY_SOURCES.has(entry.source)) continue;
    const synthetic = agentActivityEntryToEvent(entry);
    if (!synthetic || !isRecentProjectActivityEvent(synthetic)) continue;
    if (entry.source === 'project_ai') {
      const key = `${entry.projectId}:${(entry.message || '').slice(0, 80)}`;
      if (seenActivity.has(key)) continue;
    }
    fromActivity.push(synthetic);
  }

  const merged = [...fromLog, ...fromActivity];
  merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return merged.slice(0, Math.min(Math.max(limit, 1), 500));
}

module.exports = {
  isRecentProjectActivityEvent,
  agentActivityEntryToEvent,
  buildRecentProjectActivityFeed,
  AI_AGENT_SOURCES,
};
