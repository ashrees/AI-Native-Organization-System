/**
 * Leadership Help Chat — ask org AI agents questions with live store context.
 *
 * POST /help-chat
 * Body: { message, agent?, projectId?, messages? }
 */

const express = require('express');
const router = express.Router();

const { readPrompt, completeText } = require('../lib/llm');
const { buildAllProjectMetrics } = require('../services/metrics');
const { buildAgentContext, getProjectTimeline } = require('../services/retrieval');
const agentActivityLog = require('../lib/agentActivityLog');

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
  'Summarize open worker requests and who they were forwarded to.',
  'Who has the most blocked or in-progress tasks?',
  'What did AI agents do recently across the org?',
  'Which projects have blockers and what are they?',
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
  if (/assign|who is|people|workload|hr\b|worker request|leave|vacation/.test(q)) return 'team_builder';
  if (/project|blocker|task|risk|plan|delivery/.test(q)) return 'orchestrator';
  return 'org_ai';
}

function compactWorkerRequests(events, limit = 15) {
  return events
    .filter((e) => e.type === 'need' && e.source === 'human' && e.payload?.title)
    .slice(-limit)
    .reverse()
    .map((e) => ({
      id: e.id,
      projectId: e.projectId,
      kind: e.payload.kind,
      title: e.payload.title,
      status: e.payload.status || 'open',
      handlingMode: e.payload.handlingMode,
      forwardsTo: e.payload.forwardsTo || e.payload.routingLabel,
      forwardTargets: (e.payload.forwardTargets || e.payload.notifyTargets || []).map((t) => ({
        name: t.name,
        role: t.roleLabel || t.role,
      })),
      timestamp: e.timestamp,
    }));
}

function buildHelpContext(agent, projectId, store, orgInsights) {
  const { events, projects, people } = store;
  const metrics = buildAllProjectMetrics(projects, events);

  const projectSummaries = (metrics.projects || []).map((m) => ({
    projectId: m.projectId,
    title: m.title,
    status: m.status,
    riskLevel: m.risk?.level,
    riskReasons: (m.risk?.reasons || []).slice(0, 3),
    tasks: m.tasks,
    blockers: m.blockers?.count ?? 0,
    lastEventAgeHours: m.timeline?.lastEventAgeHours,
  }));

  const agentContext = buildAgentContext(agent, projectId || null, { focus: 'help_chat' }, {
    eventLog: events,
    projects,
    people,
    metrics,
  });

  if (projectId) {
    agentContext.projectTimeline = getProjectTimeline(projectId, events, { limit: 12 });
    const state = projects[projectId];
    if (state?.blockers?.length) {
      agentContext.openBlockers = state.blockers.slice(0, 8);
    }
  }

  return {
    agent,
    projectId: projectId || null,
    generatedAt: new Date().toISOString(),
    projectSummaries,
    workerRequests: compactWorkerRequests(events),
    recentAgentActivity: agentActivityLog.getRecent(projectId ? { projectId } : {}).slice(0, 15),
    peopleDirectory: (people || []).slice(0, 40).map((p) => ({
      id: p.id,
      name: p.name,
      department: p.department,
      team: p.team,
      role: p.role,
      currentLoad: p.currentLoad,
    })),
    orgInsights: orgInsights || null,
    agentContext,
  };
}

function buildFallbackAnswer(message, context) {
  const lines = [
    '**Live data summary** (LLM unavailable — configure `GOOGLE_API_KEY`, `OPENAI_API_KEY`, or Ollama):',
    '',
  ];
  const atRisk = (context.projectSummaries || []).filter(
    (p) => p.riskLevel === 'high' || p.riskLevel === 'medium' || (p.blockers || 0) > 0
  );
  if (atRisk.length) {
    lines.push('**Projects needing attention:**');
    for (const p of atRisk.slice(0, 6)) {
      lines.push(
        `- **${p.title || p.projectId}** — risk ${p.riskLevel || 'unknown'}, ${p.tasks?.blocked || 0} blocked, ${p.tasks?.in_progress || 0} in progress`
      );
    }
    lines.push('');
  } else {
    lines.push('No high-risk projects flagged in current metrics.');
    lines.push('');
  }

  const wr = context.workerRequests || [];
  const openWr = wr.filter((r) => ['open', 'in_review'].includes(r.status));
  lines.push(`**Worker requests:** ${openWr.length} open of ${wr.length} recent.`);
  for (const r of openWr.slice(0, 5)) {
    const fwd = (r.forwardTargets || []).map((t) => t.name).filter(Boolean).join(', ');
    lines.push(`- ${r.kind}: ${r.title}${fwd ? ` → ${fwd}` : ''}`);
  }
  lines.push('');

  const activity = context.recentAgentActivity || [];
  if (activity.length) {
    lines.push('**Recent AI activity:**');
    for (const a of activity.slice(0, 5)) {
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
  const userPayload = `${agentNote}\n\nContext JSON:\n${JSON.stringify(context)}\n\nUser question:\n${message}`;

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
