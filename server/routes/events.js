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
const { isNewProject, setupEssentialProjectRoles } = require('../services/projectRoleSetup');
const { ensurePersonalHrAssignments } = require('../services/personalHrBootstrap');
const {
  shouldRequestAssignmentGapFill,
  scheduleAssignmentGapFill,
} = require('../services/assignmentGapFill');
const { buildAllProjectMetrics } = require('../services/metrics');
const { buildAgentContext } = require('../services/retrieval');
const {
  filterProjectsForQuery,
  getLifecycleActionsForProject,
  validateLifecycleAction,
  buildLifecycleDecisionEvent,
  summarizeProjectTasks,
} = require('../services/projectLifecycle');
const postgresStore = require('../store/postgresStore');
const { runWithProjectLock } = require('../lib/projectLock');
const { sendError } = require('../lib/apiErrors');
const { isShuttingDown } = require('../lib/platformLifecycle');

/** AI agents must not create projects; only human/system events can create a project. */
const AI_EVENT_SOURCES = Object.freeze(['orchestrator', 'team_builder', 'scheduler', 'project_ai']);

const SSE_MAX_CLIENTS = Math.max(10, parseInt(process.env.SSE_MAX_CLIENTS || '200', 10));

// In-memory cache; loaded from Postgres at startup and updated on every event.
let eventLog = [];
let projects = {};
let peopleCache = [];

// Server-Sent Events clients for live updates (Leadership View)
const sseClients = new Set();

function sseBroadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function scheduleOrchestration(projectId, fn) {
  return runWithProjectLock(projectId, fn);
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
  const projectsFromDb = await postgresStore.loadAllProjects();
  if (Object.keys(projectsFromDb).length > 0) {
    projects = projectsFromDb;
    const projectIds = new Set(eventLog.map((e) => e.projectId).filter(Boolean));
    for (const projectId of projectIds) {
      if (!projects[projectId]) {
        const projectEvents = eventLog.filter((e) => e.projectId === projectId);
        projects[projectId] = applyEvents(null, projectEvents, projectId);
      }
    }
    console.log('[Store] Hydrated projects from Postgres snapshot (incremental replay for gaps only).');
  } else {
    rebuildProjectsFromEventLog();
  }
  await recomputePeopleLoadFromProjects();
  peopleCache = await postgresStore.loadAllPeople();
  if (peopleCache.length === 0) {
    console.warn('[Store] No people in DB; re-running ensureDefaultPeople().');
    await postgresStore.ensureDefaultPeople();
    peopleCache = await postgresStore.loadAllPeople();
  }
  await ensurePersonalHrAssignments(async () => {
    peopleCache = await postgresStore.loadAllPeople();
  });
  const hydrated = await agentActivityLog.hydrateFromDb();
  console.log(
    `[Store] Loaded ${eventLog.length} events, ${Object.keys(projects).length} projects, ${peopleCache.length} people, ${hydrated} agent_activity (memory).`
  );

  try {
    const { reconcileApprovedWorkerRequests } = require('../lib/reconcileApprovedRequests');
    await reconcileApprovedWorkerRequests(router);
  } catch (err) {
    console.warn('[Store] Approved request reconciliation skipped:', err.message);
  }

  try {
    const { sweepInactiveProjectNeeds } = require('../lib/workerRequestLifecycle');
    const closed = await sweepInactiveProjectNeeds(buildLeadershipAutoCtx());
    if (closed > 0) {
      console.log(`[Store] Closed ${closed} superseded need(s) on inactive projects.`);
    }
  } catch (err) {
    console.warn('[Store] Inactive project need sweep skipped:', err.message);
  }

  startProjectAIStatusPolling(buildProjectAICtx());
  const { startMockWorkerNPC, buildMockWorkerCtx } = require('../services/mockWorkerNPC');
  startMockWorkerNPC(buildMockWorkerCtx());
  broadcastNeedsSummary();
  const { processPendingLeadershipNeedsNow } = require('../services/leadershipNeedAutoHandler');
  processPendingLeadershipNeedsNow(buildLeadershipAutoCtx(), { broadcastNeeds: broadcastNeedsSummary }).catch(
    (err) => console.warn('[AI Handler] Startup process skipped:', err.message)
  );
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
      if (String(t.id || '').startsWith('wr-')) continue;
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
  const { enrichEventForMonitor } = require('../lib/eventPayload');
  const { AI_AGENT_IDS, fromEvent } = require('../models/activityRecord');

  const projectId = event.projectId;
  const projectExists = projects[projectId] != null;
  if (AI_EVENT_SOURCES.includes(event.source) && !projectExists) {
    return { applied: false, duplicate: false };
  }
  event = enrichEventForMonitor(event, projects);
  const current = projects[projectId] || createEmptyState(projectId);
  const next = applyEvent(current, event);

  let needRecord = null;
  if (event.type === 'need' && event.payload?.kind && event.payload?.description) {
    needRecord = {
      id: event.id,
      projectId,
      taskId: event.payload.taskId || null,
      source: event.source,
      kind: event.payload.kind,
      description: event.payload.description,
      status: event.payload.status || 'open',
      eventId: event.id,
      createdAt: event.timestamp,
    };
  }

  const { inserted } = await postgresStore.persistEventAndState(event, next, needRecord);
  if (!inserted) {
    return { applied: false, duplicate: true };
  }

  projects[projectId] = next;
  if (AI_AGENT_IDS.has(event.source)) {
    postgresStore.insertAgentActivity(fromEvent(event, projects)).catch((err) => {
      console.warn('[agent_activity] mirror event failed:', err.message);
    });
  }
  return { applied: true, duplicate: false };
}

