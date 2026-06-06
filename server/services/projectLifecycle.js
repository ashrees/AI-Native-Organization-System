/**
 * Leadership project lifecycle actions (event-sourced via decision events).
 */

const LIFECYCLE_ACTIONS = Object.freeze({
  complete: {
    decisionType: 'complete',
    label: 'Mark completed',
    allowedStatuses: ['active'],
  },
  kill: {
    decisionType: 'kill_project',
    label: 'Kill project',
    allowedStatuses: ['active'],
  },
  archive: {
    decisionType: 'archive_project',
    label: 'Archive',
    allowedStatuses: ['completed', 'killed'],
    requiresNotArchived: true,
  },
  unarchive: {
    decisionType: 'unarchive_project',
    label: 'Restore from archive',
    requiresArchived: true,
  },
  reactivate: {
    decisionType: 'reactivate_project',
    label: 'Reopen project',
    allowedStatuses: ['completed'],
    requiresNotArchived: true,
  },
});

function randomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getLifecycleActionsForProject(project) {
  const status = project?.status || 'active';
  const archived = Boolean(project?.archived);
  const out = [];
  for (const [action, spec] of Object.entries(LIFECYCLE_ACTIONS)) {
    if (spec.requiresArchived && !archived) continue;
    if (spec.requiresNotArchived && archived) continue;
    if (spec.allowedStatuses && !spec.allowedStatuses.includes(status)) continue;
    out.push({ action, label: spec.label, decisionType: spec.decisionType });
  }
  return out;
}

function validateLifecycleAction(project, action) {
  const spec = LIFECYCLE_ACTIONS[action];
  if (!spec) return { ok: false, error: `Unknown lifecycle action: ${action}` };
  if (!project) return { ok: false, error: 'Project not found' };
  const status = project.status || 'active';
  const archived = Boolean(project.archived);
  if (spec.requiresArchived && !archived) {
    return { ok: false, error: 'Project is not archived' };
  }
  if (spec.requiresNotArchived && archived) {
    return { ok: false, error: 'Project is archived; unarchive first' };
  }
  if (spec.allowedStatuses && !spec.allowedStatuses.includes(status)) {
    return {
      ok: false,
      error: `Cannot ${action} a project with status "${status}"`,
    };
  }
  return { ok: true, spec };
}

function buildLifecycleDecisionEvent(projectId, action, { reason, personId } = {}) {
  const spec = LIFECYCLE_ACTIONS[action];
  const timestamp = new Date().toISOString();
  const rationale =
    reason?.trim() ||
    (personId ? `Lifecycle ${action} by ${personId}` : `Project lifecycle: ${action}`);
  return {
    id: randomUUID(),
    type: 'decision',
    timestamp,
    projectId,
    source: 'human',
    rationale,
    payload: {
      decisionType: spec.decisionType,
      reason: reason?.trim() || undefined,
      lifecycleAction: action,
    },
  };
}

/**
 * Filter project list for GET /projects query params.
 * phase: active | closed | archived | all
 * status: active | completed | killed
 * archived: true | false
 */
function filterProjectsForQuery(projects, query = {}) {
  let list = Array.isArray(projects) ? [...projects] : [];
  const phase = query.phase;
  const status = query.status;
  const archived = query.archived;

  if (phase === 'active') {
    list = list.filter((p) => (p.status || 'active') === 'active' && !p.archived);
  } else if (phase === 'closed') {
    list = list.filter(
      (p) =>
        (p.status === 'completed' || p.status === 'killed') && !p.archived
    );
  } else if (phase === 'archived') {
    list = list.filter((p) => Boolean(p.archived));
  }

  if (status && ['active', 'completed', 'killed'].includes(status)) {
    list = list.filter((p) => (p.status || 'active') === status);
  }
  if (archived === 'true') list = list.filter((p) => Boolean(p.archived));
  if (archived === 'false') list = list.filter((p) => !p.archived);

  return list;
}

function summarizeProjectTasks(project) {
  const tasks = project?.progress?.tasks || [];
  const counts = { total: tasks.length, done: 0, in_progress: 0, blocked: 0, pending: 0 };
  for (const t of tasks) {
    const s = t.status || 'pending';
    if (s === 'done') counts.done += 1;
    else if (s === 'in_progress') counts.in_progress += 1;
    else if (s === 'blocked') counts.blocked += 1;
    else counts.pending += 1;
  }
  return counts;
}

module.exports = {
  LIFECYCLE_ACTIONS,
  getLifecycleActionsForProject,
  validateLifecycleAction,
  buildLifecycleDecisionEvent,
  filterProjectsForQuery,
  summarizeProjectTasks,
};
