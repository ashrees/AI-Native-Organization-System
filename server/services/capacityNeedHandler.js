/**
 * Capacity / staffing needs (orchestrator kind "capacity", workload, team_member).
 * AI Handler: dedupe, approve, run staffing agents, optional auto-hire.
 */

const agentActivityLog = require('../lib/agentActivityLog');
const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
const { ORG_AI_REVIEWER } = require('./workerRequestAutoApprove');
const { isStaffingOrCapacityRequest, applyStaffingAndCapacityEffects } = require('./workerRequestStaffing');
const { autonomousApproveWorkerRequest } = require('./workerRequestAutoApprove');
const { isTeamMemberRequest } = require('./workerRequestTeamMember');

const CAPACITY_KINDS = new Set(['capacity', 'workload_concern', 'team_member', 'onboarding', 'general']);

const CAPACITY_TEXT =
  /\b(capacity|staffing|headcount|understaffed|more\s+people|additional\s+(team|staff|resource)|design\s+team|team\s+capacity)\b/i;

function needText(needEvent) {
  const p = needEvent.payload || {};
  return `${p.title || ''} ${p.description || ''}`.trim();
}

function isCapacityNeed(needEvent) {
  if (!needEvent || needEvent.type !== 'need') return false;
  const kind = needEvent.payload?.kind || '';
  if (kind === 'capacity') return true;
  if (CAPACITY_KINDS.has(kind) && CAPACITY_TEXT.test(needText(needEvent))) return true;
  return isStaffingOrCapacityRequest(needEvent);
}

/** Stable topic key for dedupe on the same project. */
function normalizeCapacityTopic(needEvent) {
  const text = needText(needEvent).toLowerCase();
  const tokens = text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 &&
        ![
          'the',
          'and',
          'for',
          'with',
          'team',
          'needed',
          'need',
          'request',
          'creating',
          'materials',
          'task',
          'promotional',
          'design',
          'capacity',
          'additional',
        ].includes(w)
    );
  const unique = [...new Set(tokens)].sort().slice(0, 10);
  return unique.join('-') || 'capacity-general';
}

function capacityDedupeKey(needEvent) {
  return `${needEvent.projectId}|capacity|${normalizeCapacityTopic(needEvent)}`;
}

function isTerminalStatus(needEvent) {
  return ['approved', 'rejected', 'met', 'cancelled'].includes(needEvent.payload?.status || '');
}

/**
 * Close open capacity needs when an approved sibling exists, or collapse duplicate open items.
 */
async function collapseCapacityDuplicates(eventLog, ctx) {
  const { updateWorkerRequest } = ctx;
  let closed = 0;

  const capacityNeeds = (eventLog || []).filter(isCapacityNeed);
  const approvedByKey = new Map();
  for (const e of capacityNeeds.filter((n) => isTerminalStatus(n) && n.payload?.status === 'approved')) {
    const key = capacityDedupeKey(e);
    if (!approvedByKey.has(key)) approvedByKey.set(key, e);
  }

  const open = capacityNeeds.filter((n) => ['open', 'in_review'].includes(n.payload?.status || 'open'));
  const keepOpen = new Map();

  for (const e of open.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    const key = capacityDedupeKey(e);
    const approvedSibling = approvedByKey.get(key);

    if (approvedSibling) {
      await applyWorkerRequestReview(
        e,
        {
          status: 'met',
          reviewNotes: `AI Handler: duplicate — already approved (${approvedSibling.payload?.title || approvedSibling.id}).`,
          reviewedAt: new Date().toISOString(),
        },
        ORG_AI_REVIEWER,
        ctx
      );
      e.payload.aiHandlerResolved = true;
      e.payload.aiHandlerDeduped = true;
      if (updateWorkerRequest) await updateWorkerRequest(e.id, e.payload);
      closed += 1;
      continue;
    }

    if (!keepOpen.has(key)) {
      keepOpen.set(key, e);
      continue;
    }

    await applyWorkerRequestReview(
      e,
      {
        status: 'met',
        reviewNotes: 'AI Handler: duplicate capacity request closed (newer item kept).',
        reviewedAt: new Date().toISOString(),
      },
      ORG_AI_REVIEWER,
      ctx
    );
    e.payload.aiHandlerResolved = true;
    e.payload.aiHandlerDeduped = true;
    if (updateWorkerRequest) await updateWorkerRequest(e.id, e.payload);
    closed += 1;
  }

  return closed;
}

/**
 * Run staffing agents for approved capacity needs that were approved before effects existed.
 */
