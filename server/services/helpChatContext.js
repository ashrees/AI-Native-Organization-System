/**
 * Full org snapshot for Leadership Help Chat — all projects, people, events, requests.
 */

const { buildAllProjectMetrics } = require('./metrics');
const { buildWorkforceAnalytics } = require('./workforceAnalytics');
const { getProjectSnapshot, getProjectTimeline } = require('./retrieval');
const agentActivityLog = require('../lib/agentActivityLog');

const MAX_EVENT_LIMIT = Math.min(
  Math.max(parseInt(process.env.HELP_CHAT_EVENT_LIMIT || '250', 10) || 250, 50),
  500
);
const MAX_AGENT_ACTIVITY = Math.min(
  Math.max(parseInt(process.env.HELP_CHAT_ACTIVITY_LIMIT || '40', 10) || 40, 10),
  100
);
const RATIONALE_MAX = 500;
const DESC_MAX = 300;

function truncate(str, max) {
  if (str == null) return undefined;
  const s = String(str).trim();
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function compactPayload(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'request':
      return { title: p.title, description: truncate(p.description, DESC_MAX), priority: p.priority };
    case 'plan_created':
      return {
        summary: truncate(p.summary, DESC_MAX),
        riskLevel: p.riskLevel,
        taskCount: Array.isArray(p.tasks) ? p.tasks.length : 0,
      };
    case 'assignment':
      return {
        taskId: p.taskId,
        personId: p.personId,
        personName: p.person?.name,
        assignmentGapFill: p.assignmentGapFill,
      };
    case 'unassignment':
      return { taskId: p.taskId, personId: p.personId, reason: truncate(p.reason, DESC_MAX) };
    case 'schedule_proposed':
      return { taskId: p.taskId, proposedStart: p.proposedStart, proposedEnd: p.proposedEnd };
    case 'execution':
      return {
        taskId: p.taskId,
        status: p.status,
        notes: truncate(p.notes, DESC_MAX),
        personId: p.personId,
        requestAssignment: p.requestAssignment,
      };
    case 'decision':
      return {
        decisionType: p.decisionType,
        reason: truncate(p.reason, DESC_MAX),
        riskLevel: p.riskLevel,
        riskReason: truncate(p.riskReason, DESC_MAX),
        summary: truncate(p.summary, DESC_MAX),
        assignedCount: p.assignedCount,
        taskIds: p.taskIds,
      };
    case 'need':
      return {
        kind: p.kind,
        title: p.title,
        description: truncate(p.description, DESC_MAX),
        status: p.status,
        handlingMode: p.handlingMode,
        personId: p.personId,
        forwardsTo: p.forwardsTo || p.routingLabel,
        forwardTargets: (p.forwardTargets || p.notifyTargets || []).map((t) => ({
          name: t.name,
          role: t.roleLabel || t.role,
          personId: t.personId,
        })),
        forwardRoles: p.forwardRoles,
        aiAgent: p.aiAgent,
        reviewedByName: p.reviewedByName,
        reviewNotes: truncate(p.reviewNotes, DESC_MAX),
        effectsApplied: p.effectsApplied,
      };
    default:
      return p;
  }
}

function compactEvent(e) {
  return {
    id: e.id,
    type: e.type,
    timestamp: e.timestamp,
    projectId: e.projectId,
    source: e.source,
    correlationId: e.correlationId,
    rationale: truncate(e.rationale, RATIONALE_MAX),
    payload: compactPayload(e),
  };
}

function serializePerson(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    department: p.department,
    team: p.team,
    role: p.role,
    currentLoad: p.currentLoad ?? 0,
    availabilityStatus: p.availabilityStatus || 'active',
    availabilityUntil: p.availabilityUntil,
    availabilityReason: p.availabilityReason,
    skills: p.skills,
  };
}

function serializeProject(projectId, state) {
  if (!state) return null;
  const snap = getProjectSnapshot(projectId, { [projectId]: state });
  if (!snap) return null;
  return {
    ...snap,
    needs: Array.isArray(state.needs) ? state.needs : [],
    progress: {
      tasks: (state.progress?.tasks || []).map((t) => ({
        id: t.id,
        title: t.title,
        description: truncate(t.description, DESC_MAX),
        status: t.status || 'pending',
        assigneeId: t.assigneeId,
        assignee: t.assignee,
        assigneeNote: t.assigneeNote,
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
      })),
    },
    lastEventId: state.lastEventId,
  };
}

