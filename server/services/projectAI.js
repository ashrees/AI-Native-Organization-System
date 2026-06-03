/**
 * Project AI (state owner): maintains project truth (progress, risk, blockers, dependencies).
 * Updates state only via events; no direct state mutation.
 * Apply logic lives in models/projectState.js; this module can expose helpers or summaries for leadership view.
 */

const { applyEvent, applyEvents, createEmptyState } = require('../models/projectState');

/**
 * Apply a single event to project state. Used by the event intake/orchestration flow.
 * Delegates to models/projectState.applyEvent.
 */
function applyEventToState(currentState, event) {
  return applyEvent(currentState || createEmptyState(event.projectId), event);
}

/**
 * Rebuild project state from a list of events (e.g. from event log).
 */
function rebuildStateFromEvents(events, projectId) {
  return applyEvents(null, events, projectId);
}

module.exports = {
  applyEventToState,
  rebuildStateFromEvents,
  createEmptyState,
};
