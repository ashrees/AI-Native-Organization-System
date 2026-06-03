/**
 * Event schema constants and validation.
 * Source of truth: docs/event-model.md
 * Events are the single source of truth; every state change comes from an event.
 */

const EVENT_TYPES = Object.freeze([
  'request',
  'plan_created',
  'assignment',
  'unassignment',
  'schedule_proposed',
  'execution',
  'decision',
  'need',
]);

const EVENT_SOURCES = Object.freeze([
  'human',
  'orchestrator',
  'team_builder',
  'scheduler',
  'project_ai',
  'system',
]);

const EXECUTION_STATUSES = Object.freeze(['in_progress', 'done', 'blocked']);

const PROJECT_STATUSES = Object.freeze(['active', 'completed', 'killed']);

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

// ISO 8601 regex (simplified: YYYY-MM-DD or with time)
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Validates that a string looks like a UUID (v4 style).
 * We accept any 8-4-4-4-12 hex pattern for flexibility.
 */
function isUUIDLike(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Validates base event envelope: id, type, timestamp, projectId, source, payload.
 * Returns { valid: boolean, error?: string }.
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    return { valid: false, error: 'Event must be an object' };
  }

  if (!isUUIDLike(event.id)) {
    return { valid: false, error: 'Event id must be a UUID string' };
  }

  if (!EVENT_TYPES.includes(event.type)) {
    return { valid: false, error: `Event type must be one of: ${EVENT_TYPES.join(', ')}` };
  }

  if (!event.timestamp || !ISO8601_REGEX.test(String(event.timestamp))) {
    return { valid: false, error: 'Event timestamp must be ISO 8601' };
  }

  if (!event.projectId || typeof event.projectId !== 'string' || !event.projectId.trim()) {
    return { valid: false, error: 'Event projectId is required and must be a non-empty string' };
  }

  if (!EVENT_SOURCES.includes(event.source)) {
    return { valid: false, error: `Event source must be one of: ${EVENT_SOURCES.join(', ')}` };
  }

  if (event.payload === undefined || event.payload === null) {
    return { valid: false, error: 'Event payload is required' };
  }
  if (typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return { valid: false, error: 'Event payload must be an object' };
  }

  // Optional: correlationId and rationale are free-form strings if present
  if (event.correlationId !== undefined && typeof event.correlationId !== 'string') {
    return { valid: false, error: 'Event correlationId must be a string if present' };
  }
  if (event.rationale !== undefined && typeof event.rationale !== 'string') {
    return { valid: false, error: 'Event rationale must be a string if present' };
  }

  return { valid: true };
}

module.exports = {
  EVENT_TYPES,
  EVENT_SOURCES,
  EXECUTION_STATUSES,
  PROJECT_STATUSES,
  RISK_LEVELS,
  validateEvent,
  isUUIDLike,
};
