/**
 * Every worker request kind forwards to explicit organizational roles and/or AI agents.
 */

const ORG_GENERAL_PROJECT_ID = 'org-general';

/** Role ids used for matching people in the directory. */
const ROLES = Object.freeze({
  hr: {
    id: 'hr',
    label: 'Human Resources',
    agent: 'org_ai',
    match: (p) => {
      const d = (p.department || '').toLowerCase();
      const r = (p.role || '').toLowerCase();
      const s = (p.skills || []).join(' ').toLowerCase();
      return d.includes('human resources') || r.includes('hr') || s.includes('human-resources');
    },
  },
  project_lead: {
    id: 'project_lead',
    label: 'Project leadership',
    agent: 'orchestrator',
    match: () => false,
  },
  project_team: {
    id: 'project_team',
    label: 'Project team',
    agent: 'project_ai',
    match: () => false,
  },
  engineering_mgmt: {
    id: 'engineering_mgmt',
    label: 'Engineering management',
    agent: 'orchestrator',
    match: (p) => {
      const d = (p.department || '').toLowerCase();
      const r = (p.role || '').toLowerCase();
      return d.includes('engineering') && (r.includes('manager') || r.includes('lead'));
    },
  },
  finance: {
    id: 'finance',
    label: 'Finance',
    agent: 'org_ai',
    match: (p) => (p.department || '').toLowerCase().includes('finance'),
  },
  legal: {
    id: 'legal',
    label: 'Legal',
    agent: 'org_ai',
    match: (p) => (p.department || '').toLowerCase().includes('legal'),
  },
  devops: {
    id: 'devops',
    label: 'DevOps / Platform',
    agent: 'scheduler',
    match: (p) => {
      const t = (p.team || '').toLowerCase();
      const r = (p.role || '').toLowerCase();
      return t.includes('devops') || r.includes('devops');
    },
  },
  data_lead: {
    id: 'data_lead',
    label: 'Data / ML leadership',
    agent: 'team_builder',
    match: (p) => {
      const d = (p.department || '').toLowerCase();
      return (d.includes('data') || d.includes('ai')) && (p.role || '').toLowerCase().includes('manager');
    },
  },
});

/**
 * Per request kind: which roles receive the request; AI agent that coordinates forwarding.
 * projectScoped: when true and projectId set, include project_lead + project_team.
 */
const KIND_ROUTES = Object.freeze({
  sick_leave: {
    roles: ['hr'],
    projectScoped: false,
    hrInbox: true,
    aiAgent: 'org_ai',
    label: 'HR',
  },
  vacation: {
    roles: ['hr'],
    projectScoped: false,
    hrInbox: true,
    aiAgent: 'org_ai',
    label: 'HR',
  },
  project_transfer: {
    roles: ['hr', 'project_lead', 'engineering_mgmt'],
    projectScoped: true,
    hrInbox: true,
    aiAgent: 'orchestrator',
    label: 'HR + Project lead + Engineering mgmt',
  },
  workload_concern: {
    roles: ['project_lead', 'engineering_mgmt'],
    projectScoped: true,
    orgFallbackRoles: ['hr'],
    hrInbox: false,
    aiAgent: 'orchestrator',
    label: 'Project lead + Engineering mgmt',
  },
  project_contribution_change: {
    roles: ['project_lead', 'project_team'],
    projectScoped: true,
    hrInbox: false,
    aiAgent: 'project_ai',
    label: 'Project lead + Project team',
  },
  schedule_change: {
    roles: ['project_lead', 'project_team'],
    projectScoped: true,
    orgFallbackRoles: ['hr'],
    hrInbox: false,
    aiAgent: 'scheduler',
    label: 'Project lead + Scheduler (AI)',
  },
  blocker_escalation: {
    roles: ['project_lead', 'project_team', 'engineering_mgmt'],
    projectScoped: true,
    hrInbox: false,
    aiAgent: 'orchestrator',
    label: 'Project lead + Team + Engineering mgmt',
  },
  role_change: {
    roles: ['hr', 'engineering_mgmt'],
    projectScoped: true,
    hrInbox: true,
    aiAgent: 'org_ai',
    label: 'HR + Engineering mgmt',
  },
  training: {
    roles: ['hr'],
    projectScoped: false,
    hrInbox: true,
    aiAgent: 'org_ai',
    label: 'HR',
  },
  equipment: {
    roles: ['devops', 'hr'],
    projectScoped: false,
    hrInbox: true,
    aiAgent: 'scheduler',
    label: 'DevOps + HR',
  },
  general: {
    roles: ['hr'],
    projectScoped: true,
    projectOverrideRoles: ['project_lead', 'project_team'],
    orgFallbackRoles: ['hr'],
    hrInbox: false,
    aiAgent: 'org_ai',
    label: 'Project lead (on project) or HR (org-wide)',
  },
  emergency_return: {
    roles: ['hr'],
    projectScoped: true,
    orgFallbackRoles: ['hr'],
    hrInbox: true,
    aiAgent: 'org_ai',
    label: 'HR (emergency return authorization)',
  },
});

