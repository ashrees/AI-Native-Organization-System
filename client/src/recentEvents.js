/** Shared helpers for project recent-change summaries (Leadership Projects tab). */

export function logMessageShort(text, maxSentences = 2) {
  if (text == null || typeof text !== 'string') return '';
  const t = text.trim();
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return t;
  return sentences.slice(0, maxSentences).join(' ');
}

/** Match server/lib/recentProjectActivity.js */
export function isRecentChangeEvent(event) {
  if (!event?.type) return false;
  if (['execution', 'decision', 'unassignment'].includes(event.type)) return true;
  if (
    ['plan_created', 'assignment', 'schedule_proposed'].includes(event.type) &&
    ['orchestrator', 'team_builder', 'scheduler', 'project_ai', 'org_ai', 'system'].includes(
      event.source
    )
  ) {
    return true;
  }
  if (
    event.type === 'agent_activity' &&
    ['orchestrator', 'team_builder', 'scheduler', 'org_ai', 'project_ai'].includes(event.source)
  ) {
    return true;
  }
  return false;
}

export function recentEventSummary(event, project) {
  const p = event.payload || {};
  if (event.type === 'agent_activity') {
    return logMessageShort(event.rationale || event.message);
  }
  if (event.type === 'plan_created') {
    const n = Array.isArray(p.tasks) ? p.tasks.length : 0;
    return logMessageShort(
      event.rationale || p.summary || (n ? `Plan created/updated (${n} task${n > 1 ? 's' : ''})` : 'Plan updated')
    );
  }
  if (event.type === 'assignment' && p.taskId) {
    const task = (project?.progress?.tasks || []).find((t) => t.id === p.taskId);
    const title = task?.title || p.taskId;
    const who = p.person?.name || p.personId || 'assignee';
    return logMessageShort(event.rationale || `Team Builder assigned ${who} to "${title}"`);
  }
  if (event.type === 'schedule_proposed' && p.taskId) {
    const task = (project?.progress?.tasks || []).find((t) => t.id === p.taskId);
    const title = task?.title || p.taskId;
    return logMessageShort(event.rationale || `Scheduler set dates for "${title}"`);
  }
  if (event.type === 'decision' && p.decisionType === 'project_assessment') {
    return logMessageShort(p.summary || event.rationale || p.riskReason || 'Project AI status review');
  }
  const direct = event.rationale || event.message;
  if (direct) return logMessageShort(direct);
  if (event.type === 'execution' && p.taskId) {
    const task = (project?.progress?.tasks || []).find((t) => t.id === p.taskId);
    const title = task?.title || p.taskId;
    const statusLabel = String(p.status || 'updated').replace(/_/g, ' ');
    let msg = `Task "${title}" marked ${statusLabel}`;
    if (p.notes) msg += `: ${p.notes}`;
    return logMessageShort(msg);
  }
  if (event.type === 'decision' && p.decisionType === 'assignment_gap_fill') {
    const n = p.assignedCount ?? 0;
    return logMessageShort(
      event.rationale ||
        `Assignment gap fill: ${n} unassigned task(s) assigned by Team Builder.`
    );
  }
  if (p.reason) return logMessageShort(String(p.reason));
  if (p.summary) return logMessageShort(String(p.summary));
  if (p.description) return logMessageShort(String(p.description));
  return '';
}
