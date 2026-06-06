/**
 * Project AI — monitor project status and delegate to other agents.
 */

const crypto = require('crypto');
const { readPrompt, complete, OLLAMA_TOOLS } = require('../lib/llm');
const { buildProjectMetrics } = require('./metrics');
const { buildAgentContext } = require('./retrieval');
const agentActivityLog = require('../lib/agentActivityLog');
const { RISK_LEVELS } = require('../models/eventSchema');
const { normalizeAgentActions, executeAgentActions } = require('./projectAIActions');

const DEBOUNCE_MS = Math.max(0, parseInt(process.env.PROJECT_AI_DEBOUNCE_MS || '15000', 10));
const POLL_INTERVAL_MS = Math.max(0, parseInt(process.env.PROJECT_AI_POLL_INTERVAL_MS || '300000', 10));

const pendingChecks = new Map();
const lastCheckAt = new Map();
let pollTimer = null;

function agentLogMessage(text, maxSentences = 2) {
  if (text == null || typeof text !== 'string') return '';
  const t = text.trim();
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return t;
  return sentences.slice(0, maxSentences).join(' ');
}

function formatTrigger(triggerEvent) {
  if (!triggerEvent) return { type: 'poll', source: 'system' };
  const p = triggerEvent.payload || {};
  return {
    type: triggerEvent.type,
    source: triggerEvent.source,
    eventId: triggerEvent.id,
    taskId: p.taskId,
    status: p.status,
    notes: p.notes,
    poll: p.poll === true || triggerEvent.type === 'poll',
  };
}

function stubAssessment(metrics, trigger, projectState, projectEvents) {
  const { scanDeliverableGaps, gapsToSummary, gapsToAgentActions } = require('./projectAIDeliverables');
  const deliverableGaps = scanDeliverableGaps(projectState, projectEvents);
  const tasks = metrics.tasks || {};
  const total = tasks.total || 0;
  const done = tasks.done || 0;
  const blocked = tasks.blocked || 0;
  const inProgress = tasks.in_progress || 0;
  const blockerCount = metrics.blockers?.count || 0;
  const taskId = trigger?.taskId;
  const status = trigger?.status;

  let riskLevel = metrics.risk?.level || 'medium';
  if (blockerCount > 0 || blocked > 0) {
    riskLevel = 'high';
  } else if (total > 0 && done === total) {
    riskLevel = 'low';
  } else if (total > 0 && done / total >= 0.5 && blocked === 0) {
    riskLevel = 'low';
  } else if (inProgress > 0 && blocked === 0) {
    riskLevel = 'medium';
  }

  const summaryParts = [];
  if (trigger?.poll) {
    summaryParts.push(`Periodic status check: ${done}/${total} tasks done, ${blocked} blocked.`);
  } else if (status === 'done' && taskId) {
    summaryParts.push(`Task ${taskId} marked done (${done}/${total} tasks complete).`);
  } else if (status === 'blocked' && taskId) {
    summaryParts.push(`Task ${taskId} is blocked; project risk elevated.`);
  } else if (status === 'in_progress' && taskId) {
    summaryParts.push(`Task ${taskId} in progress (${done}/${total} done).`);
  } else {
    summaryParts.push(`Project has ${done}/${total} tasks done, ${blocked} blocked.`);
  }

  let suggestProjectCompleted =
    total > 0 && done === total && blocked === 0 && blockerCount === 0;
  let gapActions = [];

  if (deliverableGaps.length > 0) {
    suggestProjectCompleted = false;
    if (riskLevel === 'low') riskLevel = 'medium';
    const gapSummary = gapsToSummary(deliverableGaps);
    if (gapSummary) summaryParts.push(gapSummary);
    gapActions = gapsToAgentActions(deliverableGaps, projectState, projectEvents);
  }

  return {
    summary: summaryParts.join(' '),
    riskLevel,
    riskReason:
      deliverableGaps.length > 0
        ? gapsToSummary(deliverableGaps)
        : blockerCount > 0 || blocked > 0
          ? `${blocked} blocked task(s), ${blockerCount} blocker(s) recorded`
          : done === total && total > 0
            ? 'All tasks complete'
            : `${done} of ${total} tasks done`,
    recentChanges: [
      taskId && status
        ? `Update: ${taskId} → ${status}`
        : trigger?.poll
          ? 'Periodic project status review'
          : 'Project status reviewed',
      ...deliverableGaps.slice(0, 2).map((g) => `Gap: ${g.type}${g.evidence ? ` — ${g.evidence}` : ''}`),
    ],
    suggestProjectCompleted,
    deliverableGaps,
    agentActions: gapActions,
  };
}

