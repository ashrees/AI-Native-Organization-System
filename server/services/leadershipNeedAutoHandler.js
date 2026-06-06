/**
 * Leadership AI Handler — auto-resolve open/in_review needs when preference is enabled.
 */

const agentActivityLog = require('../lib/agentActivityLog');

const AI_HANDLER_SOURCE = 'ai_handler';
let lastActivityAt = null;
let lastActivityMessage = null;
let lastRunResolved = 0;

function touchAiHandlerActivity(message, projectId = null) {
  const text = String(message || '').trim().slice(0, 500);
  if (!text) return;
  lastActivityAt = new Date().toISOString();
  lastActivityMessage = text.slice(0, 200);
  agentActivityLog.push({
    source: AI_HANDLER_SOURCE,
    projectId,
    message: text,
    summary: lastActivityMessage,
  });
}
const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
const { autonomousApproveWorkerRequest, ORG_AI_REVIEWER } = require('./workerRequestAutoApprove');
const { isTeamMemberRequest } = require('./workerRequestTeamMember');
const { processWorkerRequest } = require('./workerRequestHandler');
const {
  assessWorkerRequest,
  shouldHandlerAutoApprove,
  ACTIONS,
} = require('./aiHandlerOversight');

const LEADERSHIP_ID = 'leadership';
const PREF_KEY = 'aiHandlerAutomatic';

/** Kinds Project AI creates that are routine operational gates. */
const ROUTINE_APPROVE_KINDS = new Set([
  'approval',
  'legal_approval',
  'schedule_approval',
  'input',
  'sponsor_approval',
  'resource_approval',
]);

const pendingStatuses = new Set(['open', 'in_review']);

function isPendingNeedEvent(e) {
  if (e?.type !== 'need') return false;
  const status = e.payload?.status || 'open';
  return pendingStatuses.has(status);
}

function countPendingNeeds(eventLog, projects = {}) {
  const { isActionablePendingNeed } = require('../lib/workerRequestLifecycle');
  return (eventLog || []).filter((e) => isActionablePendingNeed(e, projects)).length;
}

async function isAiHandlerEnabled(postgresStore) {
  const prefs = await postgresStore.loadUserPreferences(LEADERSHIP_ID);
  const v = prefs[PREF_KEY];
  return v === true || v === 'true';
}

const LEAVE_KINDS = new Set(['sick_leave', 'vacation']);

async function collapseLeaveDuplicates(eventLog, ctx) {
  const { updateWorkerRequest } = ctx;
  const open = eventLog.filter(
    (e) =>
      e.type === 'need' &&
      LEAVE_KINDS.has(e.payload?.kind) &&
      isPendingNeedEvent(e)
  );
  const keepByKey = new Map();
  const toClose = [];

  for (const e of open.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    const key = `${e.payload?.personId}|${e.payload?.kind}`;
    if (!keepByKey.has(key)) {
      keepByKey.set(key, e);
      continue;
    }
    toClose.push(e);
  }

  for (const dup of toClose) {
    await applyWorkerRequestReview(
      dup,
      {
        status: 'met',
        reviewNotes: 'AI Handler: duplicate leave request closed (newer item kept).',
        reviewedAt: new Date().toISOString(),
      },
      ORG_AI_REVIEWER,
      ctx
    );
    dup.payload.aiHandlerResolved = true;
    dup.payload.aiHandlerDeduped = true;
    if (updateWorkerRequest) await updateWorkerRequest(dup.id, dup.payload);
  }

  return toClose.length;
}

function normalizeDedupeKey(needEvent) {
  try {
    const { isCapacityNeed, capacityDedupeKey } = require('./capacityNeedHandler');
    if (isCapacityNeed(needEvent)) return capacityDedupeKey(needEvent);
  } catch {
    /* ignore */
  }
  const p = needEvent.payload || {};
  const text = `${p.title || ''} ${p.description || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${needEvent.projectId}|${p.kind || 'general'}|${text}`;
}

