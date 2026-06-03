/**
 * Event intake: POST /events to submit an event, GET for debug/health.
 * Validates, persists, routes by type; Project AI apply is invoked from the orchestration flow.
 * On "request" events: runs Orchestrator → Team Builder → Scheduler and emits plan_created, assignment, schedule_proposed events.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { validateEvent, EXECUTION_STATUSES } = require('../models/eventSchema');
const { applyEvent, createEmptyState, findTask, applyEvents } = require('../models/projectState');
const orchestratorAI = require('../services/orchestratorAI');
const teamBuilderAI = require('../services/teamBuilderAI');
const schedulerAI = require('../services/schedulerAI');
const agentActivityLog = require('../lib/agentActivityLog');
const { scheduleProjectStatusCheck, startProjectAIStatusPolling, shouldScheduleStatusCheck } = require('../services/projectAIEvaluator');
const {
  shouldRequestAssignmentGapFill,
  scheduleAssignmentGapFill,
} = require('../services/assignmentGapFill');
const { buildAllProjectMetrics } = require('../services/metrics');
const { buildAgentContext } = require('../services/retrieval');
const postgresStore = require('../store/postgresStore');

/** AI agents must not create projects; only human/system events can create a project. */
const AI_EVENT_SOURCES = Object.freeze(['orchestrator', 'team_builder', 'scheduler', 'project_ai']);

// In-memory cache; loaded from Postgres at startup and updated on every event.
let eventLog = [];
let projects = {};
let peopleCache = [];

// Server-Sent Events clients for live updates (Leadership View)
const sseClients = new Set();

function sseBroadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      // ignore broken connections; removed on close
    }
  }
}

function rebuildProjectsFromEventLog() {
  const projectIds = [...new Set(eventLog.map((e) => e.projectId).filter(Boolean))];
  for (const projectId of projectIds) {
    const projectEvents = eventLog.filter((e) => e.projectId === projectId);
    const state = applyEvents(null, projectEvents, projectId);
    projects[projectId] = state;
  }
}

/**
 * Async init: load events, project state, and people from Postgres.
 */
async function initStore() {
  await postgresStore.ensureTables();

  const diagnostic = await postgresStore.getConnectionDiagnostic();
  if (diagnostic) {
    if (diagnostic.error) {
      console.warn('[Store] Postgres diagnostic failed:', diagnostic.error);
    } else {
      console.log(
        `[Store] Postgres: database=${diagnostic.database}, schema=${diagnostic.schema} | events=${diagnostic.events}, projects=${diagnostic.projects}, people=${diagnostic.people}, needs=${diagnostic.needs ?? 'n/a'}`
      );
    }
  } else {
    console.warn('[Store] Postgres: no connection diagnostic (pool not ready).');
  }

  await postgresStore.ensureDefaultPeople();
  eventLog = await postgresStore.loadAllEvents();
  rebuildProjectsFromEventLog();
  await recomputePeopleLoadFromProjects();
  peopleCache = await postgresStore.loadAllPeople();
  if (peopleCache.length === 0) {
    console.warn('[Store] No people in DB; re-running ensureDefaultPeople().');
    await postgresStore.ensureDefaultPeople();
    peopleCache = await postgresStore.loadAllPeople();
  }
  console.log(`[Store] Loaded ${eventLog.length} events, ${Object.keys(projects).length} projects, ${peopleCache.length} people.`);

  try {
    const { reconcileApprovedWorkerRequests } = require('../lib/reconcileApprovedRequests');
    await reconcileApprovedWorkerRequests(router);
  } catch (err) {
    console.warn('[Store] Approved request reconciliation skipped:', err.message);
  }

  startProjectAIStatusPolling(buildProjectAICtx());
}

/**
 * Recompute each person's current_load from project state (count of assigned tasks not done).
 * Call after loading events and rebuilding projects so agents see accurate load.
 */
