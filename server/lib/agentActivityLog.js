/**
 * Agent activity log — in-memory ring + Postgres agent_activity for Ops Monitor reuse.
 */

const postgresStore = require('../store/postgresStore');
const { fromActivityLogEntry } = require('../models/activityRecord');

const MAX_ENTRIES = 500;
const log = [];

/**
 * @param {{
 *   source: string,
 *   projectId?: string | null,
 *   message: string,
 *   taskId?: string | null,
 *   summary?: string | null,
 *   rationale?: string | null,
 *   correlationEventId?: string | null,
 *   isError?: boolean,
 * }} entry
 */
function push(entry) {
  const ts = new Date().toISOString();
  const id = `al-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const row = {
    id,
    source: entry.source,
    projectId: entry.projectId ?? null,
    taskId: entry.taskId ?? null,
    message: typeof entry.message === 'string' ? entry.message.trim().slice(0, 500) : '',
    summary: entry.summary ? String(entry.summary).slice(0, 200) : null,
    rationale: entry.rationale ? String(entry.rationale).slice(0, 500) : null,
    correlationEventId: entry.correlationEventId ?? null,
    isError: !!entry.isError,
    timestamp: ts,
  };
  log.push(row);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);

  const record = fromActivityLogEntry(row, null);
  if (entry.isError != null) record.isError = entry.isError;
  postgresStore.insertAgentActivity(record).catch((err) => {
    console.warn('[agent_activity] insert failed:', err.message);
  });

  return row;
}

/**
 * @param {{ projectId?: string | null, since?: string, limit?: number }} [options]
 */
async function getRecentFromDb(options = {}) {
  if (typeof postgresStore.loadAgentActivitySince !== 'function') return [];
  const since =
    options.since ||
    new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const rows = await postgresStore.loadAgentActivitySince({
    since,
    limit: options.limit || 500,
  });
  let list = rows.filter((r) => r.recordKind === 'activity' || r.recordKind === 'event_mirror');
  if (options.projectId !== undefined && options.projectId !== null && options.projectId !== '') {
    list = list.filter((r) => r.projectId === null || r.projectId === options.projectId);
  }
  return list
    .map((r) => ({
      id: r.id,
      source: r.agentId,
      projectId: r.projectId,
      taskId: r.taskId,
      message: r.message || r.summary,
      summary: r.summary,
      rationale: r.rationale,
      timestamp: r.createdAt,
      recordKind: r.recordKind,
      eventType: r.eventType,
      status: r.status,
      isError: r.isError,
      projectTitle: r.projectTitle,
      correlationEventId: r.correlationEventId,
    }))
    .reverse();
}

/**
 * @param {{ projectId?: string | null }} [options]
 */
function getRecent(options = {}) {
  const { projectId } = options;
  let list = log.slice().reverse();
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    list = list.filter((e) => e.projectId === null || e.projectId === projectId);
  }
  return list.slice(0, 200);
}

/**
 * Load recent rows from Postgres into the in-memory ring (startup).
 */
async function hydrateFromDb(limit = 500) {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await postgresStore.loadAgentActivitySince({ since, limit });
    const activityOnly = rows.filter((r) => r.recordKind === 'activity');
    log.length = 0;
    for (const r of activityOnly.slice(-MAX_ENTRIES)) {
      log.push({
        id: r.id,
        source: r.agentId,
        projectId: r.projectId,
        taskId: r.taskId,
        message: r.message || r.summary,
        summary: r.summary,
        rationale: r.rationale,
        timestamp: r.createdAt,
        correlationEventId: r.correlationEventId,
        isError: r.isError,
      });
    }
    return log.length;
  } catch (err) {
    console.warn('[agent_activity] hydrate skipped:', err.message);
    return 0;
  }
}

module.exports = { push, getRecent, getRecentFromDb, hydrateFromDb };