/**
 * Collapse duplicate open needs (same project + kind + similar text); close older duplicates.
 */
async function dedupeOpenNeeds(eventLog, ctx) {
  const { updateWorkerRequest } = ctx;
  const open = eventLog.filter(isPendingNeedEvent);
  const byKey = new Map();
  const toClose = [];

  for (const e of open.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    const key = normalizeDedupeKey(e);
    if (!byKey.has(key)) {
      byKey.set(key, e);
      continue;
    }
    toClose.push(e);
  }

  for (const dup of toClose) {
    await applyWorkerRequestReview(
      dup,
      {
        status: 'met',
        reviewNotes: 'AI Handler: duplicate request closed (newer item kept).',
        reviewedAt: new Date().toISOString(),
      },
      ORG_AI_REVIEWER,
      ctx
    );
    dup.payload.aiHandlerResolved = true;
    dup.payload.aiHandlerDeduped = true;
    if (updateWorkerRequest) await updateWorkerRequest(dup.id, dup.payload);
  }

  return toClose.length;
}

function shouldAutoApprove(needEvent, ctx) {
  const p = needEvent.payload || {};
  const kind = p.kind || 'general';

  if (p.aiHandlerResolved || p.aiAutoApproved) return false;

  if (ctx) {
    return shouldHandlerAutoApprove(needEvent, ctx);
  }

  if (p.handlingMode === 'notify' || p.handlingMode === 'self') return false;
  if (isTeamMemberRequest(needEvent)) return true;
  if (needEvent.source === 'project_ai' && ROUTINE_APPROVE_KINDS.has(kind)) return true;
  if (p.kind === 'hiring_request' || p.kind === 'capacity') return true;
  try {
    const { isCapacityNeed } = require('./capacityNeedHandler');
    if (isCapacityNeed(needEvent)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function buildAutoReviewNotes(needEvent) {
  const kind = needEvent.payload?.kind || 'request';
  const title = needEvent.payload?.title || needEvent.payload?.description?.slice(0, 80) || kind;
  return `AI Handler: approved routine ${kind} — ${title}. Coordinated with project agents; no leadership queue required.`;
}

async function applyOversightWatch(needEvent, ctx, assessment) {
  if (!needEvent.payload.forwardTargets?.length) {
    await processWorkerRequest(needEvent, ctx);
  }
  needEvent.payload.aiHandlerWatching = true;
  needEvent.payload.aiHandlerAssessment = assessment.action;
  needEvent.payload.aiHandlerOversightReason = assessment.reason;
  if (assessment.action === ACTIONS.NOTIFY_ONLY) {
    /* keep status from processWorkerRequest */
  } else if (assessment.action === ACTIONS.DEFER_HUMAN) {
    needEvent.payload.status = 'in_review';
    if (assessment.reviewNotes) {
      needEvent.payload.reviewNotes = assessment.reviewNotes;
    }
  }
  touchAiHandlerActivity(
    `Overwatch [${needEvent.payload?.kind}]: ${assessment.reason}`.slice(0, 200),
    needEvent.projectId
  );
  if (ctx.updateWorkerRequest) await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);
  return { skipped: true, reason: assessment.action, oversight: assessment };
}

async function autoResolveOneNeed(needEvent, ctx) {
  const assessment = assessWorkerRequest(needEvent, ctx);

  if (assessment.action === ACTIONS.CLOSE_SUPERSEDED) {
    await applyWorkerRequestReview(
      needEvent,
      {
        status: 'met',
        reviewNotes: assessment.reviewNotes || assessment.reason,
        reviewedAt: new Date().toISOString(),
      },
      ORG_AI_REVIEWER,
      ctx
    );
    needEvent.payload.aiHandlerResolved = true;
    needEvent.payload.aiHandlerWatching = false;
    touchAiHandlerActivity(
      `Closed superseded ${needEvent.payload?.kind} on ${needEvent.projectId}`,
      needEvent.projectId
    );
    if (ctx.updateWorkerRequest) await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);
    return { status: 'met', mode: 'superseded', oversight: assessment };
  }

  if (
    assessment.action === ACTIONS.APPROVE_AUTONOMOUS ||
    assessment.action === ACTIONS.APPROVE_ROUTINE
  ) {
    needEvent.payload.aiHandlerWatching = false;
  } else if (
    assessment.action === ACTIONS.NOTIFY_ONLY ||
    assessment.action === ACTIONS.DEFER_HUMAN
  ) {
    return applyOversightWatch(needEvent, ctx, assessment);
  }

  if (assessment.action === ACTIONS.REJECT) {
    const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
    await applyWorkerRequestReview(
      needEvent,
      {
        status: 'rejected',
        reviewNotes: assessment.reviewNotes || assessment.reason,
        reviewedAt: new Date().toISOString(),
      },
      { id: 'ai_handler', name: 'AI Handler' },
      ctx
    );
    needEvent.payload.aiHandlerResolved = true;
    touchAiHandlerActivity(
      `Rejected ${needEvent.payload?.kind}: ${assessment.reason}`.slice(0, 200),
      needEvent.projectId
    );
    if (ctx.updateWorkerRequest) await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);
    return { status: 'rejected', mode: 'oversight' };
  }

  if (!shouldAutoApprove(needEvent, ctx)) {
    return applyOversightWatch(needEvent, ctx, assessment);
  }

  const p = needEvent.payload || {};

  try {
    const { isCapacityNeed, resolveCapacityNeedWithAI } = require('./capacityNeedHandler');
    if (isCapacityNeed(needEvent)) {
      const capacityResult = await resolveCapacityNeedWithAI(needEvent, ctx);
      if (capacityResult && !capacityResult.skipped) {
        return capacityResult;
      }
    }
  } catch (err) {
    console.warn('[AI Handler] Capacity flow skipped:', err.message);
  }

  let hiringOutcome = null;

  try {
    const { isHiringRelatedNeed, processHiringForNeed } = require('./hiringNeedHandler');
    const people = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
    if (isHiringRelatedNeed(needEvent, people) && p.hiringStatus !== 'hired') {
      hiringOutcome = await processHiringForNeed(needEvent, ctx, { autoHire: true });
    }
  } catch (err) {
    console.warn('[AI Handler] Hiring flow skipped:', err.message);
  }

  if (needEvent.source === 'human' && p.personId) {
    if (!p.forwardTargets?.length) {
      await processWorkerRequest(needEvent, ctx);
    }
    needEvent.payload.handlingMode = 'ai';
  }

  if (needEvent.source === 'human' && p.personId && (p.handlingMode === 'ai' || isTeamMemberRequest(needEvent))) {
    const note = assessment.reason || buildAutoReviewNotes(needEvent);
    await autonomousApproveWorkerRequest(needEvent, ctx, {
      forwardTargets: p.forwardTargets || [],
      oversightReason: note,
    });
    p.aiHandlerResolved = true;
    p.aiHandlerAssessment = assessment.action;
    return { status: 'approved', mode: 'worker_autonomous', oversight: assessment };
  }

  const reviewNotes =
    assessment.reason && assessment.action === ACTIONS.APPROVE_ROUTINE
      ? `AI Handler: ${assessment.reason}`
      : buildAutoReviewNotes(needEvent);

  await applyWorkerRequestReview(
    needEvent,
    {
      status: 'approved',
      reviewNotes,
      reviewedAt: new Date().toISOString(),
    },
    ORG_AI_REVIEWER,
    ctx
  );

  needEvent.payload.aiHandlerResolved = true;
  needEvent.payload.handlingMode = 'ai';
  needEvent.payload.aiHandled = true;
  needEvent.payload.aiAutoApproved = true;
  needEvent.payload.autoApprovedByName = ORG_AI_REVIEWER.name;

  touchAiHandlerActivity(
    `Resolved ${needEvent.payload?.kind || 'need'}: ${needEvent.payload?.title || needEvent.projectId}`,
    needEvent.projectId
  );

  return {
    status: 'approved',
    mode: 'leadership_auto',
    hiring: hiringOutcome,
  };
}