/**
 * Emit a new event: append to log and apply to project state.
 * Used by orchestration when we generate plan_created, assignment, schedule_proposed.
 */
function broadcastNeedsSummary() {
  const { countPendingNeeds } = require('../services/leadershipNeedAutoHandler');
  sseBroadcast('needs', {
    pending: countPendingNeeds(eventLog, projects),
    at: new Date().toISOString(),
  });
}

function buildLeadershipAutoCtx() {
  return {
    ...buildWorkerRequestCtx(),
    getEventLog: () => eventLog,
    updateWorkerRequest,
    broadcastNeeds: broadcastNeedsSummary,
  };
}

async function emitEvent(event) {
  if (eventLog.some((e) => e.id === event.id)) {
    return { duplicate: true };
  }
  const result = await applyAndPersist(event);
  if (result.duplicate || !result.applied) {
    return { duplicate: true };
  }
  eventLog.push(event);
  sseBroadcast('event', { id: event.id, type: event.type, projectId: event.projectId, timestamp: event.timestamp });

  if (event.type === 'need') {
    broadcastNeedsSummary();
    const { scheduleLeadershipAutoProcess } = require('../services/leadershipNeedAutoHandler');
    scheduleLeadershipAutoProcess(buildLeadershipAutoCtx(), { broadcastNeeds: broadcastNeedsSummary });
  }

  if (shouldScheduleStatusCheck(event)) {
    scheduleProjectStatusCheck(event.projectId, event, buildProjectAICtx());
  }

  scheduleMonitorBroadcast();
  return { duplicate: false };
}

