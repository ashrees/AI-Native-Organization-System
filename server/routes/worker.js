/**
 * Human Worker Portal API — hostable separately from Leadership View (client/).
 * Mount at /worker and /api/worker.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const eventsRouter = require('./events');
const {
  WORKER_REQUEST_KINDS,
  ORG_GENERAL_PROJECT_ID,
  HANDLING_MODES,
  NEED_STATUSES,
} = require('../constants/workerRequests');
const { isHrPerson, getRoutingForKind, requestRequiresHrInbox } = require('../lib/hrRouting');
const { processWorkerRequest } = require('../services/workerRequestHandler');
const {
  personCanReviewWorkerRequest,
  applyWorkerRequestReview,
} = require('../lib/workerRequestLifecycle');
const { activateEmergencyWork, endEmergencyWork, personCanWork } = require('../services/emergencyReturn');
const { getPersonalHr } = require('../services/personalHr');

function mapWorkerRequestEvent(e, peopleById) {
  const p = e.payload || {};
  const submitter = peopleById.get(p.personId) || peopleById.get(p.submittedBy);
  return {
    id: e.id,
    projectId: e.projectId,
    kind: p.kind,
    title: p.title || p.kind,
    description: p.description,
    status: p.status || 'open',
    handlingMode: p.handlingMode || 'ai',
    routingLabel: p.routingLabel || getRoutingForKind(p.kind, e.projectId).label,
    requiresHrInbox: p.requiresHrInbox ?? requestRequiresHrInbox({ kind: p.kind, projectId: e.projectId, ...p }),
    notifyTargets: p.notifyTargets || p.forwardTargets || [],
    forwardTargets: p.forwardTargets || p.notifyTargets || [],
    forwardsTo: p.forwardsTo || p.routingLabel,
    aiAgent: p.aiAgent,
    forwardRoles: p.forwardRoles || [],
    roleAssignments: p.roleAssignments || [],
    primaryReviewerPersonIds: p.primaryReviewerPersonIds || [],
    reviewedByName: p.reviewedByName,
    effectsApplied: p.effectsApplied,
    effectsError: p.effectsError,
    hrTaskId: p.hrTaskId,
    assignedHrPersonId: p.assignedHrPersonId,
    assignedReviewerPersonId: p.assignedReviewerPersonId,
    projectReviewTaskId: p.projectReviewTaskId,
    aiHandled: !!p.aiHandled,
    aiAutoApproved: !!p.aiAutoApproved,
    aiHandlerWatching: !!p.aiHandlerWatching,
    aiHandlerAssessment: p.aiHandlerAssessment,
    aiHandlerOversightReason: p.aiHandlerOversightReason,
    autoApprovedByName: p.autoApprovedByName,
    reviewedBy: p.reviewedBy,
    reviewedAt: p.reviewedAt,
    reviewNotes: p.reviewNotes,
    submitterName: submitter?.name,
    submitterId: p.personId,
    taskId: p.taskId,
    timestamp: e.timestamp,
    startDate: p.startDate,
    endDate: p.endDate,
    hrHiringQueue: !!p.hrHiringQueue,
    hiringRequirements: p.hiringRequirements,
    hiringProfileId: p.hiringProfileId,
    hiringProjectId: p.hiringProjectId,
    hiringStatus: p.hiringStatus,
    hiredPersonName: p.hiredPersonName,
    hiringError: p.hiringError,
  };
}

function taskAssigneeId(task) {
  return task?.assigneeId || task?.assignee?.id || null;
}

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

/** Match every whitespace-separated term against name, dept, team, role, or id. */
function personMatchesQuery(person, q) {
  if (!q) return true;
  const hay = normalizeName(
    [person.name, person.department, person.team, person.role, person.id].join(' ')
  );
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.every((term) => hay.includes(term));
}

