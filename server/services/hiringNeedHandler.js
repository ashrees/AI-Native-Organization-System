/**
 * Hiring needs — detect staffing/expertise gaps, queue for HR, or auto-hire via mock generator.
 * Used by AI Handler, assignment gap fill, and HR worker portal.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const { parseHiringRequirements } = require('../lib/mockEmployeeGenerator');
const { hireFromRequirements } = require('./hiringService');
const { ORG_AI_REVIEWER } = require('./workerRequestAutoApprove');
const { isTeamMemberRequest, resolveTargetPerson } = require('./workerRequestTeamMember');
const { isStaffingOrCapacityRequest } = require('./workerRequestStaffing');
const { listUnassignedTasks } = require('./assignmentGapFill');

const HIRING_TEXT =
  /\b(recruit|recruit(?:ment)?|hire|hiring|headcount|staffing|understaffed|shortage|short\s+staffed|need\s+(?:a|an|more)\s+(?:person|people|hire|employee|engineer|analyst|specialist)|new\s+(?:hire|employee|analyst|engineer|specialist)|expertise|skill\s+gap|not\s+available|unavailable|no\s+one\s+available|missing\s+(?:skill|expertise|capacity)|additional\s+(?:team|staff|resource|headcount))\b/i;

const HIRING_KINDS = new Set([
  'hiring_request',
  'team_member',
  'onboarding',
  'workload_concern',
  'blocker_escalation',
  'general',
]);

function needText(needEvent) {
  const p = needEvent.payload || {};
  return `${p.title || ''} ${p.description || ''}`.trim();
}

function isHiringRelatedNeed(needEvent, people = null) {
  if (!needEvent || needEvent.type !== 'need') return false;
  const p = needEvent.payload || {};
  if (p.hrHiringQueue || p.hiringRequirements) return true;
  const kind = p.kind || 'general';
  const text = needText(needEvent);
  if (kind === 'capacity' && /\b(design|creative|promotional|marketing)\b/i.test(text)) return true;
  if (kind === 'hiring_request') return true;
  if (kind === 'resource_approval' && HIRING_TEXT.test(needText(needEvent))) return true;
  if (isStaffingOrCapacityRequest(needEvent) && HIRING_TEXT.test(needText(needEvent))) return true;
  if (HIRING_KINDS.has(kind) && HIRING_TEXT.test(needText(needEvent))) return true;
  if (isTeamMemberRequest(needEvent)) {
    const roster = people || [];
    if (roster.length && !resolveTargetPerson(needEvent, roster)) return true;
    return HIRING_TEXT.test(needText(needEvent));
  }
  return HIRING_TEXT.test(needText(needEvent));
}

function extractNameHint(text) {
  const m = text.match(
    /\b(?:add|assign|onboard|hire|recruit)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/
  );
  return m ? m[1].trim() : null;
}

/**
 * Build structured hiring analysis for HR tab and auto-hire.
 */
function analyzeHiringNeed(needEvent, ctx) {
  const people = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
  const store = typeof ctx.getStore === 'function' ? ctx.getStore() : { projects: {} };
  const projectId = needEvent.projectId;
  const project = store.projects?.[projectId];
  const text = needText(needEvent);
  const p = needEvent.payload || {};

  const requirements = parseHiringRequirements({
    title: p.title,
    description: p.description,
    requirements: p.hiringRequirements || p.requirements,
    projectId: projectId !== ORG_GENERAL_PROJECT_ID ? projectId : undefined,
  });

  let targetMissing = false;
  let missingPersonHint = null;
  if (isTeamMemberRequest(needEvent)) {
    const target = resolveTargetPerson(needEvent, people);
    if (!target) {
      targetMissing = true;
      missingPersonHint = extractNameHint(text) || p.targetPersonName || null;
    }
  }

  const unassigned = project ? listUnassignedTasks(project) : [];
  const lines = [];
  if (p.title) lines.push(p.title);
  if (p.description) lines.push(p.description);
  if (targetMissing && missingPersonHint) {
    lines.push(`Requested person not in roster: ${missingPersonHint}.`);
  } else if (targetMissing) {
    lines.push('Requested team member not found in organization roster.');
  }
  if (unassigned.length > 0) {
    lines.push(
      `Project has ${unassigned.length} unassigned task(s): ${unassigned
        .slice(0, 3)
        .map((t) => t.title || t.id)
        .join('; ')}.`
    );
  }
  if (project?.title) lines.push(`Project: ${project.title} (${projectId}).`);

  const requirementsText = lines.filter(Boolean).join('\n').trim() || text;

  return {
    requirements,
    requirementsText,
    profileId: requirements.profileId,
    projectId: projectId !== ORG_GENERAL_PROJECT_ID ? projectId : null,
    projectTitle: project?.title || projectId,
    targetMissing,
    missingPersonHint,
    unassignedCount: unassigned.length,
    reason: targetMissing
      ? 'target_not_in_roster'
      : unassigned.length > 0
        ? 'unassigned_work'
        : 'hiring_keywords',
  };
}