async function recomputePeopleLoadFromProjects() {
  const people = await postgresStore.loadAllPeople();
  if (people.length === 0) return;
  const loadByPerson = new Map(people.map((p) => [p.id, 0]));
  for (const state of Object.values(projects)) {
    const tasks = state?.progress?.tasks || [];
    for (const t of tasks) {
      const assigneeId = t?.assigneeId || (t?.assignee && t.assignee.id);
      if (!assigneeId) continue;
      if (t.status === 'done') continue;
      loadByPerson.set(assigneeId, (loadByPerson.get(assigneeId) || 0) + 1);
    }
  }
  for (const p of people) {
    const load = loadByPerson.get(p.id) || 0;
    await postgresStore.upsertPerson({ ...p, currentLoad: load });
  }
}

/** Load people from Postgres (cached at startup for Team Builder AI). */
function loadPeople() {
  return peopleCache;
}

/**
 * Shorten agent rationale for UI log: max 2 sentences.
 * Used so "What changed recently" shows a concise message per agent action.
 */
function agentLogMessage(text, maxSentences = 2) {
  if (text == null || typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const sentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return trimmed;
  const taken = sentences.slice(0, maxSentences).join(' ');
  return taken.endsWith('.') || taken.endsWith('!') || taken.endsWith('?') ? taken : `${taken}.`;
}

/** Human-readable line for execution events in Leadership "What changed recently". */
function humanExecutionRationale(projectState, payload, opts = {}) {
  const { taskId, status, notes } = payload || {};
  const task = taskId && projectState ? findTask(projectState, taskId) : null;
  const title = task?.title || taskId || 'task';
  const statusLabel = String(status || 'updated').replace(/_/g, ' ');
  const who = opts.personName ? `${opts.personName} — ` : '';
  let msg = `${who}Task "${title}" marked ${statusLabel}`;
  if (notes && String(notes).trim()) msg += `: ${String(notes).trim()}`;
  return agentLogMessage(msg) || msg;
}

function enrichEventRationale(event) {
  if (!event || event.rationale) return event;
  const state = projects[event.projectId];
  if (event.type === 'execution' && event.source === 'human') {
    const personId = event.payload?.personId;
    const person = personId ? peopleCache.find((p) => p.id === personId) : null;
    event.rationale = humanExecutionRationale(state, event.payload, {
      personName: person?.name,
    });
  } else if (event.type === 'decision' && event.source === 'human') {
    const dt = event.payload?.decisionType || 'decision';
    const reason = event.payload?.reason;
    event.rationale =
      agentLogMessage(reason) ||
      `Human decision: ${String(dt).replace(/_/g, ' ')}`;
  }
  return event;
}

/**
 * Apply event to project state and persist.
 * All mutations to project state go through here (per event-model invariants).
 * AI agents are not allowed to create projects: if the event is from an AI source and the project
 * does not exist yet, we do not create it (event is still appended to the log for audit).
 * Need events are also written to the needs table for querying/updates.
 */
async function applyAndPersist(event) {
  const projectId = event.projectId;
  const projectExists = projects[projectId] != null;
  if (AI_EVENT_SOURCES.includes(event.source) && !projectExists) {
    return;
  }
  const current = projects[projectId] || createEmptyState(projectId);
  const next = applyEvent(current, event);
  projects[projectId] = next;
  await postgresStore.appendEvent(event);
  await postgresStore.saveProjectState(projectId, next);
  if (event.type === 'need' && event.payload && event.payload.kind && event.payload.description) {
    await postgresStore.upsertNeed({
      id: event.id,
      projectId,
      taskId: event.payload.taskId || null,
      source: event.source,
      kind: event.payload.kind,
      description: event.payload.description,
      status: event.payload.status || 'open',
      eventId: event.id,
      createdAt: event.timestamp,
    });
  }
}

/**
 * Emit a new event: append to log and apply to project state.
 * Used by orchestration when we generate plan_created, assignment, schedule_proposed.
 */
async function emitEvent(event) {
  eventLog.push(event);
  await applyAndPersist(event);
  sseBroadcast('event', { id: event.id, type: event.type, projectId: event.projectId, timestamp: event.timestamp });

  if (shouldScheduleStatusCheck(event)) {
    scheduleProjectStatusCheck(event.projectId, event, buildProjectAICtx());
  }
}

/**
 * Agent hierarchy (tier order). Lower tier runs first; each tier waits for the previous to complete before running.
 * Model access is serialized globally: only one agent uses the LLM at a time (see server/lib/llm.js).
 *
 * Tier 1: orchestrator  — creates plan from request
 * Tier 2: team_builder  — assigns each task (runs once per task, in order)
 * Tier 3: scheduler     — proposes schedule for all tasks
 */
const AGENT_HIERARCHY = Object.freeze(['orchestrator', 'team_builder', 'scheduler']);

const AGENT_STEP_RETRIES = Math.max(0, parseInt(process.env.AGENT_STEP_RETRIES || '3', 10));
const AGENT_STEP_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.AGENT_STEP_RETRY_DELAY_MS || '1500', 10));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the request flow: Orchestrator → Team Builder → Scheduler.
 * LLM is the main brain: we retry until we get a proper LLM response (or exhaust retries). Stubs only as last resort.
 */
