/**
 * Mock human worker NPCs — simulate every person in the roster using the same
 * worker dashboard and /worker/status flows (submitWorkerStatus), so the org
 * looks alive like a game world.
 */

const agentActivityLog = require('../lib/agentActivityLog');
const { personCanWork } = require('./emergencyReturn');
const {
  personCanReviewWorkerRequest,
  applyWorkerRequestReview,
} = require('../lib/workerRequestLifecycle');
const { requestRequiresHrInbox } = require('../lib/hrRouting');

const SOURCE = 'mock_worker';

const ENABLED = process.env.MOCK_WORKER_ENABLED !== 'false';
const INTERVAL_MS = Math.max(15000, parseInt(process.env.MOCK_WORKER_INTERVAL_MS || '45000', 10));
const BATCH_SIZE = Math.max(1, parseInt(process.env.MOCK_WORKER_BATCH_SIZE || '4', 10));
const MIN_COOLDOWN_MS = Math.max(5000, parseInt(process.env.MOCK_WORKER_MIN_COOLDOWN_MS || '30000', 10));
const REQUEST_COOLDOWN_MS = Math.max(
  60000,
  parseInt(process.env.MOCK_WORKER_REQUEST_COOLDOWN_MS || '120000', 10)
);
const REQUEST_CHANCE = Math.min(1, Math.max(0, parseFloat(process.env.MOCK_WORKER_REQUEST_CHANCE || '0.28')));
const LEAVE_REQUEST_CHANCE = Math.min(
  1,
  Math.max(0, parseFloat(process.env.MOCK_WORKER_LEAVE_CHANCE || '0.05'))
);
const LEAVE_COOLDOWN_MS = Math.max(
  REQUEST_COOLDOWN_MS,
  parseInt(process.env.MOCK_WORKER_LEAVE_COOLDOWN_MS || '900000', 10)
);
const MAX_ORG_ON_LEAVE_COUNT = Math.max(
  0,
  parseInt(process.env.MOCK_WORKER_MAX_ON_LEAVE_COUNT || '3', 10)
);
const MAX_ORG_ON_LEAVE_FRACTION = Math.min(
  1,
  Math.max(0, parseFloat(process.env.MOCK_WORKER_MAX_ON_LEAVE_FRACTION || '0.15'))
);
const HR_LEAVE_APPROVE_CHANCE = Math.min(
  1,
  Math.max(0, parseFloat(process.env.MOCK_WORKER_HR_LEAVE_APPROVE_CHANCE || '0.4'))
);
const LEAVE_KINDS = new Set(['sick_leave', 'vacation']);
const SKIP_IDS = new Set(['org_ai']);

