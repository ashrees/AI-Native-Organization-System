/**
 * Shared worker request submission (Worker Portal + mock NPCs).
 */

const crypto = require('crypto');
const { WORKER_REQUEST_KINDS, HANDLING_MODES, ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const { getRoutingForKind } = require('../constants/requestRouting');
const { processWorkerRequest } = require('./workerRequestHandler');
const { autonomousApproveWorkerRequest } = require('./workerRequestAutoApprove');
const { assessWorkerRequest, ACTIONS } = require('./aiHandlerOversight');
const { taskAssigneeId } = require('../lib/taskAssignment');

/**
 * @param {object} body
 * @param {object} deps - { emitEvent, getStore, loadPeople, buildWorkerRequestCtx, updateWorkerRequest }
 */
async function submitWorkerRequest(body, deps) {
  const {
    personId,
    kind,
    title,
    description,
    projectId,
    taskId,
    startDate,
    endDate,
    handlingMode,
    targetPersonId,
    source = 'human',
  } = body || {};

  if (!personId || typeof personId !== 'string' || !personId.trim()) {
    return { status: 400, body: { error: 'personId is required' } };
  }
  const people = deps.loadPeople();
  const person = people.find((p) => p.id === personId);
  if (!person) {
    return { status: 404, body: { error: 'Person not found' } };
  }
  const validKind = WORKER_REQUEST_KINDS.some((k) => k.id === kind);
  if (!kind || !validKind) {
    return {
      status: 400,
      body: { error: `kind must be one of: ${WORKER_REQUEST_KINDS.map((k) => k.id).join(', ')}` },
    };
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    return { status: 400, body: { error: 'title is required' } };
  }
  const mode = handlingMode || 'ai';
  if (!HANDLING_MODES.some((m) => m.id === mode)) {
    return { status: 400, body: { error: 'handlingMode must be ai, notify, or self' } };
  }

  const pid = (projectId && String(projectId).trim()) || ORG_GENERAL_PROJECT_ID;
  const { projects } = deps.getStore();
  if (pid !== ORG_GENERAL_PROJECT_ID) {
    const state = projects[pid];
    if (!state) {
      return { status: 404, body: { error: 'Project not found' } };
    }
    const assigned = (state.progress?.tasks || []).some((t) => taskAssigneeId(t) === personId);
    if (!assigned && source === 'human') {
      return { status: 400, body: { error: 'Not assigned to this project' } };
    }
  }

  if (person.availabilityStatus === 'on_leave' && kind !== 'emergency_return') {
    return {
      status: 400,
      body: {
        error: `${person.name} is on leave. For urgent work, HR must authorize emergency return.`,
      },
    };
  }

  const descParts = [
    description?.trim(),
    person ? `Submitted by: ${person.name} (${personId})` : null,
    startDate ? `Start: ${startDate}` : null,
    endDate ? `End: ${endDate}` : null,
    source === 'mock_worker' ? 'Submitted via worker portal simulation (NPC).' : null,
  ].filter(Boolean);

  const { validateTeamMemberRequestPayload } = require('./workerRequestTeamMember');
  const teamCheck = validateTeamMemberRequestPayload(
    {
      kind,
      title: title.trim(),
      description: descParts.join('\n') || title.trim(),
      personId,
      targetPersonId: targetPersonId?.trim() || undefined,
    },
    people
  );
  if (!teamCheck.ok) {
    return { status: 400, body: { error: teamCheck.error } };
  }

  const event = {
    id: crypto.randomUUID(),
    type: 'need',
    timestamp: new Date().toISOString(),
    projectId: pid,
    source,
    rationale: `${kind}: ${title.trim()}`,
    payload: {
      kind,
      title: title.trim(),
      description: descParts.join('\n') || title.trim(),
      status: mode === 'self' ? 'in_review' : 'open',
      handlingMode: mode,
      personId,
      submittedBy: personId,
      taskId: taskId || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      routingLabel: getRoutingForKind(kind, pid).label,
      requiresHrInbox: !!getRoutingForKind(kind, pid).hrInbox,
      targetPersonId: teamCheck.targetPersonId || targetPersonId?.trim() || undefined,
      targetPersonName: teamCheck.targetPersonName || undefined,
    },
  };

  await deps.emitEvent(event);

  const wrCtx = deps.buildWorkerRequestCtx();
  const routingResult = await processWorkerRequest(event, wrCtx);

  let oversight = null;
  if (mode === 'ai') {
    oversight = assessWorkerRequest(event, {
      getEventLog: wrCtx.getEventLog || deps.getEventLog,
      loadPeople: deps.loadPeople,
      getStore: deps.getStore,
    });
    event.payload.aiHandlerAssessment = oversight.action;
    event.payload.aiHandlerOversightReason = oversight.reason;

    if (
      oversight.action === ACTIONS.APPROVE_AUTONOMOUS ||
      oversight.action === ACTIONS.APPROVE_ROUTINE
    ) {
      event.payload.aiHandlerWatching = false;
      await autonomousApproveWorkerRequest(event, wrCtx, {
        ...routingResult,
        oversightReason: oversight.reason,
      });
    } else if (oversight.action === ACTIONS.REJECT) {
      const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
      await applyWorkerRequestReview(
        event,
        {
          status: 'rejected',
          reviewNotes: oversight.reviewNotes || oversight.reason,
          reviewedAt: new Date().toISOString(),
        },
        { id: 'ai_handler', name: 'AI Handler' },
        wrCtx
      );
    } else {
      event.payload.status =
        oversight.action === ACTIONS.NOTIFY_ONLY ? event.payload.status : 'in_review';
      event.payload.aiHandlerWatching = true;
    }
  }

  await deps.updateWorkerRequest(event.id, {
    status: event.payload.status,
    notifyTargets: event.payload.notifyTargets,
    forwardTargets: event.payload.forwardTargets,
    routingLabel: event.payload.routingLabel,
    forwardsTo: event.payload.forwardsTo,
    aiAgent: event.payload.aiAgent,
    forwardRoles: event.payload.forwardRoles,
    requiresHrInbox: event.payload.requiresHrInbox,
    assignedHrPersonId: event.payload.assignedHrPersonId,
    assignedReviewerPersonId: event.payload.assignedReviewerPersonId,
    primaryReviewerPersonIds: event.payload.primaryReviewerPersonIds,
    aiHandled: event.payload.aiHandled,
    aiAutoApproved: event.payload.aiAutoApproved,
    autoApprovedByName: event.payload.autoApprovedByName,
    reviewedBy: event.payload.reviewedBy,
    reviewedByName: event.payload.reviewedByName,
    reviewedAt: event.payload.reviewedAt,
    reviewNotes: event.payload.reviewNotes,
    effectsApplied: event.payload.effectsApplied,
    aiHandlerAssessment: event.payload.aiHandlerAssessment,
    aiHandlerOversightReason: event.payload.aiHandlerOversightReason,
    aiHandlerWatching: event.payload.aiHandlerWatching,
    roleAssignments: event.payload.roleAssignments,
  });

  return {
    status: 201,
    body: {
      accepted: true,
      id: event.id,
      projectId: pid,
      handlingMode: mode,
      forwardsTo: event.payload.forwardsTo,
      aiAgent: event.payload.aiAgent,
      forwardTargets: routingResult.forwardTargets,
      aiAutoApproved: !!event.payload.aiAutoApproved,
      status: event.payload.status,
      oversight: oversight
        ? { action: oversight.action, reason: oversight.reason }
        : undefined,
    },
  };
}

module.exports = { submitWorkerRequest };