function stampHiringQueueOnNeed(needEvent, analysis, extra = {}) {
  const p = needEvent.payload || {};
  needEvent.payload = {
    ...p,
    hrHiringQueue: true,
    requiresHrInbox: true,
    hiringRequirements: analysis.requirementsText,
    hiringProfileId: analysis.profileId || undefined,
    hiringProjectId: analysis.projectId || needEvent.projectId,
    hiringStatus: extra.hiringStatus || p.hiringStatus || 'pending_hr',
    hiringReason: analysis.reason,
    routingLabel: p.routingLabel || 'HR — Hiring queue',
    ...extra,
  };
  return needEvent;
}

/**
 * Try mock hire; on failure leave requirements on need for HR tab.
 */
async function processHiringForNeed(needEvent, ctx, options = {}) {
  const autoHire = options.autoHire !== false;
  if (!isHiringRelatedNeed(needEvent) && !options.force) return null;

  const analysis = analyzeHiringNeed(needEvent, ctx);
  stampHiringQueueOnNeed(needEvent, analysis, { hiringStatus: autoHire ? 'processing' : 'pending_hr' });

  if (!autoHire) {
    agentActivityLog.push({
      source: 'org_ai',
      projectId: needEvent.projectId,
      message: `AI Handler: hiring requirements queued for HR — ${analysis.requirementsText.slice(0, 120)}.`,
    });
    return { queuedForHr: true, analysis, hired: false };
  }

  const hireResult = await hireFromRequirements(
    {
      title: needEvent.payload?.title,
      description: analysis.requirementsText,
      requirements: analysis.requirementsText,
      profileId: analysis.profileId,
      projectId: analysis.projectId,
    },
    {
      emitEvent: ctx.emitEvent,
      getStore: ctx.getStore,
      refreshPeopleCache: ctx.refreshPeopleCache,
      recomputePeopleLoad: ctx.recomputePeopleLoad,
      source: 'ai',
      hiredBy: ORG_AI_REVIEWER.id,
      hiredByName: ORG_AI_REVIEWER.name,
      correlationId: needEvent.id,
      projectId: analysis.projectId,
    }
  );

  if (hireResult.hired && hireResult.person) {
    needEvent.payload.hiringStatus = 'hired';
    needEvent.payload.hiredPersonId = hireResult.person.id;
    needEvent.payload.hiredPersonName = hireResult.person.name;
    needEvent.payload.hiringResult = {
      personId: hireResult.person.id,
      personName: hireResult.person.name,
      matchScore: hireResult.matchScore,
      role: hireResult.person.role,
      department: hireResult.person.department,
    };
    if (isTeamMemberRequest(needEvent)) {
      needEvent.payload.targetPersonId = hireResult.person.id;
      needEvent.payload.targetPersonName = hireResult.person.name;
    }
    agentActivityLog.push({
      source: 'org_ai',
      projectId: needEvent.projectId,
      message: `AI Handler hired ${hireResult.person.name} for "${needEvent.payload?.title || 'staffing need'}".`,
    });
    return { hired: true, analysis, hire: hireResult };
  }

  needEvent.payload.hiringStatus = 'pending_hr';
  needEvent.payload.hiringError = hireResult.error || 'auto_hire_failed';
  agentActivityLog.push({
    source: 'org_ai',
    projectId: needEvent.projectId,
    message: `AI Handler: auto-hire failed — listed in HR hiring queue. ${hireResult.error || ''}`.trim(),
  });
  return { queuedForHr: true, analysis, hired: false, error: hireResult.error };
}

