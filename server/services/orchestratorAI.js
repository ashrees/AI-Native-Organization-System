/**
 * Orchestrator AI: breaks high-level requests into sub-tasks, estimates risk and impact.
 * Outputs a structured plan (JSON), not prose. Uses OpenAI when OPENAI_API_KEY is set; otherwise stub.
 */

const { readPrompt, complete, OLLAMA_TOOLS } = require('../lib/llm');
const { RISK_LEVELS } = require('../models/eventSchema');

/**
 * Stub plan when LLM is unavailable or fails.
 * Risk and impact are derived from request content (auth, security, deploy, scope).
 */
function stubPlan(requestPayload) {
  const titleRaw = (requestPayload?.title || '').trim();
  const descRaw = (requestPayload?.description || '').trim();
  const text = `${titleRaw}\n${descRaw}`.toLowerCase();

  const mk = (id, title, description, extra) => ({
    id,
    title,
    description: description || undefined,
    ...(extra || {}),
  });

  const tasks = [];
  const base = Date.now().toString(36);
  const add = (title, description) => tasks.push(mk(`task-${base}-${tasks.length + 1}`, title, description));
  const addWithReq = (title, description, requiredDepartments) =>
    tasks.push(
      mk(`task-${base}-${tasks.length + 1}`, title, description, {
        requiredDepartments: Array.isArray(requiredDepartments) ? requiredDepartments : undefined,
      })
    );

  const has = (...words) => words.some((w) => text.includes(w));
  const hasAll = (groupA, groupB) =>
    groupA.some((w) => text.includes(w)) && groupB.some((w) => text.includes(w));

  if (has('deploy', 'release', 'beta', 'ship', 'rollout')) {
    add('Confirm scope & freeze changes', 'Identify what is included in the beta and cut a release branch/tag.');
    add('Run checks & smoke tests', 'Run lint/tests/build; do a quick end-to-end smoke pass.');
    add('Prepare release notes', 'Summarize changes, known issues, and rollback steps.');
    add('Deploy to staging', 'Deploy and validate on staging with monitoring enabled.');
    add('Deploy beta to production', 'Roll out gradually if possible; verify key metrics.');
    add('Monitor & handle rollback', 'Watch errors/latency; be ready to revert quickly.');
  } else if (has('replan', 'repriorit', 'priority', 'backlog', 'roadmap')) {
    add('Review current work and constraints', 'Capture what is in-progress, blocked, and deadlines.');
    add('Re-rank tasks by impact and urgency', 'Reprioritize based on business value, risk, and dependencies.');
    add('Update plan and communicate changes', 'Update the project plan and notify stakeholders.');
  } else if (has('optimiz', 'performance', 'slow', 'latency')) {
    add('Profile and identify bottlenecks', 'Measure hot paths and slow endpoints/components.');
    add('Apply targeted optimizations', 'Fix the top 1–3 bottlenecks (queries, rendering, caching).');
    add('Validate with before/after metrics', 'Confirm improvements and ensure no regressions.');
  } else if (
    // AI / ML work specifically for ads / campaigns / targeting → cross-functional plan
    hasAll(['ai', 'machine learning', 'ml', 'model', 'models'], [
      'ad',
      'ads',
      'advertising',
      'targeting',
      'campaign',
      'marketing',
      'sales',
    ])
  ) {
    addWithReq(
      'Clarify ad-targeting goals and constraints',
      'Work with Sales/Marketing to define audiences, success metrics, guardrails, and compliance requirements.',
      ['Marketing', 'Sales']
    );
    addWithReq(
      'Design ad-targeting ML model',
      'Select features, model family, and evaluation approach for the ad-targeting problem.',
      ['AI', 'data science']
    );
    addWithReq(
      'Prepare and label training data for ad targeting',
      'Partner with data/AI teams to pull historical campaign data, clean it, and label positive/negative outcomes.',
      ['AI', 'data science', 'data engineering']
    );
    addWithReq(
      'Integrate model into ad delivery flow and run pilot',
      'Ship the model behind a feature flag, run an A/B test, and compare lift against current targeting.',
      ['Engineering', 'AI']
    );
  } else if (titleRaw) {
    add(titleRaw, descRaw || 'Break down the request into concrete, testable steps.');
    add('Define acceptance criteria', 'List what "done" means and how we\'ll verify it.');
    add('Implement and validate', 'Execute the work and verify in the UI/API.');
  } else {
    add('Clarify request', 'Missing title; ask for goal, constraints, and success criteria.');
  }

  // Risk from analysis: auth/security/payment/production/deploy increase risk
  const riskKeywords = ['payment', 'billing', 'auth', 'oauth', 'login', 'security', 'prod', 'production', 'deploy', 'data', 'compliance'];
  const riskScore = riskKeywords.filter((w) => text.includes(w)).length;
  const riskLevel = riskScore >= 2 ? 'high' : riskScore >= 1 ? 'medium' : 'low';

  // Impact from scope and domain
  const impactKeywords = ['deploy', 'release', 'prod', 'production'];
  const impactLevel = impactKeywords.some((w) => text.includes(w)) ? 'high' : tasks.length > 4 ? 'medium' : 'medium';

  return {
    tasks,
    riskLevel: RISK_LEVELS.includes(riskLevel) ? riskLevel : 'low',
    impactLevel: ['low', 'medium', 'high'].includes(impactLevel) ? impactLevel : 'medium',
    summary: titleRaw
      ? `Plan for: ${titleRaw} (${tasks.length} tasks).`
      : `Plan created (${tasks.length} tasks).`,
    needs: [],
  };
}