async function handleRequestFlow(requestEvent) {
  const projectId = requestEvent.projectId;
  let projectState = projects[projectId] || createEmptyState(projectId);

  if (projectState.status === 'killed') {
    return;
  }

  const people = loadPeople();
  const requestId = requestEvent.id;

  const store = { eventLog, projects, people, metrics: buildAllProjectMetrics(projects, eventLog) };
  const orchestratorContext = buildAgentContext('orchestrator', projectId, { request: requestEvent.payload }, store);

  // a. Orchestrator: retry until we get a plan (LLM or stub only after retries)
  let plan = null;
  for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
    plan = await orchestratorAI.createPlan(requestEvent.payload, projectState, orchestratorContext);
    const needRetry = plan._usedStub && plan._failReason === 'timed_out_or_no_response' && attempt <= AGENT_STEP_RETRIES;
    if (!needRetry) break;
    await delay(AGENT_STEP_RETRY_DELAY_MS);
  }

  if (projects[projectId]?.status === 'killed') return;

  // b. Emit plan_created (source: orchestrator, correlationId: request.id)
  const planCreatedEvent = {
    id: crypto.randomUUID(),
    type: 'plan_created',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'orchestrator',
    correlationId: requestId,
    rationale: agentLogMessage(plan.summary) || undefined,
    payload: {
      tasks: plan.tasks || [],
      riskLevel: plan.riskLevel,
      impactLevel: plan.impactLevel,
      summary: plan.summary,
    },
  };
  await emitEvent(planCreatedEvent);

  // Persist any needs from the orchestrator (request/changes/updates) to DB
  const planNeeds = plan.needs || [];
  for (const need of planNeeds) {
    const needEvent = {
      id: crypto.randomUUID(),
      type: 'need',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'orchestrator',
      correlationId: planCreatedEvent.id,
      rationale: need.description,
      payload: {
        kind: need.kind || 'general',
        description: need.description || '',
        taskId: need.taskId || undefined,
        status: 'open',
      },
    };
    await emitEvent(needEvent);
  }

  const tasks = plan.tasks || [];
  if (tasks.length === 0) return;

  if (projects[projectId]?.status === 'killed') return;

  // c. Team Builder: one call per task, retry until valid LLM response or exhaust retries
  const tasksWithAssignees = [];
  const assignedInRun = {};
  for (const task of tasks) {
    if (projects[projectId]?.status === 'killed') return;
    const projectStateCurrent = projects[projectId] || createEmptyState(projectId);
    const teamBuilderContext = buildAgentContext('team_builder', projectId, { currentTask: task }, store);
    let assignResult = null;
    for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
      assignResult = await teamBuilderAI.assignTask(task, loadPeople(), projectStateCurrent, { assignedInRun, agentContext: teamBuilderContext });
      const needRetry = assignResult._usedStub && assignResult._failReason === 'timed_out_or_no_response' && attempt <= AGENT_STEP_RETRIES;
      if (!needRetry) break;
      await delay(AGENT_STEP_RETRY_DELAY_MS);
    }
    const { personId, rationale } = assignResult;
    if (!personId) {
      // Fallback: if we have people but stub returned null (e.g. empty filtered list), assign via stub with full list
      const peopleList = loadPeople();
      if (peopleList && peopleList.length > 0) {
        const fallback = teamBuilderAI.stubAssign(task, peopleList, projectStateCurrent, { assignedInRun, agentContext: teamBuilderContext });
        if (fallback.personId) {
          const fbPersonId = fallback.personId;
          const fbRationale = fallback.rationale;
          assignedInRun[fbPersonId] = (assignedInRun[fbPersonId] || 0) + 1;
          const person = peopleList.find((p) => p.id === fbPersonId) || null;
          const assignmentEvent = {
            id: crypto.randomUUID(),
            type: 'assignment',
            timestamp: new Date().toISOString(),
            projectId,
            source: 'team_builder',
            correlationId: planCreatedEvent.id,
            rationale: agentLogMessage(fbRationale) || undefined,
            payload: { taskId: task.id, personId: fbPersonId, person: person ? { id: person.id, name: person.name, department: person.department, team: person.team, role: person.role } : undefined },
          };
          await emitEvent(assignmentEvent);
          await postgresStore.incrementPersonLoad(fbPersonId);
          peopleCache = await postgresStore.loadAllPeople();
          tasksWithAssignees.push({ ...task, assigneeId: fbPersonId, assignee: person });
        } else {
          console.warn(`[Team Builder] No personId for task ${task.id}; skipping assignment event.`);
        }
      } else {
        console.warn(`[Team Builder] No personId for task ${task.id} (no people in store); skipping assignment event.`);
      }
      continue;
    }
    if (personId) assignedInRun[personId] = (assignedInRun[personId] || 0) + 1;
    const person =
      personId && people
        ? people.find((p) => p.id === personId) || null
        : null;
    const assignmentEvent = {
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'team_builder',
      correlationId: planCreatedEvent.id,
      rationale: agentLogMessage(rationale) || undefined,
      payload: {
        taskId: task.id,
        personId: personId || '',
        person: person
          ? {
              id: person.id,
              name: person.name,
              department: person.department,
              team: person.team,
              role: person.role,
            }
          : undefined,
      },
    };
    await emitEvent(assignmentEvent);
    await postgresStore.incrementPersonLoad(personId);
    peopleCache = await postgresStore.loadAllPeople();
    tasksWithAssignees.push({
      ...task,
      assigneeId: personId,
      assignee: person
        ? {
            id: person.id,
            name: person.name,
            department: person.department,
            team: person.team,
            role: person.role,
          }
        : undefined,
    });
  }

  if (projects[projectId]?.status === 'killed') return;

  const schedulerContext = buildAgentContext('scheduler', projectId, { tasks: tasksWithAssignees }, store);

  // d. Scheduler: retry until we get schedule (LLM or stub only after retries)
  const tasksForScheduler = tasksWithAssignees.length > 0 ? tasksWithAssignees : tasks.map((t) => ({ ...t, assigneeId: undefined }));
  let scheduleResult = null;
  for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
    scheduleResult = await schedulerAI.proposeSchedule(tasksForScheduler, { agentContext: schedulerContext });
    const needRetry = scheduleResult._usedStub && scheduleResult._failReason === 'timed_out_or_no_response' && attempt <= AGENT_STEP_RETRIES;
    if (!needRetry) break;
    await delay(AGENT_STEP_RETRY_DELAY_MS);
  }

  const scheduleProposals = scheduleResult.proposals || [];
  for (const prop of scheduleProposals) {
    const scheduleEvent = {
      id: crypto.randomUUID(),
      type: 'schedule_proposed',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'scheduler',
      rationale: agentLogMessage(prop.rationale) || undefined,
      payload: {
        taskId: prop.taskId,
        proposedStart: prop.proposedStart,
        proposedEnd: prop.proposedEnd,
      },
    };
    await emitEvent(scheduleEvent);
  }
}