let processTimer = null;
let processing = false;

/**
 * Process pending needs when leadership AI Handler is on (debounced).
 */
function scheduleLeadershipAutoProcess(ctx, { broadcastNeeds } = {}) {
  const storeProjects = ctx.getStore?.()?.projects || {};
  const pendingNow = countPendingNeeds(ctx.getEventLog?.() || [], storeProjects);
  if (processTimer) clearTimeout(processTimer);
  touchAiHandlerActivity(
    pendingNow > 0
      ? `Run scheduled — ${pendingNow} pending worker request(s)`
      : 'Run scheduled — scanning worker request queue'
  );
  processTimer = setTimeout(async () => {
    if (processing) {
      processTimer = setTimeout(() => scheduleLeadershipAutoProcess(ctx, { broadcastNeeds }), 2500);
      touchAiHandlerActivity('Re-queued — previous run still in progress');
      return;
    }
    processing = true;
    try {
      const postgresStore = require('../store/postgresStore');
      if (!(await isAiHandlerEnabled(postgresStore))) return;

      const eventLog = ctx.getEventLog?.() || [];
      const pending = eventLog.filter(isPendingNeedEvent);
      touchAiHandlerActivity(`Processing queue — ${pending.length} pending need(s)`);
      await dedupeOpenNeeds(eventLog, ctx);
      const leaveClosed = await collapseLeaveDuplicates(eventLog, ctx);
      if (leaveClosed > 0) {
        console.log(`[AI Handler] Closed ${leaveClosed} duplicate leave request(s).`);
      }
      try {
        const { collapseCapacityDuplicates, ensureApprovedCapacityEffects } = require('./capacityNeedHandler');
        const capacityClosed = await collapseCapacityDuplicates(eventLog, ctx);
        const capacityEffects = await ensureApprovedCapacityEffects(eventLog, ctx);
        if (capacityClosed > 0) {
          console.log(`[AI Handler] Closed ${capacityClosed} duplicate capacity need(s).`);
        }
        if (capacityEffects > 0) {
          console.log(`[AI Handler] Applied staffing for ${capacityEffects} approved capacity need(s).`);
        }
      } catch (err) {
        console.warn('[AI Handler] Capacity dedupe skipped:', err.message);
      }

      try {
        const { sweepOrphanReviewTasks } = require('../lib/workerRequestLifecycle');
        const swept = await sweepOrphanReviewTasks(ctx);
        if (swept > 0) console.log(`[AI Handler] Swept ${swept} orphan review task(s).`);
      } catch (err) {
        console.warn('[AI Handler] Review task sweep skipped:', err.message);
      }

      const MAX_PER_RUN = 24;
      let resolved = 0;

      for (const needEvent of pending.slice(0, MAX_PER_RUN)) {
        if (!isPendingNeedEvent(needEvent)) continue;
        try {
          const result = await autoResolveOneNeed(needEvent, ctx);
          if (result && !result.skipped && ctx.updateWorkerRequest) {
            await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);
            resolved += 1;
          }
        } catch (err) {
          console.warn(`[AI Handler] Failed on need ${needEvent.id}:`, err.message);
        }
      }

      lastRunResolved = resolved;
      if (resolved > 0) {
        console.log(`[AI Handler] Auto-resolved ${resolved} pending need(s).`);
        touchAiHandlerActivity(`Finished run — resolved ${resolved} need(s)`);
        if (typeof ctx.recomputePeopleLoad === 'function') await ctx.recomputePeopleLoad();
      } else {
        touchAiHandlerActivity(
          pending.length > 0
            ? `Finished run — no new resolutions (${pending.length} still pending)`
            : 'Finished run — queue empty'
        );
      }

      if (broadcastNeeds) {
        broadcastNeeds({
          pending: countPendingNeeds(ctx.getEventLog?.() || [], ctx.getStore?.()?.projects || {}),
          resolved,
        });
      }
    } finally {
      processing = false;
    }
  }, 1200);
}

