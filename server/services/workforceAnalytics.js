/**
 * Workforce productivity & health analytics — derived from live store only.
 *
 * Framework (explainable indexes 0–100):
 * - Productivity: completion rate, 7d/30d throughput vs org
 * - Reliability: low blocker share, recent activity, balanced load
 * - Engagement: multi-project contribution, execution participation
 * - Health: availability, overload, distress signals (open workload/sick requests), stagnation
 * - Overall: weighted blend for leadership matrix ranking
 */

const MS_DAY = 24 * 60 * 60 * 1000;

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function daysAgo(ts, now = new Date()) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / MS_DAY;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function taskAssigneeId(task) {
  return task?.assigneeId || task?.assignee?.id || null;
}

/**
 * @param {{ events: object[], projects: object, people: object[] }} store
 */
function buildWorkforceAnalytics(store) {
  const now = new Date();
  const events = store.events || [];
  const projects = store.projects || {};
  const people = store.people || [];
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_DAY);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_DAY);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * MS_DAY);

  const byId = new Map();
  for (const p of people) {
    byId.set(p.id, {
      personId: p.id,
      name: p.name,
      department: p.department || '',
      team: p.team || '',
      role: p.role || '',
      skills: p.skills || [],
      availabilityStatus: p.availabilityStatus || 'active',
      availabilityUntil: p.availabilityUntil,
      availabilityReason: p.availabilityReason,
      currentLoad: p.currentLoad ?? 0,
      tasksAssigned: 0,
      tasksInProgress: 0,
      tasksDone: 0,
      tasksBlocked: 0,
      tasksPending: 0,
      activeProjectIds: new Set(),
      completions7d: 0,
      completions30d: 0,
      executions30d: 0,
      lastCompletionAt: null,
      openRequestsSubmitted: 0,
      requestsSubmitted30d: 0,
      requestsApproved: 0,
      requestsRejected: 0,
      reviewTasksAssigned: 0,
      reviewTasksDone: 0,
      unassignmentsWhileOnProject: 0,
      emergencySessions: 0,
    });
  }

  for (const [projectId, state] of Object.entries(projects)) {
    const tasks = state?.progress?.tasks || [];
    for (const task of tasks) {
      const aid = taskAssigneeId(task);
      if (!aid || !byId.has(aid)) continue;
      const w = byId.get(aid);
      const status = task.status || 'pending';
      w.tasksAssigned += 1;
      w.activeProjectIds.add(projectId);
      if (status === 'in_progress') w.tasksInProgress += 1;
      else if (status === 'done') w.tasksDone += 1;
      else if (status === 'blocked') w.tasksBlocked += 1;
      else w.tasksPending += 1;
      if (String(task.id || '').startsWith('wr-')) {
        w.reviewTasksAssigned += 1;
        if (status === 'done') w.reviewTasksDone += 1;
      }
    }
  }

  for (const e of events) {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    const pid = e.payload?.personId;

    if (e.type === 'execution' && e.source === 'human' && e.payload?.taskId) {
      let workerId = pid;
      if (!workerId) {
        const st = projects[e.projectId];
        const t = st?.progress?.tasks?.find((x) => x.id === e.payload.taskId);
        workerId = taskAssigneeId(t);
      }
      if (workerId && byId.has(workerId)) {
        const w = byId.get(workerId);
        if (ts && ts >= thirtyDaysAgo) w.executions30d += 1;
        if (e.payload.status === 'done') {
          if (ts && ts >= sevenDaysAgo) w.completions7d += 1;
          if (ts && ts >= thirtyDaysAgo) w.completions30d += 1;
          if (!w.lastCompletionAt || ts > new Date(w.lastCompletionAt)) {
            w.lastCompletionAt = e.timestamp;
          }
        }
      }
    }

    if (e.type === 'need' && e.source === 'human' && pid && byId.has(pid)) {
      const w = byId.get(pid);
      const status = e.payload?.status || 'open';
      if (['open', 'in_review'].includes(status)) w.openRequestsSubmitted += 1;
      if (ts && ts >= thirtyDaysAgo) w.requestsSubmitted30d += 1;
      if (status === 'approved') w.requestsApproved += 1;
      if (status === 'rejected') w.requestsRejected += 1;
    }

    if (e.type === 'unassignment' && e.payload?.personId && byId.has(e.payload.personId)) {
      byId.get(e.payload.personId).unassignmentsWhileOnProject += 1;
    }

    if (
      e.type === 'decision' &&
      e.payload?.decisionType === 'emergency_active' &&
      e.payload?.personId &&
      byId.has(e.payload.personId)
    ) {
      byId.get(e.payload.personId).emergencySessions += 1;
    }
  }

  const loads = [...byId.values()].map((w) => w.currentLoad).sort((a, b) => a - b);
  const completions7 = [...byId.values()].map((w) => w.completions7d).sort((a, b) => a - b);
  const orgBenchmarks = {
    avgLoad: loads.length ? loads.reduce((s, n) => s + n, 0) / loads.length : 0,
    medianLoad: percentile(loads, 0.5),
    p75Load: percentile(loads, 0.75),
    maxCompletions7d: completions7.length ? completions7[completions7.length - 1] : 0,
    headcount: byId.size,
  };

  const workers = [];
  for (const w of byId.values()) {
    const activeProjects = w.activeProjectIds.size;
    const assignedActive = w.tasksInProgress + w.tasksBlocked + w.tasksPending;
    const completionDenom = w.tasksDone + assignedActive;
    const completionRate = completionDenom > 0 ? w.tasksDone / completionDenom : null;
    const blockedShare =
      w.tasksAssigned > 0 ? w.tasksBlocked / w.tasksAssigned : 0;

    const maxC7 = Math.max(1, orgBenchmarks.maxCompletions7d);
    const velocityNorm = (w.completions7d / maxC7) * 100;
    const productivity = clamp(
      (completionRate != null ? completionRate * 55 : 30) +
        velocityNorm * 0.35 +
        Math.min(10, w.completions30d * 2)
    );

    const daysSinceComplete = daysAgo(w.lastCompletionAt, now);
    let activityScore = 50;
    if (daysSinceComplete != null) {
      if (daysSinceComplete <= 3) activityScore = 100;
      else if (daysSinceComplete <= 7) activityScore = 85;
      else if (daysSinceComplete <= 14) activityScore = 60;
      else if (daysSinceComplete <= 30) activityScore = 35;
      else activityScore = 15;
    } else if (assignedActive === 0 && w.tasksDone === 0) {
      activityScore = 50;
    } else if (assignedActive > 0) {
      activityScore = 25;
    }

    const loadPenalty =
      orgBenchmarks.p75Load > 0 && w.currentLoad > orgBenchmarks.p75Load * 1.35
        ? 25
        : w.currentLoad > orgBenchmarks.medianLoad * 2
          ? 15
          : 0;
    const reliability = clamp(
      (1 - blockedShare) * 45 + activityScore * 0.4 + (50 - loadPenalty)
    );

    const engagement = clamp(
      Math.min(40, activeProjects * 12) +
        Math.min(35, w.executions30d * 4) +
        Math.min(25, w.reviewTasksDone * 8)
    );

    let health = 100;
    const signals = [];

    if (w.availabilityStatus === 'on_leave') {
      health -= 45;
      signals.push('On leave');
    } else if (w.availabilityStatus === 'emergency_active') {
      health -= 25;
      signals.push('Emergency return active');
    }

    if (w.currentLoad > orgBenchmarks.p75Load + 1) {
      health -= 18;
      signals.push('High workload');
    }
    if (w.tasksBlocked >= 2) {
      health -= 12;
      signals.push('Multiple blocked tasks');
    }
    if (w.openRequestsSubmitted > 0) {
      health -= 8 * Math.min(3, w.openRequestsSubmitted);
      signals.push(`${w.openRequestsSubmitted} open worker request(s)`);
    }
    if (
      assignedActive > 0 &&
      (daysSinceComplete == null || daysSinceComplete > 14) &&
      w.availabilityStatus === 'active'
    ) {
      health -= 15;
      signals.push('Stale activity on active work');
    }
    if (w.unassignmentsWhileOnProject > 0 && w.availabilityStatus !== 'active') {
      signals.push('Removed from projects (leave)');
    }
    health = clamp(health);

    const overall = clamp(
      productivity * 0.35 + reliability * 0.25 + engagement * 0.2 + health * 0.2
    );

    let statusBand = 'steady';
    if (overall >= 75 && health >= 65) statusBand = 'thriving';
    else if (overall >= 55 && health >= 50) statusBand = 'steady';
    else if (health < 45 || overall < 40) statusBand = 'at_risk';
    else statusBand = 'watch';

    workers.push({
      personId: w.personId,
      name: w.name,
      department: w.department,
      team: w.team,
      role: w.role,
      availabilityStatus: w.availabilityStatus,
      availabilityReason: w.availabilityReason,
      statusBand,
      signals,
      metrics: {
        currentLoad: w.currentLoad,
        tasksAssigned: w.tasksAssigned,
        tasksInProgress: w.tasksInProgress,
        tasksDone: w.tasksDone,
        tasksBlocked: w.tasksBlocked,
        tasksPending: w.tasksPending,
        activeProjects,
        completions7d: w.completions7d,
        completions30d: w.completions30d,
        executions30d: w.executions30d,
        completionRate: completionRate != null ? Math.round(completionRate * 100) : null,
        blockedShare: Math.round(blockedShare * 100),
        lastCompletionAt: w.lastCompletionAt,
        daysSinceLastCompletion:
          daysSinceComplete != null ? Math.round(daysSinceComplete * 10) / 10 : null,
        openRequestsSubmitted: w.openRequestsSubmitted,
        requestsSubmitted30d: w.requestsSubmitted30d,
        reviewTasksAssigned: w.reviewTasksAssigned,
        reviewTasksDone: w.reviewTasksDone,
      },
      indexes: {
        productivity,
        reliability,
        engagement,
        health,
        overall,
      },
    });
  }

  workers.sort((a, b) => b.indexes.overall - a.indexes.overall);

  const matrixColumns = [
    'Productivity',
    'Reliability',
    'Engagement',
    'Health',
    'Overall',
  ];
  const matrixRows = workers.map((w) => ({
    personId: w.personId,
    name: w.name,
    department: w.department,
    values: [
      w.indexes.productivity,
      w.indexes.reliability,
      w.indexes.engagement,
      w.indexes.health,
      w.indexes.overall,
    ],
  }));

  const deptMap = new Map();
  for (const w of workers) {
    const d = w.department || 'Unknown';
    if (!deptMap.has(d)) {
      deptMap.set(d, {
        department: d,
        headcount: 0,
        productivity: [],
        health: [],
        overall: [],
        load: [],
        completions7d: 0,
      });
    }
    const row = deptMap.get(d);
    row.headcount += 1;
    row.productivity.push(w.indexes.productivity);
    row.health.push(w.indexes.health);
    row.overall.push(w.indexes.overall);
    row.load.push(w.metrics.currentLoad);
    row.completions7d += w.metrics.completions7d;
  }

  const departmentSummary = [...deptMap.values()].map((d) => ({
    department: d.department,
    headcount: d.headcount,
    avgProductivity: clamp(d.productivity.reduce((s, n) => s + n, 0) / d.headcount),
    avgHealth: clamp(d.health.reduce((s, n) => s + n, 0) / d.headcount),
    avgOverall: clamp(d.overall.reduce((s, n) => s + n, 0) / d.headcount),
    avgLoad: Math.round((d.load.reduce((s, n) => s + n, 0) / d.headcount) * 10) / 10,
    completions7d: d.completions7d,
  }));
  departmentSummary.sort((a, b) => b.avgOverall - a.avgOverall);

  const distribution = {
    thriving: workers.filter((w) => w.statusBand === 'thriving').length,
    steady: workers.filter((w) => w.statusBand === 'steady').length,
    watch: workers.filter((w) => w.statusBand === 'watch').length,
    at_risk: workers.filter((w) => w.statusBand === 'at_risk').length,
  };

  return {
    generatedAt: now.toISOString(),
    methodology: {
      productivity: 'Completion rate, 7d velocity vs org, 30d throughput',
      reliability: 'Low blocker share, recency of completions, load balance',
      engagement: 'Active projects, execution events (30d), review tasks completed',
      health: 'Availability, overload, open distress requests, stagnation on active work',
      overall: '35% productivity + 25% reliability + 20% engagement + 20% health',
    },
    orgBenchmarks,
    distribution,
    departmentSummary,
    matrix: { columns: matrixColumns, rows: matrixRows },
    workers,
  };
}

module.exports = { buildWorkforceAnalytics };
