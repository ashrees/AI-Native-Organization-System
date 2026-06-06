/**
 * Per-project serialization — one orchestration / replan chain at a time per project.
 */

const chains = new Map();

/**
 * Run async work exclusively for a projectId (FIFO queue per project).
 * @param {string} projectId
 * @param {() => Promise<void>} fn
 */
function runWithProjectLock(projectId, fn) {
  if (!projectId) return Promise.resolve();
  const prev = chains.get(projectId) || Promise.resolve();
  const run = prev
    .catch(() => {
      /* keep chain alive after prior failure */
    })
    .then(() => fn());
  chains.set(
    projectId,
    run.finally(() => {
      if (chains.get(projectId) === run) chains.delete(projectId);
    })
  );
  return run;
}

function getProjectLockStats() {
  return { lockedProjects: chains.size };
}

module.exports = {
  runWithProjectLock,
  getProjectLockStats,
};
