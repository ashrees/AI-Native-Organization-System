/**
 * Remove _projectEventsForAssessment from event payloads (causes Postgres jsonb size errors).
 * Run from repo root: node server/scripts/strip-assessment-event-bloat.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { pool } = require('../db');
const postgresStore = require('../store/postgresStore');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  await postgresStore.ensureTables();

  const schema = (process.env.POSTGRES_SCHEMA || 'public').replace(/["']/g, '');
  const eventsTable = `"${schema}"."events"`;

  const countRes = await pool.query(
    `SELECT count(*)::int AS n FROM ${eventsTable} WHERE payload ? '_projectEventsForAssessment'`
  );
  const n = countRes.rows[0]?.n || 0;
  console.log(`Events with bloated _projectEventsForAssessment: ${n}`);

  if (n === 0) {
    console.log('Nothing to clean.');
    await pool.end();
    return;
  }

  const upd = await pool.query(
    `UPDATE ${eventsTable}
     SET payload = payload - '_projectEventsForAssessment'
     WHERE payload ? '_projectEventsForAssessment'`
  );
  console.log(`Stripped field from ${upd.rowCount} row(s). Restart the API server.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
