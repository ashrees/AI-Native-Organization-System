/**
 * Scheduler AI: proposes timelines and task ordering.
 * Respects availability (mocked for MVP). Uses OpenAI when OPENAI_API_KEY is set; otherwise stub.
 */

const { readPrompt, complete, OLLAMA_TOOLS } = require('../lib/llm');

/**
 * Stub schedule when LLM is unavailable or fails: sequential one-day slots.
 * Rationale is user-facing (no technical "fallback" wording).
 */
function stubSchedule(tasks) {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  const nextByAssignee = new Map();
  let globalNext = new Date(now.getTime() + dayMs);

  return (tasks || []).map((t, i) => {
    const assigneeId = t?.assigneeId != null ? String(t.assigneeId) : null;
    const baseStart = assigneeId && nextByAssignee.has(assigneeId) ? nextByAssignee.get(assigneeId) : globalNext;
    const start = new Date(baseStart.getTime());
    const end = new Date(start.getTime() + dayMs);

    if (assigneeId) nextByAssignee.set(assigneeId, new Date(end.getTime() + dayMs));
    globalNext = new Date(globalNext.getTime() + dayMs);

    const title = t?.title ? t.title : 'Task';
    const rationale = `Sequential schedule: 1-day slot for “${title}”.`;

    return {
      taskId: t.id,
      proposedStart: start.toISOString(),
      proposedEnd: end.toISOString(),
      rationale,
    };
  });
}

/**
 * Given a list of tasks (with optional assignees), returns proposed start/end per task.
 * @param {object[]} tasks - Array of { id, title?, assigneeId? }
 * @param {object} [options] - { availability?: mock calendar, agentContext?: RAG context }
 * @returns {Promise<Array<{ taskId: string, proposedStart: string, proposedEnd: string, rationale?: string }>>}
 */
async function proposeSchedule(tasks, options = {}) {
  if (!tasks || tasks.length === 0) return { proposals: [], _usedStub: true, _failReason: 'no_tasks' };

  const systemPrompt = readPrompt('scheduler');
  if (!systemPrompt) return { proposals: stubSchedule(tasks), _usedStub: true, _failReason: 'no_prompt' };

  const agentContext = options.agentContext || null;
  const userMessage = JSON.stringify(
    {
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, assigneeId: t.assigneeId })),
      availability: options.availability || null,
      agentContext: agentContext
        ? {
            projectSnapshot: agentContext.projectSnapshot
              ? { risk: agentContext.projectSnapshot.risk, blockers: agentContext.projectSnapshot.blockers }
              : null,
            recentEvents: (agentContext.recentEvents || []).slice(-5),
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
    tools: OLLAMA_TOOLS.scheduler,
    agent: 'scheduler',
    projectId: options.agentContext?.projectSnapshot?.id || undefined,
    context: {
      kind: 'proposeSchedule',
    },
  });

  if (!out) {
    return { proposals: stubSchedule(tasks), _usedStub: true, _failReason: 'timed_out_or_no_response' };
  }

  // Be permissive about shapes from different models / prompts so LLM output is never rejected for shape
  let raw = null;
  if (Array.isArray(out)) {
    raw = out;
  } else if (out && typeof out === 'object') {
    raw =
      out.schedule ||
      out.proposals ||
      out.items ||
      out.plan ||
      out.tasks ||
      out.slots ||
      Object.values(out).find((v) => Array.isArray(v)) ||
      null;
  }
  if (!Array.isArray(raw)) raw = null;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { proposals: stubSchedule(tasks), _usedStub: true, _failReason: 'invalid_schedule' };
  }

  const taskIds = new Set(tasks.map((t) => t.id));
  const result = [];
  for (const item of raw) {
    const taskId = item.taskId != null ? String(item.taskId) : (item.task_id != null ? String(item.task_id) : (item.id != null ? String(item.id) : null));
    if (!taskId || !taskIds.has(taskId)) continue;

    let proposedStart = item.proposedStart || item.proposed_start || item.start || item.startDate || item.start_date;
    let proposedEnd = item.proposedEnd || item.proposed_end || item.end || item.endDate || item.end_date;
    if (!proposedStart || !proposedEnd) {
      const fallback = stubSchedule([{ id: taskId }])[0];
      proposedStart = proposedStart || fallback.proposedStart;
      proposedEnd = proposedEnd || fallback.proposedEnd;
    }
    const startValid = typeof proposedStart === 'string' && !Number.isNaN(Date.parse(proposedStart));
    const endValid = typeof proposedEnd === 'string' && !Number.isNaN(Date.parse(proposedEnd));
    if (!startValid || !endValid) {
      const fallback = stubSchedule([{ id: taskId }])[0];
      if (!startValid) proposedStart = fallback.proposedStart;
      if (!endValid) proposedEnd = fallback.proposedEnd;
    }
    // Ensure end >= start (avoid invalid ranges like 3/2–3/1)
    const startDate = new Date(proposedStart);
    const endDate = new Date(proposedEnd);
    if (endDate.getTime() < startDate.getTime()) {
      const dayMs = 24 * 60 * 60 * 1000;
      proposedEnd = new Date(startDate.getTime() + dayMs).toISOString();
    }

    const rationale = typeof item.rationale === 'string'
      ? item.rationale.trim()
      : typeof item.reason === 'string'
        ? item.reason.trim()
        : '';

    result.push({
      taskId,
      proposedStart,
      proposedEnd,
      rationale: rationale || 'Scheduled by AI in sequence.',
    });
  }

  return {
    proposals: result.length > 0 ? result : stubSchedule(tasks),
    _usedStub: result.length === 0,
    _failReason: result.length === 0 ? 'invalid_schedule' : undefined,
  };
}

module.exports = { proposeSchedule, stubSchedule };
