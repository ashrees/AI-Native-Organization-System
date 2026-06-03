/**
 * Side effects when a worker request is approved — update people, tasks, and projects.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');

const LEAVE_KINDS = new Set(['sick_leave', 'vacation']);
const PROJECT_REMOVAL_KINDS = new Set([
  'project_contribution_change',
  'project_transfer',
  'role_change',
]);

function taskAssigneeId(task) {
  return task?.assigneeId || task?.assignee?.id || null;
}

function findProjectsWithPerson(personId, projects, { activeTasksOnly = false } = {}) {
  const ids = new Set();
  for (const [projectId, state] of Object.entries(projects || {})) {
    if (projectId === ORG_GENERAL_PROJECT_ID) continue;
    for (const task of state?.progress?.tasks || []) {
      if (taskAssigneeId(task) !== personId) continue;
      if (activeTasksOnly && task.status === 'done') continue;
      ids.add(projectId);
    }
  }
  return [...ids];
}

async function emitLeaveNoticeOnProject(ctx, { projectId, personId, personName, kind, title, correlationId }) {
  const { emitEvent } = ctx;
  const reason = `Approved ${kind}: ${title} — ${personName || personId} removed from project tasks while on leave`;
  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId,
    rationale: reason,
    payload: {
      decisionType: 'member_on_leave',
      personId,
      personName,
      kind,
      title,
    },
  });
  agentActivityLog.push({
    source: 'org_ai',
    projectId,
    message: reason,
  });
}

/** Complete open "Review worker request" tasks tied to this person's needs. */
async function cancelReviewTasksForSubmitter(personId, correlationId, ctx) {
  const { getStore, emitEvent } = ctx;
  const eventLog = getStore().eventLog || [];
  const openNeedIds = new Set(
    eventLog
      .filter(
        (e) =>
          e.type === 'need' &&
          e.source === 'human' &&
          e.payload?.personId === personId &&
          ['open', 'in_review'].includes(e.payload?.status || 'open')
      )
      .map((e) => e.id)
  );

  const taskIds = new Set();
  for (const e of eventLog) {
    if (e.type !== 'assignment' || !openNeedIds.has(e.correlationId)) continue;
    const tid = e.payload?.taskId;
    if (tid) taskIds.add(tid);
  }
  for (const e of eventLog) {
    if (e.type !== 'plan_created' || !openNeedIds.has(e.correlationId)) continue;
    for (const t of e.payload?.tasks || []) {
      if (t?.id) taskIds.add(t.id);
    }
  }

  for (const taskId of taskIds) {
    for (const [projectId, state] of Object.entries(getStore().projects || {})) {
      const task = (state?.progress?.tasks || []).find((t) => t.id === taskId);
      if (!task || task.status === 'done') continue;
      await emitEvent({
        id: crypto.randomUUID(),
        type: 'execution',
        timestamp: new Date().toISOString(),
        projectId,
        source: 'system',
        correlationId,
        rationale: `Submitter on leave — cancelled review task ${taskId}`,
        payload: { taskId, status: 'done', notes: 'Cancelled: submitter on leave' },
      });
    }
  }
}

async function emitUnassignment(ctx, { projectId, taskId, personId, correlationId, reason }) {
  const { emitEvent } = ctx;
  await emitEvent({
    id: crypto.randomUUID(),
    type: 'unassignment',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId,
    rationale: reason,
    payload: { taskId, personId, reason },
  });
}

/**
 * Remove a person from all non-done tasks on one project.
 * @returns {Array<{ projectId, taskId }>}
 */
async function releasePersonFromProject(personId, projectId, correlationId, ctx, reason) {
  const { getStore } = ctx;
  const state = getStore().projects[projectId];
  if (!state) return [];

  const released = [];
  for (const task of state.progress?.tasks || []) {
    if (taskAssigneeId(task) !== personId) continue;
    if (task.status === 'done') continue;
    await emitUnassignment(ctx, {
      projectId,
      taskId: task.id,
      personId,
      correlationId,
      reason,
    });
    released.push({ projectId, taskId: task.id });
  }
  return released;
}

/**
 * Remove a person from every project they are assigned to (active tasks only).
 */
async function releasePersonFromAllProjects(personId, correlationId, ctx, reason) {
  const { getStore } = ctx;
  const allReleased = [];
  for (const projectId of Object.keys(getStore().projects || {})) {
    if (projectId === ORG_GENERAL_PROJECT_ID) continue;
    const batch = await releasePersonFromProject(personId, projectId, correlationId, ctx, reason);
    allReleased.push(...batch);
  }
  return allReleased;
}

const { setPersonAvailability } = require('../lib/personAvailability');

/**
 * Apply org-wide updates after HR/leadership approves a worker request.
 */