function getAiHandlerRuntimeStatus(eventLog = [], projects = {}) {
  const pendingNeeds = countPendingNeeds(eventLog, projects);
  return {
    processing,
    debounceScheduled: !!processTimer,
    pendingNeeds,
    lastAt: lastActivityAt,
    lastMessage: lastActivityMessage,
    lastRunResolved,
  };
}

module.exports = {
  AI_HANDLER_SOURCE,
  touchAiHandlerActivity,
  LEADERSHIP_ID,
  PREF_KEY,
  isPendingNeedEvent,
  countPendingNeeds,
  isAiHandlerEnabled,
  getAiHandlerRuntimeStatus,
  scheduleLeadershipAutoProcess,
  collapseLeaveDuplicates,
  processPendingLeadershipNeedsNow: async (ctx, opts) => {
    if (processTimer) clearTimeout(processTimer);
    processing = false;
    await new Promise((r) => setTimeout(r, 0));

    try {
      const { sweepInactiveProjectNeeds } = require('../lib/workerRequestLifecycle');
      const closed = await sweepInactiveProjectNeeds(ctx);
      if (closed > 0) {
        console.log(`[AI Handler] Closed ${closed} superseded need(s) on inactive projects.`);
      }
    } catch (err) {
      console.warn('[AI Handler] Inactive project need sweep skipped:', err.message);
    }

    const postgresStore = require('../store/postgresStore');
    if (!(await isAiHandlerEnabled(postgresStore))) {
      if (opts?.broadcastNeeds) {
        opts.broadcastNeeds({
          pending: countPendingNeeds(ctx.getEventLog?.() || [], ctx.getStore?.()?.projects || {}),
          resolved: 0,
        });
      }
      return { enabled: false, resolved: 0 };
    }
    const eventLog = ctx.getEventLog?.() || [];
    const pending = eventLog.filter(isPendingNeedEvent);
    touchAiHandlerActivity(`Startup run — ${pending.length} pending worker request(s)`);
    await dedupeOpenNeeds(eventLog, ctx);
    await collapseLeaveDuplicates(eventLog, ctx);
    try {
      const { collapseCapacityDuplicates, ensureApprovedCapacityEffects } = require('./capacityNeedHandler');
      await collapseCapacityDuplicates(eventLog, ctx);
      await ensureApprovedCapacityEffects(eventLog, ctx);
    } catch {
      /* ignore */
    }
    try {
      const { sweepOrphanReviewTasks } = require('../lib/workerRequestLifecycle');
      const swept = await sweepOrphanReviewTasks(ctx);
      if (swept > 0) console.log(`[AI Handler] Swept ${swept} orphan review task(s).`);
    } catch (err) {
      console.warn('[AI Handler] Review task sweep skipped:', err.message);
    }

    let resolved = 0;
    for (const needEvent of eventLog.filter(isPendingNeedEvent).slice(0, 50)) {
      const result = await autoResolveOneNeed(needEvent, ctx);
      if (result && !result.skipped) {
        if (ctx.updateWorkerRequest) await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);
        resolved += 1;
      }
    }
    touchAiHandlerActivity(
      resolved > 0
        ? `Startup run finished — resolved ${resolved} need(s)`
        : pending.length > 0
          ? `Startup run finished — ${pending.length} still pending`
          : 'Startup run finished — queue empty'
    );
    if (opts?.broadcastNeeds) {
      opts.broadcastNeeds({
        pending: countPendingNeeds(ctx.getEventLog?.() || [], ctx.getStore?.()?.projects || {}),
        resolved,
      });
    }
    return { enabled: true, resolved };
  },
};
