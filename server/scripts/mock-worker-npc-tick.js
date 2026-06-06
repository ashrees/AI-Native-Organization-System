#!/usr/bin/env node
/**
 * Run one mock worker NPC batch (same as POST /worker/npc/tick).
 * Usage: node scripts/mock-worker-npc-tick.js [personId]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const eventsRouter = require('../routes/events');
const { runMockWorkerTick, buildMockWorkerCtx } = require('../services/mockWorkerNPC');

async function main() {
  const personId = process.argv[2]?.trim() || undefined;
  await eventsRouter.initStore();
  const summary = await runMockWorkerTick(buildMockWorkerCtx(), { personId });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
