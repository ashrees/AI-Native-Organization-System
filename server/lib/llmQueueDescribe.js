/**
 * Human-readable labels for LLM queue monitor (streams, status, activity log).
 */

const AGENT_LABELS = {
  orchestrator: 'Orchestrator',
  team_builder: 'Team Builder',
  scheduler: 'Scheduler',
  project_ai: 'Project AI',
  org_ai: 'Org AI',
  ai_handler: 'AI Handler',
  mock_worker: 'Worker NPCs',
  help_chat: 'Help chat',
  system: 'System',
  llm: 'LLM',
};

const CONTEXT_ACTIONS = {
  createPlan: 'Create project plan',
  assignTask: 'Assign task to teammate',
  proposeSchedule: 'Propose schedule',
  project_assessment: 'Assess project health',
  help_chat: 'Answer help question',
  org_insights: 'Org-wide insights',
};

function agentLabel(agent) {
  if (!agent) return 'Unknown agent';
  const key = String(agent).replace(/^help_/, '');
  return AGENT_LABELS[key] || AGENT_LABELS[agent] || String(agent).replace(/_/g, ' ');
}

function parseContext(ctx) {
  if (ctx == null || ctx === '') return { action: null, taskId: null, raw: null };
  if (typeof ctx === 'string') {
    try {
      const parsed = JSON.parse(ctx);
      if (parsed && typeof parsed === 'object') return parseContext(parsed);
    } catch {
      /* plain string */
    }
    return {
      action: CONTEXT_ACTIONS[ctx] || ctx.replace(/_/g, ' '),
      taskId: null,
      raw: ctx,
    };
  }
  if (typeof ctx === 'object') {
    const kind = ctx.kind || ctx.phase || ctx.label || ctx.context;
    let action = kind ? CONTEXT_ACTIONS[kind] || String(kind).replace(/_/g, ' ') : null;
    const taskId = ctx.taskId || ctx.task_id || null;
    if (taskId && action) action += ` (task ${taskId})`;
    else if (taskId) action = `Task ${taskId}`;
    return { action, taskId, raw: kind || null };
  }
  return { action: null, taskId: null, raw: null };
}

function projectName(projects, projectId) {
  if (!projectId) return null;
  return projects?.[projectId]?.title || projectId;
}

function extractInputHint(userMessage) {
  if (!userMessage) return null;
  const raw = String(userMessage);
  try {
    const j = JSON.parse(raw);
    if (j.existingProject?.title) {
      const n = j.existingProject.taskCount;
      return `Planning for “${j.existingProject.title}”${n != null ? ` (${n} tasks)` : ''}`;
    }
    if (j.trigger && typeof j.trigger === 'object') {
      const parts = [];
      if (j.trigger.type) parts.push(String(j.trigger.type).replace(/_/g, ' '));
      if (j.trigger.status) parts.push(j.trigger.status);
      if (j.trigger.source) parts.push(`via ${j.trigger.source}`);
      const trig = parts.length ? parts.join(' · ') : 'event';
      const t = j.metrics?.title || j.metrics?.projectId;
      return t ? `Assessment (${trig}) · ${t}` : `Assessment (${trig})`;
    }
    if (j.trigger) return `Trigger: ${String(j.trigger).replace(/_/g, ' ')}`;
    if (j.request?.title) return `Request: ${j.request.title}`;
    if (j.request?.type) return `Request type: ${j.request.type}`;
    if (Array.isArray(j.tasks) && j.tasks.length) {
      const first = j.tasks[0]?.title || j.tasks[0]?.id;
      return first
        ? `Scheduling ${j.tasks.length} task(s), e.g. “${first}”`
        : `Scheduling ${j.tasks.length} task(s)`;
    }
    if (j.task?.title) return `Task: “${j.task.title}”`;
    if (j.task?.id) return `Task ${j.task.id}`;
    if (j.agentContext?.projectSnapshot?.title) {
      return `Project: ${j.agentContext.projectSnapshot.title}`;
    }
    if (j.projects?.length === 1 && j.projects[0]?.title) {
      return `Org view: ${j.projects[0].title}`;
    }
    if (j.message) return `Question: ${String(j.message).slice(0, 100)}`;
  } catch {
    /* not JSON */
  }
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed.length > 24) return `Input: ${trimmed.slice(0, 140)}${trimmed.length > 140 ? '…' : ''}`;
  return null;
}

function promptPurpose(systemPrompt) {
  if (!systemPrompt) return null;
  const line = String(systemPrompt).split('\n').find((l) => l.trim().length > 12);
  if (!line) return null;
  const t = line.trim().slice(0, 160);
  return t.length > 20 ? `Prompt: ${t}${line.length > 160 ? '…' : ''}` : null;
}

/**
 * @param {object} meta - agent, context, projectId, projectTitle, taskId, provider, model, error, userMessage, systemPrompt
 * @param {object} [projects]
 */
function describeLlmWork(meta = {}, projects = {}) {
  const agent = meta.agent || null;
  const { action, taskId: ctxTaskId } = parseContext(meta.context);
  const taskId = meta.taskId || ctxTaskId || null;
  const projTitle =
    meta.projectTitle || projectName(projects, meta.projectId) || meta.projectId || null;

  const parts = [agentLabel(agent)];
  if (action) parts.push(action);
  if (projTitle) parts.push(`“${projTitle}”`);
  else if (meta.projectId) parts.push(meta.projectId);
  if (taskId && !action?.includes(String(taskId))) parts.push(`task ${taskId}`);

  const provider = meta.provider && meta.provider !== 'auto' ? meta.provider : null;
  const model = meta.model || null;
  if (model) parts.push(model);
  else if (provider) parts.push(provider);

  let rationale =
    meta.error != null && meta.error !== ''
      ? `Error: ${String(meta.error).slice(0, 220)}`
      : extractInputHint(meta.userMessage) || promptPurpose(meta.systemPrompt) || null;

  if (!rationale && meta.waiting > 0) {
    rationale = `${meta.waiting} caller(s) waiting for the model lock`;
  }

  return {
    summary: parts.filter(Boolean).join(' · ').slice(0, 200) || 'LLM call',
    rationale: rationale ? String(rationale).slice(0, 500) : null,
    agent,
    agentDisplay: agentLabel(agent),
    action,
    projectId: meta.projectId || null,
    projectTitle: projTitle,
    taskId,
  };
}

/** Short label for lock holder (status chip, live segment). */
function describeLockHolder(meta = {}, projects = {}) {
  const d = describeLlmWork(meta, projects);
  const waiting = meta.waiting || 0;
  if (waiting > 0 && !meta.busy) {
    return {
      summary: `Waiting (${waiting} in queue)`,
      rationale: meta.blockedBy
        ? `Behind ${agentLabel(meta.blockedBy)}`
        : d.rationale,
    };
  }
  return { summary: d.summary, rationale: d.rationale };
}

module.exports = {
  AGENT_LABELS,
  agentLabel,
  parseContext,
  describeLlmWork,
  describeLockHolder,
  extractInputHint,
};
