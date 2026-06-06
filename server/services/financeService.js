/**
 * Revenue / budget analytics and mutations (event-sourced via project decisions & needs).
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const {
  ensureFinance,
  computeFinanceMetrics,
  appendBurn,
  defaultFinanceForProject,
} = require('../lib/projectFinance');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');

function loadStoreFromEventsRouter() {
  const eventsRouter = require('../routes/events');
  return {
    projects: eventsRouter.getStore?.().projects || {},
    eventLog: eventsRouter.getEventLog?.() || [],
    emitEvent: eventsRouter.emitEvent,
    loadPeople: eventsRouter.loadPeople,
  };
}

function projectFinanceRow(projectId, state) {
  const finance = ensureFinance({ ...state, finance: state.finance || defaultFinanceForProject(state) });
  const metrics = computeFinanceMetrics(finance);
  const tasks = state.progress?.tasks || [];
  const done = tasks.filter((t) => t.status === 'done').length;
  return {
    projectId,
    title: state.title || projectId,
    department: state.department || 'Other',
    status: state.status || 'active',
    archived: !!state.archived,
    currency: finance.currency || 'USD',
    finance: { ...finance, metrics },
    taskCount: tasks.length,
    tasksDone: done,
  };
}

function isRevenueProject(projectId, state) {
  if (!state || !projectId) return false;
  if (projectId === ORG_GENERAL_PROJECT_ID) return false;
  return true;
}

function buildRevenueAnalytics(store) {
  const projects = store.projects || {};
  const rows = [];
  for (const [projectId, state] of Object.entries(projects)) {
    if (!isRevenueProject(projectId, state)) continue;
    rows.push(projectFinanceRow(projectId, state));
  }

  const phaseRank = (r) => {
    if (r.archived) return 3;
    if (r.status === 'killed') return 2;
    if (r.status === 'completed') return 1;
    return 0;
  };
  rows.sort((a, b) => {
    const pr = phaseRank(a) - phaseRank(b);
    if (pr !== 0) return pr;
    return b.finance.metrics.utilizationPct - a.finance.metrics.utilizationPct;
  });

  const totals = rows.reduce(
    (acc, r) => {
      const m = r.finance.metrics;
      acc.budgetTotal += m.budgetTotal;
      acc.budgetSpent += m.budgetSpent;
      acc.remaining += m.remaining;
      acc.revenuePlanned += m.revenuePlanned || 0;
      acc.burn7d += m.burn7d;
      return acc;
    },
    { budgetTotal: 0, budgetSpent: 0, remaining: 0, revenuePlanned: 0, burn7d: 0 }
  );
  totals.utilizationPct =
    totals.budgetTotal > 0 ? Math.round((totals.budgetSpent / totals.budgetTotal) * 100) : 0;

  const byDepartment = new Map();
  for (const r of rows) {
    const dept = r.department || 'Other';
    if (!byDepartment.has(dept)) {
      byDepartment.set(dept, {
        department: dept,
        projectCount: 0,
        budgetTotal: 0,
        budgetSpent: 0,
        remaining: 0,
        burn7d: 0,
      });
    }
    const d = byDepartment.get(dept);
    d.projectCount += 1;
    d.budgetTotal += r.finance.metrics.budgetTotal;
    d.budgetSpent += r.finance.metrics.budgetSpent;
    d.remaining += r.finance.metrics.remaining;
    d.burn7d += r.finance.metrics.burn7d;
  }

  const departmentSummary = [...byDepartment.values()]
    .map((d) => ({
      ...d,
      utilizationPct: d.budgetTotal > 0 ? Math.round((d.budgetSpent / d.budgetTotal) * 100) : 0,
    }))
    .sort((a, b) => b.budgetSpent - a.budgetSpent);

  const matrix = {
    columns: ['Budget', 'Spent', 'Remaining', 'Util %', '7d burn', 'Runway (d)'],
    rows: rows.map((r) => {
      const m = r.finance.metrics;
      return {
        projectId: r.projectId,
        name: r.title,
        department: r.department,
        values: [
          m.budgetTotal,
          m.budgetSpent,
          m.remaining,
          m.utilizationPct,
          m.burn7d,
          m.runwayDays ?? 0,
        ],
      };
    }),
  };

  const openBudgetRequests = (store.eventLog || []).filter(
    (e) =>
      e.type === 'need' &&
      e.payload?.kind === 'budget_request' &&
      ['open', 'in_review'].includes(e.payload?.status || 'open')
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totals,
    projects: rows,
    departmentSummary,
    matrix,
    methodology: {
      budget: 'Per-project budget from finance decisions; defaults estimated from team size and task count until set.',
      burn: 'Recorded on manual burn, task completion (auto), and approved spend decisions.',
      runway: 'Remaining budget ÷ average daily burn (7-day window).',
      matrix:
        'Rows include all portfolio projects (active, completed, killed, and archived). Org-general is excluded. Higher utilization highlights budget pressure.',
    },
    openBudgetRequests,
  };
}

async function emitFinanceDecision(projectId, decisionType, payload, ctx) {
  const event = {
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'human',
    rationale: payload.summary || decisionType,
    payload: { decisionType, ...payload },
  };
  await ctx.emitEvent(event);
  return event;
}

async function setProjectBudget(projectId, { budgetTotal, revenuePlanned, currency, reason }, ctx) {
  const store = ctx.getStore();
  const state = store.projects[projectId];
  if (!state) return { error: 'Project not found' };
  const amount = Number(budgetTotal);
  if (!amount || amount < 0) return { error: 'budgetTotal must be a positive number' };

  await emitFinanceDecision(
    projectId,
    'budget_set',
    {
      budgetTotal: amount,
      revenuePlanned: revenuePlanned != null ? Number(revenuePlanned) : undefined,
      currency: currency || 'USD',
      reason,
      summary: `Budget set to ${amount}${revenuePlanned ? `; planned revenue ${revenuePlanned}` : ''}.`,
    },
    ctx
  );
  return { ok: true, projectId, budgetTotal: amount };
}

async function recordBudgetBurn(projectId, { amount, reason, taskId, source }, ctx) {
  const store = ctx.getStore();
  const state = store.projects[projectId];
  if (!state) return { error: 'Project not found' };
  const amt = Number(amount);
  if (!amt || amt <= 0) return { error: 'amount must be positive' };

  const finance = ensureFinance(state);
  if (finance.budgetSpent + amt > finance.budgetTotal * 1.05) {
    return {
      error: 'Burn exceeds budget (+5% tolerance). Request additional budget first.',
      code: 'over_budget',
      metrics: computeFinanceMetrics(finance),
    };
  }

  await emitFinanceDecision(projectId, 'budget_burn', {
    amount: amt,
    reason: reason || 'Project spend',
    taskId,
    source: source || 'manual',
    summary: `Burned ${amt} on ${state.title || projectId}.`,
  }, ctx);

  return { ok: true, amount: amt };
}

async function requestAdditionalBudget(projectId, { amount, reason, requestedBy }, ctx) {
  const store = ctx.getStore();
  const state = store.projects[projectId];
  if (!state) return { error: 'Project not found' };
  const add = Number(amount);
  if (!add || add <= 0) return { error: 'amount must be positive' };

  const finance = ensureFinance(state);
  const metrics = computeFinanceMetrics(finance);

  const event = {
    id: crypto.randomUUID(),
    type: 'need',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'human',
    rationale: `Budget increase request: +${add}`,
    payload: {
      kind: 'budget_request',
      title: `Additional budget for ${state.title || projectId}`,
      description: [
        reason || 'Additional funding required to continue delivery.',
        `Current budget: ${metrics.budgetTotal}, spent: ${metrics.budgetSpent}, remaining: ${metrics.remaining}.`,
        `Requested increase: ${add}.`,
        requestedBy ? `Requested by: ${requestedBy}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      status: 'open',
      handlingMode: 'notify',
      personId: requestedBy || 'leadership',
      submittedBy: requestedBy || 'leadership',
      requestedAmount: add,
      requiresHrInbox: false,
      routingLabel: 'Finance',
      forwardsTo: 'Finance',
    },
  };

  await ctx.emitEvent(event);
  agentActivityLog.push({
    source: 'human',
    projectId,
    message: `Budget request +${add} for ${state.title || projectId}.`,
  });

  return { ok: true, needId: event.id, requestedAmount: add };
}

async function approveBudgetRequest(needId, { approvedAmount, reviewerName }, ctx) {
  const need = ctx.getEventLog().find((e) => e.id === needId && e.type === 'need');
  if (!need) return { error: 'Request not found' };
  const add = Number(approvedAmount || need.payload?.requestedAmount);
  if (!add || add <= 0) return { error: 'approvedAmount required' };

  await emitFinanceDecision(need.projectId, 'budget_increase', {
    amount: add,
    needId,
    summary: `Approved additional budget +${add} (${reviewerName || 'Finance'}).`,
  }, ctx);

  need.payload.status = 'approved';
  need.payload.reviewedAt = new Date().toISOString();
  if (ctx.updateWorkerRequest) await ctx.updateWorkerRequest(needId, need.payload);

  return { ok: true, approvedAmount: add, projectId: need.projectId };
}

/** Auto burn when a task is marked done (scaled by role load). */
async function recordTaskCompletionBurn(projectId, taskId, personId, ctx) {
  const store = ctx.getStore();
  const state = store.projects[projectId];
  if (!state || state.status !== 'active') return null;

  const task = (state.progress?.tasks || []).find((t) => t.id === taskId);
  if (!task) return null;

  const finance = ensureFinance(state);
  const metrics = computeFinanceMetrics(finance);
  if (metrics.remaining <= 0) return { skipped: 'no_budget_remaining' };

  const baseBurn = 800 + Math.min(4200, (task.title || '').length * 40);
  const amount = Math.min(baseBurn, Math.max(200, Math.round(metrics.remaining * 0.08)));

  if (finance.budgetSpent + amount > finance.budgetTotal) return { skipped: 'over_budget' };

  return recordBudgetBurn(projectId, {
    amount,
    reason: `Task completed: ${task.title || taskId}`,
    taskId,
    source: 'task_completion',
  }, ctx);
}

module.exports = {
  buildRevenueAnalytics,
  setProjectBudget,
  recordBudgetBurn,
  requestAdditionalBudget,
  approveBudgetRequest,
  recordTaskCompletionBurn,
  loadStoreFromEventsRouter,
  projectFinanceRow,
};