/** Simulated human requests — varied kinds and handling modes. */
const NPC_REQUEST_SCENARIOS = [
  {
    kind: 'sick_leave',
    weight: 1,
    orgWide: true,
    handlingModes: ['notify'],
    titles: ['Sick day — {name}', 'Unable to work today', 'Medical absence'],
    descriptions: ['Feeling unwell; need the day off.', 'Doctor visit scheduled.'],
    dateOffset: [0, 2],
  },
  {
    kind: 'vacation',
    weight: 1,
    orgWide: true,
    handlingModes: ['notify'],
    titles: ['PTO — {name}', 'Planned vacation'],
    descriptions: ['Family trip.', 'Taking time off for rest.'],
    dateOffset: [7, 14],
  },
  {
    kind: 'workload_concern',
    weight: 4,
    needsProject: true,
    handlingModes: ['notify', 'self', 'ai'],
    titles: ['Too many parallel tasks', 'Deadline risk on {project}', 'Need help prioritizing'],
    descriptions: [
      'Current assignments exceed capacity this sprint.',
      'Blocked on dependencies and need rebalancing.',
    ],
  },
  {
    kind: 'schedule_change',
    weight: 3,
    needsProject: true,
    handlingModes: ['ai'],
    titles: ['Shift milestone on {project}', 'Timeline adjustment needed'],
    descriptions: ['Milestone should move by one week.', 'Dependency slip — propose new dates.'],
  },
  {
    kind: 'project_transfer',
    weight: 2,
    needsProject: true,
    handlingModes: ['notify', 'self'],
    titles: ['Transfer to another team', 'Request project move'],
    descriptions: ['Skills better aligned with another initiative.', 'Seeking rotation for growth.'],
  },
  {
    kind: 'training',
    weight: 2,
    orgWide: true,
    handlingModes: ['ai'],
    titles: ['Training request — {name}', 'Course enrollment'],
    descriptions: ['Need time for certification prep.', 'Workshop next month.'],
  },
  {
    kind: 'equipment',
    weight: 2,
    orgWide: true,
    handlingModes: ['ai'],
    titles: ['Laptop upgrade', 'Access to tooling'],
    descriptions: ['Current machine too slow for builds.', 'Need license for design tool.'],
  },
  {
    kind: 'blocker_escalation',
    weight: 3,
    needsProject: true,
    handlingModes: ['notify', 'self'],
    titles: ['Blocked on {project}', 'Escalation: external dependency'],
    descriptions: ['Waiting on vendor API for 5 days.', 'Cross-team blocker needs leadership attention.'],
  },
  {
    kind: 'general',
    weight: 1,
    orgWide: true,
    handlingModes: ['notify', 'self', 'ai'],
    titles: ['Workplace question', 'Policy clarification'],
    descriptions: ['Need guidance on remote work policy.', 'Question about benefits enrollment.'],
  },
];

/** Request kinds NPC reviewers may approve when in notify/self flow (not AI-watching). */
const NPC_REVIEW_KINDS = new Set([
  'team_member',
  'onboarding',
  'general',
  'training',
  'equipment',
  'schedule_change',
  'workload_concern',
  'project_contribution_change',
]);

const START_NOTES = [
  'Picking up {title} on {project}.',
  'Starting work on {title}.',
  'On it — {title} ({project}).',
  'Diving into {title} now.',
];

const DONE_NOTES = [
  'Finished {title} for {project}.',
  'Wrapped up {title} — moving on.',
  'Done with {title}.',
  'Shipped {title} ({project}).',
];

const REVIEW_NOTES = [
  'Reviewed and approved — routing looks good.',
  'LGTM — approved from worker portal.',
  'Approved; team can proceed.',
];

let timer = null;
let tickIndex = 0;
let lastTickAt = null;
let lastTickSummary = { processed: 0, actions: 0, errors: 0 };

const lastActionAt = new Map();
const lastRequestAt = new Map();
const lastLeaveRequestAt = new Map();

function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function addDaysISO(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function orgLeavePressure(ctx) {
  const people = ctx.loadPeople?.() || [];
  const onLeave = people.filter((p) => p.availabilityStatus === 'on_leave').length;
  const total = people.length || 1;
  return { onLeave, total, fraction: onLeave / total };
}

function orgAtLeaveCap(ctx) {
  const { onLeave, fraction } = orgLeavePressure(ctx);
  return onLeave >= MAX_ORG_ON_LEAVE_COUNT || fraction >= MAX_ORG_ON_LEAVE_FRACTION;
}

function countOpenLeaveNeeds(eventLog, personId) {
  return (eventLog || []).filter(
    (e) =>
      e.type === 'need' &&
      e.payload?.personId === personId &&
      LEAVE_KINDS.has(e.payload?.kind) &&
      ['open', 'in_review'].includes(e.payload?.status || 'open')
  ).length;
}

function pickWeightedScenario(ctx, rng = Math.random) {
  let pool = NPC_REQUEST_SCENARIOS;
  if (orgAtLeaveCap(ctx)) {
    pool = pool.filter((s) => !LEAVE_KINDS.has(s.kind));
  }
  if (pool.length === 0) pool = NPC_REQUEST_SCENARIOS.filter((s) => !LEAVE_KINDS.has(s.kind));
  if (pool.length === 0) return NPC_REQUEST_SCENARIOS[0];

  const total = pool.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const scenario of pool) {
    r -= scenario.weight;
    if (r <= 0) return scenario;
  }
  return pool[0];
}

