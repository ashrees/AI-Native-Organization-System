#!/usr/bin/env node
/**
 * Print Postgres connection info and table row counts (same DB/schema the app uses).
 * Run from repo root: node server/scripts/postgres-diagnostic.js
 * Use this to verify DATABASE_URL points to the same Neon branch/DB where you see data.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const { pool } = require('../db');
const postgresStore = require('../store/postgresStore');

async function main() {
  await postgresStore.ensureTables();
  const d = await postgresStore.getConnectionDiagnostic();
  if (d && d.error) {
    console.error('Diagnostic error:', d.error);
    process.exit(1);
  }
  if (d) {
    console.log('Database:', d.database);
    console.log('Schema:', d.schema);
    console.log('Row counts: events=%d, projects=%d, people=%d', d.events, d.projects, d.people);
    console.log('\nIf people=0 here but you see data in Neon, use the same connection string (branch + database) in .env DATABASE_URL.');
  } else {
    console.error('No diagnostic (pool not available).');
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    if (pool) pool.end();
  });
