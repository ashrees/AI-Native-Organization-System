/**
 * One-shot: run AI Handler on all open/in_review worker requests.
 * Usage: node server/scripts/flush-ai-handler-queue.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();
  const { processPendingLeadershipNeedsNow } = require('../services/leadershipNeedAutoHandler');

  let totalResolved = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const { enabled, resolved } = await processPendingLeadershipNeedsNow(
      eventsRouter.buildLeadershipAutoCtx(),
      {}
    );
    if (!enabled) {
      console.log('AI Handler preference is off — enable in Leadership preferences first.');
      process.exit(1);
    }
    totalResolved += resolved || 0;
    console.log(`Pass ${pass + 1}: resolved ${resolved || 0}`);
    if (!resolved) break;
  }
  const eventLog = eventsRouter.getEventLog();
  const pending = eventLog.filter(
    (e) =>
      e.type === 'need' && ['open', 'in_review'].includes(e.payload?.status || 'open')
  ).length;
  try {
    const ctx = eventsRouter.buildLeadershipAutoCtx();
    const { sweepOrphanReviewTasks, sweepInactiveProjectNeeds } = require('../lib/workerRequestLifecycle');
    const closed = await sweepInactiveProjectNeeds(ctx);
    if (closed > 0) console.log(`Closed ${closed} superseded need(s) on inactive projects.`);
    const swept = await sweepOrphanReviewTasks(ctx);
    if (swept > 0) console.log(`Swept ${swept} orphan review task(s).`);
  } catch (err) {
    console.warn('Need/review sweep skipped:', err.message);
  }
  if (typeof eventsRouter.recomputePeopleLoadFromProjects === 'function') {
    await eventsRouter.recomputePeopleLoadFromProjects();
    console.log('Recomputed people load (review tasks wr-* excluded).');
  }
  console.log(`Done. Total resolved: ${totalResolved}. Still pending: ${pending}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