function canSubmitLeaveRequest(person, ctx) {
  if ((person.availabilityStatus || 'active') === 'on_leave') return false;
  if (Math.random() > LEAVE_REQUEST_CHANCE) return false;
  if (orgAtLeaveCap(ctx)) return false;

  const lastLeave = lastLeaveRequestAt.get(person.id) || 0;
  if (Date.now() - lastLeave < LEAVE_COOLDOWN_MS) return false;

  const eventLog = typeof ctx.getEventLog === 'function' ? ctx.getEventLog() : [];
  if (countOpenLeaveNeeds(eventLog, person.id) > 0) return false;

  return true;
}

function pickHandlingMode(scenario, rng = Math.random) {
  const modes = scenario.handlingModes || ['notify'];
  return modes[Math.floor(rng() * modes.length)];
}

/**
 * Submit a realistic worker request (same API path as Worker Portal).
 */
async function trySubmitNpcRequest(person, ctx) {
  if (Math.random() > REQUEST_CHANCE) return null;
  const lastReq = lastRequestAt.get(person.id) || 0;
  if (Date.now() - lastReq < REQUEST_COOLDOWN_MS) return null;

  const dashboard = ctx.buildWorkerDashboard(person.id);
  if (!dashboard) return null;

  const activeProjects = (dashboard.projects || []).filter(
    (p) => (p.status || 'active') === 'active' && !p.archived
  );
  let scenario = pickWeightedScenario(ctx);
  if (scenario.needsProject && activeProjects.length === 0) return null;

  if (LEAVE_KINDS.has(scenario.kind) && !canSubmitLeaveRequest(person, ctx)) {
    const nonLeave = NPC_REQUEST_SCENARIOS.filter(
      (s) => !LEAVE_KINDS.has(s.kind) && (!s.needsProject || activeProjects.length > 0)
    );
    if (nonLeave.length === 0) return null;
    scenario = pick(nonLeave);
  }

  const project =
    scenario.orgWide || !scenario.needsProject
      ? null
      : pick(activeProjects);
  const projectId = project?.id;
  const vars = {
    name: person.name,
    project: project?.title || projectId || 'project',
  };
  const title = fill(pick(scenario.titles), vars);
  const description = fill(pick(scenario.descriptions), vars);
  const handlingMode = pickHandlingMode(scenario);
  let startDate;
  let endDate;
  if (scenario.dateOffset) {
    startDate = addDaysISO(scenario.dateOffset[0]);
    endDate = addDaysISO(scenario.dateOffset[1]);
  }

  const { submitWorkerRequest } = require('./workerRequestSubmit');
  const result = await submitWorkerRequest(
    {
      personId: person.id,
      kind: scenario.kind,
      handlingMode,
      title,
      description,
      projectId,
      startDate,
      endDate,
      source: 'mock_worker',
    },
    {
      emitEvent: ctx.emitEvent,
      getStore: ctx.getStore,
      loadPeople: ctx.loadPeople,
      getEventLog: ctx.getEventLog,
      buildWorkerRequestCtx: ctx.buildWorkerRequestCtx,
      updateWorkerRequest: ctx.updateWorkerRequest,
    }
  );

  if (result.status !== 201) {
    return { skipped: result.body?.error || 'request_failed', actions: [] };
  }

  lastRequestAt.set(person.id, Date.now());
  lastActionAt.set(person.id, Date.now());
  if (LEAVE_KINDS.has(scenario.kind)) {
    lastLeaveRequestAt.set(person.id, Date.now());
  }

  const body = result.body;
  agentActivityLog.push({
    source: SOURCE,
    projectId: body.projectId || null,
    message: `${person.name} submitted ${scenario.kind} [${handlingMode}]: "${title}" → ${body.status || 'open'}.`,
  });

  return {
    actions: [
      {
        type: 'worker_request',
        kind: scenario.kind,
        handlingMode,
        requestId: body.id,
        status: body.status,
        aiAutoApproved: body.aiAutoApproved,
      },
    ],
  };
}