function buildWorkerDashboard(personId) {
  const people = eventsRouter.loadPeople();
  const person = people.find((p) => p.id === personId);
  if (!person) return null;

  const { personCanWork } = require('../services/emergencyReturn');
  const reviewerUnavailable = !personCanWork(person);

  const { projects } = eventsRouter.getStore();
  const eventLog = eventsRouter.getEventLog();

  const assignedProjects = [];
  const tasks = [];

  for (const [projectId, state] of Object.entries(projects)) {
    const allTasks = state?.progress?.tasks || [];
    const mine = allTasks.filter((t) => taskAssigneeId(t) === personId);
    if (mine.length === 0) continue;

    const blockers = (state.blockers || []).filter((b) =>
      mine.some((t) => t.id === b.taskId)
    );

    assignedProjects.push({
      id: projectId,
      title: state.title || projectId,
      status: state.status || 'active',
      department: state.department || '',
      team: state.team || '',
      riskLevel: state.risk?.level || 'low',
      riskReasons: state.risk?.reasons || [],
      lastUpdatedAt: state.lastUpdatedAt,
      taskCount: mine.length,
      tasksDone: mine.filter((t) => t.status === 'done').length,
      tasksBlocked: mine.filter((t) => t.status === 'blocked').length,
      blockers,
      roles: state.roles || {},
    });

    for (const t of mine) {
      if (reviewerUnavailable && String(t.id || '').startsWith('wr-')) continue;
      tasks.push({
        projectId,
        projectTitle: state.title || projectId,
        projectStatus: state.status || 'active',
        id: t.id,
        title: t.title || t.id,
        description: t.description,
        status: t.status || 'pending',
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
        assignee: t.assignee,
      });
    }
  }

  tasks.sort((a, b) => {
    const order = { blocked: 0, in_progress: 1, pending: 2, done: 3 };
    const sa = order[a.status] ?? 2;
    const sb = order[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    return (a.projectTitle || '').localeCompare(b.projectTitle || '');
  });

  const peopleById = new Map(people.map((p) => [p.id, p]));
  const requests = eventLog
    .filter(
      (e) =>
        e.type === 'need' &&
        e.source === 'human' &&
        e.payload?.personId &&
        (e.payload.personId === personId || e.payload.submittedBy === personId)
    )
    .map((e) => mapWorkerRequestEvent(e, peopleById))
    .reverse()
    .slice(0, 50);

  const recentActivity = eventLog
    .filter((e) => {
      if (e.type !== 'execution' || e.source !== 'human') return false;
      const task = tasks.find(
        (t) => t.projectId === e.projectId && t.id === e.payload?.taskId
      );
      return !!task;
    })
    .slice(-30)
    .reverse()
    .map((e) => ({
      id: e.id,
      type: e.type,
      projectId: e.projectId,
      taskId: e.payload?.taskId,
      status: e.payload?.status,
      notes: e.payload?.notes,
      timestamp: e.timestamp,
    }));

  const stats = {
    totalTasks: tasks.length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    done: tasks.filter((t) => t.status === 'done').length,
    pending: tasks.filter((t) => !t.status || t.status === 'pending').length,
    activeProjects: assignedProjects.filter((p) => p.status === 'active').length,
    openRequests: requests.filter((r) => ['open', 'in_review'].includes(r.status)).length,
    openHrInbox: isHrPerson(person)
      ? eventLog
          .filter((e) => e.type === 'need' && e.source === 'human' && e.payload?.personId)
          .map((e) => mapWorkerRequestEvent(e, peopleById))
          .filter((r) => ['open', 'in_review'].includes(r.status))
          .filter((r) => requestRequiresHrInbox(r)).length
      : 0,
    currentLoad: person.currentLoad ?? 0,
  };

  return {
    person: {
      id: person.id,
      name: person.name,
      department: person.department,
      team: person.team,
      role: person.role,
      skills: person.skills || [],
      currentLoad: person.currentLoad ?? 0,
      availabilityStatus: person.availabilityStatus || 'active',
      availabilityUntil: person.availabilityUntil,
      availabilityReason: person.availabilityReason,
    },
    stats,
    projects: assignedProjects,
    tasks,
    requests,
    recentActivity,
    requestKinds: WORKER_REQUEST_KINDS,
    handlingModes: HANDLING_MODES,
    isHr: isHrPerson(person),
    personalHr: (() => {
      const hr = getPersonalHr(personId, people);
      return hr ? { id: hr.id, name: hr.name, role: hr.role, department: hr.department } : null;
    })(),
  };
}

function buildHrInbox(personId) {
  const people = eventsRouter.loadPeople();
  const person = people.find((p) => p.id === personId);
  if (!person || !isHrPerson(person)) return null;

  const eventLog = eventsRouter.getEventLog();
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const inbox = eventLog
    .filter((e) => e.type === 'need' && e.source === 'human' && e.payload?.personId)
    .map((e) => mapWorkerRequestEvent(e, peopleById))
    .filter((r) => ['open', 'in_review'].includes(r.status))
    .filter((r) => requestRequiresHrInbox(r))
    .reverse();

  const hrTasks = [];
  const { projects } = eventsRouter.getStore();
  for (const [projectId, state] of Object.entries(projects)) {
    for (const t of state?.progress?.tasks || []) {
      if (
        (t.title || '').toLowerCase().includes('review worker request') &&
        taskAssigneeId(t) === personId
      ) {
        hrTasks.push({
          projectId,
          projectTitle: state.title || projectId,
          ...t,
        });
      }
    }
  }

  const { listHrHiringQueue } = require('../services/hiringNeedHandler');
  const hiringQueue = listHrHiringQueue(eventLog);

  return {
    person: { id: person.id, name: person.name, role: person.role },
    inbox,
    hrTasks,
    hiringQueue,
  };
}

/** Project-scoped worker requests this person should review (Worker Portal inbox). */
function buildProjectInbox(personId) {
  const eventLog = eventsRouter.getEventLog();
  const people = eventsRouter.loadPeople();
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return eventLog
    .filter((e) => e.type === 'need' && e.source === 'human' && e.payload?.personId)
    .map((e) => mapWorkerRequestEvent(e, peopleById))
    .filter((r) => ['open', 'in_review'].includes(r.status))
    .filter((r) => !requestRequiresHrInbox(r))
    .filter((r) => {
      const fwd = r.forwardTargets || r.notifyTargets || [];
      const notified = fwd.some((t) => t.personId === personId);
      const assigned =
        r.assignedReviewerPersonId === personId ||
        (r.primaryReviewerPersonIds || []).includes(personId) ||
        (r.roleAssignments || []).some((a) => a.assigneeId === personId);
      return notified || assigned;
    })
    .reverse();
}

/** GET /worker/project/inbox?personId= — project-scoped requests this person should review */
router.get('/project/inbox', (req, res) => {
  const personId = (req.query.personId || '').trim();
  if (!personId) return res.status(400).json({ error: 'personId is required' });
  res.json({ inbox: buildProjectInbox(personId) });
});

/** GET /worker/people — list people for name login (?q= partial name) */
router.get('/people', (req, res) => {
  const q = normalizeName(req.query.q);
  let list = eventsRouter.loadPeople().map((p) => ({
    id: p.id,
    name: p.name,
    department: p.department,
    team: p.team,
    role: p.role,
    currentLoad: p.currentLoad ?? 0,
  }));
  if (q) {
    list = list.filter((p) => personMatchesQuery(p, q));
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ people: list });
});

