/**
 * Project state structure and apply logic.
 * Source of truth: docs/event-model.md
 * State is updated ONLY by applying events; no direct writes elsewhere.
 */

const { EVENT_TYPES, EXECUTION_STATUSES, PROJECT_STATUSES, RISK_LEVELS } = require('./eventSchema');

/**
 * Creates an empty project state for a given project id.
 * Title and other fields are filled when we apply the first relevant event.
 */
function createEmptyState(projectId) {
  return {
    id: projectId,
    title: '',
    department: '',
    team: '',
    sponsor: '',
    status: 'active',
    progress: {
      tasks: [],
    },
    risk: {
      level: 'low',
      reasons: [],
    },
    blockers: [],
    dependencies: [],
    needs: [],
    lastUpdatedAt: null,
    lastEventId: null,
  };
}

/**
 * Finds a task by id in state.progress.tasks.
 * Returns the task object or undefined.
 */
function findTask(state, taskId) {
  return state.progress.tasks.find((t) => t.id === taskId);
}

/**
 * Ensures a task exists; creates a placeholder if not.
 * Mutates state.progress.tasks and returns the task.
 */
function ensureTask(state, taskId, defaults = {}) {
  let task = findTask(state, taskId);
  if (!task) {
    task = { id: taskId, ...defaults };
    state.progress.tasks.push(task);
  }
  return task;
}

/**
 * Applies a single event to project state.
 * Returns the updated state (new object; does not mutate input state).
 * If the event type does not affect project state, returns state unchanged except lastUpdatedAt/lastEventId.
 */
function applyEvent(previousState, event) {
  const state = JSON.parse(JSON.stringify(previousState));

  // Ensure we have a state for this project
  if (state.id !== event.projectId) {
    return previousState;
  }

  const { type, payload, timestamp, id: eventId } = event;

  switch (type) {
    case 'request': {
      if (!state.title && payload.title) {
        state.title = payload.title;
      }
      if (payload.department && !state.department) {
        state.department = payload.department;
      }
      if (payload.team && !state.team) {
        state.team = payload.team;
      }
      if (payload.sponsor && !state.sponsor) {
        state.sponsor = payload.sponsor;
      }
      if (state.status === undefined || state.status === null) {
        state.status = 'active';
      }
      break;
    }

    case 'plan_created': {
      const tasks = payload.tasks || (payload.taskIds && payload.taskIds.map((id) => ({ id }))) || [];
      for (const t of tasks) {
        const taskId = typeof t === 'string' ? t : t.id;
        ensureTask(state, taskId, typeof t === 'object' ? { title: t.title, description: t.description } : {});
      }
      if (payload.riskLevel && RISK_LEVELS.includes(payload.riskLevel)) {
        state.risk.level = payload.riskLevel;
        if (event.rationale) {
          state.risk.reasons.push(event.rationale);
        }
      }
      if (payload.dependencies && Array.isArray(payload.dependencies)) {
        state.dependencies = payload.dependencies;
      }
      break;
    }

    case 'assignment': {
      const { taskId, personId, person } = payload || {};
      if (taskId && personId) {
        const task = ensureTask(state, taskId);
        task.assigneeId = personId;
        if (person && typeof person === 'object') {
          task.assignee = {
            id: person.id || personId,
            name: person.name || '',
            department: person.department || '',
            team: person.team || '',
            role: person.role || '',
          };
        }
      }
      break;
    }

    case 'schedule_proposed': {
      const { taskId, proposedStart, proposedEnd } = payload || {};
      if (taskId) {
        const task = ensureTask(state, taskId);
        if (proposedStart) task.scheduledStart = proposedStart;
        if (proposedEnd) task.scheduledEnd = proposedEnd;
      }
      break;
    }

    case 'execution': {
      const { taskId, status, notes } = payload || {};
      if (taskId && status && EXECUTION_STATUSES.includes(status)) {
        const task = ensureTask(state, taskId);
        task.status = status;
        if (status === 'blocked' && notes) {
          state.blockers.push({
            taskId,
            description: notes,
            raisedAt: timestamp,
          });
        }
      }
      break;
    }

    case 'decision': {
      const { decisionType, reason } = payload || {};
      if (decisionType === 'kill_project' || decisionType === 'kill') {
        state.status = 'killed';
        // Revert all human resources: clear assignees from every task so people are released
        if (state.progress && Array.isArray(state.progress.tasks)) {
          for (const task of state.progress.tasks) {
            delete task.assigneeId;
            delete task.assignee;
          }
        }
      } else if (decisionType === 'complete' || decisionType === 'completed') {
        state.status = 'completed';
      }
      if (reason && state.risk.reasons) {
        state.risk.reasons.push(reason);
      }
      break;
    }

    case 'need': {
      const { kind, description, taskId, status } = payload || {};
      if (kind && description) {
        const need = {
          id: eventId,
          kind,
          description,
          taskId: taskId || null,
          status: status === 'met' || status === 'cancelled' ? status : 'open',
          source: event.source,
          createdAt: timestamp,
        };
        if (!state.needs) state.needs = [];
        const idx = state.needs.findIndex((n) => n.id === eventId);
        if (idx >= 0) state.needs[idx] = { ...state.needs[idx], ...need };
        else state.needs.push(need);
      }
      break;
    }

    default:
      break;
  }

  state.lastUpdatedAt = timestamp;
  state.lastEventId = eventId;
  return state;
}

/**
 * Applies a list of events in order to an initial state (or empty state for projectId).
 * Used to rebuild state from event log or to apply a batch of new events.
 */
function applyEvents(initialStateOrNull, events, projectId) {
  let state = initialStateOrNull || createEmptyState(projectId);
  for (const event of events) {
    if (event.projectId !== projectId) continue;
    state = applyEvent(state, event);
  }
  return state;
}

module.exports = {
  createEmptyState,
  applyEvent,
  applyEvents,
  findTask,
  ensureTask,
  PROJECT_STATUSES,
  RISK_LEVELS,
};
