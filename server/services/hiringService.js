/**
 * Hire mock or specified employees into Postgres and refresh org roster.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const postgresStore = require('../store/postgresStore');
const {
  generateMockEmployee,
  generateMockEmployeeForRequirements,
  parseHiringRequirements,
  scoreCandidateMatch,
} = require('../lib/mockEmployeeGenerator');
const { ensurePersonalHrAssignments } = require('./personalHrBootstrap');
const { applyTeamMemberEffects } = require('./workerRequestTeamMember');
const { ORG_AI_REVIEWER } = require('./workerRequestAutoApprove');

function normalizePersonInput(body) {
  const p = body?.person || body;
  if (!p?.name || typeof p.name !== 'string') {
    return { error: 'person.name is required' };
  }
  return {
    person: {
      id: p.id,
      name: p.name.trim(),
      department: (p.department || 'General').trim(),
      team: (p.team || p.department || 'General').trim(),
      role: (p.role || 'Individual Contributor').trim(),
      skills: Array.isArray(p.skills) ? p.skills.map((s) => String(s).trim()).filter(Boolean) : [],
      currentLoad: 0,
      availabilityStatus: 'active',
    },
  };
}

/**
 * Persist employee and emit hire decision.
 */
async function hireEmployee(person, options = {}) {
  const {
    hiredBy = 'hr',
    hiredByName = 'HR',
    source = 'human',
    projectId = null,
    correlationId = null,
    requirements = null,
    refreshPeopleCache,
    emitEvent,
    getStore,
  } = options;

  const existing = await postgresStore.loadAllPeople();
  if (existing.some((p) => p.id === person.id)) {
    return { error: `Employee id ${person.id} already exists`, code: 'duplicate_id' };
  }
  if (existing.some((p) => p.name.toLowerCase() === person.name.toLowerCase())) {
    return { error: `Employee named ${person.name} already exists`, code: 'duplicate_name' };
  }

  const { allocateNextPersonId } = require('../lib/mockEmployeeGenerator');
  if (!person.id || existing.some((p) => p.id === person.id)) {
    person.id = allocateNextPersonId(existing);
  }

  await postgresStore.upsertPerson(person);
  await ensurePersonalHrAssignments(refreshPeopleCache);

  if (typeof refreshPeopleCache === 'function') {
    await refreshPeopleCache();
  }

  const summary = `${person.name} hired as ${person.role} (${person.department} / ${person.team}).`;
  let decisionEvent = null;

  if (typeof emitEvent === 'function') {
    decisionEvent = {
      id: crypto.randomUUID(),
      type: 'decision',
      timestamp: new Date().toISOString(),
      projectId: projectId || 'org-general',
      source: source === 'ai' ? 'org_ai' : 'human',
      correlationId: correlationId || undefined,
      rationale: summary,
      payload: {
        decisionType: 'employee_hired',
        personId: person.id,
        personName: person.name,
        department: person.department,
        team: person.team,
        role: person.role,
        skills: person.skills,
        hiredBy,
        hiredByName,
        requirements: requirements || undefined,
      },
    };
    await emitEvent(decisionEvent);
  }

  agentActivityLog.push({
    source: source === 'ai' ? 'org_ai' : 'human',
    projectId: projectId || undefined,
    message: `${hiredByName}: ${summary}`,
  });

  let teamMember = null;
  if (projectId && projectId !== 'org-general' && typeof getStore === 'function' && typeof emitEvent === 'function') {
    const roster = await postgresStore.loadAllPeople();
    const needStub = {
      id: correlationId || decisionEvent?.id || crypto.randomUUID(),
      projectId,
      payload: {
        kind: 'team_member',
        title: `Add ${person.name} to project team`,
        description: `Onboard ${person.name} (${person.role}) to meet hiring requirements.`,
        targetPersonId: person.id,
        status: 'approved',
      },
    };
    const ctx = {
      emitEvent,
      getStore,
      loadPeople: () => roster,
      incrementPersonLoad: postgresStore.incrementPersonLoad,
      recomputePeopleLoad: options.recomputePeopleLoad,
    };
    teamMember = await applyTeamMemberEffects(needStub, { id: hiredBy, name: hiredByName }, ctx);
  }

  return {
    hired: true,
    person,
    decisionId: decisionEvent?.id,
    teamMember,
    message: summary,
  };
}

async function previewMockEmployee(options = {}) {
  const existing = await postgresStore.loadAllPeople();
  const generated = options.matchRequirements
    ? generateMockEmployeeForRequirements({ ...options, existingPeople: existing })
    : generateMockEmployee({ ...options, existingPeople: existing });
  return generated;
}

async function hireFromRequirements(requirementsInput, options = {}) {
  const requirements = parseHiringRequirements(requirementsInput);
  const existing = await postgresStore.loadAllPeople();
  const text = `${requirementsInput.title || ''} ${requirementsInput.description || ''} ${requirementsInput.requirements || ''}`.trim();
  const profileOnly =
    !!requirements.profileId && !text && !requirementsInput.department && !requirementsInput.team && !requirementsInput.role;

  const generated = generateMockEmployeeForRequirements({
    ...requirementsInput,
    requirements,
    existingPeople: existing,
    minMatchScore: options.minMatchScore ?? (profileOnly ? 0 : 40),
  });

  if (!generated) {
    return { error: 'Could not generate a candidate matching requirements' };
  }

  const hire = await hireEmployee(generated.person, {
    ...options,
    requirements,
    source: options.source || 'ai',
    hiredBy: options.hiredBy || ORG_AI_REVIEWER.id,
    hiredByName: options.hiredByName || ORG_AI_REVIEWER.name,
  });

  if (hire.error) return hire;

  return {
    ...hire,
    matchScore: generated.matchScore,
    profileId: generated.profileId,
    requirements,
  };
}

/**
 * If a need describes recruitment, generate and hire a matching employee.
 */
async function tryAutoHireFromNeed(needEvent, ctx) {
  const text = `${needEvent.payload?.title || ''} ${needEvent.payload?.description || ''}`.toLowerCase();
  if (!/\b(recruit|hire|onboard|specialist|headcount|new\s+(hire|employee|analyst|engineer))\b/.test(text)) {
    return null;
  }

  const projectId = needEvent.projectId;
  if (!projectId || projectId === 'org-general') return null;

  const existing = await postgresStore.loadAllPeople();
  const requirements = parseHiringRequirements({
    title: needEvent.payload?.title,
    description: needEvent.payload?.description,
    projectId,
  });

  const generated = generateMockEmployeeForRequirements({
    existingPeople: existing,
    ...requirements,
    minMatchScore: 45,
  });
  if (!generated) return { skipped: 'no_matching_candidate' };

  const hire = await hireEmployee(generated.person, {
    hiredBy: ORG_AI_REVIEWER.id,
    hiredByName: ORG_AI_REVIEWER.name,
    source: 'ai',
    projectId,
    correlationId: needEvent.id,
    requirements,
    emitEvent: ctx.emitEvent,
    getStore: ctx.getStore,
    refreshPeopleCache: ctx.refreshPeopleCache,
    recomputePeopleLoad: ctx.recomputePeopleLoad,
  });

  return { hire, generated, requirements };
}

module.exports = {
  normalizePersonInput,
  hireEmployee,
  previewMockEmployee,
  hireFromRequirements,
  tryAutoHireFromNeed,
  scoreCandidateMatch,
};
