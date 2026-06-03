/**
 * Team Builder AI: selects people by skill match, current load, project relevance.
 * Must provide rationale for every assignment. Uses OpenAI when OPENAI_API_KEY is set; otherwise stub.
 */

const { readPrompt, complete, OLLAMA_TOOLS } = require('../lib/llm');

// --- Task type classification (for deterministic assignment) ---
const TASK_TYPES = Object.freeze({
  AUTH_BACKEND: 'auth_backend',   // login, oauth, auth → backend/auth engineer only
  UI_FRONTEND: 'ui_frontend',     // ui, design, frontend → frontend engineer preferred
  API_OR_TEST: 'api_or_test',     // api, test → backend/fullstack
  AI_ML: 'ai_ml',                 // ml, model, data-science → AI department only
  GOTOMARKET: 'gotomarket',       // ads, campaign, sales, marketing
  OTHER: 'other',
});

/**
 * Classify task into one of TASK_TYPES using keyword precedence (first match wins).
 * Auth/OAuth/login must not be treated as AI_ML so AI Manager is never chosen for login.
 */
function classifyTask(combined) {
  const t = combined.toLowerCase();
  if (/\b(oauth|auth|login|sso|identity|session)\b/.test(t) && !/\b(model|ml|machine|data-science)\b/.test(t)) {
    return TASK_TYPES.AUTH_BACKEND;
  }
  if (/\b(ui|ux|frontend|interface|redesign|design)\b/.test(t)) {
    return TASK_TYPES.UI_FRONTEND;
  }
  if (/\b(api|test|testing)\b/.test(t)) {
    return TASK_TYPES.API_OR_TEST;
  }
  if (/\b(ai|machine learning|ml|model|data-science|ai-engineering)\b/.test(t) &&
      /\b(ad|ads|targeting|campaign|marketing|sales)\b/.test(t)) {
    return TASK_TYPES.AI_ML;
  }
  if (/\b(ai|machine learning|ml|model|data-science)\b/.test(t)) {
    return TASK_TYPES.AI_ML;
  }
  if (/\b(ad|ads|advertising|campaign|brand|branding|marketing|sales|audience)\b/.test(t)) {
    return TASK_TYPES.GOTOMARKET;
  }
  return TASK_TYPES.OTHER;
}

/**
 * Derive a person's primary profiles from role + skills (set of TASK_TYPES they fit).
 */
function personProfiles(p) {
  const role = (p.role || '').toLowerCase();
  const dept = (p.department || '').toLowerCase();
  const skills = (p.skills || []).map((s) => String(s).toLowerCase());
  const has = (keywords) => keywords.some((k) => role.includes(k) || skills.some((s) => s.includes(k) || k.includes(s)));
  const profiles = new Set();
  if (has(['auth', 'backend', 'api', 'node']) || dept === 'engineering') {
    if (has(['auth', 'oauth', 'backend', 'api'])) profiles.add(TASK_TYPES.AUTH_BACKEND);
    if (has(['api', 'backend', 'node']) || has(['fullstack'])) profiles.add(TASK_TYPES.API_OR_TEST);
  }
  if (has(['frontend', 'react', 'design-systems', 'ui', 'ux'])) {
    profiles.add(TASK_TYPES.UI_FRONTEND);
  }
  if (has(['fullstack', 'node', 'react'])) {
    profiles.add(TASK_TYPES.API_OR_TEST);
    if (!profiles.has(TASK_TYPES.UI_FRONTEND) && has(['react'])) profiles.add(TASK_TYPES.UI_FRONTEND);
  }
  if (dept.includes('ai') || has(['ai', 'machine-learning', 'data-science', 'ai-engineering'])) {
    profiles.add(TASK_TYPES.AI_ML);
  }
  if (dept === 'marketing' || dept === 'sales' || has(['marketing', 'branding', 'sales'])) {
    profiles.add(TASK_TYPES.GOTOMARKET);
  }
  return profiles;
}

/** Weighted scoring: taskType vs person profile and department. */
const WEIGHTS = {
  profileMatch: 50,
  profileMismatchAuthVsAi: -80,
  profileMismatchTechnical: -50,
  departmentEngineering: 20,
  departmentAi: 15,
  departmentNonTech: -60,
  skillTokenMatch: 8,
  frontendPrimaryBonus: 25,
  backendPrimaryBonus: 25,
  loadPenaltyPerUnit: 2,
  alreadyAssignedPenalty: 15,
};

function normalizeDept(value) {
  return (value || '').toString().toLowerCase().trim();
}

