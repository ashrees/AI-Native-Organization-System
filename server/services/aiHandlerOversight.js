/**
 * AI Handler oversight — evaluate worker requests by scenario and handling mode
 * before auto-approve (not blind approval).
 */

const { personCanWork } = require('./emergencyReturn');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');

const ACTIONS = Object.freeze({
  APPROVE_AUTONOMOUS: 'approve_autonomous',
  APPROVE_ROUTINE: 'approve_routine',
  NOTIFY_ONLY: 'notify_only',
  DEFER_HUMAN: 'defer_human',
  REJECT: 'reject',
  CLOSE_SUPERSEDED: 'close_superseded',
});

function projectContext(needEvent, projects) {
  const pid = needEvent.projectId;
  if (!pid || pid === ORG_GENERAL_PROJECT_ID) {
    return { scoped: false, status: 'org', archived: false };
  }
  const state = projects[pid];
  return {
    scoped: true,
    status: state?.status || 'active',
    archived: !!state?.archived,
    title: state?.title || pid,
  };
}

function isInactiveProject(ctx) {
  if (!ctx.scoped) return false;
  return ctx.archived || ctx.status === 'completed' || ctx.status === 'killed';
}

/** Kinds that must stay in human/team queues (AI Handler watches but does not close). */
const WATCH_ONLY_KINDS = new Set([
  'workload_concern',
  'blocker_escalation',
  'budget_request',
  'emergency_return',
  'project_transfer',
  'role_change',
]);

/** Routine project gates the handler may close when handlingMode is ai. */
const ROUTINE_AI_KINDS = new Set([
  'sick_leave',
  'vacation',
  'schedule_change',
  'training',
  'equipment',
  'team_member',
  'onboarding',
  'general',
]);

const LEAVE_KINDS = new Set(['sick_leave', 'vacation']);

/** Project AI operational gates — leadership handler may close without human queue. */
const ROUTINE_PROJECT_KINDS = new Set([
  'approval',
  'legal_approval',
  'schedule_approval',
  'input',
  'sponsor_approval',
  'resource_approval',
]);

function hasLeaveDates(payload) {
  if (payload.startDate || payload.endDate) return true;
  const text = `${payload.description || ''} ${payload.title || ''}`;
  return /\b(20\d{2}-\d{2}-\d{2}|start|end|through|until)\b/i.test(text);
}

function countOpenRequestsForPerson(eventLog, personId, kind, excludeId = null) {
  return (eventLog || []).filter(
    (e) =>
      e.id !== excludeId &&
      e.type === 'need' &&
      e.payload?.personId === personId &&
      (e.payload?.kind === kind || !kind) &&
      ['open', 'in_review'].includes(e.payload?.status || 'open')
  ).length;
}

/**
 * @param {object} needEvent
 * @param {object} ctx - { getEventLog, loadPeople, getStore }
 * @returns {{ action: string, reason: string, reviewNotes?: string }}
 */
