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
    handlingMode: p.handlingMode || 'notify',
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
    hrTaskId: p.hrTaskId,
    assignedHrPersonId: p.assignedHrPersonId,
    assignedReviewerPersonId: p.assignedReviewerPersonId,
    projectReviewTaskId: p.projectReviewTaskId,
    aiHandled: !!p.aiHandled,
    reviewedBy: p.reviewedBy,
    reviewedAt: p.reviewedAt,
    reviewNotes: p.reviewNotes,
    submitterName: submitter?.name,
    submitterId: p.personId,
    taskId: p.taskId,
    timestamp: e.timestamp,
    startDate: p.startDate,
    endDate: p.endDate,
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
    });

    for (const t of mine) {
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

  return { person: { id: person.id, name: person.name, role: person.role }, inbox, hrTasks };
}

/** GET /worker/project/inbox?personId= — project-scoped requests this person should review */
router.get('/project/inbox', (req, res) => {
  const personId = (req.query.personId || '').trim();
  if (!personId) return res.status(400).json({ error: 'personId is required' });

  const eventLog = eventsRouter.getEventLog();
  const people = eventsRouter.loadPeople();
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const inbox = eventLog
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

  res.json({ inbox });
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

/** POST /worker/status — update assigned task status */
router.post('/status', async (req, res) => {
  const result = await eventsRouter.submitWorkerStatus(req.body);
  return res.status(result.status).json(result.body);
});

/** POST /worker/requests — HR/ops request with routing (AI / notify / self) */
router.post('/requests', async (req, res) => {
  const {
    personId,
    kind,
    title,
    description,
    projectId,
    taskId,
    startDate,
    endDate,
    handlingMode,
  } = req.body || {};

  if (!personId || typeof personId !== 'string' || !personId.trim()) {
    return res.status(400).json({ error: 'personId is required' });
  }
  const people = eventsRouter.loadPeople();
  if (!people.some((p) => p.id === personId)) {
    return res.status(404).json({ error: 'Person not found' });
  }
  const validKind = WORKER_REQUEST_KINDS.some((k) => k.id === kind);
  if (!kind || !validKind) {
    return res.status(400).json({
      error: `kind must be one of: ${WORKER_REQUEST_KINDS.map((k) => k.id).join(', ')}`,
    });
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const mode = handlingMode || 'notify';
  if (!HANDLING_MODES.some((m) => m.id === mode)) {
    return res.status(400).json({ error: 'handlingMode must be ai, notify, or self' });
  }

  const pid = (projectId && String(projectId).trim()) || ORG_GENERAL_PROJECT_ID;
  const { projects } = eventsRouter.getStore();
  if (pid !== ORG_GENERAL_PROJECT_ID) {
    const state = projects[pid];
    if (!state) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const assigned = (state.progress?.tasks || []).some((t) => taskAssigneeId(t) === personId);
    if (!assigned) {
      return res.status(400).json({ error: 'Not assigned to this project' });
    }
  }

  const person = people.find((p) => p.id === personId);
  if (person?.availabilityStatus === 'on_leave') {
    return res.status(400).json({
      error: `${person.name} is on leave. For urgent work, HR must authorize emergency return (HR inbox → Emergency return, or emergency activate API).`,
    });
  }
  const descParts = [
    description?.trim(),
    person ? `Submitted by: ${person.name} (${personId})` : null,
    startDate ? `Start: ${startDate}` : null,
    endDate ? `End: ${endDate}` : null,
  ].filter(Boolean);

  const event = {
    id: crypto.randomUUID(),
    type: 'need',
    timestamp: new Date().toISOString(),
    projectId: pid,
    source: 'human',
    rationale: `${kind}: ${title.trim()}`,
    payload: {
      kind,
      title: title.trim(),
      description: descParts.join('\n') || title.trim(),
      status: mode === 'self' ? 'in_review' : 'open',
      handlingMode: mode,
      personId,
      submittedBy: personId,
      taskId: taskId || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      routingLabel: getRoutingForKind(kind, pid).label,
      requiresHrInbox: !!getRoutingForKind(kind, pid).hrInbox,
    },
  };

  await eventsRouter.emitEvent(event);

  const routingResult = await processWorkerRequest(event, eventsRouter.buildWorkerRequestCtx());

  await eventsRouter.updateWorkerRequest(event.id, {
    status: event.payload.status,
    notifyTargets: event.payload.notifyTargets,
    forwardTargets: event.payload.forwardTargets,
    routingLabel: event.payload.routingLabel,
    forwardsTo: event.payload.forwardsTo,
    aiAgent: event.payload.aiAgent,
    forwardRoles: event.payload.forwardRoles,
    requiresHrInbox: event.payload.requiresHrInbox,
    hrTaskId: event.payload.hrTaskId,
    assignedHrPersonId: event.payload.assignedHrPersonId,
    assignedReviewerPersonId: event.payload.assignedReviewerPersonId,
    projectReviewTaskId: event.payload.projectReviewTaskId,
    roleAssignments: event.payload.roleAssignments,
    primaryReviewerPersonIds: event.payload.primaryReviewerPersonIds,
    aiHandled: event.payload.aiHandled,
    status: event.payload.status,
  });

  return res.status(201).json({
    accepted: true,
    id: event.id,
    projectId: pid,
    handlingMode: mode,
    forwardsTo: event.payload.forwardsTo,
    aiAgent: event.payload.aiAgent,
    forwardTargets: routingResult.forwardTargets,
    roleAssignments: routingResult.assignments || [],
  });
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

module.exports = router;
