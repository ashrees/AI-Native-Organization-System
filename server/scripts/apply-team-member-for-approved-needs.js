#!/usr/bin/env node
/**
 * Backfill project team membership for approved team_member / onboarding / assign-to-team requests.
 *
 * Usage: node server/scripts/apply-team-member-for-approved-needs.js [projectId]
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const TARGET_PROJECT = process.argv[2] || 'proj-organize-company-legal-cases';

async function main() {
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const log = eventsRouter.getEventLog();
  const ctx = eventsRouter.buildWorkerRequestCtx();
  const { isTeamMemberRequest, applyTeamMemberEffects } = require('../services/workerRequestTeamMember');

  const needs = log.filter(
    (e) =>
      e.type === 'need' &&
      e.projectId === TARGET_PROJECT &&
      e.payload?.status === 'approved' &&
      isTeamMemberRequest(e)
  );

  let ran = 0;
  for (const needEvent of needs) {
    const done =
      needEvent.payload?.effectsApplied?.teamMember?.targetPersonId &&
      (needEvent.payload.effectsApplied.teamMember.addedToTeam ||
        needEvent.payload.effectsApplied.teamMember.alreadyOnTeam);
    if (done) {
      console.log(`Skip (already applied): ${needEvent.payload?.title} (${needEvent.id})`);
      continue;
    }

    console.log(`Applying team member effects: ${needEvent.payload?.title} (${needEvent.id})`);
    const result = await applyTeamMemberEffects(
      needEvent,
      { id: 'org_ai', name: 'Org AI' },
      ctx
    );
    console.log('  result:', result);

    needEvent.payload.effectsApplied = {
      ...(needEvent.payload.effectsApplied || {}),
      at: needEvent.payload.effectsApplied?.at || new Date().toISOString(),
      teamMember: result,
    };
    await eventsRouter.updateWorkerRequest(needEvent.id, needEvent.payload);
    ran += 1;
  }

  const state = eventsRouter.getStore().projects[TARGET_PROJECT];
  const roles = state?.roles ? Object.values(state.roles).map((r) => `${r.label}: ${r.name}`) : [];
  console.log(`\nProject roles now: ${roles.join(' · ') || '(none)'}`);

  if (ran === 0) {
    console.log(`No pending team-member approvals on ${TARGET_PROJECT}.`);
  } else {
    console.log(`Done. Applied ${ran} team-member effect(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
