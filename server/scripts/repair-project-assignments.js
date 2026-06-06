/**
 * Reassign delivery tasks away from on-leave people and close orphan wr-* tasks.
 * Usage: node server/scripts/repair-project-assignments.js [projectId]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const projectId = process.argv[2];
  const { getStore, getEventLog } = eventsRouter;
  const store = getStore();
  const projects = store.projects || {};

  const targets = projectId
    ? [projectId]
    : Object.keys(projects).filter((id) => {
        const st = projects[id];
        return st?.status === 'active' && !st?.archived;
      });

  const { fillAssignmentGaps } = require('../services/assignmentGapFill');
  const { sweepOrphanReviewTasks } = require('../lib/workerRequestLifecycle');
  const ctx = eventsRouter.buildLeadershipAutoCtx();

  let reassigned = 0;
  for (const pid of targets) {
    const trigger = {
      id: `repair-${pid}`,
      type: 'decision',
      timestamp: new Date().toISOString(),
      projectId: pid,
      source: 'system',
      rationale: 'Repair script: reassign tasks from on-leave assignees',
      payload: { decisionType: 'assignment_gap_fill' },
    };
    const result = await fillAssignmentGaps(pid, trigger, ctx);
    reassigned += result.assigned || 0;
    console.log(`${pid}: reassigned ${result.assigned || 0} task(s) (${result.skipped || 'ok'})`);
  }

  const swept = await sweepOrphanReviewTasks(ctx);
  console.log(`Swept ${swept} orphan review task(s).`);

  if (typeof eventsRouter.recomputePeopleLoadFromProjects === 'function') {
    await eventsRouter.recomputePeopleLoadFromProjects();
  }

  const pending = (getEventLog() || []).filter(
    (e) =>
      e.type === 'need' && ['open', 'in_review'].includes(e.payload?.status || 'open')
  ).length;
  console.log(`Done. Reassigned total: ${reassigned}. Open needs: ${pending}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