function normalizeAssessment(raw, metrics, trigger, projectState, store, projectEvents) {
  const stub = stubAssessment(metrics, trigger, projectState, projectEvents);
  if (!raw || typeof raw !== 'object') {
    return {
      ...stub,
      agentActions: normalizeAgentActions([], metrics, projectState, store),
    };
  }
  let riskLevel = raw.riskLevel || metrics.risk?.level || 'medium';
  if (!RISK_LEVELS.includes(riskLevel)) riskLevel = 'medium';

  let suggestProjectCompleted = !!raw.suggestProjectCompleted;
  if ((stub.deliverableGaps || []).length > 0) {
    suggestProjectCompleted = false;
  }

  const baseActions = normalizeAgentActions(raw.agentActions, metrics, projectState, store);
  const { gapsToAgentActions } = require('./projectAIDeliverables');
  const gapActions = gapsToAgentActions(stub.deliverableGaps || [], projectState, projectEvents);
  let mergedActions = [...gapActions, ...baseActions].slice(0, 6);

  const noGaps = !(stub.deliverableGaps || []).length;
  const llmMentionsBudgetGap = (text) =>
    /\b(budget|deliverable)\b.*\b(gap|missing|unresolved|loop|not\s+confirmed)\b/i.test(text || '');

  let summary = typeof raw.summary === 'string' ? raw.summary.trim() : stub.summary;
  let riskReason = typeof raw.riskReason === 'string' ? raw.riskReason.trim() : stub.riskReason;

  if (noGaps) {
    if (llmMentionsBudgetGap(summary) || llmMentionsBudgetGap(riskReason)) {
      summary = stub.summary;
      riskReason = stub.riskReason;
    }
    if (stub.suggestProjectCompleted) {
      suggestProjectCompleted = true;
      riskLevel = stub.riskLevel;
    } else if (noGaps && stub.riskLevel === 'low' && riskLevel === 'high') {
      riskLevel = 'low';
    }
    mergedActions = mergedActions.filter(
      (a) =>
        !(
          a.action === 'create_need' &&
          (a.payload?.kind === 'budget_request' ||
            String(a.payload?.kind || '').includes('budget'))
        )
    );
  }

  return {
    summary,
    riskLevel: (stub.deliverableGaps || []).length > 0 && riskLevel === 'low' ? 'medium' : riskLevel,
    riskReason,
    recentChanges: Array.isArray(raw.recentChanges) ? raw.recentChanges.map(String).slice(0, 5) : stub.recentChanges,
    suggestProjectCompleted,
    deliverableGaps: stub.deliverableGaps || [],
    agentActions: mergedActions,
  };
}

