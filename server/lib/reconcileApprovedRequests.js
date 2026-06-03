/**
 * One-time style reconciliation: approved requests that predate effects should still update the org.
 */

const {
  applyApprovedRequestEffects,
  recordLeaveProjectNotices,
  LEAVE_KINDS,
} = require('../services/workerRequestEffects');

async function reconcileApprovedWorkerRequests(eventsRouter) {
  const eventLog = eventsRouter.getEventLog();
  const ctx = eventsRouter.buildWorkerRequestCtx();
  let count = 0;

  for (const e of eventLog) {
    if (e.type !== 'need' || e.source !== 'human') continue;
    if (e.payload?.status !== 'approved') continue;
    const reviewer = {
      id: e.payload.reviewedBy || 'system',
      name: e.payload.reviewedByName || 'System',
    };

    if (LEAVE_KINDS.has(e.payload?.kind) && !e.payload?.effectsApplied?.leaveNoticesRecorded) {
      await recordLeaveProjectNotices(e, ctx);
      await eventsRouter.updateWorkerRequest(e.id, e.payload);
      count += 1;
      continue;
    }

    if (e.payload?.effectsApplied?.at) continue;

    await applyApprovedRequestEffects(e, reviewer, ctx);
    await eventsRouter.updateWorkerRequest(e.id, e.payload);
    count += 1;
  }

  if (count > 0) {
    console.log(`[Store] Reconciled ${count} approved worker request(s) with system effects.`);
    if (typeof ctx.recomputePeopleLoad === 'function') await ctx.recomputePeopleLoad();
    if (typeof ctx.refreshPeopleCache === 'function') await ctx.refreshPeopleCache();
  }
}

module.exports = { reconcileApprovedWorkerRequests };
