/**
 * RAG retrieval helper: assembles bounded, project-aware context from events, state, and metrics
 * so AI agents reason only over concrete data and avoid hallucinating.
 * All functions accept live store data (eventLog, projects, people, metrics) from the caller.
 */

const DEFAULT_EVENT_LIMIT = 20;
const MAX_PEOPLE_STATS = 5;

/**
 * Get the last N events for a project as a compact timeline for LLM context.
 * @param {string} projectId
 * @param {Array<object>} eventLog - full event log
 * @param {{ limit?: number }} [opts] - limit (default 20)
 * @returns {Array<{ type: string, timestamp: string, source: string, summary: string }>}
 */
function getProjectTimeline(projectId, eventLog, opts = {}) {
  const limit = Math.min(Math.max(0, opts.limit || DEFAULT_EVENT_LIMIT), 100);
  if (!projectId || !Array.isArray(eventLog)) return [];

  const filtered = eventLog
    .filter((e) => e.projectId === projectId)
    .slice(-limit);

  return filtered.map((e) => {
    let summary = '';
    if (e.rationale && typeof e.rationale === 'string') {
      summary = e.rationale.slice(0, 200);
    } else if (e.payload) {
      const p = e.payload;
      if (e.type === 'request' && p.title) summary = p.title;
      else if (e.type === 'plan_created' && p.summary) summary = p.summary;
      else if (e.type === 'assignment' && p.taskId) summary = `task ${p.taskId}`;
      else if (e.type === 'schedule_proposed' && p.taskId) summary = `task ${p.taskId}`;
      else if (e.type === 'execution' && p.taskId) summary = `${p.status || ''} task ${p.taskId}`;
      else if (e.type === 'decision' && p.decisionType) summary = p.decisionType;
      else summary = e.type;
    } else {
      summary = e.type || 'event';
    }
    return {
      type: e.type || 'unknown',
      timestamp: e.timestamp || '',
      source: e.source || 'unknown',
      summary: summary.trim() || e.type,
    };
  });
}

/**
 * Get current project state snapshot for a project (tasks, risk, blockers, org metadata).
 * @param {string} projectId
 * @param {object} projectsMap - map of projectId -> project state
 * @returns {object|null} - project state or null if not found
 */
function getProjectSnapshot(projectId, projectsMap) {
  if (!projectId || !projectsMap || typeof projectsMap !== 'object') return null;
  const state = projectsMap[projectId];
  if (!state) return null;
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    department: state.department,
    team: state.team,
    sponsor: state.sponsor,
    risk: state.risk,
    blockers: Array.isArray(state.blockers) ? state.blockers : [],
    dependencies: Array.isArray(state.dependencies) ? state.dependencies : [],
    progress: state.progress
      ? {
          tasks: (state.progress.tasks || []).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            assigneeId: t.assigneeId,
            assignee: t.assignee,
          })),
        }
      : { tasks: [] },
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

/**
 * Get people list plus per-person aggregates from metrics for this project or overall.
 * @param {string|null} projectId - if set, prefer metrics for this project
 * @param {Array<object>} people - full people catalog
 * @param {object} metrics - result of buildAllProjectMetrics(projects, eventLog): { projects: [...] }
 * @returns {{ people: Array<object>, peopleStats: Array<{ personId: string, name: string, department: string, tasksTotal: number, tasksDone: number, tasksBlocked: number }> }}
 */
function getPeopleContext(projectId, people, metrics) {
  const peopleList = Array.isArray(people) ? people : [];
  const peopleStats = [];

  const projectMetrics = (metrics?.projects || []).find((m) => m.projectId === projectId);
  const byPerson = projectMetrics?.people?.byPerson || [];
  const seen = new Set();
  for (const p of byPerson.slice(0, MAX_PEOPLE_STATS * 2)) {
    const id = p.personId || p.name;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    peopleStats.push({
      personId: p.personId,
      name: p.name,
      department: p.department,
      tasksTotal: p.tasksTotal ?? 0,
      tasksDone: p.tasksDone ?? 0,
      tasksBlocked: p.tasksBlocked ?? 0,
    });
  }

  // If no project-specific stats, aggregate from all projects
  if (peopleStats.length === 0 && metrics?.projects) {
    const agg = new Map();
    for (const proj of metrics.projects) {
      for (const p of proj.people?.byPerson || []) {
        const id = p.personId || p.name;
        if (!id) continue;
        if (!agg.has(id)) {
          agg.set(id, {
            personId: p.personId,
            name: p.name,
            department: p.department,
            tasksTotal: 0,
            tasksDone: 0,
            tasksBlocked: 0,
          });
        }
        const e = agg.get(id);
        e.tasksTotal += p.tasksTotal ?? 0;
        e.tasksDone += p.tasksDone ?? 0;
        e.tasksBlocked += p.tasksBlocked ?? 0;
      }
    }
    for (const [id, s] of agg) {
      if (seen.has(id)) continue;
      seen.add(id);
      peopleStats.push(s);
      if (peopleStats.length >= MAX_PEOPLE_STATS * 2) break;
    }
  }

  return { people: peopleList, peopleStats: peopleStats.slice(0, MAX_PEOPLE_STATS * 2) };
}

/**
 * Build a single agentContext object for an agent. Caller must pass live store data.
 * @param {string} agentName - 'orchestrator' | 'team_builder' | 'scheduler' | 'org_ai' | 'project_ai'
 * @param {string|null} projectId
 * @param {object} extra - agent-specific payload (e.g. { request }, { currentTask }, { tasks })
 * @param {{ eventLog: Array<object>, projects: object, people: Array<object>, metrics: object }} store - live data
 * @returns {object} - { projectSnapshot, recentEvents, peopleContext, metricsSummary, extra }
 */
function buildAgentContext(agentName, projectId, extra, store) {
  const { eventLog = [], projects = {}, people = [], metrics = {} } = store || {};

  const recentEvents =
    projectId != null
      ? getProjectTimeline(projectId, eventLog, { limit: DEFAULT_EVENT_LIMIT })
      : [];

  const projectSnapshot = projectId != null ? getProjectSnapshot(projectId, projects) : null;

  const { people: peopleList, peopleStats } = getPeopleContext(projectId, people, metrics);

  const metricsSummary =
    metrics && metrics.projects
      ? {
          projectCount: metrics.projects.length,
          validProjectIds: metrics.projects.map((m) => m.projectId).filter(Boolean),
        }
      : null;

  return {
    projectSnapshot,
    recentEvents,
    peopleContext: {
      peopleCount: peopleList.length,
      peopleStats,
    },
    metricsSummary,
    extra,
  };
}

module.exports = {
  getProjectTimeline,
  getProjectSnapshot,
  getPeopleContext,
  buildAgentContext,
  DEFAULT_EVENT_LIMIT,
};