async function ensureApprovedCapacityEffects(eventLog, ctx) {
  const { updateWorkerRequest } = ctx;
  let applied = 0;

  for (const e of (eventLog || []).filter(
    (n) => isCapacityNeed(n) && n.payload?.status === 'approved' && !n.payload?.effectsApplied?.staffing
  )) {
    const staffing = await applyStaffingAndCapacityEffects(e, ORG_AI_REVIEWER, ctx);
    if (!staffing || staffing.skipped) continue;

    e.payload.effectsApplied = {
      ...(e.payload.effectsApplied || { at: new Date().toISOString() }),
      staffing,
    };
    e.payload.aiHandlerResolved = true;
    if (!e.payload.reviewNotes?.includes('AI Handler')) {
      e.payload.reviewNotes = buildCapacityApprovalNote(e, staffing, null);
    }
    if (updateWorkerRequest) await updateWorkerRequest(e.id, e.payload);
    applied += 1;
  }

  return applied;
}

function buildCapacityApprovalNote(needEvent, staffing, hiring) {
  const title = needEvent.payload?.title || needText(needEvent).slice(0, 80);
  const parts = [`AI Handler: approved capacity need — ${title}.`];
  if (staffing?.assigned > 0) parts.push(`Assigned ${staffing.assigned} task(s).`);
  if (staffing?.replanned) parts.push('Triggered replan.');
  if (hiring?.hired) parts.push(`Hired ${hiring.hire?.person?.name || 'new team member'}.`);
  else if (hiring?.queuedForHr) parts.push('Hiring queued for HR.');
  return parts.join(' ');
}

/**
 * Full AI resolution for capacity/staffing needs (project_ai, orchestrator, or worker).
 */
async function resolveCapacityNeedWithAI(needEvent, ctx) {
  if (!isCapacityNeed(needEvent)) return null;

  const p = needEvent.payload || {};
  if (p.aiHandlerResolved && isTerminalStatus(needEvent)) {
    return { skipped: true, reason: 'already_resolved' };
  }

  if (needEvent.source === 'human' && p.personId) {
    if (!p.forwardTargets?.length && typeof ctx.emitEvent === 'function') {
      const { processWorkerRequest } = require('./workerRequestHandler');
      await processWorkerRequest(needEvent, ctx);
    }
    p.handlingMode = p.handlingMode || 'ai';
    if (p.handlingMode === 'ai' || isTeamMemberRequest(needEvent)) {
      await autonomousApproveWorkerRequest(needEvent, ctx, {
        forwardTargets: p.forwardTargets || [],
      });
      p.aiHandlerResolved = true;
      return { status: 'approved', mode: 'worker_autonomous', capacity: true };
    }
  }

  let hiringOutcome = null;
  try {
    const { processHiringForNeed, isHiringRelatedNeed } = require('./hiringNeedHandler');
    const people = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
    if (isHiringRelatedNeed(needEvent, people) && p.hiringStatus !== 'hired') {
      hiringOutcome = await processHiringForNeed(needEvent, ctx, { autoHire: true });
    }
  } catch (err) {
    console.warn('[Capacity] Hiring flow skipped:', err.message);
  }

  await applyWorkerRequestReview(
    needEvent,
    {
      status: 'approved',
      reviewNotes: buildCapacityApprovalNote(needEvent, null, hiringOutcome),
      reviewedAt: new Date().toISOString(),
    },
    ORG_AI_REVIEWER,
    ctx
  );

  let staffing = needEvent.payload.effectsApplied?.staffing;
  if (!staffing) {
    staffing = await applyStaffingAndCapacityEffects(needEvent, ORG_AI_REVIEWER, ctx);
    if (staffing) {
      needEvent.payload.effectsApplied = {
        ...(needEvent.payload.effectsApplied || { at: new Date().toISOString() }),
        staffing,
      };
    }
  }

  if (staffing) {
    needEvent.payload.reviewNotes = buildCapacityApprovalNote(needEvent, staffing, hiringOutcome);
  }

  needEvent.payload.aiHandlerResolved = true;
  needEvent.payload.handlingMode = 'ai';
  needEvent.payload.aiHandled = true;
  needEvent.payload.aiAutoApproved = true;
  needEvent.payload.autoApprovedByName = ORG_AI_REVIEWER.name;
  if (hiringOutcome?.hire?.person) {
    needEvent.payload.hiringResult = {
      personId: hiringOutcome.hire.person.id,
      personName: hiringOutcome.hire.person.name,
    };
  }

  agentActivityLog.push({
    source: 'org_ai',
    projectId: needEvent.projectId,
    message: `AI Handler resolved capacity need on ${needEvent.projectId}: staffing=${staffing?.assigned ?? 0} assigned.`,
  });

  return {
    status: 'approved',
    mode: 'capacity_auto',
    staffing,
    hiring: hiringOutcome,
  };
}

module.exports = {
  isCapacityNeed,
  normalizeCapacityTopic,
  capacityDedupeKey,
  collapseCapacityDuplicates,
  ensureApprovedCapacityEffects,
  resolveCapacityNeedWithAI,
};
