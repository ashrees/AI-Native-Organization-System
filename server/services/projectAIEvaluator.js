/**
 * Project AI — reevaluate project risk and status after human execution events.
 */

const crypto = require('crypto');
const { readPrompt, complete } = require('../lib/llm');
const { buildProjectMetrics } = require('./metrics');
const { buildAgentContext } = require('./retrieval');
const agentActivityLog = require('../lib/agentActivityLog');
const { RISK_LEVELS } = require('../models/eventSchema');

function agentLogMessage(text, maxSentences = 2) {
  if (text == null || typeof text !== 'string') return '';
  const t = text.trim();
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return t;
  return sentences.slice(0, maxSentences).join(' ');
}

function stubAssessment(metrics, triggerExecution) {
  const tasks = metrics.tasks || {};
  const total = tasks.total || 0;
  const done = tasks.done || 0;
  const blocked = tasks.blocked || 0;
  const inProgress = tasks.in_progress || 0;
  const blockerCount = metrics.blockers?.count || 0;
  const taskId = triggerExecution?.taskId;
  const status = triggerExecution?.status;

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
  if (status === 'done' && taskId) {
    summaryParts.push(`Task ${taskId} marked done (${done}/${total} tasks complete).`);
  } else if (status === 'blocked' && taskId) {
    summaryParts.push(`Task ${taskId} is blocked; project risk elevated.`);
  } else if (status === 'in_progress' && taskId) {
    summaryParts.push(`Task ${taskId} in progress (${done}/${total} done).`);
  } else {
    summaryParts.push(`Project has ${done}/${total} tasks done, ${blocked} blocked.`);
  }

  return {
    summary: summaryParts.join(' '),
    riskLevel,
    riskReason:
      blockerCount > 0 || blocked > 0
        ? `${blocked} blocked task(s), ${blockerCount} blocker(s) recorded`
        : done === total && total > 0
          ? 'All tasks complete'
          : `${done} of ${total} tasks done`,
    recentChanges: [
      taskId && status
        ? `Human execution: ${taskId} → ${status}`
        : 'Human execution updated task status',
    ],
    suggestProjectCompleted: total > 0 && done === total && blocked === 0 && blockerCount === 0,
  };
}

function normalizeAssessment(raw, metrics, triggerExecution) {
  if (!raw || typeof raw !== 'object') {
    return stubAssessment(metrics, triggerExecution);
  }
  let riskLevel = raw.riskLevel || metrics.risk?.level || 'medium';
  if (!RISK_LEVELS.includes(riskLevel)) riskLevel = 'medium';

  return {
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : stubAssessment(metrics, triggerExecution).summary,
    riskLevel,
    riskReason:
      typeof raw.riskReason === 'string'
        ? raw.riskReason.trim()
        : stubAssessment(metrics, triggerExecution).riskReason,
    recentChanges: Array.isArray(raw.recentChanges)
      ? raw.recentChanges.map(String).slice(0, 5)
      : [],
    suggestProjectCompleted: !!raw.suggestProjectCompleted,
  };
}

/**
 * Run Project AI evaluation and emit a project_assessment decision event.
 * @param {string} projectId
 * @param {object} triggerEvent - human execution event
 * @param {{ emitEvent, getStore, loadPeople }} ctx
 */
async function runProjectAIEvaluation(projectId, triggerEvent, ctx) {
  const { emitEvent, getStore, loadPeople } = ctx;
  const store = getStore();
  const projectState = store.projects[projectId];
  if (!projectState || projectState.status === 'killed') return null;

  const projectEvents = (store.eventLog || []).filter((e) => e.projectId === projectId);
  const metrics = buildProjectMetrics(projectState, projectEvents);
  const people = typeof loadPeople === 'function' ? loadPeople() : [];

  const triggerExecution = {
    taskId: triggerEvent.payload?.taskId,
    status: triggerEvent.payload?.status,
    notes: triggerEvent.payload?.notes,
    personId: triggerEvent.payload?.personId,
    timestamp: triggerEvent.timestamp,
  };

  const agentContext = buildAgentContext('project_ai', projectId, { triggerExecution }, {
    eventLog: store.eventLog,
    projects: store.projects,
    people,
    metrics: { projects: [metrics] },
  });

  const input = { triggerExecution, agentContext, metrics };
  const systemPrompt = readPrompt('projectAI');
  let assessment = stubAssessment(metrics, triggerExecution);

  if (systemPrompt) {
    const result = await complete(systemPrompt, JSON.stringify(input), {
      agent: 'project_ai',
      projectId,
      context: 'project_assessment',
      timeoutMs: 120000,
    });
    assessment = normalizeAssessment(result, metrics, triggerExecution);
  }

  const logSummary = agentLogMessage(assessment.summary) || assessment.riskReason;
  agentActivityLog.push({
    source: 'project_ai',
    projectId,
    message: `Reevaluated after human execution (${triggerExecution.status || 'update'} on ${triggerExecution.taskId || 'task'}): ${logSummary}`,
  });

  const decisionEvent = {
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'project_ai',
    correlationId: triggerEvent.id,
    rationale: logSummary,
    payload: {
      decisionType: 'project_assessment',
      riskLevel: assessment.riskLevel,
      riskReason: assessment.riskReason,
      summary: assessment.summary,
      recentChanges: assessment.recentChanges,
      suggestProjectCompleted: assessment.suggestProjectCompleted,
      triggerTaskId: triggerExecution.taskId,
      triggerStatus: triggerExecution.status,
    },
  };

  await emitEvent(decisionEvent);
  return { assessment, decisionEvent };
}

function scheduleProjectAIReevaluation(projectId, triggerEvent, ctx) {
  if (!triggerEvent || triggerEvent.type !== 'execution' || triggerEvent.source !== 'human') {
    return;
  }
  const state = ctx.getStore?.().projects?.[projectId];
  if (!state || state.status === 'killed') return;

  runProjectAIEvaluation(projectId, triggerEvent, ctx).catch((err) => {
    console.error('Project AI evaluation error:', err.message);
  });
}

module.exports = {
  runProjectAIEvaluation,
  scheduleProjectAIReevaluation,
  stubAssessment,
};