/** GET /worker/dashboard?personId= — full worker home data */
router.get('/dashboard', (req, res) => {
  const personId = (req.query.personId || '').trim();
  if (!personId) {
    return res.status(400).json({ error: 'personId is required' });
  }
  const dashboard = buildWorkerDashboard(personId);
  if (!dashboard) {
    return res.status(404).json({ error: 'Person not found' });
  }
  res.json(dashboard);
});

/** GET /worker/meta — request kinds and org project id */
router.get('/meta', (_req, res) => {
  const { KIND_ROUTES, ROLES } = require('../constants/requestRouting');
  res.json({
    requestKinds: WORKER_REQUEST_KINDS,
    handlingModes: HANDLING_MODES,
    needStatuses: NEED_STATUSES,
    orgGeneralProjectId: ORG_GENERAL_PROJECT_ID,
    roleDefinitions: Object.values(ROLES).map((r) => ({ id: r.id, label: r.label, agent: r.agent })),
    kindRoutes: KIND_ROUTES,
  });
});

/** GET /worker/hr/hiring-queue?personId= — open hiring requirements for HR */
router.get('/hr/hiring-queue', (req, res) => {
  const personId = (req.query.personId || '').trim();
  if (!personId) return res.status(400).json({ error: 'personId is required' });
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === personId);
  if (!hr || !isHrPerson(hr)) return res.status(403).json({ error: 'HR access only' });
  const { listHrHiringQueue } = require('../services/hiringNeedHandler');
  res.json({ hiringQueue: listHrHiringQueue(eventsRouter.getEventLog()) });
});

/** GET /worker/hr/inbox?personId= — HR queue (HR role only) */
router.get('/hr/inbox', (req, res) => {
  const personId = (req.query.personId || '').trim();
  if (!personId) return res.status(400).json({ error: 'personId is required' });
  const inbox = buildHrInbox(personId);
  if (!inbox) return res.status(403).json({ error: 'HR access only' });
  res.json(inbox);
});