function isReviewTask(task) {
  const title = (task.title || '').toLowerCase();
  return title.includes('review worker request') || title.includes('review:');
}

function shouldSkipPerson(person) {
  if (!person?.id || SKIP_IDS.has(person.id)) return true;
  if (!personCanWork(person)) return true;
  const last = lastActionAt.get(person.id) || 0;
  if (Date.now() - last < MIN_COOLDOWN_MS) return true;
  return false;
}

/**
 * One NPC action for a person (same paths as Worker Portal).
 * @returns {Promise<{ actions: object[], skipped?: string }>}
 */
async function actAsWorker(person, ctx) {
  const dashboard = ctx.buildWorkerDashboard(person.id);
  if (!dashboard) return { skipped: 'no_dashboard', actions: [] };

  const tasks = dashboard.tasks || [];
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const pending = tasks.filter((t) => !t.status || t.status === 'pending');
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const reviewTasks = tasks.filter(
    (t) => isReviewTask(t) && t.status !== 'done' && (t.status === 'in_progress' || t.status === 'pending')
  );

  const vars = (task) => ({
    title: task.title || task.id,
    project: task.projectTitle || task.projectId,
  });

  async function postStatus(task, status, notes) {
    return ctx.submitWorkerStatus({
      projectId: task.projectId,
      taskId: task.id,
      personId: person.id,
      status,
      notes,
    });
  }

  if (inProgress.length > 0) {
    const task = pick(inProgress);
    const result = await postStatus(task, 'done', fill(pick(DONE_NOTES), vars(task)));
    if (result.status === 201) {
      logAction(person, task, 'done');
      return { actions: [{ type: 'task_done', taskId: task.id, projectId: task.projectId }] };
    }
    return { skipped: result.body?.error || 'status_failed', actions: [] };
  }

  if (pending.length > 0) {
    const task = pick(pending);
    const result = await postStatus(task, 'in_progress', fill(pick(START_NOTES), vars(task)));
    if (result.status === 201) {
      logAction(person, task, 'in_progress');
      return { actions: [{ type: 'task_start', taskId: task.id, projectId: task.projectId }] };
    }
    return { skipped: result.body?.error || 'status_failed', actions: [] };
  }

  if (reviewTasks.length > 0) {
    const task = reviewTasks[0];
    const result = await postStatus(task, 'done', 'Review complete (mock worker).');
    if (result.status === 201) {
      logAction(person, task, 'review_done');
      return { actions: [{ type: 'review_task_done', taskId: task.id }] };
    }
  }

  if (blocked.length > 0 && Math.random() < 0.35) {
    const task = pick(blocked);
    const result = await postStatus(task, 'in_progress', `Retrying ${task.title || task.id} after blocker.`);
    if (result.status === 201) {
      logAction(person, task, 'unblock');
      return { actions: [{ type: 'task_retry', taskId: task.id }] };
    }
  }

  const reviewAction = await tryApproveProjectInbox(person, ctx);
  if (reviewAction) return reviewAction;

  if (dashboard.isHr) {
    const hrAction = await tryHrNpcActions(person, ctx);
    if (hrAction) return hrAction;
  }

  const requestAction = await trySubmitNpcRequest(person, ctx);
  if (requestAction?.actions?.length) return requestAction;

  return { skipped: 'idle', actions: [] };
}

function logAction(person, task, kind) {
  const msg = `${person.name}: ${kind} — ${task.title || task.id} (${task.projectTitle || task.projectId})`;
  agentActivityLog.push({
    source: SOURCE,
    projectId: task.projectId,
    message: msg,
  });
}

