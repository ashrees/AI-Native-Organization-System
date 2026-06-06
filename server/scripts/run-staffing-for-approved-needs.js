#!/usr/bin/env node
/**
 * Re-run staffing agent workflow for already-approved project-scoped requests
 * (e.g. "additional team member") that did not trigger orchestration before the fix.
 *
 * Usage: node server/scripts/run-staffing-for-approved-needs.js [projectId]
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const TARGET_PROJECT = process.argv[2] || 'proj-organize-company-legal-cases';

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const log = eventsRouter.getEventLog();
  const ctx = {
    ...eventsRouter.buildWorkerRequestCtx(),
    buildProjectAICtx: eventsRouter.buildProjectAICtx,
    buildAssignmentGapFillCtx: eventsRouter.buildAssignmentGapFillCtx,
  };
  const { applyStaffingAndCapacityEffects, isStaffingOrCapacityRequest } = require('../services/workerRequestStaffing');

  const needs = log.filter(
    (e) =>
      e.type === 'need' &&
      e.projectId === TARGET_PROJECT &&
      e.payload?.status === 'approved'
  );

  let ran = 0;
  for (const needEvent of needs) {
    if (!isStaffingOrCapacityRequest(needEvent)) continue;
    console.log(`Running staffing workflow for: ${needEvent.payload?.title} (${needEvent.id})`);
    const result = await applyStaffingAndCapacityEffects(
      needEvent,
      { id: 'org_ai', name: 'Org AI' },
      ctx
    );
    console.log('  result:', result);
    ran += 1;
  }

  if (ran === 0) {
    console.log(`No approved staffing/capacity needs found on ${TARGET_PROJECT}.`);
  } else {
    console.log(`Done. Ran ${ran} staffing workflow(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
