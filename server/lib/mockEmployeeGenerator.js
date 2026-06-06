/**
 * Random mock employee generator for demos and hiring flows.
 */

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Jamie',
  'Dakota', 'Skyler', 'Reese', 'Blake', 'Cameron', 'Drew', 'Emery', 'Finley', 'Harper', 'Jesse',
  'Kai', 'Logan', 'Noah', 'Parker', 'River', 'Sage', 'Rowan', 'Phoenix', 'Eden', 'Micah',
];

const LAST_NAMES = [
  'Rivera', 'Chen', 'Patel', 'Nguyen', 'Kim', 'Garcia', 'Martinez', 'Johnson', 'Williams', 'Brown',
  'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris',
  'Martin', 'Thompson', 'Young', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Adams',
];

const PROFILES = [
  {
    id: 'engineering',
    department: 'Engineering',
    teams: ['Platform', 'Auth', 'Frontend', 'Backend', 'Infrastructure'],
    roles: ['Software Engineer', 'Senior Engineer', 'Staff Engineer', 'Engineering Lead'],
    skills: ['backend', 'frontend', 'node', 'react', 'api', 'infrastructure', 'devops'],
  },
  {
    id: 'data',
    department: 'data engineering',
    teams: ['data science', 'data engineering', 'analytics'],
    roles: ['Data Analyst', 'Data Scientist', 'ML Engineer', 'data science Manager'],
    skills: ['data-science', 'machine-learning', 'data-engineering', 'data-analysis', 'python', 'sql'],
  },
  {
    id: 'legal',
    department: 'Legal',
    teams: ['Legal', 'Compliance'],
    roles: ['Legal Analyst', 'Legal Counsel', 'Compliance Specialist'],
    skills: ['legal', 'compliance', 'contracts', 'intellectual-property', 'research'],
  },
  {
    id: 'security',
    department: 'Security',
    teams: ['Security', 'GRC'],
    roles: ['Security Analyst', 'Security Engineer', 'Security Manager'],
    skills: ['security', 'audit', 'penetration-testing', 'risk', 'compliance'],
  },
  {
    id: 'hr',
    department: 'Human Resources',
    teams: ['Human Resources', 'Talent'],
    roles: ['HR Coordinator', 'Recruiter', 'HR Business Partner'],
    skills: ['human-resources', 'recruiting', 'onboarding', 'employee-relations'],
  },
  {
    id: 'finance',
    department: 'Finance',
    teams: ['Finance', 'Accounting'],
    roles: ['Financial Analyst', 'Accountant', 'Finance Manager'],
    skills: ['finance', 'accounting', 'budgeting', 'forecasting'],
  },
  {
    id: 'marketing',
    department: 'Marketing',
    teams: ['Marketing', 'Content', 'Brand'],
    roles: ['Marketing Specialist', 'Content Strategist', 'Marketing Manager'],
    skills: ['marketing', 'content', 'branding', 'social-media', 'analytics'],
  },
  {
    id: 'ai',
    department: 'AI/ML',
    teams: ['AI', 'ML Platform'],
    roles: ['ML Engineer', 'AI Researcher', 'AI/ML Manager'],
    skills: ['ai', 'machine-learning', 'nlp', 'computer-vision', 'python'],
  },
];

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse hiring requirements from free text or structured fields.
 */
function parseHiringRequirements(input = {}) {
  const text = `${input.title || ''} ${input.description || ''} ${input.requirements || ''}`.toLowerCase();
  const req = {
    profileId: input.profileId || null,
    department: input.department || null,
    team: input.team || null,
    role: input.role || null,
    skills: Array.isArray(input.skills) ? input.skills.map((s) => String(s).toLowerCase()) : [],
    minSkillMatches: 1,
  };

  if (/data\s*science|data\s*scientist|ml\b|machine\s*learning|analytics/.test(text)) {
    req.profileId = 'data';
  } else if (/legal|counsel|compliance|analyst/.test(text) && /legal|case|remediation/.test(text)) {
    req.profileId = 'legal';
  } else if (/security|audit|penetration/.test(text)) {
    req.profileId = 'security';
  } else if (/human resources|recruit|onboard|hr\b/.test(text)) {
    req.profileId = 'hr';
  } else if (/finance|accounting|budget/.test(text)) {
    req.profileId = 'finance';
  } else if (/design|promotional|graphic|creative/.test(text)) {
    req.profileId = 'marketing';
    req.team = req.team || 'Content';
    req.role = req.role || 'Marketing Specialist';
  } else if (/marketing|content|brand/.test(text)) {
    req.profileId = 'marketing';
  } else if (/\bai\b|ml\b|machine learning/.test(text)) {
    req.profileId = 'ai';
  } else if (/engineer|developer|software|backend|frontend|devops/.test(text)) {
    req.profileId = 'engineering';
  }

  if (input.department) req.department = input.department;
  if (input.team) req.team = input.team;
  if (input.role) req.role = input.role;

  const skillHints = text.match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (const hint of skillHints) {
    if (['the', 'and', 'for', 'with', 'project', 'team', 'role'].includes(hint)) continue;
    if (hint.length > 3 && !req.skills.includes(hint)) req.skills.push(hint);
  }

  if (req.skills.length >= 3) req.minSkillMatches = 2;
  return req;
}