/**
 * POST /events — submit a single event.
 * Body: full event object (id, type, timestamp, projectId, source, payload, optional correlationId, rationale).
 * When type is "request", orchestration runs: Orchestrator → Team Builder → Scheduler; derived events are emitted and applied.
 */
router.post('/', async (req, res) => {
  const event = req.body;
  const validation = validateEvent(event);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  // Idempotency: if we already have this event id, return success without re-applying
  if (eventLog.some((e) => e.id === event.id)) {
    return res.status(200).json({ accepted: true, id: event.id, duplicate: true });
  }

  enrichEventRationale(event);
  eventLog.push(event);
  await applyAndPersist(event);
  sseBroadcast('event', { id: event.id, type: event.type, projectId: event.projectId, timestamp: event.timestamp });

  // Route by event.type: for "request", run the orchestration pipeline in hierarchy order (async).
  // Do not run agents for killed projects; agents stop when project is killed.
  if (event.type === 'request') {
    const projectStateAfterApply = projects[event.projectId];
    if (projectStateAfterApply && projectStateAfterApply.status !== 'killed') {
      handleRequestFlow(event).catch((err) => {
        console.error('Orchestration error:', err);
      });
    }
  }

  if (event.type === 'execution' && event.source === 'human') {
    scheduleProjectStatusCheck(event.projectId, event, buildProjectAICtx());
    const stateAfterExec = projects[event.projectId];
    if (stateAfterExec && shouldRequestAssignmentGapFill(event, stateAfterExec)) {
      scheduleAssignmentGapFill(event.projectId, event, buildAssignmentGapFillCtx());
    }
  }

  // Optional replan: on blocker or reprioritize, emit a system request and run orchestration once
  const projectState = projects[event.projectId];
  if (projectState && projectState.status === 'active') {
    const shouldReplan =
      (event.type === 'execution' && event.payload?.status === 'blocked') ||
      (event.type === 'decision' && (event.payload?.decisionType === 'reprioritize' || event.payload?.decisionType === 'reprioritization'));
    if (shouldReplan) {
      const reason =
        event.type === 'execution'
          ? `Replan: blocker on task ${event.payload?.taskId || 'unknown'}`
          : 'Replan: reprioritization requested';
      const replanRequest = {
        id: crypto.randomUUID(),
        type: 'request',
        timestamp: new Date().toISOString(),
        projectId: event.projectId,
        source: 'system',
        correlationId: event.id,
        rationale: reason,
        payload: { title: reason, description: event.payload?.notes || event.payload?.reason, priority: 'high' },
      };
      await emitEvent(replanRequest);
      // Replan runs async so the response is not blocked; pipeline inside handleRequestFlow remains sequential.
      handleRequestFlow(replanRequest).catch((err) => {
        console.error('Replan orchestration error:', err);
      });
    }
  }

  res.status(201).json({ accepted: true, id: event.id });
});

