/**
 * Leadership Help Chat — ask org AI agents questions with live store context.
 *
 * POST /help-chat
 * Body: { message, agent?, projectId?, messages? }
 */

const express = require('express');
const router = express.Router();

const { readPrompt, completeText } = require('../lib/llm');
const { buildFullHelpContext } = require('../services/helpChatContext');

const AGENTS = Object.freeze({
  org_ai: { label: 'Org AI', description: 'Organization-wide status, risk, and insights' },
  orchestrator: { label: 'Orchestrator', description: 'Plans, projects, blockers, and delivery' },
  project_ai: { label: 'Project AI', description: 'Single-project tasks and progress' },
  team_builder: { label: 'Team Builder', description: 'People, assignments, and workload' },
  scheduler: { label: 'Scheduler', description: 'Timelines and scheduling' },
  auto: { label: 'Auto', description: 'Pick the best agent for your question' },
});

const SUGGESTED_QUESTIONS = [
  'Which projects are at highest risk right now?',
  'Who is at risk on the workforce health matrix and why?',
  'Which departments have the best productivity scores?',
  'Summarize open worker requests and who they were forwarded to.',
  'Who has the most blocked or in-progress tasks?',
  'What did AI agents do recently across the org?',
];

function loadStore() {
  try {
    const eventsRouter = require('./events');
    const store = typeof eventsRouter.getStore === 'function' ? eventsRouter.getStore() : null;
    const people =
      typeof eventsRouter.loadPeople === 'function' ? eventsRouter.loadPeople() : [];
    if (store && Array.isArray(store.eventLog)) {
      return { events: store.eventLog, projects: store.projects || {}, people };
    }
  } catch (err) {
    console.error('helpChat: failed to load store', err.message);
  }
  return { events: [], projects: {}, people: [] };
}

function pickAgent(message, projectId) {
  const q = String(message || '').toLowerCase();
  if (projectId) {
    if (/schedule|timeline|deadline|when\b/.test(q)) return 'scheduler';
    if (/assign|who is|people|workload|team\b/.test(q)) return 'team_builder';
    return 'project_ai';
  }
  if (/schedule|timeline|deadline/.test(q)) return 'scheduler';
  if (/workforce|productivity|health score|engagement|reliability|thriving|at.risk|matrix|status band|overloaded|underutilized/.test(q)) {
    return 'org_ai';
  }
  if (/assign|who is|people|workload|hr\b|worker request|leave|vacation/.test(q)) return 'team_builder';
  if (/project|blocker|task|risk|plan|delivery/.test(q)) return 'orchestrator';
  return 'org_ai';
}

const buildHelpContext = buildFullHelpContext;