function resolveProfile(requirements) {
  if (requirements.profileId) {
    const p = PROFILES.find((x) => x.id === requirements.profileId);
    if (p) return p;
  }
  if (requirements.department) {
    const d = requirements.department.toLowerCase();
    const p = PROFILES.find((x) => x.department.toLowerCase().includes(d) || d.includes(x.department.toLowerCase()));
    if (p) return p;
  }
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

function scoreCandidateMatch(person, requirements) {
  let score = 0;
  const req = requirements;
  if (req.department && person.department?.toLowerCase().includes(req.department.toLowerCase())) {
    score += 25;
  }
  if (req.team && person.team?.toLowerCase().includes(req.team.toLowerCase())) score += 15;
  if (req.role && person.role?.toLowerCase().includes(req.role.toLowerCase().slice(0, 8))) score += 15;

  const personSkills = new Set((person.skills || []).map((s) => s.toLowerCase()));
  let skillHits = 0;
  for (const s of req.skills || []) {
    if ([...personSkills].some((ps) => ps.includes(s) || s.includes(ps))) skillHits += 1;
  }
  score += skillHits * 12;
  if (skillHits >= req.minSkillMatches) score += 20;

  return score;
}

function allocateNextPersonId(existingPeople) {
  let max = 0;
  for (const p of existingPeople || []) {
    const m = String(p.id || '').match(/^person-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `person-${max + 1}`;
}

/**
 * Generate one mock employee (not persisted).
 */
function generateMockEmployee(options = {}) {
  const seed = options.seed != null ? Number(options.seed) : Date.now() + Math.floor(Math.random() * 1e6);
  const rng = mulberry32(seed);
  const requirements = parseHiringRequirements(options);
  const profile = resolveProfile(requirements);
  const existing = options.existingPeople || [];

  const first = options.firstName || pick(FIRST_NAMES, rng);
  const last = options.lastName || pick(LAST_NAMES, rng);
  const name = options.name || `${first} ${last}`;
  const department = requirements.department || profile.department;
  const team = requirements.team || pick(profile.teams, rng);
  const role = requirements.role || pick(profile.roles, rng);

  const skillPool = [...new Set([...profile.skills, ...(requirements.skills || [])])];
  const skillCount = 3 + Math.floor(rng() * 3);
  const skills = [];
  while (skills.length < skillCount && skillPool.length > 0) {
    const s = pick(skillPool, rng);
    if (!skills.includes(s)) skills.push(s);
  }

  const id = options.id || allocateNextPersonId(existing);

  const person = {
    id,
    name,
    department,
    team,
    role,
    skills,
    currentLoad: 0,
    availabilityStatus: 'active',
  };

  return {
    person,
    requirements,
    matchScore: scoreCandidateMatch(person, requirements),
    profileId: profile.id,
    seed,
  };
}

/**
 * Generate candidates until one meets minimum match score (for AI/HR hire).
 */
function generateMockEmployeeForRequirements(options = {}) {
  const minScore = options.minMatchScore ?? 35;
  const maxAttempts = options.maxAttempts ?? 12;
  let best = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    const generated = generateMockEmployee({
      ...options,
      seed: (options.seed || Date.now()) + i * 997,
    });
    if (!best || generated.matchScore > best.matchScore) best = generated;
    if (generated.matchScore >= minScore) return generated;
  }

  return best;
}

module.exports = {
  PROFILES,
  parseHiringRequirements,
  scoreCandidateMatch,
  allocateNextPersonId,
  generateMockEmployee,
  generateMockEmployeeForRequirements,
};