/**
 * Emit HR hiring need when assignment gap fill could not staff tasks.
 */
async function emitHrHiringNeedForStaffingGap(projectId, gapInfo, ctx) {
  if (!ctx.emitEvent || !projectId) return null;
  const store = ctx.getStore?.();
  const project = store?.projects?.[projectId];
  const tasks = gapInfo.taskTitles || [];
  const title = `Hire expertise for ${project?.title || projectId}`;
  const description = [
    gapInfo.description ||
      'Assignment gap fill could not assign unassigned work — expertise or headcount missing from roster.',
    tasks.length ? `Unassigned: ${tasks.join('; ')}` : null,
    gapInfo.unassignedCount != null ? `Count: ${gapInfo.unassignedCount} task(s).` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const event = {
    id: crypto.randomUUID(),
    type: 'need',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'org_ai',
    correlationId: gapInfo.triggerEventId,
    rationale: title,
    payload: {
      kind: 'hiring_request',
      title,
      description,
      status: 'open',
      handlingMode: 'ai',
      personId: ORG_AI_REVIEWER.id,
      submittedBy: ORG_AI_REVIEWER.id,
      requiresHrInbox: true,
      hrHiringQueue: true,
      hiringStatus: 'pending_hr',
      routingLabel: 'HR — Hiring queue',
      aiAgent: 'org_ai',
    },
  };

  const analysis = analyzeHiringNeed(event, ctx);
  stampHiringQueueOnNeed(event, analysis);

  await ctx.emitEvent(event);

  const { scheduleLeadershipAutoProcess } = require('./leadershipNeedAutoHandler');
  if (typeof scheduleLeadershipAutoProcess === 'function') {
    scheduleLeadershipAutoProcess(ctx);
  }

  return event;
}

function listHrHiringQueue(eventLog) {
  return (eventLog || [])
    .filter(
      (e) =>
        e.type === 'need' &&
        e.payload?.hrHiringQueue &&
        !['hired', 'cancelled'].includes(e.payload?.hiringStatus || '')
    )
    .map((e) => {
      const p = e.payload || {};
      return {
        id: e.id,
        projectId: e.projectId,
        kind: p.kind,
        title: p.title || p.kind,
        description: p.description,
        status: p.status || 'open',
        hiringStatus: p.hiringStatus || 'pending_hr',
        hiringRequirements: p.hiringRequirements,
        hiringProfileId: p.hiringProfileId,
        hiringProjectId: p.hiringProjectId || e.projectId,
        hiringReason: p.hiringReason,
        hiredPersonName: p.hiredPersonName,
        hiringError: p.hiringError,
        timestamp: e.timestamp,
        source: e.source,
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function markHiringNeedHired(needId, hireResult, ctx) {
  if (!needId || !ctx?.updateWorkerRequest || !ctx?.getEventLog) return false;
  const needEvent = ctx.getEventLog().find((e) => e.id === needId && e.type === 'need');
  if (!needEvent) return false;
  needEvent.payload.hiringStatus = 'hired';
  needEvent.payload.hrHiringQueue = false;
  needEvent.payload.hiredPersonId = hireResult.person?.id;
  needEvent.payload.hiredPersonName = hireResult.person?.name;
  needEvent.payload.hiringResult = {
    personId: hireResult.person?.id,
    personName: hireResult.person?.name,
    matchScore: hireResult.matchScore,
  };
  await ctx.updateWorkerRequest(needId, needEvent.payload);
  return true;
}

module.exports = {
  isHiringRelatedNeed,
  analyzeHiringNeed,
  processHiringForNeed,
  emitHrHiringNeedForStaffingGap,
  listHrHiringQueue,
  stampHiringQueueOnNeed,
  markHiringNeedHired,
};