/** GET /worker/hr/on-leave?personId= — people currently on leave (HR activates emergency) */
router.get('/hr/on-leave', (req, res) => {
  const hrId = (req.query.personId || '').trim();
  if (!hrId) return res.status(400).json({ error: 'personId is required' });
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === hrId);
  if (!hr || !isHrPerson(hr)) return res.status(403).json({ error: 'HR access only' });
  const onLeave = people
    .filter((p) => p.availabilityStatus === 'on_leave' || p.availabilityStatus === 'emergency_active')
    .map((p) => ({
      id: p.id,
      name: p.name,
      department: p.department,
      team: p.team,
      role: p.role,
      availabilityStatus: p.availabilityStatus,
      availabilityUntil: p.availabilityUntil,
      availabilityReason: p.availabilityReason,
    }));
  res.json({ people: onLeave });
});

/** POST /worker/hr/emergency-activate — HR temporarily authorizes work during leave */
router.post('/hr/emergency-activate', async (req, res) => {
  const { hrPersonId, targetPersonId, reason, projectId, taskId } = req.body || {};
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === (hrPersonId || '').trim());
  if (!hr || !isHrPerson(hr)) {
    return res.status(403).json({ error: 'Only HR can authorize emergency return' });
  }
  const targetId = (targetPersonId || '').trim();
  if (!targetId) return res.status(400).json({ error: 'targetPersonId is required' });

  const ctx = eventsRouter.buildWorkerRequestCtx();
  const result = await activateEmergencyWork(targetId, {
    hrPerson: hr,
    reason: reason || 'Emergency operational need',
    projectId: projectId || undefined,
    taskId: taskId || undefined,
  }, ctx);

  if (result.error) return res.status(400).json({ error: result.error });
  return res.status(200).json(result);
});

/** POST /worker/hr/emergency-end — HR ends emergency period */
router.post('/hr/emergency-end', async (req, res) => {
  const { hrPersonId, targetPersonId, returnTo, reason } = req.body || {};
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === (hrPersonId || '').trim());
  if (!hr || !isHrPerson(hr)) {
    return res.status(403).json({ error: 'Only HR can end emergency return' });
  }
  const targetId = (targetPersonId || '').trim();
  if (!targetId) return res.status(400).json({ error: 'targetPersonId is required' });
  const mode = returnTo === 'active' ? 'active' : 'leave';

  const ctx = {
    ...eventsRouter.buildWorkerRequestCtx(),
    updateWorkerRequest: eventsRouter.updateWorkerRequest,
  };
  const result = await endEmergencyWork(
    targetId,
    { hrPerson: hr, returnTo: mode, reason },
    ctx
  );
  if (result.error) return res.status(400).json({ error: result.error });
  return res.status(200).json(result);
});

/** POST /worker/hr/generate-mock — HR previews a random candidate */
router.post('/hr/generate-mock', async (req, res) => {
  const hrPersonId = (req.body?.hrPersonId || req.query?.personId || '').trim();
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === hrPersonId);
  if (!hr || !isHrPerson(hr)) return res.status(403).json({ error: 'HR access only' });

  try {
    const { previewMockEmployee } = require('../services/hiringService');
    const generated = await previewMockEmployee({
      ...req.body,
      matchRequirements: !!req.body?.matchRequirements,
    });
    return res.json({
      preview: true,
      person: generated.person,
      matchScore: generated.matchScore,
      profileId: generated.profileId,
      requirements: generated.requirements,
    });
  } catch (err) {
    console.error('POST /worker/hr/generate-mock error:', err);
    return res.status(500).json({ error: err.message || 'Generate failed' });
  }
});

