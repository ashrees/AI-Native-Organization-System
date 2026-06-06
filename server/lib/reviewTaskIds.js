/**
 * Stable unique ids for worker-request review tasks (one per role per need).
 */

function buildReviewTaskId(needEvent, role) {
  const needFrag = String(needEvent.id || '')
    .replace(/-/g, '')
    .slice(0, 12);
  const roleKey = String(role || 'review')
    .replace(/[^a-z0-9_]/gi, '_')
    .slice(0, 24);
  return `wr-${roleKey}-${needFrag}`;
}

module.exports = { buildReviewTaskId };
