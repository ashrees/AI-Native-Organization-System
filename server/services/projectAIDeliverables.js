/**
 * Deliverable / compliance gaps Project AI must catch from the full event stream.
 */

const BUDGET_REPORT_TEXT =
  /\b(budget|expenses?)\s*(report|submission|expense)|submit\s+(the\s+)?budget|budget\s+expenses?\s+report/i;

const BUDGET_STILL_MISSING_RE =
  /\b(report\s+not\s+(created|submitted)|not\s+submitted|not\s+confirmed|still\s+missing|deliverable\s+gap|unresolved|pending\s+submission|cannot\s+close)\b/i;

const BUDGET_APPROVAL_RE =
  /\b(approved|confirmed|submitted|resolved|met|fulfilled|closed|complete)\b/i;

const CLOSED_NEED_STATUSES = new Set([
  'met',
  'approved',
  'fulfilled',
  'closed',
  'rejected',
  'cancelled',
]);

function mentionText(...parts) {
  return parts.filter(Boolean).join(' ').trim();
}

function budgetTasks(projectState) {
  return (projectState?.progress?.tasks || []).filter((t) =>
    BUDGET_REPORT_TEXT.test(`${t.title || ''} ${t.description || ''}`)
  );
}

function isBudgetWorkerRequestApproval(event) {
  const text = mentionText(event.rationale, event.payload?.summary, event.payload?.reviewNotes);
  if (!text || !BUDGET_REPORT_TEXT.test(text)) return false;
  return (
    /\bworker request\b/i.test(text) &&
    BUDGET_APPROVAL_RE.test(text) &&
    !BUDGET_STILL_MISSING_RE.test(text)
  );
}

/**
 * Budget report is satisfied when the plan task is done and/or finance needs were approved.
 */
function isBudgetDeliverableSatisfied(projectState, projectEvents = []) {
  const tasks = budgetTasks(projectState);
  if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) {
    return true;
  }

  const events = (projectEvents || []).slice(-60);
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === 'execution' && p.status === 'done' && p.taskId) {
      const task = tasks.find((t) => t.id === p.taskId);
      if (task) return true;
    }
    if (
      e.type === 'need' &&
      (p.kind === 'budget_request' || String(p.kind || '').includes('budget')) &&
      CLOSED_NEED_STATUSES.has(p.status || '')
    ) {
      return true;
    }
    if (e.type === 'decision' && isBudgetWorkerRequestApproval(e)) {
      return true;
    }
    if (
      e.type === 'decision' &&
      ['budget_report_submitted', 'budget_report_confirmed', 'budget_submitted'].includes(
        p.decisionType || ''
      )
    ) {
      return true;
    }
  }

  for (const n of projectState?.needs || []) {
    if (
      (n.kind === 'budget_request' || String(n.kind || '').includes('budget')) &&
      CLOSED_NEED_STATUSES.has(n.status || '')
    ) {
      return true;
    }
  }

  return false;
}

