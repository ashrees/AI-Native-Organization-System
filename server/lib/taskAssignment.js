/**
 * Task assign / reassign — always release the previous assignee before assigning someone new.
 */

const crypto = require('crypto');
const { findTask } = require('../models/projectState');
const { buildAssigneeSnapshot } = require('./projectMemberRoles');

function taskAssigneeId(task) {
  if (!task) return null;
  const aid = task.assigneeId ?? task.assignee?.id;
  if (aid == null || String(aid).trim() === '') return null;
  return String(aid).trim();
}

function taskIsAssigned(task) {
  return taskAssigneeId(task) != null;
}

/**
 * Emit unassignment and decrement load for the person leaving the task.
 */
async function releaseTaskAssignee(ctx, {
  projectId,
  taskId,
  previousPersonId,
  correlationId,
  rationale,
  source = 'system',
  reason,
}) {
  if (!previousPersonId || !taskId) return false;

  const { emitEvent, decrementPersonLoad, getStore } = ctx;
  if (!emitEvent) return false;

  const state = getStore?.()?.projects?.[projectId];
  const task = state ? findTask(state, taskId) : null;
  if (task?.status === 'done') return false;

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'unassignment',
    timestamp: new Date().toISOString(),
    projectId,
    source,
    correlationId,
    rationale:
      rationale ||
      `Released previous assignee from task ${taskId}.`,
    payload: {
      taskId,
      personId: previousPersonId,
      reason: reason || 'reassigned',
    },
  });

  if (typeof decrementPersonLoad === 'function') {
    await decrementPersonLoad(previousPersonId);
  }

  return true;
}

/**
 * Assign a task to a person; unassigns the previous holder when different.
 */
async function assignTaskToPerson(ctx, {
  projectId,
  task,
  personId,
  person,
  correlationId,
  rationale,
  source = 'team_builder',
  payloadExtra,
}) {
  if (!task?.id || !personId || !ctx?.emitEvent) {
    return { assigned: false, reason: 'missing_task_or_person' };
  }

  const { emitEvent, getStore, incrementPersonLoad } = ctx;
  const state = getStore?.()?.projects?.[projectId];
  const taskInState = state ? findTask(state, task.id) : null;
  const previousId = taskAssigneeId(taskInState || task);

  if (previousId && previousId !== personId) {
    await releaseTaskAssignee(ctx, {
      projectId,
      taskId: task.id,
      previousPersonId: previousId,
      correlationId,
      source,
      rationale: `Reassigning ${task.title || task.id}: removing ${previousId}.`,
      reason: payloadExtra?.reassignReason || 'reassigned',
    });
  }

  let assigneeSnapshot = person;
  if (!assigneeSnapshot || typeof assigneeSnapshot !== 'object') {
    const roster = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
    let people = roster;
    if (people && typeof people.then === 'function') people = await people;
    const rosterPerson = Array.isArray(people)
      ? people.find((p) => p.id === personId)
      : null;
    assigneeSnapshot = buildAssigneeSnapshot(rosterPerson, state) || undefined;
  }

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'assignment',
    timestamp: new Date().toISOString(),
    projectId,
    source,
    correlationId,
    rationale,
    payload: {
      taskId: task.id,
      personId,
      person: assigneeSnapshot,
      ...(payloadExtra || {}),
    },
  });

  if (previousId !== personId && typeof incrementPersonLoad === 'function') {
    await incrementPersonLoad(personId);
  }

  return {
    assigned: true,
    previousPersonId: previousId,
    personId,
    assignee: assigneeSnapshot,
  };
}

module.exports = {
  taskAssigneeId,
  taskIsAssigned,
  releaseTaskAssignee,
  assignTaskToPerson,
};
