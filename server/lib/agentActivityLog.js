/**
 * In-memory log of AI agent activity (org_ai, project_ai, etc.) for the Log tab.
 * Max 2-sentence messages. All agents share the same LLM queue (see llm.js).
 */

const MAX_ENTRIES = 500;

const log = [];

/**
 * @param {{ source: string, projectId?: string | null, message: string }} entry
 */
function push(entry) {
  const ts = new Date().toISOString();
  const id = `al-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  log.push({
    id,
    source: entry.source,
    projectId: entry.projectId ?? null,
    message: typeof entry.message === 'string' ? entry.message.trim().slice(0, 500) : '',
    timestamp: ts,
  });
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
}

/**
 * @param {{ projectId?: string | null }} [options] - If provided, return only entries for this project or global (null projectId).
 */
function getRecent(options = {}) {
  const { projectId } = options;
  let list = log.slice().reverse();
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    list = list.filter((e) => e.projectId === null || e.projectId === projectId);
  }
  return list.slice(0, 200);
}

module.exports = { push, getRecent };