function shouldScheduleStatusCheck(event) {
  if (!event || !event.projectId) return false;
  if (event.source === 'project_ai') return false;

  const watchTypes = new Set([
    'execution',
    'plan_created',
    'assignment',
    'schedule_proposed',
    'need',
    'unassignment',
    'request',
    'poll',
  ]);
  if (watchTypes.has(event.type)) return true;

  if (event.type === 'decision') {
    const dt = event.payload?.decisionType || '';
    if (dt === 'project_assessment' && event.source === 'project_ai') return false;
    if (dt === 'assignment_gap_fill') return false;
    const rationale = event.rationale || event.payload?.summary || '';
    if (
      event.source === 'human' &&
      /\bworker request\b/i.test(rationale) &&
      /\bapproved\b/i.test(rationale) &&
      /\bbudget\b/i.test(rationale)
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Run Project AI evaluation, emit project_assessment, then delegate to other agents.
 */
async function runProjectAIEvaluation(projectId, triggerEvent, ctx) {
  const { emitEvent, getStore, loadPeople } = ctx;
  const store = getStore();
  const projectState = store.projects[projectId];
  if (!projectState || projectState.status === 'killed' || projectState.archived) {
    return null;
  }

  const pendingTasks = (projectState.progress?.tasks || []).filter((t) => t.status !== 'done');
  if (projectState.status === 'completed' && pendingTasks.length === 0) {
    return null;
  }
  if (projectState.status === 'completed' && pendingTasks.length > 0) {
    projectState.status = 'active';
    projectState.closedAt = null;
  }

  const projectEvents = (store.eventLog || []).filter((e) => e.projectId === projectId);
  const metrics = buildProjectMetrics(projectState, projectEvents);
  const people = typeof loadPeople === 'function' ? loadPeople() : [];
  const trigger = formatTrigger(triggerEvent);

  const agentContext = buildAgentContext('project_ai', projectId, { trigger }, {
    eventLog: store.eventLog,
    projects: store.projects,
    people,
    metrics: { projects: [metrics] },
  });

  const tasksDetail = (projectState.progress?.tasks || []).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status || 'pending',
    assigneeId: t.assigneeId || t.assignee?.id || null,
    scheduledStart: t.scheduledStart || null,
    scheduledEnd: t.scheduledEnd || null,
    hasSchedule: Boolean(t.scheduledStart && t.scheduledEnd),
  }));

  const { scanDeliverableGaps } = require('./projectAIDeliverables');
  const deliverableGaps = scanDeliverableGaps(projectState, projectEvents);
  const recentSignals = projectEvents.slice(-12).map((e) => ({
    type: e.type,
    source: e.source,
    timestamp: e.timestamp,
    rationale: (e.rationale || '').slice(0, 160),
    decisionType: e.payload?.decisionType,
    taskId: e.payload?.taskId,
    status: e.payload?.status,
    notes: e.payload?.notes ? String(e.payload.notes).slice(0, 160) : undefined,
  }));

  const input = {
    trigger,
    agentContext,
    metrics,
    tasks: tasksDetail,
    deliverableGaps,
    recentSignals,
  };
  const systemPrompt = readPrompt('projectAI');
  let assessment = normalizeAssessment(null, metrics, trigger, projectState, store, projectEvents);

  if (systemPrompt) {
    const result = await complete(systemPrompt, JSON.stringify(input), {
      agent: 'project_ai',
      projectId,
      projectTitle: projectState.title || projectId,
      context: 'project_assessment',
      timeoutMs: 120000,
      tools: OLLAMA_TOOLS.projectAI,
    });
    assessment = normalizeAssessment(result, metrics, trigger, projectState, store, projectEvents);
  } else {
    assessment.agentActions = normalizeAgentActions(
      assessment.agentActions || [],
      metrics,
      projectState,
      store
    );
  }

  const actionSummary =
    assessment.agentActions.length > 0
      ? ` Next: ${assessment.agentActions.map((a) => `${a.agent}/${a.action}`).join(', ')}.`
      : '';

  const logSummary =
    agentLogMessage(assessment.summary) || assessment.riskReason;
  agentActivityLog.push({
    source: 'project_ai',
    projectId,
    message: `Status review (${trigger.type || 'check'}): ${logSummary}${actionSummary}`,
  });

  const decisionEvent = {
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'project_ai',
    correlationId: triggerEvent?.id,
    rationale: logSummary,
    payload: {
      decisionType: 'project_assessment',
      riskLevel: assessment.riskLevel,
      riskReason: assessment.riskReason,
      summary: assessment.summary,
      recentChanges: assessment.recentChanges,
      suggestProjectCompleted: assessment.suggestProjectCompleted,
      triggerType: trigger.type,
      triggerTaskId: trigger.taskId,
      triggerStatus: trigger.status,
      agentActions: assessment.agentActions,
      deliverableGapCount: (assessment.deliverableGaps || []).length,
      deliverableGaps: (assessment.deliverableGaps || []).slice(0, 12),
    },
  };

  await emitEvent(decisionEvent);

  if (assessment.agentActions.length > 0) {
    await executeAgentActions(assessment.agentActions, projectId, decisionEvent, ctx);
  }

  return { assessment, decisionEvent };
}