/**
 * Worker task status update (shared by /events/worker/status and /worker/status).
 * @returns {{ status: number, body: object }}
 */
async function submitWorkerStatus(body) {
  const { projectId, taskId, personId, status, notes } = body || {};
  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return { status: 400, body: { error: 'projectId is required' } };
  }
  if (!taskId || typeof taskId !== 'string' || !taskId.trim()) {
    return { status: 400, body: { error: 'taskId is required' } };
  }
  if (!personId || typeof personId !== 'string' || !personId.trim()) {
    return { status: 400, body: { error: 'personId is required' } };
  }
  if (!status || !EXECUTION_STATUSES.includes(status)) {
    return {
      status: 400,
      body: { error: `status must be one of: ${EXECUTION_STATUSES.join(', ')}` },
    };
  }

  const projectState = projects[projectId];
  if (!projectState) {
    return { status: 404, body: { error: 'Project not found' } };
  }
  if (projectState.status !== 'active') {
    return {
      status: 400,
      body: { error: `Project is ${projectState.status}; cannot update task status` },
    };
  }

  const task = findTask(projectState, taskId);
  if (!task) {
    return { status: 404, body: { error: 'Task not found in project' } };
  }
  const assigneeId = task.assigneeId || (task.assignee && task.assignee.id) || null;
  if (assigneeId !== personId) {
    return { status: 403, body: { error: 'Only the assigned person may update this task status' } };
  }
  const worker = peopleCache.find((p) => p.id === personId);
  const { personCanWork } = require('../services/emergencyReturn');
  if (worker && !personCanWork(worker)) {
    return {
      status: 403,
      body: {
        error: `${worker.name} is on leave. HR must authorize emergency return before task updates.`,
      },
    };
  }

  const event = {
    id: crypto.randomUUID(),
    type: 'execution',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'human',
    payload: {
      taskId,
      status,
      personId,
      notes: notes != null && String(notes).trim() !== '' ? String(notes).trim() : undefined,
    },
  };

  enrichEventRationale(event);
  eventLog.push(event);
  await applyAndPersist(event);
  sseBroadcast('event', { id: event.id, type: event.type, projectId, timestamp: event.timestamp });

  if (status === 'done') {
    await postgresStore.decrementPersonLoad(personId);
    peopleCache = await postgresStore.loadAllPeople();
  }

  const projectStateAfter = projects[projectId];
  scheduleProjectStatusCheck(projectId, event, buildProjectAICtx());

  if (projectStateAfter && projectStateAfter.status === 'active' && status === 'blocked') {
    const replanRequest = {
      id: crypto.randomUUID(),
      type: 'request',
      timestamp: new Date().toISOString(),
      projectId,
      source: 'system',
      correlationId: event.id,
      rationale: `Replan: blocker on task ${taskId}`,
      payload: {
        title: 'Replan after blocker',
        description: notes || `Task ${taskId} marked blocked`,
        priority: 'high',
      },
    };
    await emitEvent(replanRequest);
    handleRequestFlow(replanRequest).catch((err) => {
      console.error('Replan orchestration error:', err);
    });
  }

  return { status: 201, body: { accepted: true, id: event.id } };
}

