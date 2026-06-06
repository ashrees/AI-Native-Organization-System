/**
 * Forward every worker request to the right roles and/or AI agents (all handling modes).
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { buildReviewTaskId } = require('../lib/reviewTaskIds');
const { getRoutingForKind, resolveForwardTargets, ROLES } = require('../constants/requestRouting');

async function createReviewTask(
  needEvent,
  ctx,
  assignee,
  reviewTitle,
  reviewDesc,
  submitterName,
  roleLabel,
  roleId
) {
  const { emitEvent } = ctx;
  const projectId = needEvent.projectId;
  const taskId = buildReviewTaskId(needEvent, roleId || roleLabel);

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'plan_created',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId: needEvent.id,
    rationale: `${roleLabel} review for worker request (${needEvent.payload.kind})`,
    payload: {
      tasks: [{ id: taskId, title: reviewTitle, description: reviewDesc }],
      summary: `${roleLabel}: review request from ${submitterName}`,
    },
  });

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'assignment',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'team_builder',
    correlationId: needEvent.id,
    rationale: `Worker request forwarded to ${assignee.name} (${roleLabel})`,
    payload: {
      taskId,
      personId: assignee.id,
      person: {
        id: assignee.id,
        name: assignee.name,
        department: assignee.department,
        team: assignee.team,
        role: assignee.role,
      },
    },
  });

  return {
    taskId,
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    roleLabel,
    role: roleId || roleLabel,
  };
}

/**
 * @param {object} needEvent
 * @param {object} ctx - { emitEvent, loadPeople, getStore, handlingMode }
 */
async function processWorkerRequest(needEvent, ctx) {
  const { emitEvent, loadPeople, getStore } = ctx;
  const handlingMode = needEvent.payload?.handlingMode || 'notify';
  const { kind, personId } = needEvent.payload || {};
  const title =
    needEvent.payload?.title?.trim() ||
    needEvent.payload?.kind ||
    'Worker request';
  const people = loadPeople();
  const { projects } = getStore();
  const projectId = needEvent.projectId;
  const submitter = people.find((p) => p.id === personId);
  const submitterName = submitter?.name || personId;

  const routing = getRoutingForKind(kind, projectId);
  const forwardTargets = resolveForwardTargets(kind, projectId, projects, people, personId);

  needEvent.payload.forwardTargets = forwardTargets;
  needEvent.payload.notifyTargets = forwardTargets;
  needEvent.payload.routingLabel = routing.label;
  needEvent.payload.forwardsTo = routing.forwardsTo;
  needEvent.payload.aiAgent = routing.aiAgent;
  needEvent.payload.forwardRoles = routing.roles;
  needEvent.payload.requiresHrInbox = !!routing.hrInbox;

  const targetSummary =
    forwardTargets.map((t) => `${t.name} (${t.roleLabel})`).join(', ') || 'pending assignment';

  agentActivityLog.push({
    source: routing.aiAgent || 'org_ai',
    projectId,
    message: `Worker request "${title}" from ${submitterName} [${handlingMode}]. Forwarded to: ${targetSummary}.`,
  });

  const reviewTitle = `Review worker request: ${title}`;
  const reviewDesc = needEvent.payload.description || title;
  const assignments = [];

  const assignedRoles = new Set();

  if (handlingMode === 'ai') {
    const hrTarget = forwardTargets.find((t) => t.role === 'hr' && t.personId);
    if (hrTarget) needEvent.payload.assignedHrPersonId = hrTarget.personId;
    const nonHr = forwardTargets.find((t) => t.role !== 'hr' && t.personId);
    if (nonHr) needEvent.payload.assignedReviewerPersonId = nonHr.personId;
    needEvent.payload.aiHandled = true;
    needEvent.payload.status = 'open';
    agentActivityLog.push({
      source: 'ai_handler',
      projectId,
      message: `AI Handler evaluating "${title}" — autonomous approval only if oversight policy allows.`,
    });
  }

  if (handlingMode === 'notify' || handlingMode === 'self') {
    for (const target of forwardTargets) {
      const agent = target.agent || routing.aiAgent || 'org_ai';
      const msg = `${submitterName} submitted ${kind}: "${title}". Action needed (${target.roleLabel}).`;
      if (target.personId) {
        agentActivityLog.push({
          source: agent,
          projectId,
          message: `${msg} Notified: ${target.name}.`,
          meta: { notifyPersonId: target.personId, needId: needEvent.id, role: target.role },
        });
      } else {
        agentActivityLog.push({
          source: agent,
          projectId,
          message: `${msg} Notify: ${target.name} (no person id).`,
        });
      }
    }
    if (handlingMode === 'self') {
      agentActivityLog.push({
        source: 'system',
        projectId,
        message: `${submitterName} self-managing "${title}"; roles notified: ${routing.forwardsTo}.`,
      });
    }

    const reviewerRoles = new Set(['hr', 'project_lead', 'engineering_mgmt', 'finance', 'legal']);
    for (const target of forwardTargets) {
      if (!target.personId || !reviewerRoles.has(target.role)) continue;
      if (assignedRoles.has(target.role)) continue;
      assignedRoles.add(target.role);
      const assignee = people.find((p) => p.id === target.personId);
      if (!assignee) continue;
      try {
        const a = await createReviewTask(
          needEvent,
          ctx,
          assignee,
          reviewTitle,
          reviewDesc,
          submitterName,
          target.roleLabel,
          target.role
        );
        assignments.push(a);
      } catch (err) {
        console.warn('[workerRequest] review task skipped:', err.message);
      }
    }

    if (assignments.length) {
      needEvent.payload.roleAssignments = assignments;
    }

    if (forwardTargets.some((t) => t.personId)) {
      needEvent.payload.primaryReviewerPersonIds = forwardTargets
        .filter((t) => t.personId && t.role !== 'project_team')
        .map((t) => t.personId);
      if (needEvent.payload.status === 'open') {
        needEvent.payload.status = 'in_review';
      }
    }
  }

  return { forwardTargets, routing, handlingMode, assignments };
}

module.exports = { processWorkerRequest, createReviewTask };
