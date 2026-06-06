/**
 * Project AI — delegate work to other agents (orchestrator, team_builder, scheduler).
 */

const crypto = require('crypto');
const schedulerAI = require('./schedulerAI');
const { fillAssignmentGaps, listUnassignedTasks, assignOneTask } = require('./assignmentGapFill');
const { buildAgentContext } = require('./retrieval');
const { buildAllProjectMetrics } = require('./metrics');
const agentActivityLog = require('../lib/agentActivityLog');

const AGENT_STEP_RETRIES = Math.max(0, parseInt(process.env.AGENT_STEP_RETRIES || '3', 10));
const AGENT_STEP_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.AGENT_STEP_RETRY_DELAY_MS || '1500', 10));

const VALID_AGENTS = Object.freeze(['orchestrator', 'team_builder', 'scheduler']);
const VALID_ACTIONS = Object.freeze([
  'assign_unassigned',
  'assign_task',
  'reschedule',
  'replan',
  'create_need',
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recentlyReplanned(eventLog, projectId, minutes = 15) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return (eventLog || []).some(
    (e) =>
      e.projectId === projectId &&
      e.type === 'request' &&
      e.source === 'system' &&
      e.timestamp &&
      new Date(e.timestamp).getTime() > cutoff &&
      (String(e.payload?.title || '').toLowerCase().includes('replan') ||
        String(e.rationale || '').toLowerCase().includes('replan'))
  );
}

function tasksNeedingSchedule(projectState, taskIds = null) {
  const tasks = projectState?.progress?.tasks || [];
  const idSet = taskIds?.length ? new Set(taskIds.map(String)) : null;
  return tasks.filter((t) => {
    if (t.status === 'done') return false;
    if (idSet && !idSet.has(String(t.id))) return false;
    const assigneeId = t.assigneeId || t.assignee?.id;
    if (!assigneeId) return false;
    return !t.scheduledStart || !t.scheduledEnd;
  });
}

function normalizeAgentActions(raw, metrics, projectState, store) {
  if (!Array.isArray(raw)) return stubAgentActions(metrics, projectState, store);
  const out = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue;
    const agent = String(item.agent || '').trim();
    const action = String(item.action || '').trim();
    if (!VALID_AGENTS.includes(agent) && !(agent === 'system' && action === 'create_need')) continue;
    if (!VALID_ACTIONS.includes(action)) continue;
    out.push({
      agent,
      action,
      reason: typeof item.reason === 'string' ? item.reason.trim().slice(0, 300) : undefined,
      taskId: item.taskId != null ? String(item.taskId) : undefined,
      taskIds: Array.isArray(item.taskIds) ? item.taskIds.map(String).slice(0, 20) : undefined,
      payload: item.payload && typeof item.payload === 'object' ? item.payload : undefined,
    });
  }
  const merged = out.length > 0 ? out : stubAgentActions(metrics, projectState, store);
  return pruneAgentActions(merged, projectState);
}

/** Drop scheduler/reschedule when every assigned task already has dates. */
function pruneAgentActions(actions, projectState) {
  const needsSchedule = tasksNeedingSchedule(projectState);
  return (actions || []).filter((a) => {
    if (a.agent === 'scheduler' && a.action === 'reschedule') {
      if (needsSchedule.length === 0) return false;
      if (Array.isArray(a.taskIds) && a.taskIds.length > 0) {
        const needIds = new Set(needsSchedule.map((t) => String(t.id)));
        return a.taskIds.some((id) => needIds.has(String(id)));
      }
      return true;
    }
    return true;
  });
}