/** POST /events/worker/status — legacy path for worker apps */
router.post('/worker/status', async (req, res) => {
  const result = await submitWorkerStatus(req.body);
  return res.status(result.status).json(result.body);
});

/**
 * GET /events/stream — Server-Sent Events stream for live updates.
 * Emits: event { id, type, projectId, timestamp } whenever the event log changes.
 */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch (_) {
      // ignore
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

/**
 * GET /events — list recent events (debug). Optional ?projectId= to filter.
 */
router.get('/', (req, res) => {
  const { projectId, limit: limitParam, recentChanges } = req.query;
  let list = eventLog;
  if (projectId) {
    list = list.filter((e) => e.projectId === projectId);
  }
  if (recentChanges === '1' || recentChanges === 'true') {
    list = list.filter((e) =>
      ['execution', 'decision', 'unassignment'].includes(e.type)
    );
  }
  const cap = Math.min(Math.max(parseInt(String(limitParam || ''), 10) || 200, 1), 500);
  const recent = list
    .slice(-cap)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ events: recent });
});

/**
 * GET /events/agent-activity — recent AI agent activity (org_ai, project_ai) for the Log tab.
 * Optional ?projectId= to filter to that project or global (org_ai) entries.
 */
router.get('/agent-activity', (req, res) => {
  const { projectId } = req.query;
  const list = agentActivityLog.getRecent(projectId != null && projectId !== '' ? { projectId } : {});
  res.json({ agentActivity: list });
});

/**
 * GET /projects — list current project state (for leadership view / debug).
 */