function allWorkerRequests(events, people) {
  const peopleById = new Map((people || []).map((p) => [p.id, p]));
  return events
    .filter((e) => e.type === 'need' && e.source === 'human')
    .map((e) => {
      const p = e.payload || {};
      const submitter = peopleById.get(p.personId);
      return {
        id: e.id,
        projectId: e.projectId,
        timestamp: e.timestamp,
        kind: p.kind,
        title: p.title || p.kind,
        description: truncate(p.description, DESC_MAX),
        status: p.status || 'open',
        handlingMode: p.handlingMode,
        taskId: p.taskId,
        submitterId: p.personId,
        submitterName: submitter?.name,
        forwardsTo: p.forwardsTo || p.routingLabel,
        forwardTargets: (p.forwardTargets || p.notifyTargets || []).map((t) => ({
          name: t.name,
          role: t.roleLabel || t.role,
          personId: t.personId,
        })),
        forwardRoles: p.forwardRoles,
        roleAssignments: p.roleAssignments,
        primaryReviewerPersonIds: p.primaryReviewerPersonIds,
        aiAgent: p.aiAgent,
        aiHandled: !!p.aiHandled,
        reviewedBy: p.reviewedBy,
        reviewedByName: p.reviewedByName,
        reviewedAt: p.reviewedAt,
        reviewNotes: truncate(p.reviewNotes, DESC_MAX),
        effectsApplied: p.effectsApplied,
        startDate: p.startDate,
        endDate: p.endDate,
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function selectEvents(eventLog, projectId) {
  let list = Array.isArray(eventLog) ? eventLog : [];
  if (projectId) {
    list = list.filter((e) => e.projectId === projectId);
  }
  const sorted = list
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, MAX_EVENT_LIMIT);
  return sorted.map(compactEvent);
}

function compactWorkforceAnalytics(analytics) {
  if (!analytics) return null;
  const workers = (analytics.workers || []).map((w) => ({
    personId: w.personId,
    name: w.name,
    department: w.department,
    team: w.team,
    role: w.role,
    availabilityStatus: w.availabilityStatus,
    statusBand: w.statusBand,
    signals: w.signals,
    indexes: w.indexes,
    metrics: w.metrics,
  }));

  return {
    generatedAt: analytics.generatedAt,
    methodology: analytics.methodology,
    orgBenchmarks: analytics.orgBenchmarks,
    distribution: analytics.distribution,
    departmentSummary: analytics.departmentSummary,
    workers,
    highlights: {
      thriving: workers.filter((w) => w.statusBand === 'thriving').slice(0, 8),
      atRisk: workers.filter((w) => w.statusBand === 'at_risk').slice(0, 8),
      watch: workers.filter((w) => w.statusBand === 'watch').slice(0, 8),
      highestOverall: workers.slice(0, 5).map((w) => ({
        name: w.name,
        overall: w.indexes.overall,
        department: w.department,
      })),
      lowestHealth: [...workers]
        .sort((a, b) => a.indexes.health - b.indexes.health)
        .slice(0, 5)
        .map((w) => ({
          name: w.name,
          health: w.indexes.health,
          signals: w.signals,
        })),
    },
  };
}

/**
 * Build exhaustive (bounded) context for Leadership Help Chat.
 */
function buildFullHelpContext(agent, projectId, store, orgInsights) {
  const { events = [], projects = {}, people = [] } = store;
  const metrics = buildAllProjectMetrics(projects, events);
  const projectIds = Object.keys(projects);

  const allProjects = projectIds.map((id) => serializeProject(id, projects[id])).filter(Boolean);

  const focusProject = projectId ? serializeProject(projectId, projects[projectId]) : null;
  const focusProjectTimeline = projectId
    ? getProjectTimeline(projectId, events, { limit: 100 })
    : null;

  const recentEvents = selectEvents(events, projectId);
  const orgWideEventCount = events.length;

  const workerRequests = allWorkerRequests(events, people);
  const openWorkerRequests = workerRequests.filter((r) =>
    ['open', 'in_review'].includes(r.status)
  );

  const peopleDirectory = (people || []).map(serializePerson);

  const workforce = compactWorkforceAnalytics(
    buildWorkforceAnalytics({ events, projects, people })
  );

  const recentAgentActivity = projectId
    ? [
        ...agentActivityLog.getRecent({ projectId }),
        ...agentActivityLog.getRecent({}).filter((a) => !a.projectId),
      ]
        .slice(0, MAX_AGENT_ACTIVITY)
    : agentActivityLog.getRecent({}).slice(0, MAX_AGENT_ACTIVITY);

  const unassignedTasks = [];
  for (const proj of allProjects) {
    for (const t of proj.progress?.tasks || []) {
      if (t.status === 'done') continue;
      if (!t.assigneeId && !t.assignee?.id) {
        unassignedTasks.push({
          projectId: proj.id,
          projectTitle: proj.title,
          taskId: t.id,
          taskTitle: t.title,
          status: t.status,
        });
      }
    }
  }

  return {
    scope: projectId ? 'project' : 'organization',
    agent,
    projectId: projectId || null,
    generatedAt: new Date().toISOString(),
    dataCoverage: {
      projects: allProjects.length,
      people: peopleDirectory.length,
      eventsIncluded: recentEvents.length,
      eventsTotalInStore: orgWideEventCount,
      workerRequestsTotal: workerRequests.length,
      openWorkerRequests: openWorkerRequests.length,
      workforceWorkers: workforce?.workers?.length ?? 0,
      note: projectId
        ? `Focused on project ${projectId}; org-wide projects and people are still included.`
        : 'Full organization snapshot.',
    },
    metrics: {
      projects: metrics.projects || [],
      org: {
        projectCount: metrics.projects?.length || 0,
        totalTasks: (metrics.projects || []).reduce((n, m) => n + (m.tasks?.total || 0), 0),
        totalBlocked: (metrics.projects || []).reduce((n, m) => n + (m.tasks?.blocked || 0), 0),
        highRiskProjects: (metrics.projects || [])
          .filter((m) => m.risk?.level === 'high')
          .map((m) => m.projectId),
      },
    },
    allProjects,
    focusProject,
    focusProjectTimeline,
    peopleDirectory,
    workerRequests,
    openWorkerRequests,
    unassignedTasks,
    recentEvents,
    recentAgentActivity,
    workforce,
    orgInsights: orgInsights || null,
    agentContext: {
      validProjectIds: projectIds,
      metricsSummary: (metrics.projects || []).map((m) => ({
        projectId: m.projectId,
        title: m.title,
        status: m.status,
        riskLevel: m.risk?.level,
        tasks: m.tasks,
        blockers: m.blockers?.count,
      })),
    },
  };
}

module.exports = {
  buildFullHelpContext,
  compactEvent,
  compactWorkforceAnalytics,
  allWorkerRequests,
};