function scheduleProjectStatusCheck(projectId, triggerEvent, ctx) {
  if (!projectId || !ctx) return;
  if (triggerEvent && !shouldScheduleStatusCheck(triggerEvent)) return;

  const state = ctx.getStore?.().projects?.[projectId];
  if (!state || state.status !== 'active') return;

  if (pendingChecks.has(projectId)) {
    clearTimeout(pendingChecks.get(projectId));
  }

  const now = Date.now();
  const last = lastCheckAt.get(projectId) || 0;
  const waitMs = Math.max(500, DEBOUNCE_MS - (now - last));

  const timeoutId = setTimeout(() => {
    pendingChecks.delete(projectId);
    lastCheckAt.set(projectId, Date.now());
    runProjectAIEvaluation(projectId, triggerEvent, ctx).catch((err) => {
      console.error('Project AI evaluation error:', err.message);
    });
  }, waitMs);

  pendingChecks.set(projectId, timeoutId);
}

/** @deprecated use scheduleProjectStatusCheck */
function scheduleProjectAIReevaluation(projectId, triggerEvent, ctx) {
  scheduleProjectStatusCheck(projectId, triggerEvent, ctx);
}

function startProjectAIStatusPolling(ctx) {
  if (POLL_INTERVAL_MS <= 0 || pollTimer) return;
  const activeIds = () => {
    const store = ctx.getStore?.();
    if (!store?.projects) return [];
    return Object.entries(store.projects)
      .filter(([, state]) => state.status === 'active')
      .map(([id]) => id);
  };
  let pollCursor = 0;
  pollTimer = setInterval(() => {
    const ids = activeIds();
    if (ids.length === 0) return;
    const batch = Math.min(3, ids.length);
    for (let i = 0; i < batch; i++) {
      const projectId = ids[(pollCursor + i) % ids.length];
      scheduleProjectStatusCheck(
        projectId,
        {
          id: `poll-${projectId}-${Date.now()}`,
          type: 'poll',
          timestamp: new Date().toISOString(),
          projectId,
          source: 'system',
          payload: { poll: true },
        },
        ctx
      );
    }
    pollCursor = (pollCursor + batch) % Math.max(1, ids.length);
  }, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  console.log(`[Project AI] Status polling every ${Math.round(POLL_INTERVAL_MS / 1000)}s (staggered)`);
}

function stopProjectAIPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const t of pendingChecks.values()) clearTimeout(t);
  pendingChecks.clear();
}

function getProjectAIRuntimeStatus() {
  return {
    pendingChecks: pendingChecks.size,
    pollIntervalMs: POLL_INTERVAL_MS,
    debounceMs: DEBOUNCE_MS,
  };
}

module.exports = {
  stopProjectAIPolling,
  runProjectAIEvaluation,
  scheduleProjectStatusCheck,
  scheduleProjectAIReevaluation,
  startProjectAIStatusPolling,
  shouldScheduleStatusCheck,
  getProjectAIRuntimeStatus,
  stubAssessment,
};
