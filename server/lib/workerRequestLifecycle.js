/**
 * Worker request review permissions and lifecycle (close review tasks, log decisions).
 */

const crypto = require('crypto');
const { isHrPerson, requestRequiresHrInbox } = require('../constants/requestRouting');
const agentActivityLog = require('./agentActivityLog');
const { applyApprovedRequestEffects } = require('../services/workerRequestEffects');

const REVIEWER_ROLES = new Set(['hr', 'project_lead', 'engineering_mgmt', 'devops', 'data_lead']);

function personCanReviewWorkerRequest(person, request) {
  if (!person?.id || !request) return false;

  const pid = person.id;
  const p = request.payload || request;

  if (isHrPerson(person) && requestRequiresHrInbox(request)) return true;
  if (p.assignedHrPersonId === pid && isHrPerson(person)) return true;
  if (p.assignedReviewerPersonId === pid) return true;
  if ((p.roleAssignments || []).some((a) => a.assigneeId === pid)) return true;
  if ((p.primaryReviewerPersonIds || []).includes(pid)) return true;

  const fwd = p.forwardTargets || p.notifyTargets || [];
  return fwd.some((t) => t.personId === pid && REVIEWER_ROLES.has(t.role));
}

async function completeReviewTasksForRequest(needEvent, ctx, status) {
  const { emitEvent } = ctx;
  const projectId = needEvent.projectId;
  const taskIds = new Set();

  for (const a of needEvent.payload?.roleAssignments || []) {
    if (a.taskId) taskIds.add(a.taskId);
  }
  if (needEvent.payload?.projectReviewTaskId) {
    taskIds.add(needEvent.payload.projectReviewTaskId);
  }
  if (needEvent.payload?.hrTaskId) taskIds.add(needEvent.payload.hrTaskId);

  for (const taskId of taskIds) {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'execution',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'system',
      correlationId: needEvent.id,
      rationale: `Worker request ${status}: review task completed`,
      payload: {
        taskId,
        status: 'done',
        notes: `Request ${status}`,
      },
    });
  }
}

async function recordRequestDecision(needEvent, ctx, { status, reviewer, reviewNotes }) {
  const { emitEvent } = ctx;
  const title = needEvent.payload?.title || needEvent.payload?.kind;

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: needEvent.projectId,
    source: 'human',
    correlationId: needEvent.id,
    rationale: `Worker request "${title}" ${status} by ${reviewer.name}`,
    payload: {
      decisionType: `worker_request_${status}`,
      needId: needEvent.id,
      status,
      reviewerPersonId: reviewer.id,
      reviewerName: reviewer.name,
      reviewNotes: reviewNotes || undefined,
    },
  });

  agentActivityLog.push({
    source: 'org_ai',
    projectId: needEvent.projectId,
    message: `Worker request "${title}" marked ${status} by ${reviewer.name}.`,
  });
}

/**
 * Apply review outcome: update payload fields, close review tasks, emit decision.
 */
async function applyWorkerRequestReview(needEvent, updates, reviewer, ctx) {
  const terminal = ['approved', 'rejected', 'met', 'cancelled'].includes(updates.status);

  needEvent.payload = {
    ...needEvent.payload,
    ...updates,
    reviewedBy: reviewer.id,
    reviewedByName: reviewer.name,
    reviewedAt: updates.reviewedAt || new Date().toISOString(),
  };

  if (terminal) {
    await completeReviewTasksForRequest(needEvent, ctx, updates.status);
    if (updates.status === 'approved') {
      await applyApprovedRequestEffects(needEvent, reviewer, ctx);
    }
    await recordRequestDecision(needEvent, ctx, {
      status: updates.status,
      reviewer,
      reviewNotes: updates.reviewNotes,
    });
  }

  return needEvent;
}

module.exports = {
  personCanReviewWorkerRequest,
  completeReviewTasksForRequest,
  applyWorkerRequestReview,
  REVIEWER_ROLES,
};
