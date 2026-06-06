/**
 * Worker request review permissions and lifecycle (close review tasks, log decisions).
 */

const crypto = require('crypto');
const { isHrPerson, requestRequiresHrInbox } = require('../constants/requestRouting');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const agentActivityLog = require('./agentActivityLog');
const { applyApprovedRequestEffects } = require('../services/workerRequestEffects');
const { personCanWork } = require('../services/emergencyReturn');
const SYSTEM_REVIEWER = Object.freeze({ id: 'ai_handler', name: 'AI Handler' });

const REVIEWER_ROLES = new Set(['hr', 'project_lead', 'engineering_mgmt', 'devops', 'data_lead']);

function personCanReviewWorkerRequest(person, request) {
  if (!person?.id || !request) return false;
  if (!personCanWork(person)) return false;

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

function needIdFragment(needId) {
  return String(needId || '')
    .replace(/-/g, '')
    .slice(0, 12);
}

async function completeReviewTasksForRequest(needEvent, ctx, status) {
  const { emitEvent, getStore } = ctx;
  const taskIds = new Set();
  const tasksByProject = new Map();

  const addTask = (taskId, projectId) => {
    if (!taskId || !projectId) return;
    taskIds.add(taskId);
    if (!tasksByProject.has(projectId)) tasksByProject.set(projectId, new Set());
    tasksByProject.get(projectId).add(taskId);
  };

  for (const a of needEvent.payload?.roleAssignments || []) {
    addTask(a.taskId, needEvent.projectId);
  }
  if (needEvent.payload?.projectReviewTaskId) {
    addTask(needEvent.payload.projectReviewTaskId, needEvent.projectId);
  }
  if (needEvent.payload?.hrTaskId) {
    addTask(needEvent.payload.hrTaskId, needEvent.projectId);
  }

  const frag = needIdFragment(needEvent.id);
  if (frag) {
    for (const [pid, state] of Object.entries(getStore?.()?.projects || {})) {
      for (const task of state?.progress?.tasks || []) {
        const tid = String(task.id || '');
        if (task.status === 'done') continue;
        if (!tid.startsWith('wr-') || !tid.includes(frag)) continue;
        addTask(tid, pid);
      }
    }
  }

  for (const [projectId, ids] of tasksByProject) {
    for (const taskId of ids) {
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
  const wasAlreadyTerminal = ['approved', 'rejected', 'met', 'cancelled'].includes(
    needEvent.payload?.status
  );

  needEvent.payload = {
    ...needEvent.payload,
    ...updates,
    reviewedBy: reviewer.id,
    reviewedByName: reviewer.name,
    reviewedAt: updates.reviewedAt || new Date().toISOString(),
  };

  if (terminal) {
    await completeReviewTasksForRequest(needEvent, ctx, updates.status);
    const effectsRecorded = !!needEvent.payload?.effectsApplied?.at;
    const teamIncomplete =
      updates.status === 'approved' &&
      (() => {
        try {
          const { isTeamMemberRequest, teamMemberEffectsComplete } = require('../services/workerRequestTeamMember');
          return isTeamMemberRequest(needEvent) && !teamMemberEffectsComplete(needEvent);
        } catch {
          return false;
        }
      })();

    if (
      updates.status === 'approved' &&
      (!wasAlreadyTerminal || !effectsRecorded || teamIncomplete)
    ) {
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

const TERMINAL_NEED_STATUSES = new Set(['approved', 'rejected', 'met', 'cancelled']);
const PENDING_NEED_STATUSES = new Set(['open', 'in_review']);

function isInactiveProjectForNeeds(projectId, state) {
  if (!projectId || projectId === ORG_GENERAL_PROJECT_ID) return false;
  if (!state) return true;
  return !!state.archived || state.status === 'completed' || state.status === 'killed';
}

function isNeedOnInactiveProject(needEvent, projects = {}) {
  if (!needEvent || needEvent.type !== 'need') return false;
  const state = projects[needEvent.projectId];
  return isInactiveProjectForNeeds(needEvent.projectId, state);
}

function isActionablePendingNeed(needEvent, projects = {}) {
  if (!needEvent || needEvent.type !== 'need') return false;
  const status = needEvent.payload?.status || 'open';
  if (!PENDING_NEED_STATUSES.has(status)) return false;
  return !isNeedOnInactiveProject(needEvent, projects);
}

/**
 * Close open/in_review needs on a killed/completed/archived project.
 */
async function closeNeedsForInactiveProject(projectId, ctx, { reason } = {}) {
  const { getStore, getEventLog, updateWorkerRequest } = ctx;
  if (!getStore || !getEventLog) return 0;

  const state = getStore().projects?.[projectId];
  if (!isInactiveProjectForNeeds(projectId, state)) return 0;

  const statusLabel = state?.archived ? 'archived' : state?.status || 'inactive';
  let closed = 0;

  for (const needEvent of getEventLog() || []) {
    if (needEvent.type !== 'need' || needEvent.projectId !== projectId) continue;
    const st = needEvent.payload?.status || 'open';
    if (TERMINAL_NEED_STATUSES.has(st) || !PENDING_NEED_STATUSES.has(st)) continue;

    await applyWorkerRequestReview(
      needEvent,
      {
        status: 'met',
        reviewNotes:
          reason ||
          `Closed — project ${statusLabel}; request superseded.`,
        reviewedAt: new Date().toISOString(),
      },
      SYSTEM_REVIEWER,
      ctx
    );
    needEvent.payload.aiHandlerResolved = true;
    needEvent.payload.supersededByProjectLifecycle = true;
    if (updateWorkerRequest) await updateWorkerRequest(needEvent.id, needEvent.payload);
    closed += 1;
  }

  return closed;
}

/**
 * Close pending needs on all inactive projects (startup / maintenance).
 */
async function sweepInactiveProjectNeeds(ctx) {
  const projects = ctx.getStore?.()?.projects || {};
  let closed = 0;
  for (const [projectId, state] of Object.entries(projects)) {
    if (!isInactiveProjectForNeeds(projectId, state)) continue;
    closed += await closeNeedsForInactiveProject(projectId, ctx);
  }
  if (closed > 0) {
    try {
      await sweepOrphanReviewTasks(ctx);
    } catch {
      /* ignore */
    }
  }
  return closed;
}

function isReviewTaskId(taskId) {
  return String(taskId || '').startsWith('wr-');
}

function taskMatchesNeed(taskId, needId) {
  return String(taskId || '').includes(needIdFragment(needId));
}

/**
 * Close wr-* review tasks whose parent need is terminal or project is inactive.
 */
async function sweepOrphanReviewTasks(ctx) {
  const { emitEvent, getStore, getEventLog } = ctx;
  if (!getStore || !emitEvent) return 0;

  const eventLog = typeof getEventLog === 'function' ? getEventLog() : [];
  const needsById = new Map(eventLog.filter((e) => e.type === 'need').map((e) => [e.id, e]));
  let closed = 0;

  for (const [projectId, state] of Object.entries(getStore().projects || {})) {
    const inactive =
      !!state?.archived || state?.status === 'completed' || state?.status === 'killed';

    for (const task of state?.progress?.tasks || []) {
      if (task.status === 'done' || !isReviewTaskId(task.id)) continue;

      let parentNeed = null;
      for (const need of needsById.values()) {
        if (taskMatchesNeed(task.id, need.id)) {
          parentNeed = need;
          break;
        }
      }

      const parentTerminal =
        parentNeed && TERMINAL_NEED_STATUSES.has(parentNeed.payload?.status || '');
      if (!parentTerminal && !inactive) continue;

      const reason = parentTerminal
        ? `Parent request ${parentNeed.payload?.status}`
        : `Project ${state?.status || 'inactive'}`;

      await emitEvent({
        id: crypto.randomUUID(),
        type: 'execution',
        timestamp: new Date().toISOString(),
        projectId,
        source: 'system',
        correlationId: parentNeed?.id,
        rationale: `Sweep: close orphan review task (${reason})`,
        payload: {
          taskId: task.id,
          status: 'done',
          notes: `Auto-closed orphan review task — ${reason}`,
        },
      });
      closed += 1;
    }
  }

  return closed;
}

module.exports = {
  personCanReviewWorkerRequest,
  completeReviewTasksForRequest,
  applyWorkerRequestReview,
  sweepOrphanReviewTasks,
  sweepInactiveProjectNeeds,
  closeNeedsForInactiveProject,
  isInactiveProjectForNeeds,
  isNeedOnInactiveProject,
  isActionablePendingNeed,
  isReviewTaskId,
  needIdFragment,
  REVIEWER_ROLES,
};
