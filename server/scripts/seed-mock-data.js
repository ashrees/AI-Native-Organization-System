#!/usr/bin/env node
/**
 * Seed Postgres with people (and optional sample events from mock-data/ if present).
 * If mock-data/people.json is missing, seeds default people from postgresStore.
 * Run after clean DB. Requires DATABASE_URL.
 *
 * Usage: node server/scripts/seed-mock-data.js
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const { pool } = require('../db');
const postgresStore = require('../store/postgresStore');
const { applyEvents } = require('../models/projectState');

const mockDir = path.join(__dirname, '../../mock-data');

async function seed() {
  await postgresStore.ensureTables();

  let people = [];
  const peoplePath = path.join(mockDir, 'people.json');
  if (fs.existsSync(peoplePath)) {
    people = JSON.parse(fs.readFileSync(peoplePath, 'utf8'));
    if (!Array.isArray(people)) {
      console.error('people.json must be a JSON array.');
      process.exit(1);
    }
    for (const p of people) {
      await postgresStore.upsertPerson({
        id: p.id,
        name: p.name,
        department: p.department,
        team: p.team,
        role: p.role,
        skills: p.skills || [],
        currentLoad: p.currentLoad != null ? p.currentLoad : 0,
      });
    }
    console.log(`Seeded ${people.length} people from people.json.`);
  } else {
    await postgresStore.ensureDefaultPeople();
    const count = (await postgresStore.loadAllPeople()).length;
    console.log(`Seeded ${count} default people.`);
  }

  const samplePath = path.join(mockDir, 'sample-events.json');
  if (fs.existsSync(samplePath)) {
    const events = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    if (!Array.isArray(events)) {
      console.error('sample-events.json must be a JSON array.');
      process.exit(1);
    }
    for (const ev of events) {
      await postgresStore.appendEvent({
        id: ev.id,
        type: ev.type,
        timestamp: ev.timestamp,
        projectId: ev.projectId,
        source: ev.source,
        correlationId: ev.correlationId ?? undefined,
        rationale: ev.rationale ?? undefined,
        payload: ev.payload,
      });
    }
    const projectIds = [...new Set(events.map((e) => e.projectId).filter(Boolean))];
    for (const projectId of projectIds) {
      const projectEvents = events.filter((e) => e.projectId === projectId);
      const state = applyEvents(null, projectEvents, projectId);
      await postgresStore.saveProjectState(projectId, state);
    }
    console.log(`Seeded ${events.length} sample events (${projectIds.length} project(s)).`);
  }

  console.log('Seed done.');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    if (pool) pool.end();
  });