function stubAgentActions(metrics, projectState, store) {
  const actions = [];
  const unassigned = listUnassignedTasks(projectState);
  if (unassigned.length > 0) {
    actions.push({
      agent: 'team_builder',
      action: 'assign_unassigned',
      reason: `${unassigned.length} open task(s) have no assignee`,
    });
  }

  const blocked = (metrics?.tasks?.blocked || 0) + (metrics?.blockers?.count || 0);
  const eventLog = store?.eventLog || [];
  const projectId = projectState?.id;
  if (blocked > 0 && projectId && !recentlyReplanned(eventLog, projectId)) {
    actions.push({
      agent: 'orchestrator',
      action: 'replan',
      reason: 'Blocked work may need an updated plan',
      payload: {
        title: 'Replan: address blockers',
        description: `${blocked} blocked item(s) on project`,
        priority: 'high',
      },
    });
  }

  const needsSchedule = tasksNeedingSchedule(projectState);
  if (needsSchedule.length > 0) {
    actions.push({
      agent: 'scheduler',
      action: 'reschedule',
      reason: `${needsSchedule.length} assigned task(s) lack schedule dates`,
      taskIds: needsSchedule.map((t) => t.id),
    });
  }

  const openNeeds = (projectState?.needs || []).filter((n) => n.status === 'open');
  if (blocked > 0 && openNeeds.length === 0) {
    actions.push({
      agent: 'system',
      action: 'create_need',
      reason: 'Track blocker resolution',
      payload: {
        kind: 'unblock',
        description: 'Project has blocked tasks; leadership input may be required',
      },
    });
  }

  return actions;
}

async function rescheduleTasks(projectId, taskIds, correlationId, ctx) {
  const { emitEvent, getStore, loadPeople, agentLogMessage } = ctx;
  const store = getStore();
  const projectState = store.projects[projectId];
  if (!projectState) return { scheduled: 0 };

  const targets = tasksNeedingSchedule(projectState, taskIds);
  if (targets.length === 0) return { scheduled: 0, skipped: 'none_need_schedule' };

  const tasksForScheduler = targets.map((t) => ({
    ...t,
    assigneeId: t.assigneeId || t.assignee?.id,
    assignee: t.assignee,
  }));

  const schedulerContext = buildAgentContext(
    'scheduler',
    projectId,
    { tasks: tasksForScheduler, projectAIReschedule: true },
    {
      eventLog: store.eventLog,
      projects: store.projects,
      people: loadPeople(),
      metrics: buildAllProjectMetrics(store.projects, store.eventLog),
    }
  );

  let scheduleResult = null;
  for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
    scheduleResult = await schedulerAI.proposeSchedule(tasksForScheduler, {
      agentContext: schedulerContext,
    });
    const needRetry =
      scheduleResult._usedStub &&
      scheduleResult._failReason === 'timed_out_or_no_response' &&
      attempt <= AGENT_STEP_RETRIES;
    if (!needRetry) break;
    await delay(AGENT_STEP_RETRY_DELAY_MS);
  }

  let count = 0;
  for (const prop of scheduleResult?.proposals || []) {
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'schedule_proposed',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'scheduler',
      correlationId,
      rationale: agentLogMessage(prop.rationale) || 'Schedule updated by Project AI request',
      payload: {
        taskId: prop.taskId,
        proposedStart: prop.proposedStart,
        proposedEnd: prop.proposedEnd,
        projectAIDelegated: true,
      },
    });
    count += 1;
  }

  return { scheduled: count };
}

async function triggerReplan(projectId, payload, correlationId, ctx) {
  const { emitEvent, getStore, handleRequestFlow, agentLogMessage } = ctx;
  const store = getStore();
  if (store.projects[projectId]?.status !== 'active') return { replanned: false };

  if (recentlyReplanned(store.eventLog, projectId)) {
    return { replanned: false, skipped: 'recent_replan' };
  }

  const title = payload?.title || 'Replan: Project AI status review';
  const requestEvent = {
    id: crypto.randomUUID(),
    type: 'request',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId,
    rationale: agentLogMessage(payload?.reason || title) || title,
    payload: {
      title,
      description: payload?.description || 'Project AI requested an updated plan based on current status',
      priority: payload?.priority || 'high',
      projectAIDelegated: true,
    },
  };

  await emitEvent(requestEvent);
  if (typeof handleRequestFlow === 'function') {
    await handleRequestFlow(requestEvent);
  }
  return { replanned: true, requestId: requestEvent.id };
}

