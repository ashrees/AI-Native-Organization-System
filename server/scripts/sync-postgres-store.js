#!/usr/bin/env node
/**
 * Rebuild Postgres project state, people load, and task index from the event log.
 * Usage: node server/scripts/sync-postgres-store.js
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

async function main() {
  const eventsRouter = require('../routes/events');
  const postgresStore = require('../store/postgresStore');
  const { applyEvents } = require('../models/projectState');

  await eventsRouter.initStore();

  const eventLog = eventsRouter.getEventLog();
  const projectIds = [...new Set(eventLog.map((e) => e.projectId).filter(Boolean))];
  const projects = {};

  for (const projectId of projectIds) {
    const projectEvents = eventLog.filter((e) => e.projectId === projectId);
    const state = applyEvents(null, projectEvents, projectId);
    projects[projectId] = state;
    await postgresStore.saveProjectState(projectId, state);

    for (const task of state.progress?.tasks || []) {
      const assigneeId = task.assigneeId || task.assignee?.id || null;
      await postgresStore.upsertProjectTaskIndex(
        projectId,
        task.id,
        task.title,
        assigneeId,
        task.status || 'pending',
        state.lastEventId,
        state.lastUpdatedAt
      );
    }
  }

  const people = await postgresStore.loadAllPeople();
  const loadByPerson = new Map(people.map((p) => [p.id, 0]));

  for (const state of Object.values(projects)) {
    for (const task of state?.progress?.tasks || []) {
      const assigneeId = task.assigneeId || task.assignee?.id;
      if (!assigneeId || task.status === 'done') continue;
      loadByPerson.set(assigneeId, (loadByPerson.get(assigneeId) || 0) + 1);
    }
  }

  for (const p of people) {
    const load = loadByPerson.get(p.id) || 0;
    await postgresStore.upsertPerson({ ...p, currentLoad: load });
  }

  const { ensurePersonalHrAssignments } = require('../services/personalHrBootstrap');
  await ensurePersonalHrAssignments();

  // Backfill Luna role_change need effects in events payload (Postgres JSONB)
  const { pool } = require('../db');
  await pool.query(
    `UPDATE events SET payload = payload || $1::jsonb
     WHERE type = 'need' AND payload->>'kind' = 'role_change'
       AND payload->>'personId' = 'person-10'
       AND payload->>'title' = 'Request to change role to Team Lead'
       AND payload->>'status' = 'approved'`,
    [
      JSON.stringify({
        effectsApplied: {
          at: new Date().toISOString(),
          kind: 'role_change',
          personId: 'person-10',
          personName: 'Luna Lovegood',
          roleChange: {
            personId: 'person-10',
            personName: 'Luna Lovegood',
            previousRole: 'data science Manager',
            newRole: 'Team Lead',
            updated: true,
          },
          taskCount: 0,
          repaired: true,
        },
      }),
    ]
  );

  const luna = (await postgresStore.loadAllPeople()).find((p) => p.id === 'person-10');
  const proj = projects['proj-ai-builders'];
  const task3 = proj?.progress?.tasks?.find((t) => t.id === 'task-3');

  console.log('Postgres sync complete.');
  console.log(`Projects rebuilt: ${projectIds.length}`);
  console.log(`People load updated: ${people.length}`);
  console.log(
    `Luna: role=${luna?.role}, load=${luna?.currentLoad}; task-3 assignee=${task3?.assignee?.name || task3?.assigneeId}`
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
