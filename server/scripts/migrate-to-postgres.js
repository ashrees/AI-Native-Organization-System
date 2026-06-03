#!/usr/bin/env node
/**
 * Migrate events and project state from JSON files (server/store/*.json) into Postgres.
 * Run once before or after switching to DATABASE_URL. Safe to run multiple times (events use ON CONFLICT DO NOTHING).
 *
 * Usage: DATABASE_URL=postgres://... node server/scripts/migrate-to-postgres.js
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it in .env or: DATABASE_URL=postgres://... node server/scripts/migrate-to-postgres.js');
  process.exit(1);
}

const { pool } = require('../db');
const postgresStore = require('../store/postgresStore');
const { applyEvents } = require('../models/projectState');

const storeDir = path.join(__dirname, '../store');
const eventsPath = path.join(storeDir, 'events.json');
const projectsPath = path.join(storeDir, 'projects.json');

async function migrate() {
  await postgresStore.ensureTables();
  console.log('Postgres tables ensured.');

  let events = [];
  if (fs.existsSync(eventsPath)) {
    const raw = fs.readFileSync(eventsPath, 'utf8');
    events = JSON.parse(raw);
    if (!Array.isArray(events)) {
      console.error('events.json must be a JSON array.');
      process.exit(1);
    }
    console.log(`Found ${events.length} events in events.json`);
  }

  if (events.length === 0) {
    console.log('No events to migrate. Exiting.');
    return;
  }

  for (const ev of events) {
    const event = {
      id: ev.id,
      type: ev.type,
      timestamp: ev.timestamp,
      projectId: ev.projectId,
      source: ev.source,
      correlationId: ev.correlationId ?? undefined,
      rationale: ev.rationale ?? undefined,
      payload: ev.payload,
    };
    await postgresStore.appendEvent(event);
  }
  console.log(`Inserted ${events.length} events (duplicates skipped by id).`);

  const projectIds = [...new Set(events.map((e) => e.projectId).filter(Boolean))];
  for (const projectId of projectIds) {
    const projectEvents = events.filter((e) => e.projectId === projectId);
    const state = applyEvents(null, projectEvents, projectId);
    await postgresStore.saveProjectState(projectId, state);
  }
  console.log(`Saved state for ${projectIds.length} project(s).`);

  if (fs.existsSync(projectsPath)) {
    const projectsJson = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    const projectIdsFromFile = Object.keys(projectsJson || {});
    if (projectIdsFromFile.length > 0) {
      for (const id of projectIdsFromFile) {
        await postgresStore.saveProjectState(id, projectsJson[id]);
      }
      console.log(`Also synced ${projectIdsFromFile.length} project(s) from projects.json (overwrote rebuilt state).`);
    }
  }

  console.log('Migration done.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    if (pool) pool.end();
  });
