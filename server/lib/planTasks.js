/**
 * Sanitize orchestrator plans — avoid meta "Reassign task-*" rows and replan spam on active projects.
 */

function normalizeTitle(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Orchestrator/LLM sometimes emits meta tasks instead of using unassignment events. */
function isMetaReassignTask(task) {
  const title = normalizeTitle(task?.title);
  return /^reassign\s+task-/.test(title) || /^assign\s+.*tasks?\s+to\s+new\s+hire/.test(title);
}

/** Junk or duplicate plan rows that should not be appended to an active project. */
function isJunkPlanTask(task) {
  if (!task || typeof task !== 'object') return true;
  if (isMetaReassignTask(task)) return true;
  const id = String(task.id || '');
  if (/^task-(mpz|clean|consolidate)/i.test(id)) return true;

  const title = normalizeTitle(task.title);
  if (!title) return true;
  if (/^staffing:\s*approved worker request/.test(title)) return true;
  if (title === 'define acceptance criteria' || title === 'implement and validate') return true;
  if (/identify and remove duplicate/.test(title)) return true;
  if (/^update task dependencies/.test(title)) return true;
  if (/^clarify request$/.test(title)) return true;
  return false;
}

function isStaffingReplanRequest(requestPayload = {}) {
  const text = `${requestPayload.title || ''} ${requestPayload.description || ''}`.toLowerCase();
  return (
    text.includes('staffing:') ||
    text.includes('replan:') ||
    text.includes('replan after') ||
    /\b(replan|repriorit)\b/.test(text)
  );
}

/**
 * Skip appending orchestrator tasks when project already has real work in flight.
 */
function shouldSkipOrchestratorPlanAppend(requestPayload, projectState) {
  const tasks = projectState?.progress?.tasks || [];
  const substantive = tasks.filter((t) => !isJunkPlanTask(t));
  if (substantive.length < 4) return false;

  const text = `${requestPayload.title || ''} ${requestPayload.description || ''}`.toLowerCase();
  if (isStaffingReplanRequest(requestPayload)) return true;
  if (/\b(consolidat|duplicate|clean up|cleanup|reassign)\b/.test(text)) return true;
  return false;
}

/**
 * Filter tasks before plan_created is applied.
 */
function sanitizePlanTasks(tasks, projectState = null) {
  const existing = projectState?.progress?.tasks || [];
  const existingIds = new Set(existing.map((t) => String(t.id)));
  const seenTitles = new Set(
    existing
      .filter((t) => !isJunkPlanTask(t))
      .map((t) => normalizeTitle(t.title))
      .filter(Boolean)
  );

  const out = [];
  for (let i = 0; i < (tasks || []).length; i++) {
    const raw = tasks[i];
    if (!raw || typeof raw !== 'object') continue;
    if (isJunkPlanTask(raw)) continue;

    const titleNorm = normalizeTitle(raw.title);
    if (titleNorm.startsWith('staffing:') && seenTitles.size >= 4) continue;
    if (titleNorm && seenTitles.has(titleNorm)) continue;

    let id = raw.id != null ? String(raw.id) : '';
    if (!id || existingIds.has(id)) {
      id = `task-${Date.now().toString(36)}-${i}`;
    }
    existingIds.add(id);
    if (titleNorm) seenTitles.add(titleNorm);

    out.push({
      id,
      title: raw.title || id,
      description: raw.description,
      requiredDepartments: raw.requiredDepartments,
      preferredDepartments: raw.preferredDepartments,
    });
  }
  return out;
}

module.exports = {
  isMetaReassignTask,
  isJunkPlanTask,
  isStaffingReplanRequest,
  shouldSkipOrchestratorPlanAppend,
  sanitizePlanTasks,
  normalizeTitle,
};
