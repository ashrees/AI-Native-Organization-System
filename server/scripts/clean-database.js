#!/usr/bin/env node
/**
 * Remove all data from the Postgres store (events and projects).
 * Requires DATABASE_URL. Use with care.
 *
 * Usage: node server/scripts/clean-database.js
 *        CONFIRM_CLEAN=1 node server/scripts/clean-database.js   # skip confirmation
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const { pool } = require('../db');

const SCHEMA = (process.env.POSTGRES_SCHEMA || 'public').replace(/["']/g, '');
function table(name) {
  return `"${SCHEMA}"."${name}"`;
}

async function clean() {
  const client = await pool.connect();
  try {
    await client.query(`TRUNCATE TABLE ${table('events')}, ${table('projects')}, ${table('people')}`);
    console.log('All data removed from events, projects, and people tables.');
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const confirm = process.env.CONFIRM_CLEAN === '1' || process.env.CONFIRM_CLEAN === 'true';
  if (!confirm) {
    console.warn('This will delete ALL events and projects in the database.');
    console.warn('Run with CONFIRM_CLEAN=1 to proceed without prompting.');
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('Type "yes" to continue: ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }
  await clean();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