let monitorBroadcastTimer = null;
function scheduleMonitorBroadcast() {
  if (monitorBroadcastTimer) clearTimeout(monitorBroadcastTimer);
  monitorBroadcastTimer = setTimeout(() => {
    monitorBroadcastTimer = null;
    (async () => {
      try {
        const { buildOpsMonitorSnapshot } = require('../services/opsMonitor');
        const snap = await buildOpsMonitorSnapshot({
          getStore: () => ({ eventLog, projects }),
          getEventLog: () => eventLog,
          loadPeople,
        });
        sseBroadcast('monitor', { at: new Date().toISOString(), summary: snap.summary });
      } catch {
        /* ignore */
      }
    })();
  }, 800);
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
  const newProject = isNewProject(projectState);

  const store = { eventLog, projects, people, metrics: buildAllProjectMetrics(projects, eventLog) };
  const orchestratorContext = buildAgentContext('orchestrator', projectId, { request: requestEvent.payload, isNewProject: newProject }, store);

  // a. Orchestrator: retry until we get a plan (LLM or stub only after retries)
  let plan = null;
  for (let attempt = 1; attempt <= AGENT_STEP_RETRIES + 1; attempt++) {
    plan = await orchestratorAI.createPlan(requestEvent.payload, projectState, orchestratorContext);
    const needRetry = plan._usedStub && plan._failReason === 'timed_out_or_no_response' && attempt <= AGENT_STEP_RETRIES;
    if (!needRetry) break;
    await delay(AGENT_STEP_RETRY_DELAY_MS);
  }

  if (projects[projectId]?.status === 'killed') return;

  const {
    sanitizePlanTasks,
    shouldSkipOrchestratorPlanAppend,
  } = require('../lib/planTasks');
  const skipPlanAppend = shouldSkipOrchestratorPlanAppend(requestEvent.payload, projectState);
  const planTasks = skipPlanAppend
    ? []
    : sanitizePlanTasks(plan.tasks || [], projects[projectId] || projectState);

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
      tasks: planTasks,
      riskLevel: plan.riskLevel,
      impactLevel: plan.impactLevel,
      summary: plan.summary,
      skippedAppend: skipPlanAppend || undefined,
    },
  };
  await emitEvent(planCreatedEvent);
  agentActivityLog.push({
    source: 'orchestrator',
    projectId,
    message: agentLogMessage(
      plan.summary || `Orchestrator created plan with ${(plan.tasks || []).length} task(s).`
    ),
  });

  if (newProject) {
    await setupEssentialProjectRoles(projectId, requestEvent, plan, {
      emitEvent,
      loadPeople,
      agentLogMessage,
    });
  }

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

  const tasks = planTasks;
  if (tasks.length === 0) {
    if (skipPlanAppend) {
      const { fillAssignmentGaps } = require('../services/assignmentGapFill');
      await fillAssignmentGaps(projectId, requestEvent, buildAssignmentGapFillCtx());
    }
    return;
  }

  if (projects[projectId]?.status === 'killed') return;

  // c. Team Builder: one call per task, retry until valid LLM response or exhaust retries
  const tasksWithAssignees = [];
  const assignedInRun = {};
  const { assignTaskToPerson } = require('../lib/taskAssignment');
  const assignCtx = buildAssignmentGapFillCtx();
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
      const peopleList = teamBuilderAI.peopleAvailableForAssignment(loadPeople());
      if (peopleList && peopleList.length > 0) {
        const fallback = teamBuilderAI.stubAssign(task, peopleList, projectStateCurrent, { assignedInRun, agentContext: teamBuilderContext });
        if (fallback.personId) {
          const fbPersonId = fallback.personId;
          const fbRationale = fallback.rationale;
          assignedInRun[fbPersonId] = (assignedInRun[fbPersonId] || 0) + 1;
          const person = peopleList.find((p) => p.id === fbPersonId) || null;
          const { buildAssigneeSnapshot } = require('../lib/projectMemberRoles');
          const assignee = buildAssigneeSnapshot(person, projectStateCurrent);
          const fbAssign = await assignTaskToPerson(assignCtx, {
            projectId,
            task,
            personId: fbPersonId,
            person: assignee,
            correlationId: planCreatedEvent.id,
            rationale: agentLogMessage(fbRationale) || undefined,
            source: 'team_builder',
          });
          if (fbAssign.assigned) {
            peopleCache = await postgresStore.loadAllPeople();
            tasksWithAssignees.push({ ...task, assigneeId: fbPersonId, assignee: assignee || person });
          }
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
    const { buildAssigneeSnapshot } = require('../lib/projectMemberRoles');
    const assignee = buildAssigneeSnapshot(person, projectStateCurrent);
    const mainAssign = await assignTaskToPerson(assignCtx, {
      projectId,
      task,
      personId,
      person: assignee,
      correlationId: planCreatedEvent.id,
      rationale: agentLogMessage(rationale) || undefined,
      source: 'team_builder',
    });
    if (mainAssign.assigned) {
      peopleCache = await postgresStore.loadAllPeople();
      tasksWithAssignees.push({
        ...task,
        assigneeId: personId,
        assignee: assignee || undefined,
      });
    }
  }

  if (projects[projectId]?.status === 'killed') return;

  if (tasksWithAssignees.length > 0) {
    const names = tasksWithAssignees
      .map((t) => t.assignee?.name || t.assigneeId)
      .filter(Boolean)
      .slice(0, 4);
    agentActivityLog.push({
      source: 'team_builder',
      projectId,
      message: agentLogMessage(
        `Team Builder assigned ${tasksWithAssignees.length} task(s)${names.length ? ` (${names.join(', ')})` : ''}.`
      ),
    });
  }

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

  if (scheduleProposals.length > 0) {
    agentActivityLog.push({
      source: 'scheduler',
      projectId,
      message: agentLogMessage(`Scheduler proposed dates for ${scheduleProposals.length} task(s).`),
    });
  }

  const { fillAssignmentGaps } = require('../services/assignmentGapFill');
  await fillAssignmentGaps(projectId, planCreatedEvent, buildAssignmentGapFillCtx());
}