function normalizeRequiredDepartments(task) {
  if (!task) return [];
  const raw =
    Array.isArray(task.requiredDepartments) && task.requiredDepartments.length > 0
      ? task.requiredDepartments
      : Array.isArray(task.preferredDepartments) && task.preferredDepartments.length > 0
        ? task.preferredDepartments
        : Array.isArray(task.required_departments) && task.required_departments.length > 0
          ? task.required_departments
          : [];
  return raw.map(normalizeDept).filter(Boolean);
}

/**
 * Narrow candidate people by task.requiredDepartments when provided.
 * Falls back gracefully to the full pool if no departments match.
 */
function filterPeopleByRequiredDepartments(task, people) {
  if (!people || people.length === 0) {
    return { people: [], note: null };
  }
  const required = normalizeRequiredDepartments(task);
  if (required.length === 0) {
    return { people, note: null };
  }

  const matches = people.filter((p) => {
    const dept = normalizeDept(p.department);
    if (!dept) return false;
    return required.some((req) => dept === req || dept.includes(req) || req.includes(dept));
  });

  if (matches.length > 0) {
    const labels = [...new Set(matches.map((p) => p.department).filter(Boolean))];
    return {
      people: matches,
      note: labels.length > 0 ? `filtered to departments: ${labels.join(', ')}` : 'filtered by requiredDepartments',
    };
  }

  // Graceful widening: use full pool if no one matched.
  return { people, note: 'requiredDepartments provided but no department match; using full pool' };
}

/**
 * Stub assignment using task-type classification and profile-based scoring (no LLM).
 */
