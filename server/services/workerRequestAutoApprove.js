/**
 * Autonomous handling for worker requests submitted with handlingMode "ai".
 * Org AI approves and applies effects without leadership or review-task workflow.
 */

const agentActivityLog = require('../lib/agentActivityLog');
const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
const { getPersonalHr, getHrPeople } = require('../constants/requestRouting');

const ORG_AI_REVIEWER = Object.freeze({ id: 'org_ai', name: 'Org AI' });

function pickReviewer(needEvent, people) {
  const kind = needEvent.payload?.kind;
  if (kind === 'emergency_return') {
    const hrId = needEvent.payload?.assignedHrPersonId;
    const hr =
      (hrId && people.find((p) => p.id === hrId)) ||
      getPersonalHr(needEvent.payload?.personId, people) ||
      getHrPeople(people)[0];
    if (hr) return hr;
  }
  return ORG_AI_REVIEWER;
}

function buildAutoApprovalNote(needEvent, routingResult) {
  const kind = needEvent.payload?.kind || 'request';
  const title = needEvent.payload?.title || kind;
  const targets =
    routingResult?.forwardTargets?.map((t) => t.name).filter(Boolean).join(', ') ||
    needEvent.payload?.forwardsTo ||
    'mapped roles';
  const oversight =
    routingResult?.oversightReason ||
    needEvent.payload?.aiHandlerOversightReason ||
    needEvent.payload?.aiHandlerAssessment;
  const prefix = oversight ? `AI oversight (${oversight}): ` : 'Autonomous AI approval: ';
  return `${prefix}${title}. Routed to ${targets}; effects applied per handling mode.`;
}

/**
 * Approve and apply effects for an AI-handled worker request.
 * @returns {object} updated payload fields
 */
async function autonomousApproveWorkerRequest(needEvent, ctx, routingResult = {}) {
  const { loadPeople } = ctx;
  const people = loadPeople();
  const reviewer = pickReviewer(needEvent, people);
  const reviewNotes = buildAutoApprovalNote(needEvent, routingResult);

  needEvent.payload.aiHandled = true;
  needEvent.payload.aiAutoApproved = true;
  needEvent.payload.autoApprovedBy = reviewer.id;
  needEvent.payload.autoApprovedByName = reviewer.name;

  await applyWorkerRequestReview(
    needEvent,
    {
      status: 'approved',
      reviewNotes,
      reviewedAt: new Date().toISOString(),
    },
    reviewer,
    ctx
  );

  agentActivityLog.push({
    source: needEvent.payload?.aiAgent || 'org_ai',
    projectId: needEvent.projectId,
    message: `Worker request "${needEvent.payload?.title || needEvent.payload?.kind}" auto-approved by ${reviewer.name}.`,
  });

  return {
    status: needEvent.payload.status,
    reviewNotes: needEvent.payload.reviewNotes,
    reviewedBy: needEvent.payload.reviewedBy,
    reviewedByName: needEvent.payload.reviewedByName,
    reviewedAt: needEvent.payload.reviewedAt,
    effectsApplied: needEvent.payload.effectsApplied,
    aiHandled: true,
    aiAutoApproved: true,
  };
}

module.exports = {
  autonomousApproveWorkerRequest,
  ORG_AI_REVIEWER,
};
