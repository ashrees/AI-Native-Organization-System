/**
 * Org-level people roster and post-processing for Org AI peopleInsights.
 * Ensures on-leave and emergency-return staff are not labeled underutilized.
 */

const LEAVE_BLOCKED_SUGGESTION_KINDS = new Set(['rebalance_work', 'acknowledge_contribution']);
const EMERGENCY_BLOCKED_SUGGESTION_KINDS = new Set(['acknowledge_contribution']);

function aggregatePersonTaskMetrics(metrics) {
  const agg = new Map();
  for (const proj of metrics?.projects || []) {
    for (const p of proj.people?.byPerson || []) {
      const id = p.personId;
      if (!id) continue;
      if (!agg.has(id)) {
        agg.set(id, {
          tasksTotal: 0,
          tasksInProgress: 0,
          tasksDone: 0,
          tasksBlocked: 0,
        });
      }
      const e = agg.get(id);
      e.tasksTotal += p.tasksTotal ?? 0;
      e.tasksInProgress += p.tasksInProgress ?? 0;
      e.tasksDone += p.tasksDone ?? 0;
      e.tasksBlocked += p.tasksBlocked ?? 0;
    }
  }
  return agg;
}

/**
 * Roster for Org AI: catalog availability + rolled-up task counts.
 */
function buildOrgPeopleRoster(people, metrics) {
  const byTasks = aggregatePersonTaskMetrics(metrics);
  return (people || []).map((p) => {
    const tasks = byTasks.get(p.id) || {
      tasksTotal: 0,
      tasksInProgress: 0,
      tasksDone: 0,
      tasksBlocked: 0,
    };
    return {
      personId: p.id,
      name: p.name,
      department: p.department,
      team: p.team,
      role: p.role,
      availabilityStatus: p.availabilityStatus || 'active',
      availabilityReason: p.availabilityReason || null,
      availabilityUntil: p.availabilityUntil || null,
      currentLoad: p.currentLoad ?? 0,
      tasks,
    };
  });
}

function leaveSummary(person) {
  const reason = person.availabilityReason;
  const until = person.availabilityUntil;
  const parts = ['On leave'];
  if (reason) parts.push(`(${reason})`);
  if (until) {
    try {
      const d = new Date(until);
      if (!Number.isNaN(d.getTime())) parts.push(`until ${d.toLocaleDateString()}`);
    } catch (_) {
      /* ignore */
    }
  }
  parts.push(
    '— no new assignments expected; zero in-progress tasks is normal. Historical task counts may still appear in metrics.'
  );
  return parts.join(' ');
}

function emergencySummary(person) {
  return `${person.name || person.id} is on emergency return from leave; only treat active assignments as current workload.`;
}

/**
 * Correct or strip misleading peopleInsights after Org AI (or when serving cached results).
 */
function sanitizePeopleInsights(rawPeople, peopleById) {
  return (rawPeople || []).map((pi) => {
    const personId = pi.personId;
    const person = personId ? peopleById.get(personId) : null;
    const status = person?.availabilityStatus || pi.availabilityStatus || 'active';

    if (status === 'on_leave') {
      const filtered = (pi.suggestedRequests || []).filter(
        (sr) => !LEAVE_BLOCKED_SUGGESTION_KINDS.has(sr.kind)
      );
      return {
        ...pi,
        personId: personId || pi.personId,
        name: pi.name || person?.name,
        availabilityStatus: 'on_leave',
        availabilityReason: person?.availabilityReason || pi.availabilityReason || null,
        loadLevel: 'on_leave',
        summary: person ? leaveSummary(person) : pi.summary || leaveSummary({ availabilityReason: pi.availabilityReason }),
        suggestedRequests: filtered,
      };
    }

    if (status === 'emergency_active') {
      const filtered = (pi.suggestedRequests || []).filter(
        (sr) => !EMERGENCY_BLOCKED_SUGGESTION_KINDS.has(sr.kind)
      );
      return {
        ...pi,
        personId: personId || pi.personId,
        name: pi.name || person?.name,
        availabilityStatus: 'emergency_active',
        loadLevel: 'emergency_return',
        summary: person ? emergencySummary(person) : pi.summary,
        suggestedRequests: filtered,
      };
    }

    return pi;
  });
}

module.exports = {
  buildOrgPeopleRoster,
  sanitizePeopleInsights,
};