function buildFallbackAnswer(message, context) {
  const lines = [
    '**Live data summary** (LLM unavailable — configure `GOOGLE_API_KEY`, `OPENAI_API_KEY`, or Ollama):',
    '',
  ];
  const cov = context.dataCoverage || {};
  lines.push(
    `Coverage: ${cov.projects ?? 0} projects, ${cov.people ?? 0} people, ${cov.workforceWorkers ?? 0} workforce profiles, ${cov.eventsIncluded ?? 0}/${cov.eventsTotalInStore ?? 0} events, ${cov.openWorkerRequests ?? 0} open worker requests.`
  );
  lines.push('');

  const atRisk = (context.metrics?.projects || []).filter(
    (p) => p.risk?.level === 'high' || p.risk?.level === 'medium' || (p.blockers?.count || 0) > 0
  );
  if (atRisk.length) {
    lines.push('**Projects needing attention:**');
    for (const p of atRisk.slice(0, 8)) {
      lines.push(
        `- **${p.title || p.projectId}** — risk ${p.risk?.level || 'unknown'}, ${p.tasks?.blocked || 0} blocked, ${p.tasks?.in_progress || 0} in progress`
      );
    }
    lines.push('');
  }

  const unassigned = context.unassignedTasks || [];
  if (unassigned.length) {
    lines.push(`**Unassigned tasks:** ${unassigned.length}`);
    for (const t of unassigned.slice(0, 6)) {
      lines.push(`- ${t.projectTitle}: ${t.taskTitle || t.taskId}`);
    }
    lines.push('');
  }

  const openWr = context.openWorkerRequests || [];
  lines.push(`**Worker requests:** ${openWr.length} open of ${(context.workerRequests || []).length} total.`);
  for (const r of openWr.slice(0, 8)) {
    const fwd = (r.forwardTargets || []).map((t) => t.name).filter(Boolean).join(', ');
    lines.push(`- ${r.kind}: ${r.title}${fwd ? ` → ${fwd}` : ''}`);
  }
  lines.push('');

  const wf = context.workforce;
  if (wf?.workers?.length) {
    const dist = wf.distribution || {};
    lines.push(
      `**Workforce:** ${wf.workers.length} profiles — ${dist.thriving ?? 0} thriving, ${dist.steady ?? 0} steady, ${dist.watch ?? 0} watch, ${dist.at_risk ?? 0} at risk.`
    );
    for (const w of (wf.highlights?.atRisk || []).slice(0, 5)) {
      lines.push(
        `- **${w.name}** — overall ${w.indexes?.overall ?? '?'}, health ${w.indexes?.health ?? '?'}${w.signals?.length ? ` (${w.signals.join('; ')})` : ''}`
      );
    }
    if (wf.departmentSummary?.length) {
      lines.push('');
      lines.push('**Departments (avg overall):**');
      for (const d of wf.departmentSummary.slice(0, 6)) {
        lines.push(`- ${d.department}: ${d.avgOverall} (${d.headcount} people)`);
      }
    }
    lines.push('');
  }

  const activity = context.recentAgentActivity || [];
  if (activity.length) {
    lines.push('**Recent AI activity:**');
    for (const a of activity.slice(0, 6)) {
      lines.push(`- [${a.source}] ${a.message}`);
    }
  }

  lines.push('');
  lines.push(`_Your question:_ ${message}`);
  return lines.join('\n');
}

router.get('/meta', (_req, res) => {
  res.json({
    agents: AGENTS,
    suggestedQuestions: SUGGESTED_QUESTIONS,
  });
});

router.post('/', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const projectId =
    typeof req.body?.projectId === 'string' && req.body.projectId.trim()
      ? req.body.projectId.trim()
      : null;
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];

  let agent = req.body?.agent;
  if (!agent || agent === 'auto') {
    agent = pickAgent(message, projectId);
  }
  if (!AGENTS[agent]) {
    return res.status(400).json({
      error: `agent must be one of: ${Object.keys(AGENTS).join(', ')}`,
    });
  }

  const store = loadStore();
  if (projectId && !store.projects[projectId]) {
    return res.status(404).json({ error: 'Project not found' });
  }

  let orgInsights = null;
  try {
    const orgRouter = require('./orgInsights');
    if (typeof orgRouter.getLatestInsights === 'function') {
      orgInsights = orgRouter.getLatestInsights();
    }
  } catch {
    /* optional */
  }

  const context = buildHelpContext(agent, projectId, store, orgInsights);
  const systemPrompt = readPrompt('helpChat') || 'Answer using only the provided JSON context.';
  const agentNote = `You are answering as the **${AGENTS[agent]?.label || agent}** agent.`;
  const coverage = context.dataCoverage
    ? `Data coverage: ${JSON.stringify(context.dataCoverage)}`
    : '';
  const userPayload = `${agentNote}\n${coverage}\n\nContext JSON:\n${JSON.stringify(context)}\n\nUser question:\n${message}`;

  const answer = await completeText(systemPrompt, userPayload, {
    agent: `help_${agent}`,
    projectId,
    messages: history,
    timeoutMs: 120000,
  });

  if (answer) {
    return res.json({
      answer,
      agent,
      agentLabel: AGENTS[agent].label,
      fallback: false,
      suggestedQuestions: SUGGESTED_QUESTIONS,
    });
  }

  return res.json({
    answer: buildFallbackAnswer(message, context),
    agent,
    agentLabel: AGENTS[agent].label,
    fallback: true,
    suggestedQuestions: SUGGESTED_QUESTIONS,
  });
});

module.exports = router;
