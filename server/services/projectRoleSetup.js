/**
 * Assign essential project roles when a new project is created (before delivery task assignments).
 */

const crypto = require('crypto');
const { ESSENTIAL_PROJECT_ROLES } = require('../constants/projectRoles');
const { personCanWork } = require('./emergencyReturn');
const { getPersonalHr } = require('./personalHr');
const agentActivityLog = require('../lib/agentActivityLog');

function isNewProject(projectState) {
  const tasks = projectState?.progress?.tasks || [];
  const hasRoles = projectState?.roles && Object.keys(projectState.roles).length > 0;
  return tasks.length === 0 && !hasRoles;
}

function pickForRole(roleDef, people, usedIds, requestPayload) {
  const text = `${requestPayload?.title || ''} ${requestPayload?.description || ''}`.toLowerCase();
  const candidates = (people || [])
    .filter((p) => personCanWork(p) && !usedIds.has(p.id))
    .filter((p) => roleDef.match(p))
    .sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0));

  if (roleDef.id === 'hr_liaison') {
    const requesterId = requestPayload?.requestedBy || requestPayload?.personId;
    const personalHr = requesterId ? getPersonalHr(requesterId, people) : null;
    if (personalHr && !usedIds.has(personalHr.id)) return personalHr;
    const hrCandidates = (people || []).filter((p) => personCanWork(p) && roleDef.match(p));
    return hrCandidates.sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0))[0] || null;
  }

  if (candidates.length > 0) return candidates[0];

  if (roleDef.id === 'technical_lead' && /\b(ai|ml|data|model|financial)\b/.test(text)) {
    const dataAi = (people || [])
      .filter((p) => personCanWork(p) && !usedIds.has(p.id))
      .filter((p) => /data|ai|ml/i.test(p.department || '') || /data|ai|ml/i.test(p.team || ''))
      .sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0));
    if (dataAi[0]) return dataAi[0];
  }

  const fallback = (people || [])
    .filter((p) => personCanWork(p) && !usedIds.has(p.id))
    .sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0));
  return fallback[0] || null;
}

function buildRoleEntry(roleDef, person) {
  return {
    roleId: roleDef.id,
    label: roleDef.label,
    personId: person.id,
    name: person.name,
    department: person.department,
    team: person.team,
    jobTitle: person.role,
  };
}

/**
 * Assign essential roles and emit project_roles_assigned decision.
 */
async function setupEssentialProjectRoles(projectId, requestEvent, plan, ctx) {
  const { emitEvent, loadPeople, agentLogMessage } = ctx;
  const people = loadPeople();
  const usedIds = new Set();
  const roles = {};
  const assignments = [];

  for (const roleDef of ESSENTIAL_PROJECT_ROLES) {
    const person = pickForRole(roleDef, people, usedIds, requestEvent.payload);
    if (!person) continue;
    usedIds.add(person.id);
    roles[roleDef.id] = buildRoleEntry(roleDef, person);
    assignments.push(`${roleDef.label}: ${person.name}`);
  }

  if (Object.keys(roles).length === 0) return null;

  const summary = agentLogMessage(
    `Essential project roles assigned — ${assignments.join('; ')}. Delivery tasks planned separately (${(plan?.tasks || []).length} tasks).`
  );

  agentActivityLog.push({
    source: 'orchestrator',
    projectId,
    message: summary,
  });

  const decisionEvent = {
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId,
    source: 'orchestrator',
    correlationId: requestEvent.id,
    rationale: summary,
    payload: {
      decisionType: 'project_roles_assigned',
      roles,
      deliveryTaskCount: (plan?.tasks || []).length,
      essentialRoleIds: Object.keys(roles),
    },
  };

  await emitEvent(decisionEvent);
  return { roles, decisionEvent };
}

module.exports = {
  isNewProject,
  setupEssentialProjectRoles,
  pickForRole,
};
