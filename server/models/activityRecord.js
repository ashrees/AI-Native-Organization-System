/**
 * Normalized activity / stream detail shape for Ops Monitor and Postgres agent_activity.
 */

const AI_AGENT_IDS = new Set([
  'orchestrator',
  'team_builder',
  'scheduler',
  'project_ai',
  'org_ai',
  'ai_handler',
  'mock_worker',
  'llm_queue',
]);

const ERROR_RE = /\b(error|failed|skipped|timeout|null)\b/i;

function projectTitle(projects, projectId) {
  if (!projectId || !projects) return null;
  return projects[projectId]?.title || projectId;
}

function summaryFromEvent(event) {
  const p = event.payload || {};
  const rationale = (event.rationale || p.reason || p.riskReason || '').trim();
  const summary =
    p.monitor?.summary ||
    p.summary ||
    p.title ||
    (p.decisionType ? String(p.decisionType).replace(/_/g, ' ') : '') ||
    (p.taskId && p.status ? `Task ${p.taskId} → ${p.status}` : '') ||
    (p.taskId ? `Task ${p.taskId}` : '') ||
    event.type;
  return {
    summary: String(summary).slice(0, 200),
    rationale: rationale ? rationale.slice(0, 500) : null,
  };
}

function isErrorSignal(text, event) {
  const p = event?.payload || {};
  return (
    ERROR_RE.test(text || '') ||
    (event?.type === 'execution' && p.status === 'blocked')
  );
}

/**
 * Structured block stored on event.payload.monitor for queries and reuse.
 */
function buildMonitorPayloadFields(event, projects) {
  const p = event.payload || {};
  const { summary, rationale } = summaryFromEvent(event);
  return {
    taskId: p.taskId || p.monitor?.taskId || null,
    status: p.status || p.decisionType || p.monitor?.status || null,
    decisionType: p.decisionType || null,
    summary,
    rationale,
    projectTitle: projectTitle(projects, event.projectId),
    isError: isErrorSignal(`${summary} ${rationale}`, event),
  };
}

/**
 * @param {object} event
 * @param {object} [projects]
 */
function enrichEventForMonitor(event, projects) {
  if (!event || typeof event !== 'object') return event;
  const monitor = buildMonitorPayloadFields(event, projects);
  return {
    ...event,
    payload: {
      ...(event.payload || {}),
      monitor,
    },
  };
}

/**
 * Stream detail item (API / UI).
 */
function toStreamDetail(record) {
  return {
    kind: record.recordKind === 'event_mirror' ? 'event' : 'activity',
    at: record.createdAt || record.timestamp,
    type: record.eventType || (record.recordKind === 'activity' ? 'activity' : 'event'),
    projectId: record.projectId || null,
    projectTitle: record.projectTitle || null,
    taskId: record.taskId || null,
    status: record.status || null,
    summary: record.summary || record.message || '',
    rationale: record.rationale || null,
  };
}

/**
 * Row for agent_activity table insert.
 */
function fromActivityLogEntry(entry, projects) {
  const msg = (entry.message || '').trim();
  const isError = isErrorSignal(msg, null);
  return {
    id: entry.id,
    agentId: entry.source,
    projectId: entry.projectId || null,
    taskId: entry.taskId || null,
    recordKind: 'activity',
    eventType: 'activity',
    status: null,
    summary: (entry.summary || msg).slice(0, 200),
    rationale: entry.rationale ? String(entry.rationale).slice(0, 500) : null,
    message: msg.slice(0, 500),
    isError,
    correlationEventId: entry.correlationEventId || null,
    projectTitle: projectTitle(projects, entry.projectId),
    createdAt: entry.timestamp || new Date().toISOString(),
  };
}

/**
 * Mirror AI-originated events into agent_activity for stream history.
 */
function fromEvent(event, projects) {
  const p = event.payload || {};
  const mon = p.monitor || buildMonitorPayloadFields(event, projects);
  const { summary, rationale } = summaryFromEvent(event);
  return {
    id: `ev-${event.id}`,
    agentId: event.source,
    projectId: event.projectId || null,
    taskId: mon.taskId || p.taskId || null,
    recordKind: 'event_mirror',
    eventType: event.type,
    status: mon.status || p.status || p.decisionType || null,
    summary: mon.summary || summary,
    rationale: mon.rationale || rationale,
    message: null,
    isError: mon.isError ?? isErrorSignal(`${summary} ${rationale}`, event),
    correlationEventId: event.id,
    projectTitle: mon.projectTitle || projectTitle(projects, event.projectId),
    createdAt: event.timestamp || new Date().toISOString(),
  };
}

function rowToActivityRecord(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    taskId: row.task_id,
    recordKind: row.record_kind,
    eventType: row.event_type,
    status: row.status,
    summary: row.summary || '',
    rationale: row.rationale,
    message: row.message,
    isError: !!row.is_error,
    correlationEventId: row.correlation_event_id,
    projectTitle: row.project_title,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

module.exports = {
  AI_AGENT_IDS,
  ERROR_RE,
  projectTitle,
  enrichEventForMonitor,
  toStreamDetail,
  fromActivityLogEntry,
  fromEvent,
  rowToActivityRecord,
  isErrorSignal,
};