/** POST /worker/hr/hire — HR adds employee to database */
router.post('/hr/hire', async (req, res) => {
  const hrPersonId = (req.body?.hrPersonId || '').trim();
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === hrPersonId);
  if (!hr || !isHrPerson(hr)) return res.status(403).json({ error: 'HR access only' });

  const { normalizePersonInput, hireEmployee } = require('../services/hiringService');
  const normalized = normalizePersonInput(req.body);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  try {
    const result = await hireEmployee(normalized.person, {
      emitEvent: eventsRouter.emitEvent,
      getStore: eventsRouter.getStore,
      refreshPeopleCache: eventsRouter.refreshPeopleCache,
      recomputePeopleLoad: eventsRouter.recomputePeopleLoadFromProjects,
      hiredBy: hr.id,
      hiredByName: hr.name,
      source: 'human',
      projectId: req.body?.projectId || null,
      correlationId: req.body?.correlationId || null,
      requirements: req.body?.requirements || null,
    });
    if (result.error) {
      const status = result.code === 'duplicate_id' || result.code === 'duplicate_name' ? 409 : 400;
      return res.status(status).json({ error: result.error });
    }
    const needId = (req.body?.needId || req.body?.correlationId || '').trim();
    if (needId) {
      const { markHiringNeedHired } = require('../services/hiringNeedHandler');
      await markHiringNeedHired(needId, result, {
        updateWorkerRequest: eventsRouter.updateWorkerRequest,
        getEventLog: eventsRouter.getEventLog,
      });
    }
    return res.status(201).json(result);
  } catch (err) {
    console.error('POST /worker/hr/hire error:', err);
    return res.status(500).json({ error: err.message || 'Hire failed' });
  }
});