function getKindRoute(kind) {
  return KIND_ROUTES[kind] || KIND_ROUTES.general;
}

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function isProjectScoped(projectId) {
  return !!projectId && projectId !== ORG_GENERAL_PROJECT_ID;
}

function getRoutingForKind(kind, projectId) {
  const route = getKindRoute(kind);
  const onProject = isProjectScoped(projectId);
  let roles = [...route.roles];
  if (onProject && route.projectScoped && route.projectOverrideRoles) {
    roles = [...route.projectOverrideRoles];
  } else if (!onProject && route.orgFallbackRoles) {
    roles = [...route.orgFallbackRoles];
  }
  if (onProject && kind === 'workload_concern') {
    roles = roles.filter((r) => r !== 'hr');
  }
  const label =
    onProject && route.projectOverrideRoles
      ? route.projectOverrideRoles.map((r) => ROLES[r]?.label || r).join(' + ')
      : route.label;
  const hrInbox = roles.includes('hr') && (route.hrInbox || !onProject);
  return {
    roles,
    roleLabels: roles.map((r) => ROLES[r]?.label || r),
    hrInbox,
    aiAgent: route.aiAgent,
    label,
    forwardsTo: roles.map((r) => ROLES[r]?.label || r).join(', '),
  };
}

function peopleForRole(roleId, people, excludeId) {
  const def = ROLES[roleId];
  if (!def || roleId === 'project_lead' || roleId === 'project_team') return [];
  return (people || [])
    .filter((p) => p.id !== excludeId && def.match(p))
    .sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0));
}

function getProjectLeadTarget(projectId, projects, people) {
  const state = projects[projectId];
  if (!state?.sponsor) return null;
  const sponsorPerson = people.find(
    (p) => normalizeName(p.name) === normalizeName(state.sponsor)
  );
  return {
    personId: sponsorPerson?.id || null,
    name: sponsorPerson?.name || state.sponsor,
    role: 'project_lead',
    agent: ROLES.project_lead.agent,
  };
}

/** One project-team representative for notifications (not every assignee). */
function pickProjectTeamRepresentative(projectId, submitterId, projects, people) {
  const state = projects[projectId];
  const candidates = [];
  for (const t of state?.progress?.tasks || []) {
    const aid = t.assigneeId || t.assignee?.id;
    if (!aid || aid === submitterId) continue;
    const person = people.find((p) => p.id === aid);
    if (person) candidates.push(person);
  }
  candidates.sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0));
  const pick = candidates[0];
  if (!pick) return null;
  return {
    personId: pick.id,
    name: pick.name,
    role: 'project_team',
    agent: ROLES.project_team.agent,
  };
}

/**
 * Resolve everyone who should receive this request.
 * @returns {Array<{ personId, name, role, roleLabel, agent }>}
 */
function resolveForwardTargets(kind, projectId, projects, people, submitterId) {
  const routing = getRoutingForKind(kind, projectId);
  const targets = [];
  const seen = new Set();

  const add = (t) => {
    const key = t.personId || `name:${t.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({
      ...t,
      roleLabel: ROLES[t.role]?.label || t.role,
      agent: t.agent || ROLES[t.role]?.agent || 'org_ai',
    });
  };

  for (const roleId of routing.roles) {
    if (roleId === 'project_lead' && isProjectScoped(projectId)) {
      const lead = getProjectLeadTarget(projectId, projects, people);
      if (lead) add(lead);
      continue;
    }
    if (roleId === 'project_team' && isProjectScoped(projectId)) {
      const rep = pickProjectTeamRepresentative(projectId, submitterId, projects, people);
      if (rep) add(rep);
      continue;
    }
    const matches = peopleForRole(roleId, people, submitterId);
    if (matches[0]) {
      add({
        personId: matches[0].id,
        name: matches[0].name,
        role: roleId,
        agent: ROLES[roleId].agent,
      });
    }
  }

  return targets;
}

function requestRequiresHrInbox(request) {
  if (request.requiresHrInbox === false) return false;
  if (request.requiresHrInbox === true) return true;
  if (request.assignedHrPersonId) return true;
  const fwd = request.forwardTargets || request.notifyTargets || [];
  if (fwd.some((t) => t.role === 'hr')) return true;
  return !!getRoutingForKind(request.kind, request.projectId).hrInbox;
}

function isHrPerson(person) {
  return ROLES.hr.match(person);
}

function getHrPeople(people) {
  return peopleForRole('hr', people, null);
}

module.exports = {
  ROLES,
  KIND_ROUTES,
  getKindRoute,
  getRoutingForKind,
  resolveForwardTargets,
  requestRequiresHrInbox,
  isHrPerson,
  getHrPeople,
  isProjectScoped,
  ORG_GENERAL_PROJECT_ID,
};