/**
 * Given a request payload and optional project context and RAG context, returns a structured plan.
 * @param {object} requestPayload - { title, description?, priority?, requestedBy? }
 * @param {object} [projectContext] - Current project state for context
 * @param {object} [agentContext] - RAG context: { projectSnapshot, recentEvents, peopleContext, metricsSummary, extra }
 * @returns {Promise<{ tasks: Array<...>, riskLevel?: string, impactLevel?: string, summary?: string }>}
 */
async function createPlan(requestPayload, projectContext = null, agentContext = null) {
  const systemPrompt = readPrompt('orchestrator');
  if (!systemPrompt) {
    const stub = stubPlan(requestPayload);
    return { ...stub, _usedStub: true, _failReason: 'no_prompt' };
  }

  const userMessage = JSON.stringify(
    {
      request: requestPayload || {},
      existingProject: projectContext
        ? {
            title: projectContext.title,
            status: projectContext.status,
            taskCount: projectContext.progress?.tasks?.length ?? 0,
            risk: projectContext.risk?.level,
          }
        : null,
      agentContext: agentContext || null,
    },
    null,
    2
  );

  const defaultTimeoutMs =
    String(process.env.LLM_PROVIDER || '').toLowerCase() === 'ollama' ? 60000 : 2500;
  const timeoutMs = Number(process.env.AGENT_LLM_TIMEOUT_MS || defaultTimeoutMs);
  const out = await complete(systemPrompt, userMessage, {
    timeoutMs,
    tools: OLLAMA_TOOLS.orchestrator,
    agent: 'orchestrator',
    projectId: projectContext?.id || undefined,
    context: {
      kind: 'createPlan',
    },
  });

  // --- Normalize: extract tasks from any structure so LLM output is never rejected for shape ---
  let tasks = Array.isArray(out?.tasks)
    ? out.tasks
    : Array.isArray(out?.plan?.tasks)
      ? out.plan.tasks
      : Array.isArray(out?.subtasks)
        ? out.subtasks
        : Array.isArray(out?.task_list)
          ? out.task_list
          : null;
  if (!tasks && out && typeof out === 'object') {
    const firstArray = Object.values(out).find((v) => Array.isArray(v) && v.length > 0);
    if (firstArray && firstArray.every((t) => t && typeof t === 'object' && (t.title != null || t.name != null || t.task != null))) {
      tasks = firstArray;
    }
  }

  if (!out) {
    const stub = stubPlan(requestPayload);
    return { ...stub, _usedStub: true, _failReason: 'timed_out_or_no_response' };
  }
  if (!tasks || tasks.length === 0) {
    const stub = stubPlan(requestPayload);
    return { ...stub, _usedStub: true, _failReason: 'invalid_plan' };
  }
  // Strip projectId from tasks instead of rejecting (LLM must not fail for this)
  const tasksClean = tasks.map((t) => {
    if (t == null || typeof t !== 'object') return t;
    const { projectId: _p, ...rest } = t;
    return rest;
  });
  tasks = tasksClean;

  // Normalize: ensure riskLevel/impactLevel are valid enums
  const riskLevel = RISK_LEVELS.includes(out.riskLevel) ? out.riskLevel : 'low';
  const impactLevel = ['low', 'medium', 'high'].includes(out.impactLevel) ? out.impactLevel : 'medium';

  const needs = Array.isArray(out.needs)
    ? out.needs.filter((n) => n && (n.kind || n.description))
    : [];

  return {
    tasks: tasks.map((t) => ({
      id: t.id || t.task_id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: t.title || t.name || t.task || 'Unnamed task',
      description: t.description != null ? t.description : t.desc,
      // Preserve any explicit department hints from the model or stub so Team Builder can filter candidates.
      requiredDepartments: Array.isArray(t.requiredDepartments)
        ? t.requiredDepartments
        : Array.isArray(t.preferredDepartments)
          ? t.preferredDepartments
          : Array.isArray(t.required_departments)
            ? t.required_departments
            : undefined,
    })),
    riskLevel,
    impactLevel,
    summary: typeof out.summary === 'string' ? out.summary : '',
    needs: needs.map((n) => ({
      kind: n.kind || 'general',
      description: typeof n.description === 'string' ? n.description : String(n.description || ''),
      taskId: n.taskId || n.task_id || undefined,
    })),
    _usedStub: false,
  };
}

module.exports = { createPlan, stubPlan };