async function createNeed(projectId, payload, correlationId, ctx) {
  const { emitEvent, getStore } = ctx;
  const kind = payload?.kind || 'general';
  const description = payload?.description;
  if (!description) return { created: false };

  const state = getStore().projects[projectId];
  const duplicate = (state?.needs || []).some(
    (n) => n.status === 'open' && n.kind === kind && n.description === description
  );
  if (duplicate) return { created: false, skipped: 'duplicate_need' };

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'need',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'project_ai',
    correlationId,
    rationale: description,
    payload: {
      kind,
      title: payload?.title || undefined,
      description,
      taskId: payload?.taskId || undefined,
      status: 'open',
    },
  });
  return { created: true };
}

/**
 * Execute agentActions from Project AI assessment.
 * @param {Array<object>} actions
 * @param {string} projectId
 * @param {object} correlationEvent - assessment decision event
 * @param {object} ctx
 */
async function executeAgentActions(actions, projectId, correlationEvent, ctx) {
  const correlationId = correlationEvent?.id;
  const gapFillCtx = ctx.buildAssignmentGapFillCtx?.() || ctx;
  const results = [];

  for (const step of actions) {
    const store = ctx.getStore?.();
    if (store?.projects?.[projectId]?.status !== 'active') break;

    try {
      if (step.agent === 'team_builder' && step.action === 'assign_unassigned') {
        const fill = await fillAssignmentGaps(projectId, correlationEvent, gapFillCtx);
        results.push({ ...step, result: fill });
        agentActivityLog.push({
          source: 'project_ai',
          projectId,
          message: `Delegated to Team Builder: assign unassigned tasks (${fill.assigned ?? 0} assigned).`,
        });
      } else if (step.agent === 'team_builder' && step.action === 'assign_task' && step.taskId) {
        const state = store.projects[projectId];
        const task = (state?.progress?.tasks || []).find((t) => String(t.id) === step.taskId);
        const unassigned = listUnassignedTasks(state);
        if (task && unassigned.some((t) => t.id === task.id)) {
          const assignedInRun = {};
          const updated = await assignOneTask(projectId, task, correlationId, assignedInRun, gapFillCtx);
          results.push({ ...step, result: { assigned: updated ? 1 : 0, taskId: step.taskId } });
          if (updated) {
            await rescheduleTasks(projectId, [step.taskId], correlationId, ctx);
            agentActivityLog.push({
              source: 'project_ai',
              projectId,
              message: `Delegated to Team Builder: assigned task ${step.taskId}.`,
            });
          }
        }
      } else if (step.agent === 'scheduler' && step.action === 'reschedule') {
        const res = await rescheduleTasks(projectId, step.taskIds, correlationId, ctx);
        results.push({ ...step, result: res });
        agentActivityLog.push({
          source: 'project_ai',
          projectId,
          message: `Delegated to Scheduler: updated schedule for ${res.scheduled ?? 0} task(s).`,
        });
      } else if (step.agent === 'orchestrator' && step.action === 'replan') {
        const res = await triggerReplan(projectId, { ...step.payload, reason: step.reason }, correlationId, ctx);
        results.push({ ...step, result: res });
        if (res.replanned) {
          agentActivityLog.push({
            source: 'project_ai',
            projectId,
            message: `Delegated to Orchestrator: replan requested (${step.reason || 'status review'}).`,
          });
        }
      } else if (step.action === 'create_need') {
        const res = await createNeed(projectId, step.payload || {}, correlationId, ctx);
        results.push({ ...step, result: res });
      }
    } catch (err) {
      console.error(`[Project AI actions] ${step.agent}/${step.action}:`, err.message);
      results.push({ ...step, error: err.message });
    }
  }

  return results;
}

module.exports = {
  VALID_AGENTS,
  VALID_ACTIONS,
  normalizeAgentActions,
  stubAgentActions,
  pruneAgentActions,
  executeAgentActions,
  recentlyReplanned, // exported for replan deduplication in events router
  tasksNeedingSchedule,
  rescheduleTasks,
  triggerReplan,
};
