/**
 * Side effects when a worker request is approved — update people, tasks, and projects.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { resolveForwardTargets } = require('../constants/requestRouting');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const { personCanWork } = require('./emergencyReturn');

const LEAVE_KINDS = new Set(['sick_leave', 'vacation']);
const PROJECT_REMOVAL_KINDS = new Set([
  'project_contribution_change',
  'project_transfer',
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

/**
 * When a reviewer goes on leave, release their wr-* review tasks and reassign open needs if possible.
 */
async function releaseReviewTasksAssignedToReviewer(personId, correlationId, ctx) {
  const { getStore, emitEvent, loadPeople } = ctx;
  const people = loadPeople();
  const eventLog = getStore().eventLog || [];
  const projects = getStore().projects || {};
  for (const [projectId, state] of Object.entries(projects)) {
    for (const task of state?.progress?.tasks || []) {
      if (taskAssigneeId(task) !== personId) continue;
      if (!String(task.id || '').startsWith('wr-')) continue;

      const assignmentEv = [...eventLog]
        .reverse()
        .find(
          (e) =>
            e.type === 'assignment' &&
            e.projectId === projectId &&
            e.payload?.taskId === task.id &&
            e.payload?.personId === personId
        );
      const needId = assignmentEv?.correlationId;
      const needEvent = needId
        ? eventLog.find((e) => e.id === needId && e.type === 'need')
        : null;
      const needOpen =
        needEvent && ['open', 'in_review'].includes(needEvent.payload?.status || 'open');

      await emitUnassignment(ctx, {
        projectId,
        taskId: task.id,
        personId,
        correlationId: correlationId || needId,
        reason: 'Reviewer on leave — review task released',
      });

      if (task.status !== 'done') {
        await emitEvent({
          id: crypto.randomUUID(),
          type: 'execution',
          timestamp: new Date().toISOString(),
          projectId,
          source: 'system',
          correlationId: needId || correlationId,
          rationale: `Reviewer ${personId} on leave — review task closed`,
          payload: {
            taskId: task.id,
            status: 'done',
            notes: 'Closed: assigned reviewer on leave',
          },
        });
      }

      if (!needOpen || !needEvent) continue;

      const kind = needEvent.payload?.kind;
      const submitterId = needEvent.payload?.personId;
      const targets = resolveForwardTargets(
        kind,
        projectId,
        projects,
        people,
        submitterId
      ).filter((t) => t.personId && t.personId !== personId);

      for (const target of targets) {
        const assignee = people.find((p) => p.id === target.personId);
        if (!assignee || !personCanWork(assignee)) continue;
        const already = (needEvent.payload?.roleAssignments || []).some(
          (a) => a.role === target.role && a.assigneeId === assignee.id
        );
        if (already) continue;

        const reviewTitle = `Review worker request: ${needEvent.payload?.title || kind}`;
        const reviewDesc = needEvent.payload?.description || reviewTitle;
        const submitter = people.find((p) => p.id === submitterId);
        const { createReviewTask } = require('./workerRequestHandler');
        const result = await createReviewTask(
          needEvent,
          ctx,
          assignee,
          `[${target.roleLabel}] ${reviewTitle}`,
          reviewDesc,
          submitter?.name || submitterId,
          target.roleLabel,
          target.role
        );
        needEvent.payload.roleAssignments = [
          ...(needEvent.payload?.roleAssignments || []).filter(
            (a) => a.role !== target.role
          ),
          {
            ...result,
            role: target.role,
            agent: target.agent,
            assigneeName: assignee.name,
          },
        ];
        agentActivityLog.push({
          source: 'org_ai',
          projectId,
          message: `Reassigned ${target.roleLabel} review to ${assignee.name} after previous reviewer went on leave.`,
        });
      }
    }
  }
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

function inferRequestedRole(title, description) {
  const text = `${title || ''}\n${description || ''}`;
  const patterns = [
    /(?:change|changing)\s+(?:my\s+)?role\s+to\s+(.+)/i,
    /(?:role|position|title)\s+(?:to|as|:)\s+([^.\n]+)/i,
    /(?:promote|promotion)\s+(?:to|as)\s+(.+)/i,
    /(?:become|becoming)\s+(?:a|an)?\s*(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim().slice(0, 120);
  }
  return null;
}

async function applyRoleChangeEffects(needEvent, reviewer, ctx) {
  const personId = needEvent.payload?.personId;
  const title = needEvent.payload?.title || 'role_change';
  const projectId = needEvent.projectId;
  const { loadPeople, refreshPeopleCache, emitEvent, getStore } = ctx;
  const postgresStore = require('../store/postgresStore');
  const { matchEssentialRoleByTitle, isLeadershipJobTitle } = require('../lib/projectMemberRoles');
  const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');

  const person = loadPeople().find((p) => p.id === personId);
  if (!person) return { personId, updated: false };

  const requestedRole =
    needEvent.payload?.requestedRole ||
    inferRequestedRole(title, needEvent.payload?.description);
  const previousRole = person.role;
  const essential = matchEssentialRoleByTitle(requestedRole);
  const onProject = projectId && projectId !== ORG_GENERAL_PROJECT_ID;

  if (essential) {
    if (!onProject) {
      const msg = `${person.name}: "${essential.label}" is a project role assigned by the orchestrator, not a global job title.`;
      needEvent.payload.effectsError = msg;
      return { personId, skipped: 'essential_role_project_scoped', error: msg };
    }

    const state = getStore().projects[projectId];
    if (!state || state.status !== 'active') {
      return { personId, skipped: 'project_not_active' };
    }

    const roleEntry = {
      roleId: essential.id,
      label: essential.label,
      personId: person.id,
      name: person.name,
      department: person.department,
      team: person.team,
      jobTitle: isLeadershipJobTitle(person.role) ? 'Individual Contributor' : person.role,
    };

    await emitEvent({
      id: crypto.randomUUID(),
      type: 'decision',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'system',
      correlationId: needEvent.id,
      rationale: `${person.name} assigned as ${essential.label} on this project only (not org-wide).`,
      payload: {
        decisionType: 'project_roles_assigned',
        roles: { [essential.id]: roleEntry },
        fromWorkerRequest: true,
        needId: needEvent.id,
      },
    });

    const summary = `${person.name} is ${essential.label} on ${projectId} (project-local; directory job title unchanged).`;
    agentActivityLog.push({ source: 'orchestrator', projectId, message: summary });

    return {
      personId,
      personName: person.name,
      projectRoleId: essential.id,
      projectRoleLabel: essential.label,
      projectScoped: true,
      updated: true,
    };
  }

  let updatedPerson = person;
  if (requestedRole && requestedRole !== previousRole && !isLeadershipJobTitle(requestedRole)) {
    updatedPerson = { ...person, role: requestedRole };
    await postgresStore.upsertPerson(updatedPerson);
    if (typeof refreshPeopleCache === 'function') await refreshPeopleCache();
  } else if (requestedRole && isLeadershipJobTitle(requestedRole)) {
    const msg = `"${requestedRole}" is a project leadership role; use orchestrator setup or a project-scoped request.`;
    needEvent.payload.effectsError = msg;
    return { personId, skipped: 'leadership_not_global', error: msg };
  }

  const summary = requestedRole
    ? `${person.name}'s job title updated to "${requestedRole}" (was "${previousRole || 'unset'}").`
    : `${person.name}'s role change approved.`;

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: needEvent.projectId,
    source: 'system',
    correlationId: needEvent.id,
    rationale: summary,
    payload: {
      decisionType: 'role_change_approved',
      personId,
      personName: person.name,
      previousRole,
      newRole: requestedRole || previousRole,
      title,
      scope: 'directory_job_title',
    },
  });

  agentActivityLog.push({
    source: 'org_ai',
    projectId: needEvent.projectId,
    message: summary,
  });

  return {
    personId,
    personName: person.name,
    previousRole,
    newRole: requestedRole || previousRole,
    updated: !!requestedRole && requestedRole !== previousRole,
  };
}