/** POST /worker/hr/hire-for-requirements — HR/AI-style generate matching hire */
router.post('/hr/hire-for-requirements', async (req, res) => {
  const hrPersonId = (req.body?.hrPersonId || '').trim();
  const people = eventsRouter.loadPeople();
  const hr = people.find((p) => p.id === hrPersonId);
  if (!hr || !isHrPerson(hr)) return res.status(403).json({ error: 'HR access only' });

  const { hireFromRequirements } = require('../services/hiringService');
  try {
    const result = await hireFromRequirements(req.body || {}, {
      emitEvent: eventsRouter.emitEvent,
      getStore: eventsRouter.getStore,
      refreshPeopleCache: eventsRouter.refreshPeopleCache,
      recomputePeopleLoad: eventsRouter.recomputePeopleLoadFromProjects,
      source: 'human',
      hiredBy: hr.id,
      hiredByName: hr.name,
      projectId: req.body?.projectId || null,
      correlationId: req.body?.correlationId || null,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    const needId = (req.body?.needId || req.body?.correlationId || '').trim();
    if (needId) {
      const { markHiringNeedHired } = require('../services/hiringNeedHandler');
      await markHiringNeedHired(needId, result, {
        updateWorkerRequest: eventsRouter.updateWorkerRequest,
        getEventLog: eventsRouter.getEventLog,
      });
    }
    return res.status(201).json(result);
  } catch (err) {
    console.error('POST /worker/hr/hire-for-requirements error:', err);
    return res.status(500).json({ error: err.message || 'Hire failed' });
  }
});

/** GET /worker/npc/status — mock human worker NPC simulator */
router.get('/npc/status', (_req, res) => {
  const { getMockWorkerStatus } = require('../services/mockWorkerNPC');
  res.json(getMockWorkerStatus());
});

/** POST /worker/npc/tick — run one NPC batch now (?personId= optional single worker) */
router.post('/npc/tick', async (req, res) => {
  const { runMockWorkerTick, buildMockWorkerCtx } = require('../services/mockWorkerNPC');
  const personId = (req.body?.personId || req.query?.personId || '').trim() || undefined;
  try {
    const summary = await runMockWorkerTick(buildMockWorkerCtx(), { personId });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('POST /worker/npc/tick error:', err);
    res.status(500).json({ error: err.message || 'NPC tick failed' });
  }
});

/** POST /worker/status — update assigned task status */
router.post('/status', async (req, res) => {
  const result = await eventsRouter.submitWorkerStatus(req.body);
  return res.status(result.status).json(result.body);
});

/** POST /worker/requests — HR/ops request with routing (AI / notify / self) */
router.post('/requests', async (req, res) => {
  try {
    const { submitWorkerRequest } = require('../services/workerRequestSubmit');
    const result = await submitWorkerRequest(req.body || {}, {
      emitEvent: eventsRouter.emitEvent,
      getStore: eventsRouter.getStore,
      loadPeople: eventsRouter.loadPeople,
      getEventLog: eventsRouter.getEventLog,
      buildWorkerRequestCtx: eventsRouter.buildWorkerRequestCtx,
      updateWorkerRequest: eventsRouter.updateWorkerRequest,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /worker/requests error:', err);
    return res.status(500).json({ error: err.message || 'Failed to submit request' });
  }
});

/** PATCH /worker/requests/:id — assigned reviewer or HR approves / rejects / manages */
router.patch('/requests/:id', async (req, res) => {
  const { status, reviewNotes, reviewerPersonId } = req.body || {};
  if (!status || !NEED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${NEED_STATUSES.join(', ')}` });
  }
  const reviewerId = (reviewerPersonId || '').trim();
  if (!reviewerId) {
    return res.status(400).json({ error: 'reviewerPersonId is required' });
  }
  const people = eventsRouter.loadPeople();
  const reviewer = people.find((p) => p.id === reviewerId);
  if (!reviewer) {
    return res.status(404).json({ error: 'Reviewer not found' });
  }

  const eventLog = eventsRouter.getEventLog();
  const needEvent = eventLog.find((e) => e.id === req.params.id && e.type === 'need');
  if (!needEvent) return res.status(404).json({ error: 'Request not found' });

  const mapped = mapWorkerRequestEvent(needEvent, new Map(people.map((p) => [p.id, p])));
  if (!personCanReviewWorkerRequest(reviewer, mapped)) {
    return res.status(403).json({
      error: 'You are not assigned to review this request. Check Project reviews or HR inbox.',
    });
  }

  const ctx = eventsRouter.buildWorkerRequestCtx
    ? eventsRouter.buildWorkerRequestCtx()
    : { emitEvent: eventsRouter.emitEvent, loadPeople: eventsRouter.loadPeople, getStore: eventsRouter.getStore };
  await applyWorkerRequestReview(
    needEvent,
    {
      status,
      reviewNotes: reviewNotes || undefined,
      reviewedAt: new Date().toISOString(),
    },
    reviewer,
    ctx
  );

  const updated = await eventsRouter.updateWorkerRequest(req.params.id, needEvent.payload);
  if (!updated) return res.status(404).json({ error: 'Request not found' });

  return res.json({ ok: true, request: mapWorkerRequestEvent(updated, new Map(people.map((p) => [p.id, p]))) });
});

/** POST /worker/requests/:id/tasks — HR creates an additional task on the request project */
router.post('/requests/:id/tasks', async (req, res) => {
  const { reviewerPersonId, taskTitle, taskDescription, assigneeId } = req.body || {};
  const reviewerId = (reviewerPersonId || '').trim();
  const people = eventsRouter.loadPeople();
  const reviewer = people.find((p) => p.id === reviewerId);
  if (!reviewer || !isHrPerson(reviewer)) {
    return res.status(403).json({ error: 'Only HR can create HR tasks' });
  }
  if (!taskTitle || !String(taskTitle).trim()) {
    return res.status(400).json({ error: 'taskTitle is required' });
  }

  const eventLog = eventsRouter.getEventLog();
  const needEvent = eventLog.find((e) => e.id === req.params.id && e.type === 'need');
  if (!needEvent) return res.status(404).json({ error: 'Request not found' });

  const projectId = needEvent.projectId;
  const assignee = assigneeId
    ? people.find((p) => p.id === assigneeId)
    : reviewer;
  if (!assignee) return res.status(400).json({ error: 'assignee not found' });

  const taskId = `hr-task-${crypto.randomUUID().slice(0, 8)}`;
  await eventsRouter.emitEvent({
    id: crypto.randomUUID(),
    type: 'plan_created',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'human',
    correlationId: needEvent.id,
    rationale: `HR task for worker request ${needEvent.payload.title}`,
    payload: {
      tasks: [
        {
          id: taskId,
          title: String(taskTitle).trim(),
          description: taskDescription || undefined,
        },
      ],
    },
  });
  await eventsRouter.emitEvent({
    id: crypto.randomUUID(),
    type: 'assignment',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'human',
    correlationId: needEvent.id,
    rationale: `HR assigned follow-up for worker request`,
    payload: {
      taskId,
      personId: assignee.id,
      person: {
        id: assignee.id,
        name: assignee.name,
        department: assignee.department,
        team: assignee.team,
        role: assignee.role,
      },
    },
  });

  return res.status(201).json({ accepted: true, taskId, assigneeId: assignee.id });
});

router.buildWorkerDashboard = buildWorkerDashboard;
router.buildProjectInbox = buildProjectInbox;
router.buildHrInbox = buildHrInbox;
router.mapWorkerRequestEvent = mapWorkerRequestEvent;

module.exports = router;
