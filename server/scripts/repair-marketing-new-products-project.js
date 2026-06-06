#!/usr/bin/env node
/**
 * Repair proj-marketing-tools-sales ("Marketing new coming products"):
 * - Consolidate 40+ spam "Reassign task-*" rows back to 4 core tasks
 * - Fix project department/team metadata
 * - Assign open work to marketing/sales roster
 * - Close duplicate open approval needs
 *
 * Usage: node server/scripts/repair-marketing-new-products-project.js
 */

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const PROJECT_ID = 'proj-marketing-tools-sales';
const REPAIR_ID = crypto.randomUUID();

const CORE_TASKS = [
  {
    id: 'task-1',
    title: 'Create marketing campaign plan for new products',
    status: 'done',
    assigneeId: 'person-4',
    assignee: {
      id: 'person-4',
      name: 'Harry Potter',
      department: 'Marketing',
      team: 'Marketing',
      role: 'Marketing Manager',
    },
  },
  {
    id: 'task-2',
    title: 'Design promotional materials',
    status: 'done',
    assigneeId: 'person-19',
    assignee: {
      id: 'person-19',
      name: 'Avery Taylor',
      department: 'Marketing',
      team: 'Content',
      role: 'Marketing Specialist',
    },
  },
  {
    id: 'task-3',
    title: 'Launch social media campaign',
    status: 'done',
    assigneeId: 'person-18',
    assignee: {
      id: 'person-18',
      name: 'Jesse Martin',
      department: 'Marketing',
      team: 'Content',
      role: 'Marketing Specialist',
    },
  },
  {
    id: 'task-4',
    title: 'Set up sales enablement materials',
    status: 'done',
    assigneeId: 'person-8',
    assignee: {
      id: 'person-8',
      name: 'Fred Weasley',
      department: 'Sales',
      team: 'Sales',
      role: 'Sales Manager',
    },
  },
  {
    id: 'task-5',
    title: 'Submit budget expenses report',
    status: 'pending',
    assigneeId: 'person-8',
    assignee: {
      id: 'person-8',
      name: 'Fred Weasley',
      department: 'Sales',
      team: 'Sales',
      role: 'Sales Manager',
    },
    description: 'Create and submit the project budget expenses report (referenced during sales enablement work).',
  },
];

async function main() {
  const eventsRouter = require('../routes/events');
  const postgresStore = require('../store/postgresStore');
  await eventsRouter.initStore();

  const store = eventsRouter.getStore();
  const before = store.projects[PROJECT_ID];
  const beforeCount = before?.progress?.tasks?.length ?? 0;
  console.log(`Before: ${beforeCount} tasks, dept=${before?.department}, team=${before?.team}`);

  await eventsRouter.emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: PROJECT_ID,
    source: 'system',
    correlationId: REPAIR_ID,
    rationale:
      'Repair: consolidated marketing project plan — removed duplicate Reassign meta tasks from replan loop.',
    payload: {
      decisionType: 'consolidate_project_tasks',
      title: 'Marketing new coming products',
      department: 'Marketing',
      team: 'Content',
      tasks: CORE_TASKS,
    },
  });

  const eventLog = eventsRouter.getEventLog();
  const openNeeds = eventLog.filter(
    (e) =>
      e.projectId === PROJECT_ID &&
      e.type === 'need' &&
      ['open', 'in_review'].includes(e.payload?.status || 'open')
  );

  for (const need of openNeeds) {
    need.payload.status = 'met';
    need.payload.reviewNotes =
      'Repair script: project replan consolidated; duplicate approval need closed.';
    need.payload.reviewedAt = new Date().toISOString();
    await eventsRouter.updateWorkerRequest(need.id, need.payload);
  }

  // Fix corrupted skills on Jesse from bad event payloads
  const people = await postgresStore.loadAllPeople();
  const jesse = people.find((p) => p.id === 'person-18');
  if (
    jesse &&
    Array.isArray(jesse.skills) &&
    jesse.skills.some((s) => String(s).includes('proj-marketing'))
  ) {
    await postgresStore.upsertPerson({
      ...jesse,
      skills: ['marketing', 'content', 'branding', 'social-media'],
    });
    await eventsRouter.refreshPeopleCache();
    console.log('Fixed Jesse Martin skills in directory.');
  }

  // Persist canonical snapshot to projects table (in case in-memory state drifts)
  await postgresStore.saveProjectState(PROJECT_ID, eventsRouter.getStore().projects[PROJECT_ID]);

  await eventsRouter.recomputePeopleLoadFromProjects();

  const after = eventsRouter.getStore().projects[PROJECT_ID];
  const tasks = after?.progress?.tasks || [];
  console.log(`After: ${tasks.length} tasks, dept=${after?.department}, team=${after?.team}`);
  for (const t of tasks) {
    console.log(
      `  ${t.id} [${t.status || 'pending'}] ${t.assignee?.name || t.assigneeId || 'unassigned'} — ${t.title}`
    );
  }
  console.log(`Closed ${openNeeds.length} open need(s). Done.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
