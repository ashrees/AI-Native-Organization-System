/**
 * Targeted Team Builder pass for unassigned tasks (no full Orchestrator replan).
 * Triggered when leadership requests assignment on human execution events.
 */

const crypto = require('crypto');
const teamBuilderAI = require('./teamBuilderAI');
const schedulerAI = require('./schedulerAI');
const { buildAgentContext } = require('./retrieval');
const { assignTaskToPerson, taskAssigneeId } = require('../lib/taskAssignment');
const { buildAllProjectMetrics } = require('./metrics');
const { createEmptyState, findTask } = require('../models/projectState');

const AGENT_STEP_RETRIES = Math.max(0, parseInt(process.env.AGENT_STEP_RETRIES || '3', 10));
const AGENT_STEP_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.AGENT_STEP_RETRY_DELAY_MS || '1500', 10));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskIsUnassigned(task) {
  return taskAssigneeId(task) == null;
}

function isInternalReviewTask(task) {
  const id = String(task?.id || '');
  const title = String(task?.title || '').toLowerCase();
  return id.startsWith('wr-') || title.includes('review worker request');
}

function assigneeIsUnavailable(task, peopleById) {
  const aid = taskAssigneeId(task);
  if (!aid) return false;
  const person = peopleById.get(aid);
  const status = person?.availabilityStatus || 'active';
  return status !== 'active' && status !== 'emergency_active';
}

function taskNeedsActiveAssignee(task, peopleById) {
  if (task.status === 'done') return false;
  if (isInternalReviewTask(task)) return false;
  if (taskIsUnassigned(task)) return true;
  return assigneeIsUnavailable(task, peopleById);
}

function listUnassignedTasks(projectState, people = []) {
  const peopleById = new Map((people || []).map((p) => [p.id, p]));
  return (projectState?.progress?.tasks || []).filter((t) =>
    taskNeedsActiveAssignee(t, peopleById)
  );
}

/**
 * Whether a leadership execution should run assignment gap fill.
 */
function shouldRequestAssignmentGapFill(event, projectState) {
  if (!event || event.type !== 'execution' || event.source !== 'human') return false;
  if (event.payload?.requestAssignment === true) return true;

  const taskId = event.payload?.taskId;
  const status = event.payload?.status;
  if (taskId && status === 'in_progress') {
    const task = findTask(projectState, taskId);
    if (task && taskIsUnassigned(task)) return true;
  }

  const notes = String(event.payload?.notes || '').toLowerCase();
  if (notes && /\b(assign|unassigned|reassign|asap)\b/.test(notes)) return true;

  return false;
}

async function assignOneTask(projectId, task, correlationId, assignedInRun, ctx) {
  const { getStore, loadPeople, agentLogMessage } = ctx;
  const people = loadPeople();
  const store = getStore();
  const projectStateCurrent = store.projects[projectId] || createEmptyState(projectId);
  const metricsStore = {
    eventLog: store.eventLog,
    projects: store.projects,
    people,
    metrics: buildAllProjectMetrics(store.projects, store.eventLog),
  };
  const teamBuilderContext = buildAgentContext(
    'team_builder',
    projectId,
    { currentTask: task, assignmentGapFill: true },
    metricsStore
  );

  let assignResult = null;
  for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
    assignResult = await teamBuilderAI.assignTask(task, people, projectStateCurrent, {
      assignedInRun,
      agentContext: teamBuilderContext,
    });
    const needRetry =
      assignResult._usedStub &&
      assignResult._failReason === 'timed_out_or_no_response' &&
      attempt <= AGENT_STEP_RETRIES;
    if (!needRetry) break;
    await delay(AGENT_STEP_RETRY_DELAY_MS);
  }

  let personId = assignResult?.personId;
  let rationale = assignResult?.rationale;

  const activePeople = teamBuilderAI.peopleAvailableForAssignment(people);
  if (!personId && activePeople?.length > 0) {
    const fallback = teamBuilderAI.stubAssign(task, activePeople, projectStateCurrent, {
      assignedInRun,
      agentContext: teamBuilderContext,
    });
    if (fallback.personId) {
      personId = fallback.personId;
      rationale = fallback.rationale;
    }
  }

  if (!personId) {
    console.warn(`[Assignment gap fill] No assignee for task ${task.id}`);
    return null;
  }

  assignedInRun[personId] = (assignedInRun[personId] || 0) + 1;
  const person = people.find((p) => p.id === personId) || null;
  const projectStateForSnapshot = getStore().projects[projectId] || projectStateCurrent;
  const { buildAssigneeSnapshot } = require('../lib/projectMemberRoles');
  const assigneeSnapshot = buildAssigneeSnapshot(person, projectStateForSnapshot);

  const result = await assignTaskToPerson(ctx, {
    projectId,
    task,
    personId,
    person: assigneeSnapshot,
    correlationId,
    rationale: agentLogMessage(rationale) || `Assigned for unassigned work (${task.title || task.id}).`,
    source: 'team_builder',
    payloadExtra: { assignmentGapFill: true },
  });

  if (!result.assigned) return null;

  return {
    ...task,
    assigneeId: personId,
    assignee: assigneeSnapshot || undefined,
  };
}