/**
 * POST /events — submit a single event.
 * Body: full event object (id, type, timestamp, projectId, source, payload, optional correlationId, rationale).
 * When type is "request", orchestration runs: Orchestrator → Team Builder → Scheduler; derived events are emitted and applied.
 */
router.post('/', async (req, res) => {
  try {
    if (isShuttingDown()) {
      return sendError(res, 503, 'SHUTTING_DOWN', 'Server is shutting down');
    }

    const event = req.body;
    const validation = validateEvent(event);
    if (!validation.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', validation.error);
    }

    if (eventLog.some((e) => e.id === event.id) || (await postgresStore.eventExistsById(event.id))) {
      return res.status(200).json({ accepted: true, id: event.id, duplicate: true });
    }

    enrichEventRationale(event);
    const persistResult = await applyAndPersist(event);
    if (persistResult.duplicate) {
      return res.status(200).json({ accepted: true, id: event.id, duplicate: true });
    }
    if (!persistResult.applied) {
      return res.status(200).json({ accepted: true, id: event.id, skipped: true });
    }

    eventLog.push(event);
    sseBroadcast('event', { id: event.id, type: event.type, projectId: event.projectId, timestamp: event.timestamp });

    if (event.type === 'request') {
      const projectStateAfterApply = projects[event.projectId];
      if (projectStateAfterApply && projectStateAfterApply.status !== 'killed') {
        scheduleOrchestration(event.projectId, () => handleRequestFlow(event)).catch((err) => {
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

    const { recentlyReplanned } = require('../services/projectAIActions');
    const projectState = projects[event.projectId];
    if (projectState && projectState.status === 'active') {
      const shouldReplan =
        (event.type === 'execution' && event.payload?.status === 'blocked') ||
        (event.type === 'decision' &&
          (event.payload?.decisionType === 'reprioritize' ||
            event.payload?.decisionType === 'reprioritization'));
      if (shouldReplan && !recentlyReplanned(eventLog, event.projectId)) {
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
          payload: {
            title: reason,
            description: event.payload?.notes || event.payload?.reason,
            priority: 'high',
          },
        };
        const emitted = await emitEvent(replanRequest);
        if (!emitted.duplicate) {
          scheduleOrchestration(event.projectId, () => handleRequestFlow(replanRequest)).catch((err) => {
            console.error('Replan orchestration error:', err);
          });
        }
      }
    }

    if (shouldScheduleStatusCheck(event)) {
      scheduleProjectStatusCheck(event.projectId, event, buildProjectAICtx());
    }

    return res.status(201).json({ accepted: true, id: event.id });
  } catch (err) {
    console.error('POST /events failed:', err);
    return sendError(res, 500, 'EVENT_PERSIST_FAILED', err.message);
  }
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
  if (eventLog.some((e) => e.id === event.id) || (await postgresStore.eventExistsById(event.id))) {
    return { status: 200, body: { accepted: true, id: event.id, duplicate: true } };
  }
  const persistResult = await applyAndPersist(event);
  if (persistResult.duplicate || !persistResult.applied) {
    return {
      status: 200,
      body: { accepted: true, id: event.id, duplicate: !!persistResult.duplicate },
    };
  }
  eventLog.push(event);
  sseBroadcast('event', { id: event.id, type: event.type, projectId, timestamp: event.timestamp });

  if (status === 'done') {
    await postgresStore.decrementPersonLoad(personId);
    peopleCache = await postgresStore.loadAllPeople();
    try {
      const { recordTaskCompletionBurn } = require('../services/financeService');
      await recordTaskCompletionBurn(projectId, taskId, personId, {
        getStore: () => ({ projects }),
        emitEvent,
      });
    } catch (err) {
      console.warn('[Finance] Task completion burn skipped:', err.message);
    }
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
    const { recentlyReplanned } = require('../services/projectAIActions');
    if (!recentlyReplanned(eventLog, projectId)) {
      const emitted = await emitEvent(replanRequest);
      if (!emitted.duplicate) {
        scheduleOrchestration(projectId, () => handleRequestFlow(replanRequest)).catch((err) => {
          console.error('Replan orchestration error:', err);
        });
      }
    }
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
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    return sendError(res, 503, 'SSE_CAPACITY', 'Too many live connections; retry later.');
  }
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
  const cap = Math.min(Math.max(parseInt(String(limitParam || ''), 10) || 200, 1), 500);
  let recent;
  if (recentChanges === '1' || recentChanges === 'true') {
    const { buildRecentProjectActivityFeed } = require('../lib/recentProjectActivity');
    const scoped = projectId ? eventLog.filter((e) => e.projectId === projectId) : eventLog;
    recent = buildRecentProjectActivityFeed(scoped, agentActivityLog.getRecent(), { limit: cap });
  } else {
    recent = list
      .slice(-cap)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
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
  const { enrichTaskAssigneeForView } = require('../lib/projectMemberRoles');
  const peopleById = new Map(peopleCache.map((p) => [p.id, p]));
  const isReviewTask = (t) => {
    const id = String(t?.id || '');
    const title = String(t?.title || '').toLowerCase();
    return id.startsWith('wr-') || title.includes('review worker request');
  };
  const tasks = (state.progress?.tasks || []).filter((t) => !isReviewTask(t)).map((t) => {
    const aid = t.assigneeId || t.assignee?.id;
    const person = aid ? peopleById.get(aid) : null;
    const onLeave = person?.availabilityStatus === 'on_leave';
    const onEmergency = person?.availabilityStatus === 'emergency_active';
    if (onLeave && !onEmergency) {
      return {
        ...t,
        assignee: null,
        assigneeId: null,
        assigneeNote: `${person.name} (on leave)`,
      };
    }
    return enrichTaskAssigneeForView(t, state, person);
  });
  return {
    ...state,
    progress: { ...state.progress, tasks },
  };
}

router.get('/projects', (req, res) => {
  const all = Object.values(projects).map(enrichProjectStateForView);
  const filtered = filterProjectsForQuery(all, req.query);
  const counts = {
    active: all.filter((p) => (p.status || 'active') === 'active' && !p.archived).length,
    completed: all.filter((p) => p.status === 'completed' && !p.archived).length,
    killed: all.filter((p) => p.status === 'killed' && !p.archived).length,
    archived: all.filter((p) => p.archived).length,
    total: all.length,
  };
  res.json({
    projects: filtered,
    counts,
    lifecycleActionsByProject: Object.fromEntries(
      filtered.map((p) => [p.id, getLifecycleActionsForProject(p)])
    ),
  });
});

/**
 * POST /projects/:id/lifecycle — leadership lifecycle (complete, kill, archive, reactivate).
 * Body: { action: 'complete'|'kill'|'archive'|'unarchive'|'reactivate', reason?: string }
 */
router.post('/projects/:id/lifecycle', async (req, res) => {
  const projectId = req.params.id;
  const { action, reason } = req.body || {};
  const state = projects[projectId];
  if (!state) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const check = validateLifecycleAction(state, action);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }
  try {
    const event = buildLifecycleDecisionEvent(projectId, action, { reason });
    await emitEvent(event);
    if (['kill', 'complete', 'archive'].includes(action)) {
      const { closeNeedsForInactiveProject } = require('../lib/workerRequestLifecycle');
      const closed = await closeNeedsForInactiveProject(projectId, buildWorkerRequestCtx(), {
        reason: `Project ${action} — request superseded.`,
      });
      if (closed > 0) {
        console.log(`[Lifecycle] Closed ${closed} need(s) on ${projectId} (${action}).`);
        broadcastNeedsSummary();
      }
    }
    const updated = enrichProjectStateForView(projects[projectId]);
    res.status(201).json({
      ok: true,
      project: updated,
      availableActions: getLifecycleActionsForProject(updated),
      taskSummary: summarizeProjectTasks(updated),
    });
  } catch (err) {
    console.error('POST /projects/:id/lifecycle error:', err);
    res.status(500).json({ error: err.message || 'Lifecycle action failed' });
  }
});

/**
 * GET /projects/:id — get one project state.
 */
router.get('/projects/:id', (req, res) => {
  const state = projects[req.params.id];
  if (!state) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const view = enrichProjectStateForView(state);
  res.json({
    project: view,
    availableActions: getLifecycleActionsForProject(view),
    taskSummary: summarizeProjectTasks(view),
  });
});

/**
 * GET /needs — list needs from DB. Optional ?projectId= & ?status= (open|met|cancelled).
 */
function enrichNeedsFromEventLog(rows) {
  const people = loadPeople();
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const { isInactiveProjectForNeeds } = require('../lib/workerRequestLifecycle');
  return rows
    .filter((row) => {
      const ev = eventLog.find((e) => e.id === row.id || e.id === row.eventId);
      const status = ev?.payload?.status || row.status || 'open';
      if (!['open', 'in_review'].includes(status)) return true;
      return !isInactiveProjectForNeeds(row.projectId, projects[row.projectId]);
    })
    .map((row) => {
    const ev = eventLog.find((e) => e.id === row.id || e.id === row.eventId);
    const p = ev?.payload || {};
    const submitter = peopleById.get(p.personId);
    return {
      ...row,
      title: p.title || row.kind || (p.description ? String(p.description).split('\n')[0].slice(0, 120) : row.kind),
      handlingMode: p.handlingMode,
      aiHandled: !!p.aiHandled,
      aiHandlerResolved: !!p.aiHandlerResolved,
      aiAutoApproved: !!p.aiAutoApproved,
      autoApprovedByName: p.autoApprovedByName,
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
      effectsError: p.effectsError,
      hrHiringQueue: !!p.hrHiringQueue,
      hiringRequirements: p.hiringRequirements,
      hiringStatus: p.hiringStatus,
      hiredPersonName: p.hiredPersonName,
      hiringResult: p.hiringResult,
      hiringError: p.hiringError,
    };
  });
}

router.get('/needs/summary', async (req, res) => {
  try {
    const { countPendingNeeds, isAiHandlerEnabled } = require('../services/leadershipNeedAutoHandler');
    const aiHandlerAutomatic = await isAiHandlerEnabled(postgresStore);
    res.json({
      pending: countPendingNeeds(eventLog, projects),
      aiHandlerAutomatic,
    });
  } catch (err) {
    console.error('GET /needs/summary error:', err);
    res.status(500).json({ error: 'Failed to load needs summary' });
  }
});

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
          : loadPeople().find((p) => p.id === reviewedBy) ||
            (status === 'approved' ? { id: 'leadership', name: 'Leadership' } : null);
      if (!reviewer) {
        return res.status(400).json({ error: 'reviewedBy is required for this status change' });
      }
      await applyWorkerRequestReview(
        needEvent,
        { status, reviewNotes, reviewedAt: new Date().toISOString() },
        reviewer,
        buildWorkerRequestCtx()
      );
    }

    const updated = await updateWorkerRequest(req.params.id, {
      ...needEvent.payload,
      status,
      reviewNotes,
      reviewedBy: needEvent.payload.reviewedBy || reviewedBy,
      reviewedByName: needEvent.payload.reviewedByName,
      reviewedAt: needEvent.payload.reviewedAt || new Date().toISOString(),
      effectsApplied: needEvent.payload.effectsApplied,
      effectsError: needEvent.payload.effectsError,
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
  broadcastNeedsSummary();
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
    handleRequestFlow,
    buildProjectAICtx,
    buildAssignmentGapFillCtx,
    agentLogMessage,
    incrementPersonLoad: async (personId) => {
      await postgresStore.incrementPersonLoad(personId);
      peopleCache = await postgresStore.loadAllPeople();
    },
    decrementPersonLoad: async (personId) => {
      await postgresStore.decrementPersonLoad(personId);
      peopleCache = await postgresStore.loadAllPeople();
    },
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
    decrementPersonLoad: async (personId) => {
      await postgresStore.decrementPersonLoad(personId);
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
router.broadcastNeedsSummary = broadcastNeedsSummary;
router.buildLeadershipAutoCtx = buildLeadershipAutoCtx;
router.buildProjectAICtx = buildProjectAICtx;
router.refreshPeopleCache = refreshPeopleCache;
router.recomputePeopleLoadFromProjects = recomputePeopleLoadFromProjects;
router.buildWorkerRequestCtx = buildWorkerRequestCtx;

async function shutdownEventsRouter() {
  if (monitorBroadcastTimer) {
    clearTimeout(monitorBroadcastTimer);
    monitorBroadcastTimer = null;
  }
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  try {
    const { stopProjectAIPolling } = require('../services/projectAIEvaluator');
    stopProjectAIPolling?.();
  } catch {
    /* optional */
  }
  try {
    const { stopMockWorkerNPC } = require('../services/mockWorkerNPC');
    stopMockWorkerNPC?.();
  } catch {
    /* optional */
  }
}

router.shutdown = shutdownEventsRouter;
module.exports = router;