function assessWorkerRequest(needEvent, ctx) {
  const p = needEvent.payload || {};
  const kind = p.kind || 'general';
  const mode =
    p.handlingMode ||
    (needEvent.source === 'project_ai' ? 'ai' : needEvent.source === 'mock_worker' ? 'ai' : 'notify');
  const people = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
  const eventLog = typeof ctx.getEventLog === 'function' ? ctx.getEventLog() : [];
  const projects = ctx.getStore?.()?.projects || {};
  const submitter = people.find((x) => x.id === p.personId);

  if (p.aiHandlerResolved || p.aiAutoApproved) {
    return { action: ACTIONS.NOTIFY_ONLY, reason: 'Already resolved.' };
  }

  const proj = projectContext(needEvent, projects);
  if (isInactiveProject(proj)) {
    return {
      action: ACTIONS.CLOSE_SUPERSEDED,
      reason: `Project ${proj.title} is ${proj.archived ? 'archived' : proj.status} — request closed as superseded.`,
      reviewNotes: `AI Handler: closed — project ${proj.archived ? 'archived' : proj.status}, no further action needed.`,
    };
  }

  if (ROUTINE_PROJECT_KINDS.has(kind)) {
    return {
      action: ACTIONS.APPROVE_ROUTINE,
      reason: `Routine project gate (${kind}) — auto-approve after routing.`,
    };
  }

  // NPC routine HR/ops — close autonomously even when submit used notify/self (simulation backlog).
  if (
    needEvent.source === 'mock_worker' &&
    ROUTINE_AI_KINDS.has(kind) &&
    !WATCH_ONLY_KINDS.has(kind)
  ) {
    if (LEAVE_KINDS.has(kind)) {
      if (!hasLeaveDates(p)) {
        return {
          action: ACTIONS.DEFER_HUMAN,
          reason: 'NPC leave request missing dates — kept for HR.',
        };
      }
      if (countOpenRequestsForPerson(eventLog, p.personId, kind, needEvent.id) > 0) {
        return {
          action: ACTIONS.DEFER_HUMAN,
          reason: 'Duplicate NPC leave request — kept one open per person.',
        };
      }
      const onLeave = people.filter((x) => x.availabilityStatus === 'on_leave').length;
      const maxLeave = Math.max(0, parseInt(process.env.MOCK_WORKER_MAX_ON_LEAVE_COUNT || '3', 10));
      if (onLeave >= maxLeave) {
        return {
          action: ACTIONS.DEFER_HUMAN,
          reason: `Org already has ${onLeave} on leave — NPC leave held for HR.`,
        };
      }
      if (p.handlingMode === 'notify') {
        return {
          action: ACTIONS.NOTIFY_ONLY,
          reason: 'NPC leave in notify mode — HR notified, not auto-approved.',
        };
      }
    }
    return {
      action: ACTIONS.APPROVE_AUTONOMOUS,
      reason: `Routine NPC ${kind} — AI Handler closing after oversight.`,
    };
  }

  if (mode === 'notify') {
    return {
      action: ACTIONS.NOTIFY_ONLY,
      reason:
        'Notify-teams mode: mapped roles were notified; AI Handler is monitoring without auto-approval.',
    };
  }

  if (mode === 'self') {
    return {
      action: ACTIONS.NOTIFY_ONLY,
      reason:
        'Self-manage mode: submitter tracks the request; teams notified via AI activity only.',
    };
  }

  if (WATCH_ONLY_KINDS.has(kind)) {
    return {
      action: ACTIONS.DEFER_HUMAN,
      reason: `${kind} needs coordinated review — oversight logged, not auto-closed.`,
    };
  }

  if (LEAVE_KINDS.has(kind)) {
    if (submitter && !personCanWork(submitter) && submitter.availabilityStatus === 'on_leave') {
      return {
        action: ACTIONS.REJECT,
        reason: 'Submitter is already on leave; duplicate leave request rejected.',
        reviewNotes: 'AI Handler: rejected — person already marked on leave.',
      };
    }
    if (!hasLeaveDates(p)) {
      return {
        action: ACTIONS.DEFER_HUMAN,
        reason: 'Leave request missing dates — kept in review for HR.',
        reviewNotes:
          'AI Handler: deferred to HR — add start/end dates before autonomous approval.',
      };
    }
    if (countOpenRequestsForPerson(eventLog, p.personId, kind, needEvent.id) > 0) {
      return {
        action: ACTIONS.DEFER_HUMAN,
        reason: 'Another open leave request exists for this person.',
      };
    }
    return {
      action: ACTIONS.APPROVE_AUTONOMOUS,
      reason: 'Leave request has dates and routing; autonomous approval with HR effects.',
    };
  }

  if (kind === 'schedule_change') {
    const pid = needEvent.projectId;
    const state = projects[pid];
    if (pid && pid !== ORG_GENERAL_PROJECT_ID && state?.status === 'killed') {
      return {
        action: ACTIONS.REJECT,
        reason: 'Cannot change schedule on a killed project.',
        reviewNotes: 'AI Handler: rejected — project is killed.',
      };
    }
    return {
      action: ACTIONS.APPROVE_AUTONOMOUS,
      reason: 'Schedule change within active project scope.',
    };
  }

  if (kind === 'project_contribution_change') {
    return {
      action: ACTIONS.DEFER_HUMAN,
      reason: 'Contribution change affects assignments — project lead should confirm.',
    };
  }

  if (kind === 'capacity' || kind === 'hiring_request') {
    return {
      action: ACTIONS.APPROVE_ROUTINE,
      reason: 'Capacity/hiring routed to specialized handler.',
    };
  }

  if (needEvent.source === 'project_ai') {
    return {
      action: ACTIONS.APPROVE_ROUTINE,
      reason: 'Routine project AI operational gate.',
    };
  }

  if (ROUTINE_AI_KINDS.has(kind) && mode === 'ai') {
    return {
      action: ACTIONS.APPROVE_AUTONOMOUS,
      reason: `Routine ${kind} with autonomous handling selected.`,
    };
  }

  if (needEvent.source === 'human' && p.personId) {
    if (/\b(approval|legal|schedule|sponsor|input|onboarding|recruitment)\b/i.test(
      `${p.title} ${p.description}`
    )) {
      return { action: ACTIONS.APPROVE_ROUTINE, reason: 'Matched routine approval pattern.' };
    }
    return {
      action: ACTIONS.DEFER_HUMAN,
      reason: 'Human request needs explicit reviewer — kept in queue under oversight.',
    };
  }

  return {
    action: ACTIONS.DEFER_HUMAN,
    reason: 'No autonomous policy match; default to human review.',
  };
}

function shouldHandlerAutoApprove(needEvent, ctx) {
  const { action } = assessWorkerRequest(needEvent, ctx);
  return (
    action === ACTIONS.APPROVE_AUTONOMOUS || action === ACTIONS.APPROVE_ROUTINE
  );
}

module.exports = {
  ACTIONS,
  WATCH_ONLY_KINDS,
  projectContext,
  isInactiveProject,
  assessWorkerRequest,
  shouldHandlerAutoApprove,
};
