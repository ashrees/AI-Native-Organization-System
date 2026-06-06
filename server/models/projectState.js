/**
 * Project state structure and apply logic.
 * Source of truth: docs/event-model.md
 * State is updated ONLY by applying events; no direct writes elsewhere.
 */

const { EVENT_TYPES, EXECUTION_STATUSES, PROJECT_STATUSES, RISK_LEVELS } = require('./eventSchema');
const { capRiskReasons } = require('../lib/eventPayload');

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
    archived: false,
    closedAt: null,
    archivedAt: null,
    roles: {},
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
    finance: null,
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
      const { isJunkPlanTask } = require('../lib/planTasks');
      const tasks = payload.tasks || (payload.taskIds && payload.taskIds.map((id) => ({ id }))) || [];
      for (const t of tasks) {
        if (typeof t === 'object' && isJunkPlanTask(t)) continue;
        const taskId = typeof t === 'string' ? t : t.id;
        ensureTask(state, taskId, typeof t === 'object' ? { title: t.title, description: t.description } : {});
      }
      if (payload.riskLevel && RISK_LEVELS.includes(payload.riskLevel)) {
        state.risk.level = payload.riskLevel;
        if (event.rationale) {
          state.risk.reasons.push(event.rationale);
          state.risk.reasons = capRiskReasons(state.risk.reasons);
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
        const previousId = task.assigneeId || task.assignee?.id;
        task.assigneeId = personId;
        if (person && typeof person === 'object') {
          task.assignee = {
            id: person.id || personId,
            name: person.name || '',
            department: person.department || '',
            team: person.team || '',
            role: person.role || '',
            projectRoleId: person.projectRoleId || undefined,
            jobTitle: person.jobTitle || undefined,
          };
        } else if (previousId && String(previousId) !== String(personId)) {
          delete task.assignee;
        }
      }
      break;
    }

    case 'unassignment': {
      const { taskId, personId } = payload || {};
      if (taskId) {
        const task = findTask(state, taskId);
        if (
          task &&
          (!personId ||
            task.assigneeId === personId ||
            task.assignee?.id === personId)
        ) {
          delete task.assigneeId;
          delete task.assignee;
          if (task.status === 'in_progress') {
            task.status = 'pending';
          }
          state.blockers = (state.blockers || []).filter((b) => b.taskId !== taskId);
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
        if (status === 'blocked') {
          state.blockers = (state.blockers || []).filter((b) => b.taskId !== taskId);
          state.blockers.push({
            taskId,
            description: notes || 'Blocked',
            raisedAt: timestamp,
          });
        } else {
          // Unblocked: remove this task from the project blocker list
          state.blockers = (state.blockers || []).filter((b) => b.taskId !== taskId);
        }
      }
      break;
    }

    case 'decision': {
      const { decisionType, reason, riskLevel, riskReason, summary, suggestProjectCompleted } =
        payload || {};
      if (decisionType === 'kill_project' || decisionType === 'kill') {
        state.status = 'killed';
        state.closedAt = state.closedAt || event.timestamp || new Date().toISOString();
        // Revert all human resources: clear assignees from every task so people are released
        if (state.progress && Array.isArray(state.progress.tasks)) {
          for (const task of state.progress.tasks) {
            delete task.assigneeId;
            delete task.assignee;
          }
        }
      } else if (decisionType === 'complete' || decisionType === 'completed') {
        state.status = 'completed';
        state.closedAt = state.closedAt || event.timestamp || new Date().toISOString();
      } else if (decisionType === 'archive_project') {
        state.archived = true;
        state.archivedAt = event.timestamp || new Date().toISOString();
      } else if (decisionType === 'unarchive_project') {
        state.archived = false;
      } else if (decisionType === 'reactivate_project') {
        if (state.status === 'completed') {
          state.status = 'active';
          state.archived = false;
          state.closedAt = null;
        }
      } else if (decisionType === 'project_assessment') {
        if (riskLevel && RISK_LEVELS.includes(riskLevel)) {
          state.risk.level = riskLevel;
        }
        const line = riskReason || summary || event.rationale;
        if (line && state.risk.reasons) {
          state.risk.reasons.push(line);
          state.risk.reasons = capRiskReasons(state.risk.reasons);
        }
        if (suggestProjectCompleted) {
          const tasks = state.progress?.tasks || [];
          const allDone =
            tasks.length > 0 && tasks.every((t) => t.status === 'done');
          const noBlockers = !(state.blockers || []).length;
          let deliverableGaps = [];
          try {
            if (Array.isArray(payload.deliverableGaps) && payload.deliverableGaps.length > 0) {
              deliverableGaps = payload.deliverableGaps;
            } else {
              const { scanDeliverableGaps, isBudgetDeliverableSatisfied } = require('../services/projectAIDeliverables');
              deliverableGaps = isBudgetDeliverableSatisfied(state, [])
                ? []
                : scanDeliverableGaps(state, []);
            }
          } catch {
            /* optional */
          }
          if (allDone && noBlockers && deliverableGaps.length === 0) {
            state.status = 'completed';
            state.risk.level = 'low';
            state.risk.reasons = capRiskReasons([
              riskReason || summary || 'All tasks complete; deliverables confirmed.',
            ]);
          }
        }
      } else if (decisionType === 'project_roles_assigned') {
        const roleMap = payload.roles;
        if (roleMap && typeof roleMap === 'object') {
          state.roles = { ...(state.roles || {}), ...roleMap };
          const lead = roleMap.project_lead;
          if (lead?.name) state.sponsor = lead.name;
          if (lead?.department && !state.department) state.department = lead.department;
          if (lead?.team && !state.team) state.team = lead.team;
        }
      } else if (decisionType === 'project_member_added') {
        const member = payload.member;
        const roleKey = payload.roleKey || (member?.personId ? `contributor_${member.personId}` : null);
        if (roleKey && member?.personId) {
          state.roles = { ...(state.roles || {}), [roleKey]: member };
        }
      } else if (decisionType === 'consolidate_project_tasks') {
        const nextTasks = payload.tasks;
        if (Array.isArray(nextTasks)) {
          state.progress.tasks = nextTasks.map((t) => ({
            id: t.id,
            title: t.title || t.id,
            description: t.description,
            status: t.status || 'pending',
            assigneeId: t.assigneeId,
            assignee: t.assignee,
            scheduledStart: t.scheduledStart,
            scheduledEnd: t.scheduledEnd,
            requiredDepartments: t.requiredDepartments,
          }));
        }
        if (payload.department) state.department = payload.department;
        if (payload.team) state.team = payload.team;
        if (payload.title) state.title = payload.title;
        const tasks = state.progress?.tasks || [];
        const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'done');
        if (!allDone && state.status === 'completed') {
          state.status = 'active';
          state.closedAt = null;
        }
        state.blockers = (state.blockers || []).filter((b) =>
          (state.progress.tasks || []).some((t) => t.id === b.taskId && t.status !== 'done')
        );
      } else if (
        decisionType === 'budget_set' ||
        decisionType === 'budget_burn' ||
        decisionType === 'budget_increase'
      ) {
        const { ensureFinance, appendBurn, defaultFinanceForProject } = require('../lib/projectFinance');
        if (!state.finance) state.finance = defaultFinanceForProject(state);
        ensureFinance(state);

        if (decisionType === 'budget_set') {
          if (payload.budgetTotal != null) state.finance.budgetTotal = Number(payload.budgetTotal);
          if (payload.revenuePlanned != null) state.finance.revenuePlanned = Number(payload.revenuePlanned);
          if (payload.currency) state.finance.currency = payload.currency;
        } else if (decisionType === 'budget_increase') {
          const add = Number(payload.amount) || 0;
          state.finance.budgetTotal = (Number(state.finance.budgetTotal) || 0) + add;
          state.finance.pendingBudgetRequests = Math.max(
            0,
            (state.finance.pendingBudgetRequests || 0) - 1
          );
        } else if (decisionType === 'budget_burn') {
          appendBurn(state.finance, {
            amount: Number(payload.amount) || 0,
            at: event.timestamp || new Date().toISOString(),
            reason: payload.reason || event.rationale,
            taskId: payload.taskId,
            source: payload.source || 'manual',
            eventId,
          });
        }
      }
      if (reason && state.risk.reasons) {
        state.risk.reasons.push(reason);
        state.risk.reasons = capRiskReasons(state.risk.reasons);
      }
      break;
    }

    case 'need': {
      const { kind, description, taskId, status, title } = payload || {};
      if (kind && description) {
        const resolvedStatus = status || 'open';
        const need = {
          id: eventId,
          kind,
          title: title || kind,
          description,
          taskId: taskId || null,
          status: resolvedStatus,
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