/**
 * Apply org-wide updates after HR/leadership approves a worker request.
 */
async function applyApprovedRequestEffects(needEvent, reviewer, ctx) {
  const {
    isTeamMemberRequest,
    applyTeamMemberEffects,
    teamMemberEffectsComplete,
    requiresResolvedTarget,
  } = require('./workerRequestTeamMember');

  const kind = needEvent.payload?.kind;
  const personId = needEvent.payload?.personId;
  const projectId = needEvent.projectId;
  const title = needEvent.payload?.title || kind;
  const { loadPeople } = ctx;
  const person = personId ? loadPeople().find((p) => p.id === personId) : null;
  const effects = {
    kind,
    personId: personId || null,
    personName: person?.name,
    availability: null,
    tasksReleased: [],
    projectsCleared: [],
  };

  const correlationId = needEvent.id;
  const reviewerName = reviewer?.name || 'Reviewer';

  if (isTeamMemberRequest(needEvent) && !teamMemberEffectsComplete(needEvent)) {
    const teamMember = await applyTeamMemberEffects(needEvent, reviewer, ctx);
    if (teamMember) effects.teamMember = teamMember;
    if (requiresResolvedTarget(needEvent) && teamMember?.skipped === 'target_person_not_found') {
      needEvent.payload.effectsError = teamMember.error;
    }
  }

  if (!personId) {
    needEvent.payload.effectsApplied = {
      at: new Date().toISOString(),
      ...effects,
      taskCount: effects.tasksReleased.length,
    };
    if (!effects.teamMember) {
      const { applyStaffingAndCapacityEffects } = require('./workerRequestStaffing');
      const staffing = await applyStaffingAndCapacityEffects(needEvent, reviewer, ctx);
      if (staffing) effects.staffing = staffing;
      needEvent.payload.effectsApplied = {
        ...needEvent.payload.effectsApplied,
        staffing: effects.staffing,
      };
    }
    if (typeof ctx.recomputePeopleLoad === 'function') await ctx.recomputePeopleLoad();
    return effects;
  }

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
    await releaseReviewTasksAssignedToReviewer(personId, correlationId, ctx);

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

  if (kind === 'role_change') {
    effects.roleChange = await applyRoleChangeEffects(needEvent, reviewer, ctx);
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
    } else if (kind === 'project_transfer') {
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

  const { applyStaffingAndCapacityEffects } = require('./workerRequestStaffing');
  const staffing = await applyStaffingAndCapacityEffects(needEvent, reviewer, ctx);
  if (staffing) effects.staffing = staffing;

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
  applyRoleChangeEffects,
  recordLeaveProjectNotices,
  releasePersonFromProject,
  releasePersonFromAllProjects,
  setPersonAvailability,
  clearPersonAvailability: require('../lib/personAvailability').clearPersonAvailability,
  findProjectsWithPerson,
  inferRequestedRole,
  LEAVE_KINDS,
  PROJECT_REMOVAL_KINDS,
};