async function tryApproveProjectInbox(person, ctx) {
  const inbox = ctx.buildProjectInbox(person.id) || [];
  const eventLog = ctx.getEventLog();
  const people = ctx.loadPeople();
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const PROJECT_AUTO_KINDS = new Set([...NPC_REVIEW_KINDS, 'schedule_change']);

  for (const mapped of inbox) {
    if (mapped.aiAutoApproved || mapped.aiHandled) continue;
    if (!PROJECT_AUTO_KINDS.has(mapped.kind)) continue;

    const needEvent = eventLog.find((e) => e.id === mapped.id && e.type === 'need');
    if (!needEvent) continue;
    if (!personCanReviewWorkerRequest(person, mapped)) continue;

    const wrCtx = ctx.buildWorkerRequestCtx();
    await applyWorkerRequestReview(
      needEvent,
      {
        status: 'approved',
        reviewNotes: pick(REVIEW_NOTES),
        reviewedAt: new Date().toISOString(),
      },
      person,
      wrCtx
    );
    await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);

    agentActivityLog.push({
      source: SOURCE,
      projectId: needEvent.projectId,
      message: `${person.name} approved worker request "${mapped.title}" (NPC reviewer).`,
    });

    return {
      actions: [{ type: 'request_approved', requestId: mapped.id, kind: mapped.kind }],
    };
  }

  return null;
}

async function tryHrNpcActions(person, ctx) {
  const hr = ctx.buildHrInbox(person.id);
  if (!hr) return null;

  for (const t of hr.hrTasks || []) {
    if (t.status === 'done') continue;
    const result = await ctx.submitWorkerStatus({
      projectId: t.projectId,
      taskId: t.id,
      personId: person.id,
      status: 'done',
      notes: 'HR review task closed (mock worker).',
    });
    if (result.status === 201) {
      agentActivityLog.push({
        source: SOURCE,
        projectId: t.projectId,
        message: `${person.name} closed HR review task "${t.title}".`,
      });
      return { actions: [{ type: 'hr_task_done', taskId: t.id }] };
    }
  }

  const eventLog = ctx.getEventLog();
  const peopleById = new Map(ctx.loadPeople().map((p) => [p.id, p]));

  const HR_AUTO_KINDS = new Set([
    'team_member',
    'onboarding',
    'general',
    'training',
    'equipment',
    'sick_leave',
    'vacation',
  ]);

  for (const mapped of hr.inbox || []) {
    if (mapped.aiAutoApproved) continue;
    if (!HR_AUTO_KINDS.has(mapped.kind)) continue;
    if (LEAVE_KINDS.has(mapped.kind)) {
      if (orgAtLeaveCap(ctx) || Math.random() > HR_LEAVE_APPROVE_CHANCE) continue;
    }

    const needEvent = eventLog.find((e) => e.id === mapped.id && e.type === 'need');
    if (!needEvent || !requestRequiresHrInbox(mapped)) continue;

    const wrCtx = ctx.buildWorkerRequestCtx();
    await applyWorkerRequestReview(
      needEvent,
      {
        status: 'approved',
        reviewNotes: 'HR approved (mock worker).',
        reviewedAt: new Date().toISOString(),
      },
      person,
      wrCtx
    );
    await ctx.updateWorkerRequest(needEvent.id, needEvent.payload);

    agentActivityLog.push({
      source: SOURCE,
      projectId: needEvent.projectId,
      message: `${person.name} approved HR request "${mapped.title}".`,
    });

    return { actions: [{ type: 'hr_request_approved', requestId: mapped.id }] };
  }

  return null;
}

/**
 * Run one simulation tick (batch of people).
 */