function scanDeliverableGaps(projectState, projectEvents = []) {
  const gaps = [];
  const seen = new Set();
  const budgetSatisfied = isBudgetDeliverableSatisfied(projectState, projectEvents);
  const tasks = projectState?.progress?.tasks || [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const add = (gap) => {
    if (budgetSatisfied && (gap.type.startsWith('budget') || gap.type === 'open_budget_need')) {
      return;
    }
    const key = `${gap.type}:${gap.taskId || ''}:${(gap.evidence || '').slice(0, 60)}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push(gap);
  };

  const events = (projectEvents || []).slice(-80);

  for (const e of events) {
    const p = e.payload || {};

    if (e.type === 'execution') {
      const taskId = p.taskId;
      const task = taskId ? taskById.get(taskId) : null;
      if (task?.status === 'done') continue;
      const notes = mentionText(p.notes, e.rationale);
      if (notes && BUDGET_REPORT_TEXT.test(notes) && BUDGET_STILL_MISSING_RE.test(notes)) {
        add({
          type: 'budget_report_pending',
          taskId,
          evidence: notes.slice(0, 200),
          eventId: e.id,
        });
      }
    }

    if (e.type === 'decision' && e.source === 'human') {
      if (isBudgetWorkerRequestApproval(e)) continue;
      const text = mentionText(e.rationale, p.reviewNotes, p.summary, p.reason);
      if (text && BUDGET_STILL_MISSING_RE.test(text) && BUDGET_REPORT_TEXT.test(text)) {
        add({
          type: 'budget_report_missing',
          taskId: p.taskId,
          evidence: text.slice(0, 200),
          eventId: e.id,
        });
      }
    }

    if (
      e.type === 'need' &&
      (p.kind === 'budget_request' || String(p.kind || '').includes('budget_report')) &&
      ['open', 'in_review'].includes(p.status || 'open')
    ) {
      add({
        type: 'open_budget_need',
        taskId: p.taskId,
        evidence: mentionText(p.title, p.description).slice(0, 200),
        eventId: e.id,
      });
    }
  }

  for (const n of projectState?.needs || []) {
    if (
      (n.kind === 'budget_request' || String(n.kind || '').includes('budget')) &&
      ['open', 'in_review'].includes(n.status || 'open')
    ) {
      add({
        type: 'open_budget_need',
        taskId: n.taskId,
        evidence: mentionText(n.title, n.description).slice(0, 200),
      });
    }
  }

  const hasBudgetTask = budgetTasks(projectState).length > 0;
  const budgetGap = gaps.some((g) => g.type.startsWith('budget'));
  if (budgetGap && !hasBudgetTask && !budgetSatisfied) {
    add({
      type: 'budget_task_missing_from_plan',
      evidence: 'Budget/expenses report referenced in work notes but no plan task tracks it.',
    });
  }

  return gaps;
}

function gapsToSummary(gaps) {
  if (!gaps.length) return '';
  const types = [...new Set(gaps.map((g) => g.type))];
  if (types.some((t) => t.startsWith('budget') || t === 'open_budget_need')) {
    return 'Budget expenses report still needs confirmation or an open finance request.';
  }
  return `${gaps.length} deliverable gap(s) detected from recent events.`;
}

function recentBudgetNeedCreated(projectEvents = []) {
  const cutoff = Date.now() - 45 * 60 * 1000;
  return (projectEvents || []).slice(-40).some((e) => {
    if (e.type !== 'need') return false;
    const kind = e.payload?.kind || '';
    if (kind !== 'budget_request' && !String(kind).includes('budget')) return false;
    const t = new Date(e.timestamp).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
}

function gapsToAgentActions(gaps, projectState, projectEvents = []) {
  const actions = [];
  if (isBudgetDeliverableSatisfied(projectState, projectEvents)) {
    return actions;
  }

  const budget = gaps.filter((g) => g.type.startsWith('budget') || g.type === 'open_budget_need');
  if (budget.length === 0) return actions;

  const hasOpenBudgetNeed = (projectState?.needs || []).some(
    (n) =>
      (n.kind === 'budget_request' || String(n.kind || '').includes('budget')) &&
      ['open', 'in_review'].includes(n.status || 'open')
  );

  if (!hasOpenBudgetNeed && !recentBudgetNeedCreated(projectEvents)) {
    const pendingTask = budgetTasks(projectState).find((t) => t.status !== 'done');
    actions.push({
      agent: 'system',
      action: 'create_need',
      reason: 'Budget expenses report mentioned in work but not confirmed complete.',
      payload: {
        kind: 'budget_request',
        title: pendingTask?.title || 'Submit budget expenses report',
        description: pendingTask?.description
          ? pendingTask.description
          : 'Project AI: confirm the budget expenses report is submitted before closing the project.',
        taskId: pendingTask?.id,
      },
    });
  }

  return actions;
}

module.exports = {
  scanDeliverableGaps,
  gapsToSummary,
  gapsToAgentActions,
  isBudgetDeliverableSatisfied,
  budgetTasks,
  BUDGET_REPORT_TEXT,
};
