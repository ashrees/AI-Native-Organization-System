/**
 * Project-local roles vs org directory job titles.
 * Essential roles (Project Lead, Technical Lead, …) live on project.state.roles only.
 */

const { ESSENTIAL_PROJECT_ROLES } = require('../constants/projectRoles');

const ESSENTIAL_ROLE_IDS = new Set(ESSENTIAL_PROJECT_ROLES.map((r) => r.id));
const ESSENTIAL_LABELS = new Set(
  ESSENTIAL_PROJECT_ROLES.map((r) => r.label.toLowerCase())
);

/** Directory titles that must not be copied onto tasks as if they were project roles. */
function isLeadershipJobTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return false;
  if (ESSENTIAL_LABELS.has(t)) return true;
  return /^(team lead|project lead|technical lead|delivery owner|hr liaison)$/.test(t);
}

function findProjectRoleForPerson(projectState, personId) {
  if (!personId || !projectState?.roles) return null;
  for (const entry of Object.values(projectState.roles)) {
    if (entry?.personId === personId) {
      return {
        roleId: entry.roleId,
        label: entry.label || entry.roleId,
        jobTitle: entry.jobTitle,
      };
    }
  }
  return null;
}

function matchEssentialRoleByTitle(requestedRole) {
  const norm = String(requestedRole || '')
    .trim()
    .toLowerCase();
  if (!norm) return null;
  const direct = ESSENTIAL_PROJECT_ROLES.find((r) => r.label.toLowerCase() === norm);
  if (direct) return direct;
  if (norm === 'team lead' || norm.includes('project lead')) {
    return ESSENTIAL_PROJECT_ROLES.find((r) => r.id === 'project_lead');
  }
  if (norm.includes('technical lead')) {
    return ESSENTIAL_PROJECT_ROLES.find((r) => r.id === 'technical_lead');
  }
  if (norm.includes('delivery owner')) {
    return ESSENTIAL_PROJECT_ROLES.find((r) => r.id === 'delivery_owner');
  }
  if (norm.includes('hr')) {
    return ESSENTIAL_PROJECT_ROLES.find((r) => r.id === 'hr_liaison');
  }
  return null;
}

/**
 * Org directory job title (never a project essential role label).
 */
function resolveDirectoryJobTitle(person, fallbackJobTitle) {
  const raw = fallbackJobTitle || person?.role || '';
  if (!isLeadershipJobTitle(raw)) return raw;
  return person?.previousJobTitle || 'Individual Contributor';
}

/**
 * Snapshot stored on assignment events and shown on task cards.
 */
function buildAssigneeSnapshot(person, projectState) {
  if (!person) return null;
  const projectRole = findProjectRoleForPerson(projectState, person.id);
  const jobTitle = resolveDirectoryJobTitle(person, projectRole?.jobTitle);

  if (projectRole) {
    return {
      id: person.id,
      name: person.name,
      department: person.department,
      team: person.team,
      role: projectRole.label,
      projectRoleId: projectRole.roleId,
      jobTitle: jobTitle && jobTitle !== projectRole.label ? jobTitle : undefined,
    };
  }

  return {
    id: person.id,
    name: person.name,
    department: person.department,
    team: person.team,
    role: resolveDirectoryJobTitle(person),
    projectRoleId: undefined,
    jobTitle: undefined,
  };
}

function enrichTaskAssigneeForView(task, projectState, personFromDirectory) {
  if (!task.assigneeId && !task.assignee) return task;
  const personId = task.assigneeId || task.assignee?.id;
  const person =
    personFromDirectory ||
    (task.assignee?.id
      ? {
          id: task.assignee.id,
          name: task.assignee.name,
          department: task.assignee.department,
          team: task.assignee.team,
          role: task.assignee.jobTitle || task.assignee.role,
        }
      : null);
  const snapshot = buildAssigneeSnapshot(person, projectState);
  if (!snapshot) return task;
  return { ...task, assignee: snapshot };
}

module.exports = {
  ESSENTIAL_ROLE_IDS,
  isLeadershipJobTitle,
  findProjectRoleForPerson,
  matchEssentialRoleByTitle,
  resolveDirectoryJobTitle,
  buildAssigneeSnapshot,
  enrichTaskAssigneeForView,
};
