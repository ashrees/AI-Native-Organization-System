/**
 * Emergency return-to-work while on leave — HR-gated, temporary active status.
 */

const crypto = require('crypto');
const agentActivityLog = require('../lib/agentActivityLog');
const { setPersonAvailability } = require('../lib/personAvailability');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');

const AVAILABILITY = Object.freeze({
  ACTIVE: 'active',
  ON_LEAVE: 'on_leave',
  EMERGENCY: 'emergency_active',
});

function personCanWork(person) {
  const s = person?.availabilityStatus || AVAILABILITY.ACTIVE;
  return s === AVAILABILITY.ACTIVE || s === AVAILABILITY.EMERGENCY;
}

/**
 * HR authorizes temporary work during approved leave.
 */
async function activateEmergencyWork(personId, options, ctx) {
  const { hrPerson, reason, projectId, taskId, correlationId } = options;
  const { emitEvent, loadPeople, getStore } = ctx;
  const people = loadPeople();
  const person = people.find((p) => p.id === personId);
  if (!person) return { error: 'Person not found' };

  if (person.availabilityStatus !== AVAILABILITY.ON_LEAVE) {
    return {
      error: `${person.name} is not on leave (status: ${person.availabilityStatus || 'active'}). Emergency activation applies only during sick leave or vacation.`,
    };
  }

  await setPersonAvailability(
    personId,
    {
      status: AVAILABILITY.EMERGENCY,
      until: person.availabilityUntil,
      reason: `emergency: ${reason || 'urgent work'}`,
      needId: person.activeNeedId,
    },
    ctx
  );

  const targetProject = projectId && projectId !== ORG_GENERAL_PROJECT_ID ? projectId : null;
  let assignment = null;

  if (targetProject && taskId) {
    const state = getStore().projects[targetProject];
    const task = state?.progress?.tasks?.find((t) => t.id === taskId);
    if (!task) {
      return { error: 'Task not found on project' };
    }
    await emitEvent({
      id: crypto.randomUUID(),
      type: 'assignment',
      timestamp: new Date().toISOString(),
      projectId: targetProject,
      source: 'human',
      correlationId: correlationId || null,
      rationale: `Emergency assignment for ${person.name} (${reason || 'HR authorized'})`,
      payload: {
        taskId,
        personId: person.id,
        person: {
          id: person.id,
          name: person.name,
          department: person.department,
          team: person.team,
          role: person.role,
        },
      },
    });
    assignment = { projectId: targetProject, taskId };
  }

  const noticeProject = targetProject || ORG_GENERAL_PROJECT_ID;
  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: noticeProject,
    source: 'org_ai',
    correlationId: correlationId || null,
    rationale: `Emergency work authorized for ${person.name} by ${hrPerson.name}: ${reason || 'urgent operational need'}`,
    payload: {
      decisionType: 'emergency_return',
      personId,
      personName: person.name,
      hrPersonId: hrPerson.id,
      hrPersonName: hrPerson.name,
      reason,
      assignment,
    },
  });

  agentActivityLog.push({
    source: 'org_ai',
    projectId: noticeProject,
    message: `Emergency return: ${person.name} may work temporarily (authorized by ${hrPerson.name}). ${assignment ? `Assigned to ${assignment.taskId}.` : 'HR should assign tasks as needed.'}`,
  });

  return {
    personId,
    availabilityStatus: AVAILABILITY.EMERGENCY,
    assignment,
    message: `${person.name} is authorized for emergency work. Original leave remains on record until HR ends emergency or closes leave.`,
  };
}

/**
 * End emergency period — return to on_leave or fully back to active (end leave early).
 */
async function endEmergencyWork(personId, options, ctx) {
  const { hrPerson, returnTo, reason, correlationId } = options;
  const { emitEvent, loadPeople, updateWorkerRequest } = ctx;
  const people = loadPeople();
  const person = people.find((p) => p.id === personId);
  if (!person) return { error: 'Person not found' };

  if (person.availabilityStatus !== AVAILABILITY.EMERGENCY) {
    return { error: `${person.name} is not in emergency work mode.` };
  }

  const nextStatus = returnTo === 'active' ? AVAILABILITY.ACTIVE : AVAILABILITY.ON_LEAVE;
  await setPersonAvailability(
    personId,
    {
      status: nextStatus,
      until: returnTo === 'active' ? null : person.availabilityUntil,
      reason: returnTo === 'active' ? null : person.availabilityReason?.replace(/^emergency:\s*/, '') || 'sick_leave',
      needId: returnTo === 'active' ? null : person.activeNeedId,
    },
    ctx
  );

  if (returnTo === 'active' && person.activeNeedId && typeof updateWorkerRequest === 'function') {
    await updateWorkerRequest(person.activeNeedId, {
      status: 'met',
      reviewNotes: reason || 'Returned from leave early after emergency work period.',
      reviewedBy: hrPerson.id,
      reviewedByName: hrPerson.name,
      reviewedAt: new Date().toISOString(),
    });
  }

  await emitEvent({
    id: crypto.randomUUID(),
    type: 'decision',
    timestamp: new Date().toISOString(),
    projectId: ORG_GENERAL_PROJECT_ID,
    source: 'org_ai',
    correlationId: correlationId || null,
    rationale: `Emergency work ended for ${person.name} by ${hrPerson.name} — now ${returnTo === 'active' ? 'fully active' : 'back on leave'}`,
    payload: {
      decisionType: 'emergency_return_end',
      personId,
      returnTo,
      hrPersonId: hrPerson.id,
    },
  });

  agentActivityLog.push({
    source: 'org_ai',
    projectId: null,
    message: `${person.name} emergency work ended by ${hrPerson.name}; status is ${nextStatus}.`,
  });

  return { personId, availabilityStatus: nextStatus };
}

module.exports = {
  AVAILABILITY,
  personCanWork,
  activateEmergencyWork,
  endEmergencyWork,
};