/**
 * Assign all unassigned non-done tasks on a project; schedule newly assigned tasks.
 * @param {string} projectId
 * @param {object} triggerEvent - human execution that triggered the fill
 * @param {object} ctx - { emitEvent, getStore, loadPeople, incrementPersonLoad, agentLogMessage }
 */
async function fillAssignmentGaps(projectId, triggerEvent, ctx) {
  const { emitEvent, getStore, agentLogMessage } = ctx;
  const store = getStore();
  const projectState = store.projects[projectId];
  if (!projectState || projectState.status !== 'active') {
    return { assigned: 0, skipped: 'project_not_active' };
  }

  const unassigned = listUnassignedTasks(projectState);
  if (unassigned.length === 0) {
    return { assigned: 0, skipped: 'none_unassigned' };
  }

  console.log(
    `[Assignment gap fill] Project ${projectId}: ${unassigned.length} unassigned task(s) after execution ${triggerEvent?.id || ''}`
  );

  const correlationId = triggerEvent?.id;
  const assignedInRun = {};
  const tasksWithAssignees = [];

  for (const task of unassigned) {
    if (getStore().projects[projectId]?.status === 'killed') break;
    const updated = await assignOneTask(projectId, task, correlationId, assignedInRun, ctx);
    if (updated) tasksWithAssignees.push(updated);
  }

  if (tasksWithAssignees.length > 0) {
    const schedulerContext = buildAgentContext(
      'scheduler',
      projectId,
      { tasks: tasksWithAssignees, assignmentGapFill: true },
      {
        eventLog: getStore().eventLog,
        projects: getStore().projects,
        people: ctx.loadPeople(),
        metrics: buildAllProjectMetrics(getStore().projects, getStore().eventLog),
      }
    );

    let scheduleResult = null;
    for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
      scheduleResult = await schedulerAI.proposeSchedule(tasksWithAssignees, {
        agentContext: schedulerContext,
      });
      const needRetry =
        scheduleResult._usedStub &&
        scheduleResult._failReason === 'timed_out_or_no_response' &&
        attempt <= AGENT_STEP_RETRIES;
      if (!needRetry) break;
      await delay(AGENT_STEP_RETRY_DELAY_MS);
    }

    for (const prop of scheduleResult?.proposals || []) {
      await emitEvent({
        id: crypto.randomUUID(),
        type: 'schedule_proposed',
        timestamp: new Date().toISOString(),
        projectId,
        source: 'scheduler',
        correlationId,
        rationale: agentLogMessage(prop.rationale) || undefined,
        payload: {
          taskId: prop.taskId,
          proposedStart: prop.proposedStart,
          proposedEnd: prop.proposedEnd,
        },
      });
    }
  }

  const assignedIds = tasksWithAssignees.map((t) => t.id);
  const summary =
    assignedIds.length > 0
      ? `Assignment gap fill: Team Builder assigned ${assignedIds.length} unassigned task(s).`
      : `Assignment gap fill: no assignees found for ${unassigned.length} unassigned task(s).`;

  if (assignedIds.length === 0 && unassigned.length > 0) {
    try {
      const { emitHrHiringNeedForStaffingGap } = require('./hiringNeedHandler');
      await emitHrHiringNeedForStaffingGap(
        projectId,
        {
          unassignedCount: unassigned.length,
          taskTitles: unassigned.slice(0, 5).map((t) => t.title || t.id),
          triggerEventId: triggerEvent?.id,
          description: summary,
        },
        ctx
      );
    } catch (err) {
      console.warn('[Assignment gap fill] HR hiring need skipped:', err.message);
    }
  }

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId,
    rationale: agentLogMessage(summary) || summary,
    payload: {
      decisionType: 'assignment_gap_fill',
      assignedCount: assignedIds.length,
      taskIds: assignedIds,
      triggerExecutionId: triggerEvent?.id,
    },
  });

  return { assigned: assignedIds.length, taskIds: assignedIds };
}

function scheduleAssignmentGapFill(projectId, triggerEvent, ctx) {
  fillAssignmentGaps(projectId, triggerEvent, ctx).catch((err) => {
    console.error('[Assignment gap fill] error:', err.message);
  });
}

module.exports = {
  shouldRequestAssignmentGapFill,
  fillAssignmentGaps,
  scheduleAssignmentGapFill,
  listUnassignedTasks,
  taskIsUnassigned,
  assignOneTask,
};
