/**
 * Keep event payloads bounded for Postgres jsonb limits (~256MB per array element).
 */

const MAX_RISK_REASONS = 50;

/**
 * Remove bloated fields accidentally stored on project_assessment decisions.
 */
function sanitizeEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, '_projectEventsForAssessment')) {
    return payload;
  }
  const { _projectEventsForAssessment, ...rest } = payload;
  return rest;
}

function sanitizeEventForStorage(event) {
  if (!event || typeof event !== 'object') return event;
  const payload = sanitizeEventPayload(event.payload);
  if (payload === event.payload) return event;
  return { ...event, payload };
}

function capRiskReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  if (reasons.length <= MAX_RISK_REASONS) return reasons;
  return reasons.slice(-MAX_RISK_REASONS);
}

const { enrichEventForMonitor } = require('../models/activityRecord');

module.exports = {
  sanitizeEventPayload,
  sanitizeEventForStorage,
  capRiskReasons,
  enrichEventForMonitor,
  MAX_RISK_REASONS,
};