async function applyApprovedRequestEffects(needEvent, reviewer, ctx) {
  const kind = needEvent.payload?.kind;
  const personId = needEvent.payload?.personId;
  const projectId = needEvent.projectId;
  const title = needEvent.payload?.title || kind;
  const { loadPeople } = ctx;
  const person = loadPeople().find((p) => p.id === personId);
  const effects = {
    kind,
    personId,
    personName: person?.name,
    availability: null,
    tasksReleased: [],
    projectsCleared: [],
  };

  if (!personId) return effects;

  const correlationId = needEvent.id;
  const reviewerName = reviewer?.name || 'Reviewer';

  if (LEAVE_KINDS.has(kind)) {
    effects.availability = await setPersonAvailability(
      personId,
      {
        status: 'on_leave',
        until: needEvent.payload.endDate || null,
        reason: kind,
        needId: needEvent.id,
      },
      ctx
    );
    const leaveReason = `Approved ${kind}: ${title} — removed from project tasks while on leave`;
    effects.tasksReleased = await releasePersonFromAllProjects(
      personId,
      correlationId,
      ctx,
      leaveReason
    );
    const { projects } = ctx.getStore();
    const affectedProjects = [
      ...new Set([
        ...effects.tasksReleased.map((r) => r.projectId),
        ...findProjectsWithPerson(personId, projects, { activeTasksOnly: false }),
      ]),
    ];
    effects.projectsCleared = affectedProjects;

    for (const pid of affectedProjects) {
      await emitLeaveNoticeOnProject(ctx, {
        projectId: pid,
        personId,
        personName: person?.name,
        kind,
        title,
        correlationId,
      });
    }

    await cancelReviewTasksForSubmitter(personId, correlationId, ctx);

    agentActivityLog.push({
      source: 'org_ai',
      projectId: needEvent.projectId,
      message: `${person?.name || personId} on leave (${kind}). Unassigned from ${effects.tasksReleased.length} task(s); leave recorded on ${affectedProjects.length} project(s). Approved by ${reviewerName}.`,
    });
  }

  if (kind === 'emergency_return') {
    const { activateEmergencyWork } = require('./emergencyReturn');
    const hrPerson = reviewer;
    const result = await activateEmergencyWork(
      personId,
      {
        hrPerson,
        reason: needEvent.payload.description || title,
        projectId: needEvent.payload.emergencyProjectId || (projectId !== ORG_GENERAL_PROJECT_ID ? projectId : null),
        taskId: needEvent.payload.taskId,
        correlationId: needEvent.id,
      },
      ctx
    );
    if (result.error) {
      needEvent.payload.effectsError = result.error;
    } else {
      needEvent.payload.emergencyActivated = true;
      needEvent.payload.emergencyAssignment = result.assignment;
      effects.emergency = result;
    }
  }

  if (PROJECT_REMOVAL_KINDS.has(kind)) {
    const targetProject =
      projectId && projectId !== ORG_GENERAL_PROJECT_ID ? projectId : null;

    if (targetProject) {
      const batch = await releasePersonFromProject(
        personId,
        targetProject,
        correlationId,
        ctx,
        `Approved ${kind}: ${title} — removed from project`
      );
      effects.tasksReleased.push(...batch);
      effects.projectsCleared.push(targetProject);
    } else if (kind === 'project_transfer' || kind === 'role_change') {
      effects.tasksReleased = await releasePersonFromAllProjects(
        personId,
        correlationId,
        ctx,
        `Approved ${kind}: ${title} — removed from all project assignments`
      );
      effects.projectsCleared = [...new Set(effects.tasksReleased.map((r) => r.projectId))];
    }

    if (effects.tasksReleased.length > 0) {
      agentActivityLog.push({
        source: 'orchestrator',
        projectId: targetProject || needEvent.projectId,
        message: `${person?.name || personId} removed from ${effects.tasksReleased.length} task(s) after approved ${kind}. By ${reviewerName}.`,
      });
    }
  }

  if (typeof ctx.recomputePeopleLoad === 'function') {
    await ctx.recomputePeopleLoad();
  }

  needEvent.payload.effectsApplied = {
    at: new Date().toISOString(),
    ...effects,
    taskCount: effects.tasksReleased.length,
    leaveNoticesRecorded: LEAVE_KINDS.has(kind) ? !!effects.projectsCleared?.length : undefined,
  };

  return effects;
}

/** Backfill project-level leave lines for approvals that only unassigned tasks. */
async function recordLeaveProjectNotices(needEvent, ctx) {
  const kind = needEvent.payload?.kind;
  const personId = needEvent.payload?.personId;
  if (!LEAVE_KINDS.has(kind) || !personId) return 0;

  const person = ctx.loadPeople().find((p) => p.id === personId);
  const { projects } = ctx.getStore();
  const affectedProjects = findProjectsWithPerson(personId, projects, { activeTasksOnly: false });
  const title = needEvent.payload?.title || kind;

  for (const pid of affectedProjects) {
    await emitLeaveNoticeOnProject(ctx, {
      projectId: pid,
      personId,
      personName: person?.name,
      kind,
      title,
      correlationId: needEvent.id,
    });
  }

  needEvent.payload.effectsApplied = {
    ...(needEvent.payload.effectsApplied || {}),
    leaveNoticesRecorded: true,
    projectsCleared: affectedProjects,
  };
  return affectedProjects.length;
}

module.exports = {
  applyApprovedRequestEffects,
  recordLeaveProjectNotices,
  releasePersonFromProject,
  releasePersonFromAllProjects,
  setPersonAvailability,
  clearPersonAvailability: require('../lib/personAvailability').clearPersonAvailability,
  findProjectsWithPerson,
  LEAVE_KINDS,
  PROJECT_REMOVAL_KINDS,
};
