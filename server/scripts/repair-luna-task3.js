#!/usr/bin/env node
/**
 * One-time repair: restore Luna Lovegood on task-3 (proj-ai-builders) and apply Team Lead role.
 * Usage: node server/scripts/repair-luna-task3.js
 */

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const PROJECT_ID = 'proj-ai-builders';
const TASK_ID = 'task-3';
const LUNA_ID = 'person-10';
const GEORGE_ID = 'person-9';
const NEW_ROLE = 'Team Lead';

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const store = eventsRouter.getStore();
  const people = eventsRouter.loadPeople();
  const luna = people.find((p) => p.id === LUNA_ID);
  const george = people.find((p) => p.id === GEORGE_ID);
  const state = store.projects[PROJECT_ID];
  const task = state?.progress?.tasks?.find((t) => t.id === TASK_ID);

  if (!luna) {
    console.error('Luna Lovegood (person-10) not found.');
    process.exit(1);
  }
  if (!task) {
    console.error(`Task ${TASK_ID} not found on ${PROJECT_ID}.`);
    process.exit(1);
  }

  const currentAssignee = task.assigneeId || task.assignee?.id;
  console.log(`Before: task-3 assignee=${currentAssignee} (${task.assignee?.name || 'none'}), Luna role=${luna.role}`);

  const repairId = crypto.randomUUID();
  const postgresStore = require('../store/postgresStore');

  if (currentAssignee === GEORGE_ID) {
    await eventsRouter.emitEvent({
      id: crypto.randomUUID(),
      type: 'unassignment',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: repairId,
      rationale: 'Repair: restore Luna Lovegood after incorrect role_change unassignment',
      payload: {
        taskId: TASK_ID,
        personId: GEORGE_ID,
        reason: 'Incorrect role_change side effect — reassigned to Luna Lovegood',
      },
    });
    await postgresStore.decrementPersonLoad(GEORGE_ID);
    console.log(`Unassigned George Weasley from ${TASK_ID}`);
  }

  await eventsRouter.emitEvent({
    id: crypto.randomUUID(),
    type: 'assignment',
    timestamp: new Date().toISOString(),
    projectId: PROJECT_ID,
    source: 'system',
    correlationId: repairId,
    rationale: 'Repair: Luna Lovegood restored to evaluation task after approved Team Lead request',
    payload: {
      taskId: TASK_ID,
      personId: LUNA_ID,
      person: {
        id: luna.id,
        name: luna.name,
        department: luna.department,
        team: luna.team,
        role: NEW_ROLE,
      },
    },
  });

  if (currentAssignee !== LUNA_ID) {
    await postgresStore.incrementPersonLoad(LUNA_ID);
  }

  await postgresStore.upsertPerson({ ...luna, role: NEW_ROLE });
  await eventsRouter.refreshPeopleCache();
  await eventsRouter.recomputePeopleLoadFromProjects();

  await eventsRouter.emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: PROJECT_ID,
    source: 'system',
    correlationId: repairId,
    rationale: `Repair complete: ${luna.name} restored to "${task.title}" with role "${NEW_ROLE}"`,
    payload: {
      decisionType: 'role_change_approved',
      personId: LUNA_ID,
      personName: luna.name,
      previousRole: luna.role,
      newRole: NEW_ROLE,
      repair: true,
      taskId: TASK_ID,
    },
  });

  const after = eventsRouter.getStore().projects[PROJECT_ID]?.progress?.tasks?.find((t) => t.id === TASK_ID);
  const lunaAfter = eventsRouter.loadPeople().find((p) => p.id === LUNA_ID);
  console.log(`After: task-3 assignee=${after?.assigneeId} (${after?.assignee?.name}), Luna role=${lunaAfter?.role}, load=${lunaAfter?.currentLoad}`);
  console.log('Repair done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