function enrichProjectStateForView(state) {
  const peopleById = new Map(peopleCache.map((p) => [p.id, p]));
  const tasks = (state.progress?.tasks || []).map((t) => {
    const aid = t.assigneeId || t.assignee?.id;
    const person = aid ? peopleById.get(aid) : null;
    const onLeave = person?.availabilityStatus === 'on_leave';
    const onEmergency = person?.availabilityStatus === 'emergency_active';
    if (!onLeave) return t;
    if (onEmergency) return t;
    return {
      ...t,
      assignee: null,
      assigneeId: null,
      assigneeNote: `${person.name} (on leave)`,
    };
  });
  return {
    ...state,
    progress: { ...state.progress, tasks },
  };
}

router.get('/projects', (req, res) => {
  res.json({ projects: Object.values(projects).map(enrichProjectStateForView) });
});

/**
 * GET /projects/:id — get one project state.
 */
router.get('/projects/:id', (req, res) => {
  const state = projects[req.params.id];
  if (!state) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(state);
});

/**
 * GET /needs — list needs from DB. Optional ?projectId= & ?status= (open|met|cancelled).
 */
function enrichNeedsFromEventLog(rows) {
  const people = loadPeople();
  const peopleById = new Map(people.map((p) => [p.id, p]));
  return rows.map((row) => {
    const ev = eventLog.find((e) => e.id === row.id || e.id === row.eventId);
    const p = ev?.payload || {};
    const submitter = peopleById.get(p.personId);
    return {
      ...row,
      title: p.title || row.kind,
      handlingMode: p.handlingMode,
      routingLabel: p.routingLabel,
      forwardsTo: p.forwardsTo,
      forwardTargets: p.forwardTargets || p.notifyTargets,
      roleAssignments: p.roleAssignments,
      status: p.status || row.status,
      reviewNotes: p.reviewNotes,
      reviewedBy: p.reviewedBy,
      reviewedByName: p.reviewedByName || (p.reviewedBy === 'leadership' ? 'Leadership' : submitter?.name),
      reviewedAt: p.reviewedAt,
      submitterName: submitter?.name,
      requiresHrInbox: p.requiresHrInbox,
      effectsApplied: p.effectsApplied,
      reviewedByName: p.reviewedByName,
    };
  });
}

router.get('/needs', async (req, res) => {
  try {
    const { projectId, status } = req.query;
    if (projectId) {
      const list = await postgresStore.loadNeedsByProject(projectId);
      const filtered = status ? list.filter((n) => n.status === status) : list;
      return res.json({ needs: enrichNeedsFromEventLog(filtered) });
    }
    const list = await postgresStore.loadAllNeeds(status ? { status } : {});
    res.json({ needs: enrichNeedsFromEventLog(list) });
  } catch (err) {
    console.error('GET /needs error:', err);
    res.status(500).json({ error: 'Failed to load needs' });
  }
});

/**
 * GET /projects/:id/needs — list needs for a project (from DB).
 */
router.get('/projects/:id/needs', async (req, res) => {
  try {
    const list = await postgresStore.loadNeedsByProject(req.params.id);
    res.json({ needs: list });
  } catch (err) {
    console.error('GET /projects/:id/needs error:', err);
    res.status(500).json({ error: 'Failed to load needs' });
  }
});

/**
 * PATCH /needs/:id — update need / worker request status.
 * Body: { status, reviewNotes?, reviewedBy? }
 */
