/**
 * Metrics builder: derive simple, explainable project / people metrics from
 * the event log and materialized project state.
 *
 * This is intentionally a pure, non-AI module so we can:
 * - keep invariants simple
 * - unit test easily later
 * - feed Org AI with a clean JSON shape
 */

/**
 * Build metrics for a single project from its current state and events.
 * @param {object} projectState - materialized project state
 * @param {Array<object>} projectEvents - all events for this project
 */
function buildProjectMetrics(projectState, projectEvents) {
  const tasks = Array.isArray(projectState?.progress?.tasks)
    ? projectState.progress.tasks
    : [];
  const blockers = Array.isArray(projectState?.blockers)
    ? projectState.blockers
    : [];

  const now = new Date();

  const statusCounts = {
    total: tasks.length,
    in_progress: 0,
    done: 0,
    blocked: 0,
    unknown: 0,
  };

  const peopleMap = new Map();
  let crossTeamTasks = 0;

  for (const task of tasks) {
    const isReviewTask = String(task.id || '').startsWith('wr-');
    const status = task.status || 'unknown';
    if (!isReviewTask) {
      if (statusCounts[status] != null) {
        statusCounts[status] += 1;
      } else {
        statusCounts.unknown += 1;
      }
    }

    if (task.assignee && (task.assignee.id || task.assignee.name)) {
      const key = task.assignee.id || task.assignee.name;
      if (!peopleMap.has(key)) {
        peopleMap.set(key, {
          personId: task.assignee.id || null,
          name: task.assignee.name || null,
          department: task.assignee.department || null,
          team: task.assignee.team || null,
          role: task.assignee.role || null,
          tasksTotal: 0,
          tasksInProgress: 0,
          tasksDone: 0,
          tasksBlocked: 0,
        });
      }
      const entry = peopleMap.get(key);
      if (!isReviewTask) {
        entry.tasksTotal += 1;
        if (status === 'in_progress') entry.tasksInProgress += 1;
        if (status === 'done') entry.tasksDone += 1;
        if (status === 'blocked') entry.tasksBlocked += 1;
      }

      // Cross‑team collaboration: assignee team differs from project team.
      if (task.assignee.team && projectState.team && task.assignee.team !== projectState.team) {
        crossTeamTasks += 1;
      }
    }
  }

  // Timeline metrics from events
  let lastEventAt = null;
  let completedLast7Days = 0;
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const e of projectEvents) {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    if (ts && (!lastEventAt || ts > lastEventAt)) {
      lastEventAt = ts;
    }
    if (
      e.type === 'execution' &&
      e.payload &&
      e.payload.status === 'done' &&
      ts &&
      ts >= sevenDaysAgo
    ) {
      completedLast7Days += 1;
    }
  }

  const lastEventAgeHours =
    lastEventAt != null ? (now.getTime() - lastEventAt.getTime()) / (1000 * 60 * 60) : null;

  const successRate =
    statusCounts.total > 0 ? statusCounts.done / statusCounts.total : null;
  const blockedRate =
    statusCounts.total > 0 ? statusCounts.blocked / statusCounts.total : null;

  let assignedNonDone = 0;
  let unscheduledAssigned = 0;
  for (const task of tasks) {
    if (task.status === 'done') continue;
    if (String(task.id || '').startsWith('wr-')) continue;
    const hasAssignee = task.assigneeId || task.assignee?.id;
    if (!hasAssignee) continue;
    assignedNonDone += 1;
    if (!task.scheduledStart || !task.scheduledEnd) unscheduledAssigned += 1;
  }

  return {
    projectId: projectState.id,
    title: projectState.title,
    status: projectState.status,
    org: {
      department: projectState.department || null,
      team: projectState.team || null,
      sponsor: projectState.sponsor || null,
    },
    tasks: statusCounts,
    scheduling: {
      assignedNonDone,
      unscheduledAssigned,
      allAssignedScheduled: assignedNonDone > 0 && unscheduledAssigned === 0,
    },
    blockers: {
      count: blockers.length,
    },
    throughput: {
      successRate,
      blockedRate,
    },
    collaboration: {
      crossTeamTasks,
    },
    timeline: {
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      lastEventAgeHours,
      completedLast7Days,
    },
    risk: {
      level: projectState.risk?.level || 'low',
      reasons: projectState.risk?.reasons || [],
    },
    people: {
      byPerson: Array.from(peopleMap.values()),
    },
  };
}

/**
 * Build metrics for all projects from the full store.
 * @param {object} projectsById - map of projectId -> projectState
 * @param {Array<object>} allEvents - full event log
 */
function buildAllProjectMetrics(projectsById, allEvents) {
  const projects = [];
  const eventsByProject = new Map();

  for (const e of allEvents || []) {
    const pid = e.projectId;
    if (!pid) continue;
    if (!eventsByProject.has(pid)) eventsByProject.set(pid, []);
    eventsByProject.get(pid).push(e);
  }

  for (const [id, state] of Object.entries(projectsById || {})) {
    const projectEvents = eventsByProject.get(id) || [];
    projects.push(buildProjectMetrics(state, projectEvents));
  }

  return { projects };
}

module.exports = {
  buildProjectMetrics,
  buildAllProjectMetrics,
};