async function runMockWorkerTick(ctx, options = {}) {
  const people = (ctx.loadPeople() || []).filter((p) => !shouldSkipPerson(p));
  if (people.length === 0) {
    lastTickAt = new Date().toISOString();
    lastTickSummary = { processed: 0, actions: 0, errors: 0 };
    return lastTickSummary;
  }

  const batch = options.personId
    ? people.filter((p) => p.id === options.personId)
    : (() => {
        const sorted = [...people].sort((a, b) => a.id.localeCompare(b.id));
        const start = tickIndex % sorted.length;
        tickIndex += BATCH_SIZE;
        const slice = [];
        for (let i = 0; i < BATCH_SIZE && i < sorted.length; i += 1) {
          slice.push(sorted[(start + i) % sorted.length]);
        }
        return slice;
      })();

  let actions = 0;
  let errors = 0;

  for (const person of batch) {
    try {
      const result = await actAsWorker(person, ctx);
      if (result.actions?.length) {
        actions += result.actions.length;
        lastActionAt.set(person.id, Date.now());
      }
    } catch (err) {
      errors += 1;
      console.warn(`[MockWorker] ${person.id}:`, err.message);
    }
  }

  lastTickAt = new Date().toISOString();
  lastTickSummary = { processed: batch.length, actions, errors };
  return lastTickSummary;
}

function getMockWorkerStatus() {
  return {
    enabled: ENABLED && !!timer,
    configured: ENABLED,
    intervalMs: INTERVAL_MS,
    batchSize: BATCH_SIZE,
    minCooldownMs: MIN_COOLDOWN_MS,
    requestChance: REQUEST_CHANCE,
    leaveRequestChance: LEAVE_REQUEST_CHANCE,
    maxOnLeaveCount: MAX_ORG_ON_LEAVE_COUNT,
    lastTickAt,
    lastTickSummary,
    activePeople: (() => {
      try {
        const workerRouter = require('../routes/worker');
        const eventsRouter = require('../routes/events');
        if (!eventsRouter.loadPeople) return 0;
        return eventsRouter.loadPeople().filter((p) => !shouldSkipPerson(p)).length;
      } catch {
        return 0;
      }
    })(),
  };
}

function buildMockWorkerCtx() {
  const eventsRouter = require('../routes/events');
  const workerRouter = require('../routes/worker');

  return {
    submitWorkerStatus: eventsRouter.submitWorkerStatus,
    emitEvent: eventsRouter.emitEvent,
    getStore: eventsRouter.getStore,
    loadPeople: eventsRouter.loadPeople,
    getEventLog: eventsRouter.getEventLog,
    buildWorkerDashboard: workerRouter.buildWorkerDashboard,
    buildProjectInbox: workerRouter.buildProjectInbox,
    buildHrInbox: workerRouter.buildHrInbox,
    buildWorkerRequestCtx: eventsRouter.buildWorkerRequestCtx,
    updateWorkerRequest: eventsRouter.updateWorkerRequest,
  };
}

function startMockWorkerNPC(ctx) {
  if (!ENABLED) {
    console.log('[MockWorker] Disabled (MOCK_WORKER_ENABLED=false).');
    return;
  }
  if (timer) return;

  const runCtx = ctx || buildMockWorkerCtx();

  const tick = () => {
    runMockWorkerTick(runCtx).catch((err) => {
      console.warn('[MockWorker] Tick error:', err.message);
    });
  };

  const bootDelay = Math.max(5000, parseInt(process.env.MOCK_WORKER_BOOT_DELAY_MS || '12000', 10));
  setTimeout(() => {
    tick();
    timer = setInterval(tick, INTERVAL_MS);
    console.log(
      `[MockWorker] NPC workers active — every ${INTERVAL_MS}ms, batch ${BATCH_SIZE} (worker dashboard + /worker/status).`
    );
  }, bootDelay);
}

function stopMockWorkerNPC() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  SOURCE,
  actAsWorker,
  runMockWorkerTick,
  startMockWorkerNPC,
  stopMockWorkerNPC,
  getMockWorkerStatus,
  buildMockWorkerCtx,
};