router.patch('/needs/:id', async (req, res) => {
  const { status, reviewNotes, reviewedBy } = req.body || {};
  const { NEED_STATUSES } = require('../constants/workerRequests');
  const { applyWorkerRequestReview } = require('../lib/workerRequestLifecycle');
  if (!status || !NEED_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${NEED_STATUSES.join(', ')}`,
    });
  }
  try {
    const idx = eventLog.findIndex((e) => e.id === req.params.id && e.type === 'need');
    if (idx < 0) {
      return res.status(404).json({ error: 'Need not found' });
    }
    const needEvent = eventLog[idx];
    const terminal = ['approved', 'rejected', 'met', 'cancelled'].includes(status);

    if (terminal) {
      const reviewer =
        reviewedBy === 'leadership'
          ? { id: 'leadership', name: 'Leadership' }
          : loadPeople().find((p) => p.id === reviewedBy);
      if (reviewer) {
        await applyWorkerRequestReview(
          needEvent,
          { status, reviewNotes, reviewedAt: new Date().toISOString() },
          reviewer,
          buildWorkerRequestCtx()
        );
      }
    }

    const updated = await updateWorkerRequest(req.params.id, {
      ...needEvent.payload,
      status,
      reviewNotes,
      reviewedBy,
      reviewedByName: reviewedBy === 'leadership' ? 'Leadership' : needEvent.payload.reviewedByName,
      reviewedAt: new Date().toISOString(),
    });
    if (!updated) {
      return res.status(404).json({ error: 'Need not found' });
    }
    res.json({ event: updated, need: { id: req.params.id, status: updated.payload.status } });
  } catch (err) {
    console.error('PATCH /needs/:id error:', err);
    res.status(500).json({ error: 'Failed to update need' });
  }
});

/**
 * Update worker request (need) in memory, project state, and Postgres.
 */
async function updateWorkerRequest(needId, updates) {
  const idx = eventLog.findIndex((e) => e.id === needId && e.type === 'need');
  if (idx < 0) return null;
  const prev = eventLog[idx];
  const payload = { ...prev.payload, ...updates };
  if (updates.status) payload.status = updates.status;
  const event = { ...prev, payload };
  eventLog[idx] = event;
  const projectId = event.projectId;
  projects[projectId] = applyEvent(projects[projectId] || createEmptyState(projectId), event);
  await postgresStore.saveProjectState(projectId, projects[projectId]);
  await postgresStore.updateEventPayload(needId, payload, event.rationale);
  await postgresStore.updateNeedStatus(needId, payload.status || 'open');
  sseBroadcast('event', { id: event.id, type: event.type, projectId, timestamp: event.timestamp });
  return event;
}

/**
 * GET /llm-logs — list LLM interaction logs. Optional ?projectId= & ?agent=.
 */
router.get('/llm-logs', async (req, res) => {
  try {
    const { projectId, agent } = req.query;
    const logs = await postgresStore.loadLlmLogs({
      projectId: projectId || undefined,
      agent: agent || undefined,
    });
    res.json({ logs });
  } catch (err) {
    console.error('GET /llm-logs error:', err);
    res.status(500).json({ error: 'Failed to load LLM logs' });
  }
});

async function refreshPeopleCache() {
  peopleCache = await postgresStore.loadAllPeople();
}

function buildWorkerRequestCtx() {
  return {
    emitEvent,
    loadPeople,
    getStore: () => ({ eventLog, projects }),
    refreshPeopleCache,
    recomputePeopleLoad: recomputePeopleLoadFromProjects,
  };
}

function buildProjectAICtx() {
  return {
    emitEvent,
    loadPeople,
    getStore: () => ({ eventLog, projects }),
    handleRequestFlow,
    buildAssignmentGapFillCtx,
    agentLogMessage,
  };
}

function buildAssignmentGapFillCtx() {
  return {
    emitEvent,
    getStore: () => ({ eventLog, projects }),
    loadPeople,
    incrementPersonLoad: async (personId) => {
      await postgresStore.incrementPersonLoad(personId);
      peopleCache = await postgresStore.loadAllPeople();
    },
    agentLogMessage,
  };
}

router.initStore = initStore;
router.getStore = () => ({ eventLog, projects });
router.getEventLog = () => eventLog;
router.loadPeople = loadPeople;
router.emitEvent = emitEvent;
router.submitWorkerStatus = submitWorkerStatus;
router.updateWorkerRequest = updateWorkerRequest;
router.refreshPeopleCache = refreshPeopleCache;
router.recomputePeopleLoadFromProjects = recomputePeopleLoadFromProjects;
router.buildWorkerRequestCtx = buildWorkerRequestCtx;
module.exports = router;
