/**
 * Apply approved worker requests that add or onboard someone onto a project team.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const { personCanWork } = require('./emergencyReturn');
const {
  buildAssigneeSnapshot,
  resolveDirectoryJobTitle,
} = require('../lib/projectMemberRoles');
const { assignTaskToPerson, taskAssigneeId: taskAssigneeIdFromLib } = require('../lib/taskAssignment');

const TEAM_MEMBER_KINDS = new Set(['team_member', 'onboarding']);

const ADD_MEMBER_TEXT =
  /\b(add|assign|onboard|provision|include)\b.*\b(team|project)\b|\bteam\s*member\b|\bonboarding\b/i;

function taskAssigneeId(task) {
  return taskAssigneeIdFromLib(task);
}

function isProjectScoped(projectId) {
  return !!projectId && projectId !== ORG_GENERAL_PROJECT_ID;
}

function isTeamMemberRequest(needEvent) {
  const kind = needEvent.payload?.kind;
  if (TEAM_MEMBER_KINDS.has(kind)) return true;
  const text = `${needEvent.payload?.title || ''} ${needEvent.payload?.description || ''}`;
  if (!ADD_MEMBER_TEXT.test(text)) return false;
  return /\b(add|assign|onboard|provision|include)\b/i.test(text);
}

/** True when approved request already recorded the member on the project team. */
function teamMemberEffectsComplete(needEvent) {
  const tm = needEvent.payload?.effectsApplied?.teamMember;
  if (!tm?.targetPersonId) return false;
  if (tm.skipped === 'target_person_not_found') return false;
  return !!(tm.addedToTeam || tm.alreadyOnTeam);
}

function requiresResolvedTarget(needEvent) {
  return TEAM_MEMBER_KINDS.has(needEvent.payload?.kind);
}

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

/**
 * Resolve the person being added (not the submitter).
 */
function resolveTargetPerson(needEvent, people) {
  const payload = needEvent.payload || {};
  const explicit =
    payload.targetPersonId || payload.subjectPersonId || payload.memberPersonId;
  if (explicit) {
    const p = people.find((x) => x.id === explicit);
    if (p) return p;
  }

  const submitterId = payload.personId || payload.submittedBy;
  const text = `${payload.title || ''} ${payload.description || ''}`;
  const normalized = text.toLowerCase();

  const candidates = people
    .filter((p) => p.id !== submitterId && personCanWork(p))
    .filter((p) => {
      const name = normalizeName(p.name);
      if (!name || name.length < 4) return false;
      if (normalized.includes(name)) return true;
      const parts = name.split(/\s+/).filter((w) => w.length > 2);
      return parts.length >= 2 && parts.every((part) => normalized.includes(part));
    })
    .sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length);

  return candidates[0] || null;
}

function memberAlreadyOnProject(projectState, personId) {
  const roles = projectState?.roles || {};
  return Object.values(roles).some((r) => r.personId === personId);
}

function buildMemberRoleEntry(person) {
  return {
    roleId: 'contributor',
    label: 'Contributor',
    personId: person.id,
    name: person.name,
    department: person.department,
    team: person.team,
    jobTitle: resolveDirectoryJobTitle(person),
  };
}

async function emitProjectMemberAdded(ctx, { projectId, member, needEvent, reviewerName }) {
  const { emitEvent } = ctx;
  const roleKey = `contributor_${member.personId}`;
  const summary = `${member.name} added to project team (${needEvent.payload?.title || needEvent.payload?.kind}). Approved by ${reviewerName}.`;

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'system',
    correlationId: needEvent.id,
    rationale: summary,
    payload: {
      decisionType: 'project_member_added',
      roleKey,
      member,
      needId: needEvent.id,
      kind: needEvent.payload?.kind,
    },
  });

  agentActivityLog.push({
    source: 'orchestrator',
    projectId,
    message: summary,
  });

  return { roleKey, member };
}