function stubAssign(task, people, projectContext = null, options = {}) {
  if (!people || people.length === 0) {
    return { personId: null, rationale: 'No people available.' };
  }

  const projectTitle = (projectContext?.title || '').toLowerCase();
  const taskTitle = (task?.title || '').toLowerCase();
  const taskDesc = (task?.description || '').toLowerCase();
  const combined = `${projectTitle} ${taskTitle} ${taskDesc}`;
  const taskType = classifyTask(combined);

  const assignCount = new Map();
  const tasks = projectContext?.progress?.tasks || [];
  for (const t of tasks) {
    const id = t?.assigneeId != null ? String(t.assigneeId) : null;
    if (id) assignCount.set(id, (assignCount.get(id) || 0) + 1);
  }
  const runMap = options?.assignedInRun || {};
  for (const [id, count] of Object.entries(runMap)) {
    if (id && count > 0) assignCount.set(id, (assignCount.get(id) || 0) + count);
  }

  const tokens = combined.split(/[^a-z0-9+.#_-]+/i).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);

  function scorePerson(p) {
    const dept = (p.department || '').toLowerCase();
    const role = (p.role || '').toLowerCase();
    const skills = (p.skills || []).map((s) => String(s).toLowerCase());
    const profiles = personProfiles(p);

    let score = 0;
    const matchedSkills = [];

    if (taskType === TASK_TYPES.AUTH_BACKEND) {
      if (dept.includes('ai')) {
        score += WEIGHTS.profileMismatchAuthVsAi;
      } else if (profiles.has(TASK_TYPES.AUTH_BACKEND)) {
        score += WEIGHTS.profileMatch;
      } else if (dept === 'engineering' && (profiles.has(TASK_TYPES.API_OR_TEST) || skills.some((s) => s.includes('api') || s.includes('node')))) {
        score += WEIGHTS.profileMatch * 0.6;
      } else if (!dept.includes('engineering')) {
        score += WEIGHTS.departmentNonTech;
      }
      if (skills.some((s) => /auth|oauth|api|backend/.test(s)) || role.includes('backend')) {
        score += WEIGHTS.backendPrimaryBonus;
      }
    } else if (taskType === TASK_TYPES.UI_FRONTEND) {
      if (profiles.has(TASK_TYPES.UI_FRONTEND)) {
        score += WEIGHTS.profileMatch;
      } else if (dept !== 'engineering' && !dept.includes('ai')) {
        score += WEIGHTS.departmentNonTech;
      }
      const hasFrontendPrimary = skills.some((s) => /frontend|design-systems|ui|ux/.test(s)) || role.includes('frontend');
      const hasReactOnly = skills.some((s) => s.includes('react')) && !hasFrontendPrimary;
      if (hasFrontendPrimary) score += WEIGHTS.frontendPrimaryBonus;
      else if (hasReactOnly) score += WEIGHTS.frontendPrimaryBonus * 0.5;
    } else if (taskType === TASK_TYPES.API_OR_TEST) {
      if (dept.includes('ai') && !profiles.has(TASK_TYPES.API_OR_TEST)) {
        score += WEIGHTS.profileMismatchTechnical;
      } else if (profiles.has(TASK_TYPES.API_OR_TEST) || profiles.has(TASK_TYPES.AUTH_BACKEND)) {
        score += WEIGHTS.profileMatch;
      }
      if (skills.some((s) => /api|backend|node/.test(s)) || role.includes('backend') || role.includes('fullstack')) {
        score += WEIGHTS.backendPrimaryBonus;
      }
    } else if (taskType === TASK_TYPES.AI_ML) {
      if (profiles.has(TASK_TYPES.AI_ML)) score += WEIGHTS.profileMatch;
      if (dept.includes('ai')) score += WEIGHTS.departmentAi;
      if (['marketing', 'hr', 'finance', 'legal', 'sales'].some((d) => dept.includes(d))) {
        score += WEIGHTS.departmentNonTech;
      }
    } else if (taskType === TASK_TYPES.GOTOMARKET) {
      if (dept === 'marketing' || dept === 'sales' || role.includes('marketing') || role.includes('sales')) {
        score += WEIGHTS.profileMatch;
      }
    } else {
      if (dept === 'engineering' || dept.includes('ai')) score += WEIGHTS.departmentEngineering;
      else if (['marketing', 'hr', 'finance', 'legal', 'sales'].some((d) => dept.includes(d))) {
        score += WEIGHTS.departmentNonTech;
      }
    }

    for (const s of skills) {
      for (const tok of tokens) {
        if (s.includes(tok) || tok.includes(s)) {
          matchedSkills.push(s);
          score += WEIGHTS.skillTokenMatch;
          break;
        }
      }
    }

    const load = Number.isFinite(p.currentLoad) ? p.currentLoad : 0;
    const alreadyAssigned = assignCount.get(p.id) || 0;
    score -= load * WEIGHTS.loadPenaltyPerUnit + alreadyAssigned * WEIGHTS.alreadyAssignedPenalty;

    return {
      score,
      matchedSkills: [...new Set(matchedSkills)].slice(0, 5),
      load,
      alreadyAssigned,
    };
  }

  const candidates = people.map((p) => ({ p, meta: scorePerson(p) }));
  candidates.sort((a, b) => b.meta.score - a.meta.score);
  const best = candidates[0];
  if (!best) {
    return { personId: people[0].id, rationale: `Assigned to ${people[0].name || people[0].id} (fallback).` };
  }

  const { p: chosen, meta } = best;
  const parts = [];
  if (meta.matchedSkills.length > 0) parts.push(`skills (${meta.matchedSkills.join(', ')})`);
  parts.push(`load ${meta.load}`);
  if (meta.alreadyAssigned > 0) parts.push(`${meta.alreadyAssigned} task(s) this run`);

  return {
    personId: chosen.id,
    rationale: `Assigned to ${chosen.name || chosen.id} based on ${parts.join('; ')}.`,
  };
}

/**
 * Given a task and available people (and optionally project context), returns best-fit person and rationale.
 * @param {object} task - { id, title?, description? }
 * @param {object[]} people - List of { id, skills?, currentLoad?, ... }
 * @param {object} [projectContext] - Current project state
 * @param {{ assignedInRun?: Record<string, number>, agentContext?: object }} [options] - assignedInRun; agentContext from RAG (peopleStats, projectSnapshot)
 * @returns {Promise<{ personId: string|null, rationale: string }>}
 */
function peopleAvailableForAssignment(people) {
  return (people || []).filter((p) => {
    const s = p.availabilityStatus || 'active';
    return s === 'active' || s === 'emergency_active';
  });
}

async function assignTask(task, people, projectContext = null, options = {}) {
  const availablePeople = peopleAvailableForAssignment(people);
  if (!availablePeople || availablePeople.length === 0) {
    const stub = stubAssign(task, people, projectContext, options);
    return { ...stub, _usedStub: true };
  }

  const { people: filteredPeople, note: filterNote } = filterPeopleByRequiredDepartments(task, availablePeople);
  const effectivePeople = filteredPeople && filteredPeople.length > 0 ? filteredPeople : availablePeople;

  const systemPrompt = readPrompt('teamBuilder');
  if (!systemPrompt) {
    const stub = stubAssign(task, effectivePeople, projectContext, options);
    return { ...stub, _usedStub: true };
  }

  const userMessage = JSON.stringify(
    {
      task: task || {},
      people: effectivePeople.map((p) => ({
        id: p.id,
        name: p.name,
        department: p.department,
        team: p.team,
        role: p.role,
        skills: p.skills || [],
        currentLoad: p.currentLoad ?? 0,
      })),
      projectContext: projectContext
        ? {
            title: projectContext.title,
            department: projectContext.department,
            team: projectContext.team,
            taskCount: projectContext.progress?.tasks?.length ?? 0,
          }
        : null,
      assignmentContext: {
        requiredDepartments: normalizeRequiredDepartments(task),
        filterNote: filterNote || undefined,
      },
      agentContext: options.agentContext
        ? {
            peopleStats: options.agentContext.peopleContext?.peopleStats,
            currentTaskCount: options.agentContext.projectSnapshot?.progress?.tasks?.length,
          }
        : null,
    },
    null,
    2
  );

  const defaultTimeoutMs =
    String(process.env.LLM_PROVIDER || '').toLowerCase() === 'ollama' ? 60000 : 2500;
  const timeoutMs = Number(process.env.AGENT_LLM_TIMEOUT_MS || defaultTimeoutMs);
  const out = await complete(systemPrompt, userMessage, {
    timeoutMs,
    tools: OLLAMA_TOOLS.teamBuilder,
    agent: 'team_builder',
    projectId: projectContext?.id || undefined,
    context: {
      kind: 'assignTask',
      taskId: task?.id,
    },
  });
  const rationale = typeof out?.rationale === 'string'
    ? out.rationale.trim()
    : typeof out?.reason === 'string'
      ? out.reason.trim()
      : typeof out?.explanation === 'string'
        ? out.explanation.trim()
        : null;
  const validIds = new Set(effectivePeople.map((p) => p.id));
  let rawId = out?.personId ?? out?.person_id ?? out?.assigneeId ?? out?.assignee_id;
  let personId =
    rawId != null && String(rawId).trim() !== '' && validIds.has(String(rawId).trim())
      ? (typeof rawId === 'string' ? rawId.trim() : rawId)
      : null;

  // If LLM returned structure but null/empty personId, try to infer from rationale (e.g. "Assigned to Alex Rivera")
  if (!personId && rationale && effectivePeople.length > 0) {
    const lowerRationale = rationale.toLowerCase();
    const byName = effectivePeople.filter((p) => {
      const name = (p.name || '').trim();
      if (!name) return false;
      const parts = name.split(/\s+/).filter(Boolean);
      const fullMatch = lowerRationale.includes(name.toLowerCase());
      const partMatches = parts.filter((part) => part.length >= 2 && lowerRationale.includes(part.toLowerCase()));
      return fullMatch || partMatches.length >= Math.min(2, parts.length);
    });
    if (byName.length === 1) {
      personId = byName[0].id;
    } else if (byName.length > 1) {
      // Multiple matches: prefer first mentioned in rationale (earliest index)
      let best = byName[0];
      let bestIdx = lowerRationale.indexOf((best.name || '').toLowerCase());
      for (const p of byName.slice(1)) {
        const idx = lowerRationale.indexOf((p.name || '').toLowerCase());
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          best = p;
          bestIdx = idx;
        }
      }
      personId = best.id;
    } else {
      // Single-word match: e.g. "Assigned to Alex"
      for (const p of effectivePeople) {
        const first = (p.name || '').trim().split(/\s+/)[0];
        if (first && first.length >= 2 && lowerRationale.includes(first.toLowerCase())) {
          const others = effectivePeople.filter((q) => (q.name || '').includes(first));
          if (others.length === 1) {
            personId = p.id;
            break;
          }
        }
      }
    }
  }

  // If we have personId but task has requiredDepartments and person doesn't match, pick best match from required depts (don't stub)
  if (personId && personId !== null) {
    const required = normalizeRequiredDepartments(task);
    if (required.length > 0) {
      const person = effectivePeople.find((p) => p.id === personId);
      const dept = person ? normalizeDept(person.department) : '';
      const match = dept && required.some((req) => dept === req || dept.includes(req) || req.includes(dept));
      if (!match) {
        const fromDept = effectivePeople.filter((p) => {
          const d = normalizeDept(p.department);
          return d && required.some((req) => d === req || d.includes(req) || req.includes(d));
        });
        if (fromDept.length > 0) {
          const stubPick = stubAssign(task, fromDept, projectContext, options);
          if (stubPick.personId) {
            personId = stubPick.personId;
          }
        }
      }
    }
  }
  if (personId && (!rationale || rationale.length === 0)) {
    return { personId, rationale: 'Assigned by AI based on skills and load.', _usedStub: false };
  }
  // Only stub when LLM truly returned no valid response or we still have no personId after all normalization
  if (!out || !personId) {
    const stub = stubAssign(task, effectivePeople, projectContext, options);
    return { ...stub, _usedStub: true, _failReason: !out ? 'timed_out_or_no_response' : 'invalid_person_id' };
  }

  return {
    personId,
    rationale: rationale || (personId ? 'Assigned by AI.' : 'No suitable assignee; see rationale.'),
    _usedStub: false,
  };
}

module.exports = { assignTask, stubAssign };
