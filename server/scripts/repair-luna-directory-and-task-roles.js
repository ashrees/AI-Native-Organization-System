#!/usr/bin/env node
/**
 * Restore Luna's org directory job title and fix task assignee labels on legal-cases project.
 * Usage: node server/scripts/repair-luna-directory-and-task-roles.js [projectId]
 */

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const LUNA_ID = 'person-10';
const CORRECT_JOB_TITLE = 'data science Manager';
const TARGET_PROJECT = process.argv[2] || 'proj-organize-company-legal-cases';

async function main() {
  const eventsRouter = require('../routes/events');
  const postgresStore = require('../store/postgresStore');
  const { buildAssigneeSnapshot, isLeadershipJobTitle } = require('../lib/projectMemberRoles');

  await eventsRouter.initStore();
  const people = await postgresStore.loadAllPeople();
  const luna = people.find((p) => p.id === LUNA_ID);
  if (!luna) {
    console.error('Luna not found');
    process.exit(1);
  }

  if (isLeadershipJobTitle(luna.role) || luna.role !== CORRECT_JOB_TITLE) {
    console.log(`Directory: ${luna.role} → ${CORRECT_JOB_TITLE}`);
    await postgresStore.upsertPerson({ ...luna, role: CORRECT_JOB_TITLE });
    await eventsRouter.refreshPeopleCache?.();
  }

  const state = eventsRouter.getStore().projects[TARGET_PROJECT];
  if (!state) {
    console.error('Project not found:', TARGET_PROJECT);
    process.exit(1);
  }

  const lunaFresh = eventsRouter.loadPeople().find((p) => p.id === LUNA_ID);
  const contributorKey = `contributor_${LUNA_ID}`;
  if (state.roles?.[contributorKey]) {
    state.roles[contributorKey].jobTitle = CORRECT_JOB_TITLE;
    state.roles[contributorKey].label = 'Contributor';
    state.roles[contributorKey].roleId = 'contributor';
  }

  let fixed = 0;
  for (const task of state.progress?.tasks || []) {
    const aid = task.assigneeId || task.assignee?.id;
    if (aid !== LUNA_ID) continue;
    const snapshot = buildAssigneeSnapshot(lunaFresh, state);
    await eventsRouter.emitEvent({
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId: TARGET_PROJECT,
      source: 'system',
      rationale: 'Repair: task assignee shows project Contributor role, not global Team Lead',
      payload: {
        taskId: task.id,
        personId: LUNA_ID,
        person: snapshot,
      },
    });
    console.log(`Task ${task.id}: assignee.role=${snapshot.role}, jobTitle=${snapshot.jobTitle || '(none)'}`);
    fixed += 1;
  }

  await postgresStore.saveProjectState(TARGET_PROJECT, eventsRouter.getStore().projects[TARGET_PROJECT]);
  console.log(`Done. Fixed ${fixed} task(s); directory role=${CORRECT_JOB_TITLE}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