async function assignMemberToTasks(ctx, { projectId, member, needEvent, maxTasks = 2 }) {
  const { getStore } = ctx;
  const state = getStore().projects[projectId];
  if (!state) return [];

  const kind = needEvent.payload?.kind;
  const text = `${needEvent.payload?.title || ''} ${needEvent.payload?.description || ''}`.toLowerCase();
  const allowReassign =
    kind === 'onboarding' ||
    TEAM_MEMBER_KINDS.has(kind) ||
    kind === 'capacity' ||
    kind === 'workload_concern';
  const wantDataScience = /data\s*science|specialist|analyst|ml\b|machine\s*learning/i.test(text);

  const tasks = (state.progress?.tasks || []).filter((t) => t.status !== 'done');
  const scored = tasks
    .map((t) => {
      const title = `${t.title || ''} ${t.description || ''}`.toLowerCase();
      let score = 0;
      const currentAssignee = taskAssigneeId(t);
      if (currentAssignee === member.id) return { task: t, score: -1 };
      if (taskIsUnassigned(t)) score += 3;
      if (wantDataScience && /data\s*science|specialist|onboard|analysis|remediation/i.test(title)) {
        score += 5;
      }
      if (/onboard|assign.*specialist/i.test(title)) score += 6;
      if (normalizeName(member.name).split(/\s+/).some((part) => title.includes(part))) score += 2;
      if (allowReassign && currentAssignee && /onboard|specialist|data\s*science/i.test(title)) {
        score += 4;
      }
      if (
        allowReassign &&
        currentAssignee &&
        currentAssignee !== member.id &&
        (kind === 'capacity' || kind === 'workload_concern')
      ) {
        score += 5;
      }
      const reassign =
        allowReassign &&
        currentAssignee &&
        currentAssignee !== member.id &&
        (kind === 'capacity' || kind === 'workload_concern' || score >= 6);
      return { task: t, score, reassign: !!reassign };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const assigned = [];
  for (const { task, reassign } of scored.slice(0, maxTasks)) {
    if (taskAssigneeId(task) === member.id) continue;
    if (!reassign && taskAssigneeId(task)) continue;

    const stateNow = getStore().projects[projectId];
    const assignee = buildAssigneeSnapshot(member, stateNow);
    const assignResult = await assignTaskToPerson(ctx, {
      projectId,
      task,
      personId: member.id,
      person: assignee,
      correlationId: needEvent.id,
      rationale: `Approved ${needEvent.payload?.kind || 'team request'}: assigned ${member.name} to ${task.title || task.id}`,
      source: 'system',
      payloadExtra: {
        teamMemberRequest: true,
        reassignReason: `Staffing: ${member.name}`,
      },
    });
    if (assignResult.assigned) {
      assigned.push({
        taskId: task.id,
        title: task.title,
        previousAssigneeId: assignResult.previousPersonId,
      });
    }
  }

  return assigned;
}

function taskIsUnassigned(task) {
  const aid = taskAssigneeId(task);
  return aid == null || String(aid).trim() === '';
}

/**
 * Add target person to project roles and optionally assign matching tasks.
 */
async function applyTeamMemberEffects(needEvent, reviewer, ctx) {
  const projectId = needEvent.projectId;
  if (!isProjectScoped(projectId) || !isTeamMemberRequest(needEvent)) {
    return null;
  }

  if (teamMemberEffectsComplete(needEvent)) {
    return needEvent.payload.effectsApplied.teamMember;
  }

  const { loadPeople, getStore } = ctx;
  let people = typeof loadPeople === 'function' ? loadPeople() : [];
  if (people && typeof people.then === 'function') people = await people;
  if (!Array.isArray(people)) people = [];
  const member = resolveTargetPerson(needEvent, people);
  if (!member) {
    const err =
      'Could not identify who to add to the project team. Use targetPersonId or include their full name in the title/description.';
    needEvent.payload.effectsError = err;
    return { skipped: 'target_person_not_found', error: err };
  }

  const state = getStore().projects[projectId];
  if (!state || state.status !== 'active') {
    return { skipped: 'project_not_active', targetPersonId: member.id };
  }

  const reviewerName = reviewer?.name || 'Reviewer';
  const result = {
    targetPersonId: member.id,
    targetPersonName: member.name,
    addedToTeam: false,
    roleKey: null,
    tasksAssigned: [],
  };

  if (!memberAlreadyOnProject(state, member.id)) {
    const entry = buildMemberRoleEntry(member);
    const added = await emitProjectMemberAdded(ctx, {
      projectId,
      member: entry,
      needEvent,
      reviewerName,
    });
    result.addedToTeam = true;
    result.roleKey = added.roleKey;
  } else {
    result.addedToTeam = false;
    result.alreadyOnTeam = true;
  }

  const freshState = getStore().projects[projectId];
  const assigned = await assignMemberToTasks(ctx, {
    projectId,
    member,
    needEvent,
    maxTasks: needEvent.payload?.kind === 'onboarding' ? 3 : 2,
  });
  result.tasksAssigned = assigned;

  if (result.addedToTeam || assigned.length > 0) {
    agentActivityLog.push({
      source: 'team_builder',
      projectId,
      message: `Team member effects: ${member.name} on project (${result.addedToTeam ? 'added to roles' : 'already on team'}), ${assigned.length} task(s) assigned. By ${reviewerName}.`,
    });
  }

  return result;
}

/**
 * Validate that a new team_member / onboarding request can resolve its target before submit.
 */
function validateTeamMemberRequestPayload(payload, people) {
  const preview = { payload };
  if (!requiresResolvedTarget(preview) && !isTeamMemberRequest(preview)) {
    return { ok: true };
  }
  if (!isTeamMemberRequest(preview)) return { ok: true };
  const member = resolveTargetPerson(preview, people);
  if (member) return { ok: true, targetPersonId: member.id, targetPersonName: member.name };
  return {
    ok: false,
    error:
      'Could not identify who to add. Set targetPersonId or include their full name in the title (e.g. "Add Luna Lovegood to the project team").',
  };
}

module.exports = {
  isTeamMemberRequest,
  teamMemberEffectsComplete,
  requiresResolvedTarget,
  resolveTargetPerson,
  validateTeamMemberRequestPayload,
  applyTeamMemberEffects,
  TEAM_MEMBER_KINDS,
};
