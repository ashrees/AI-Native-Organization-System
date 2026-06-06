#!/usr/bin/env node
/**
 * Repair colliding worker-request review task on Build Financial AI:
 * HR (Hermione) and engineering_mgmt (Draco) shared wr-person-* id; Draco overwrote HR assignee.
 *
 * Usage: node server/scripts/repair-draco-review-task.js
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
const NEED_ID = 'dfcf7049-83f7-4c53-a3e7-2e9bb04d0a5d';
const COLLIDING_TASK_ID = 'wr-person-dfcf7049';
const DRACO_ID = 'person-12';
const HERMIONE_ID = 'person-5';
const NEVILLE_ID = 'person-11';

const { buildReviewTaskId } = require('../lib/reviewTaskIds');

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const store = eventsRouter.getStore();
  const people = eventsRouter.loadPeople();
  const emitEvent = eventsRouter.emitEvent;
  const state = store.projects[PROJECT_ID];
  const task = state?.progress?.tasks?.find((t) => t.id === COLLIDING_TASK_ID);
  const needEv = eventsRouter.getEventLog().find((e) => e.id === NEED_ID && e.type === 'need');

  if (!task) {
    console.log(`No colliding task ${COLLIDING_TASK_ID} on ${PROJECT_ID}; nothing to repair.`);
    process.exit(0);
  }

  const assignee = task.assigneeId || task.assignee?.id;
  console.log(`Before: ${COLLIDING_TASK_ID} assignee=${assignee} (${task.assignee?.name}) status=${task.status}`);

  const needStub = needEv || { id: NEED_ID, projectId: PROJECT_ID, payload: { kind: 'role_change' } };
  const hrTaskId = buildReviewTaskId(needStub, 'hr');
  const engTaskId = buildReviewTaskId(needStub, 'engineering_mgmt');

  if (assignee === DRACO_ID) {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'unassignment',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: Draco Malfoy on leave — release colliding review task',
      payload: {
        taskId: COLLIDING_TASK_ID,
        personId: DRACO_ID,
        reason: 'Incorrect assignee (task id collision); reviewer on leave',
      },
    });
  }

  const hermione = people.find((p) => p.id === HERMIONE_ID);
  const neville = people.find((p) => p.id === NEVILLE_ID);

  if (hrTaskId !== COLLIDING_TASK_ID) {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'plan_created',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: separate HR review task id',
      payload: {
        tasks: [
          {
            id: hrTaskId,
            title: '[Human Resources] Review worker request: Request to change role to Team Lead',
            description: 'HR review (repaired task id)',
          },
        ],
        summary: 'HR review task (repair)',
      },
    });
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: assign HR review to Hermione Granger',
      payload: {
        taskId: hrTaskId,
        personId: HERMIONE_ID,
        person: {
          id: hermione.id,
          name: hermione.name,
          department: hermione.department,
          team: hermione.team,
          role: hermione.role,
        },
      },
    });
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'execution',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: HR review completed (request already approved)',
      payload: { taskId: hrTaskId, status: 'done', notes: 'Repair: request approved by HR' },
    });
  } else {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: assign HR review to Hermione Granger',
      payload: {
        taskId: COLLIDING_TASK_ID,
        personId: HERMIONE_ID,
        person: {
          id: hermione.id,
          name: hermione.name,
          department: hermione.department,
          team: hermione.team,
          role: hermione.role,
        },
      },
    });
    if (task.status !== 'done') {
      await emitEvent({
        id: crypto.randomUUID(),
        type: 'execution',
        timestamp: new Date().toISOString(),
        projectId: PROJECT_ID,
        source: 'system',
        correlationId: NEED_ID,
        rationale: 'Repair: mark HR review done',
        payload: { taskId: COLLIDING_TASK_ID, status: 'done', notes: 'Repair: request approved' },
      });
    }
  }

  if (engTaskId !== COLLIDING_TASK_ID && engTaskId !== hrTaskId) {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'plan_created',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: separate engineering_mgmt review task',
      payload: {
        tasks: [
          {
            id: engTaskId,
            title:
              '[Engineering management] Review worker request: Request to change role to Team Lead',
            description: 'Engineering review (repaired task id)',
          },
        ],
        summary: 'Engineering mgmt review (repair)',
      },
    });
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: assign engineering review to Neville Longbottom',
      payload: {
        taskId: engTaskId,
        personId: NEVILLE_ID,
        person: {
          id: neville.id,
          name: neville.name,
          department: neville.department,
          team: neville.team,
          role: neville.role,
        },
      },
    });
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'execution',
      timestamp: new Date().toISOString(),
      projectId: PROJECT_ID,
      source: 'system',
      correlationId: NEED_ID,
      rationale: 'Repair: engineering review completed',
      payload: { taskId: engTaskId, status: 'done', notes: 'Repair: request already approved' },
    });
  }

  if (typeof eventsRouter.recomputePeopleLoadFromProjects === 'function') {
    await eventsRouter.recomputePeopleLoadFromProjects();
  }

  const after = eventsRouter.getStore().projects[PROJECT_ID];
  const dracoTasks = (after?.progress?.tasks || []).filter(
    (t) => (t.assigneeId || t.assignee?.id) === DRACO_ID
  );
  console.log(
    `After: Draco assigned tasks on project: ${dracoTasks.map((t) => `${t.id} (${t.status})`).join(', ') || 'none'}`
  );
  console.log('Repair complete. Restart API or refresh worker portal as Draco.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
