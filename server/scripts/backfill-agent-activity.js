/**
 * Backfill agent_activity from events (AI agents) for monitor stream history.
 * Run once after upgrade: node server/scripts/backfill-agent-activity.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const postgresStore = require('../store/postgresStore');
const { AI_AGENT_IDS, fromEvent } = require('../models/activityRecord');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  await postgresStore.ensureTables();
  const events = await postgresStore.loadAllEvents();
  const projects = await postgresStore.loadAllProjects();

  let inserted = 0;
  let skipped = 0;

  for (const event of events) {
    if (!AI_AGENT_IDS.has(event.source)) {
      skipped += 1;
      continue;
    }
    const record = fromEvent(event, projects);
    try {
      await postgresStore.insertAgentActivity(record);
      inserted += 1;
    } catch (err) {
      if (err.code === '23505') skipped += 1;
      else console.warn('insert', event.id, err.message);
    }
  }

  console.log(`Backfill done: ${inserted} rows attempted, ${skipped} skipped (non-agent or duplicate).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
