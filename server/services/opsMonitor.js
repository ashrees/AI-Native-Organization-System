/**
 * Operations monitor — agent/human uptime, work queues, and error board for monitor/ frontend.
 */

const agentActivityLog = require('../lib/agentActivityLog');
const postgresStore = require('../store/postgresStore');
const { toStreamDetail } = require('../models/activityRecord');
const { getLlmQueueStatus } = require('../lib/llm');
const { describeLlmWork, agentLabel } = require('../lib/llmQueueDescribe');
const { getAiHandlerRuntimeStatus } = require('./leadershipNeedAutoHandler');
const { resolveActivityAgentId } = require('../lib/agentActivitySources');
const { getProjectAIRuntimeStatus } = require('./projectAIEvaluator');

const AGENT_DEFS = [
  { id: 'orchestrator', label: 'Orchestrator', role: 'plan' },
  { id: 'team_builder', label: 'Team Builder', role: 'assign' },
  { id: 'scheduler', label: 'Scheduler', role: 'schedule' },
  { id: 'project_ai', label: 'Project AI', role: 'watch' },
  { id: 'org_ai', label: 'Org AI', role: 'org' },
  { id: 'ai_handler', label: 'AI Handler', role: 'needs' },
  { id: 'mock_worker', label: 'Worker NPCs', role: 'simulate' },
  { id: 'llm_queue', label: 'LLM queue', role: 'model' },
];

const STALE_MS = 5 * 60 * 1000;
const ERROR_RE = /\b(error|failed|skipped|timeout|null)\b/i;
const STREAM_HOURS = Math.min(24, Math.max(1, parseInt(process.env.OPS_MONITOR_STREAM_HOURS || '3', 10)));
const STREAM_WINDOW_MS = STREAM_HOURS * 60 * 60 * 1000;
const STREAM_SEGMENTS = 48;

function agoMs(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function uptimeStatus(lastAt, busy) {
  if (busy) return 'busy';
  if (!lastAt) return 'unknown';
  const age = agoMs(lastAt);
  if (age == null) return 'unknown';
  if (age < STALE_MS) return 'up';
  if (age < STALE_MS * 3) return 'idle';
  return 'down';
}

function card(id, column, title, subtitle, meta = {}) {
  return {
    id,
    column,
    title: String(title || '').slice(0, 120),
    subtitle: subtitle ? String(subtitle).slice(0, 160) : undefined,
    timestamp: meta.timestamp || null,
    projectId: meta.projectId || null,
    projectTitle: meta.projectTitle || null,
    owner: meta.owner || null,
    ownerType: meta.ownerType || null,
    status: meta.status || null,
    kind: meta.kind || null,
  };
}

function scanAgentActivity(eventLog, activityEntries, activityRecords) {
  const byAgent = new Map(AGENT_DEFS.map((a) => [a.id, { lastAt: null, lastMessage: null, errors: 0 }]));

  const ingest = (src, ts, message, isError) => {
    if (!byAgent.has(src)) byAgent.set(src, { lastAt: null, lastMessage: null, errors: 0 });
    const row = byAgent.get(src);
    if (!row.lastAt || new Date(ts) > new Date(row.lastAt)) {
      row.lastAt = ts;
      row.lastMessage = message;
    }
    if (isError) row.errors += 1;
  };

  for (const e of activityEntries || []) {
    const src = resolveActivityAgentId(e.source, e.message, e.summary);
    ingest(src, e.timestamp, e.message, ERROR_RE.test(e.message || ''));
  }

  for (const rec of activityRecords || []) {
    const src = resolveActivityAgentId(rec.agentId, rec.message, rec.summary);
    const msg = rec.message || rec.summary || '';
    ingest(src, rec.createdAt, msg, !!rec.isError || ERROR_RE.test(msg));
  }

  for (const e of eventLog || []) {
    const src = resolveActivityAgentId(
      e.source,
      e.rationale || e.payload?.summary,
      e.payload?.reviewNotes
    );
    if (!src || !byAgent.has(src)) continue;
    const row = byAgent.get(src);
    if (!row.lastAt || new Date(e.timestamp) > new Date(row.lastAt)) {
      row.lastAt = e.timestamp;
      row.lastMessage = (e.rationale || e.payload?.summary || e.type || '').slice(0, 120);
    }
    if (e.type === 'execution' && e.payload?.status === 'blocked') {
      row.errors += 1;
    }
  }

  return byAgent;
}

const MAX_STREAM_DETAILS_PER_BUCKET = 8;

function projectTitle(projects, projectId) {
  if (!projectId) return null;
  return projects[projectId]?.title || projectId;
}

function collectAgentStream(agentId, eventLog, activityRecords, projects) {
  const now = Date.now();
  const start = now - STREAM_WINDOW_MS;
  const bucketMs = STREAM_WINDOW_MS / STREAM_SEGMENTS;
  const hits = Array.from({ length: STREAM_SEGMENTS }, (_, i) => ({
    events: 0,
    errors: 0,
    details: [],
    at: new Date(start + (i + 0.5) * bucketMs).toISOString(),
  }));

  const pushDetail = (ts, detail, isError) => {
    const t = new Date(ts).getTime();
    if (Number.isNaN(t) || t < start || t > now) return;
    const idx = Math.min(STREAM_SEGMENTS - 1, Math.floor((t - start) / bucketMs));
    hits[idx].events += 1;
    if (isError) hits[idx].errors += 1;
    if (hits[idx].details.length < MAX_STREAM_DETAILS_PER_BUCKET) {
      hits[idx].details.push(detail);
    }
  };

  const mirroredEventIds = new Set();

  for (const rec of activityRecords || []) {
    const recAgent = resolveActivityAgentId(rec.agentId, rec.message, rec.summary);
    if (recAgent !== agentId) continue;
    const detail = toStreamDetail(rec);
    if (!detail.projectTitle && detail.projectId) {
      detail.projectTitle = projectTitle(projects, detail.projectId);
    }
    pushDetail(rec.createdAt, detail, !!rec.isError);
    if (rec.correlationEventId) mirroredEventIds.add(rec.correlationEventId);
  }

  for (const e of eventLog || []) {
    const evAgent = resolveActivityAgentId(
      e.source,
      e.rationale || e.payload?.summary,
      e.payload?.reviewNotes
    );
    if (evAgent !== agentId) continue;
    if (mirroredEventIds.has(e.id)) continue;
    const p = e.payload || {};
    const mon = p.monitor || {};
    const rationale = (mon.rationale || e.rationale || p.reason || p.riskReason || '').trim();
    const summary =
      mon.summary ||
      p.summary ||
      p.title ||
      (p.decisionType ? String(p.decisionType).replace(/_/g, ' ') : '') ||
      (p.taskId && p.status ? `Task ${p.taskId} → ${p.status}` : '') ||
      (p.taskId ? `Task ${p.taskId}` : '') ||
      e.type;
    const isError =
      mon.isError ||
      ERROR_RE.test(`${rationale} ${summary}`) ||
      (e.type === 'execution' && p.status === 'blocked');

    pushDetail(
      e.timestamp,
      {
        kind: 'event',
        at: e.timestamp,
        type: e.type,
        projectId: e.projectId || null,
        projectTitle: mon.projectTitle || projectTitle(projects, e.projectId),
        taskId: mon.taskId || p.taskId || null,
        status: mon.status || p.status || p.decisionType || null,
        summary: String(summary).slice(0, 160),
        rationale: rationale ? rationale.slice(0, 220) : null,
      },
      isError
    );
  }

  return hits;
}

function mergeLlmLogsIntoHits(hits, llmLogs, projects, start, bucketMs, segmentCount, now) {
  for (const log of llmLogs || []) {
    const at = log.createdAt;
    const t = new Date(at).getTime();
    if (Number.isNaN(t) || t < start || t > now) continue;
    const idx = Math.min(segmentCount - 1, Math.floor((t - start) / bucketMs));
    let context = log.context;
    if (typeof context === 'string') {
      try {
        context = JSON.parse(context);
      } catch {
        /* keep string */
      }
    }
    const described = describeLlmWork(
      {
        agent: log.agent,
        context,
        projectId: log.projectId,
        projectTitle: projectTitle(projects, log.projectId),
        provider: log.provider,
        model: log.model,
        error: log.error,
        userMessage: log.userMessage,
        systemPrompt: log.systemPrompt,
      },
      projects
    );
    const isError = !!log.error;
    hits[idx].events += 1;
    if (isError) hits[idx].errors += 1;
    if (hits[idx].details.length < MAX_STREAM_DETAILS_PER_BUCKET) {
      hits[idx].details.push({
        kind: 'event',
        at,
        type: 'llm_call',
        projectId: described.projectId,
        projectTitle: described.projectTitle,
        taskId: described.taskId,
        status: isError ? 'error' : 'ok',
        summary: described.summary,
        rationale: described.rationale,
        agent: described.agent,
        agentDisplay: described.agentDisplay,
      });
    }
  }
  return hits;
}

const GENERIC_LLM_LOCK_RE = /^(Running llm|LLM idle \(finished llm\))$/i;

/** Hide idle rows and generic lock noise; prefer completed model calls. */
function dedupeLlmQueueBucketDetails(hits) {
  for (const h of hits) {
    const hasCall = h.details.some((d) => d.type === 'llm_call');
    h.details = h.details.filter((d) => {
      if (d.type === 'llm_idle') return false;
      if (d.type === 'llm_running' && GENERIC_LLM_LOCK_RE.test(d.summary || '')) return false;
      if (hasCall && (d.type === 'llm_running' || d.type === 'llm_waiting')) return false;
      return true;
    });
    h.details.sort((a, b) => new Date(b.at) - new Date(a.at));
  }
  return hits;
}

function injectLlmLiveQueueState(hits, llmStatus) {
  if (!hits?.length || !llmStatus) return hits;
  const busy = !!llmStatus.busy;
  const waiting = llmStatus.waiting || 0;
  if (!busy && waiting <= 0) return hits;

  const last = hits.length - 1;
  const prev = Math.max(0, last - 1);
  for (const idx of [prev, last]) {
    const h = hits[idx];
    h.events = Math.max(h.events, 1);
    h.level = busy ? 'busy' : waiting > 0 ? 'idle' : h.level;
    const work = llmStatus.currentWork;
    const liveSummary = work?.summary
      ? waiting > 0 && busy
        ? `${work.summary} (${waiting} waiting)`
        : work.summary
      : busy
        ? `Running ${agentLabel(llmStatus.currentAgent)}${waiting > 0 ? ` (${waiting} waiting)` : ''}`
        : `${waiting} caller(s) waiting for the model`;
    const liveRationale =
      work?.rationale ||
      (waiting > 0
        ? `${waiting} in queue · lock: ${agentLabel(llmStatus.currentAgent)}`
        : llmStatus.since
          ? `Started ${new Date(llmStatus.since).toLocaleTimeString()}`
          : null);
    const hasLive = h.details.some((d) => d.type === 'llm_live');
    if (!hasLive && h.details.length < MAX_STREAM_DETAILS_PER_BUCKET) {
      h.details.unshift({
        kind: 'activity',
        at: new Date().toISOString(),
        type: 'llm_live',
        projectId: work?.projectId || null,
        projectTitle: work?.projectTitle || null,
        taskId: work?.taskId || null,
        status: busy ? 'running' : 'waiting',
        summary: liveSummary,
        rationale: liveRationale,
        agent: work?.agent || llmStatus.currentAgent,
        agentDisplay: work?.agent ? agentLabel(work.agent) : agentLabel(llmStatus.currentAgent),
        live: true,
      });
    }
  }
  return hits;
}

function injectAiHandlerLiveState(hits, aiHandlerStatus) {
  if (!hits?.length || !aiHandlerStatus) return hits;
  const busy = !!aiHandlerStatus.processing;
  const scheduled = !!aiHandlerStatus.debounceScheduled;
  const pending = aiHandlerStatus.pendingNeeds || 0;
  if (!busy && !scheduled && pending <= 0) return hits;

  const last = hits.length - 1;
  const prev = Math.max(0, last - 1);
  for (const idx of [prev, last]) {
    const h = hits[idx];
    const liveSummary = busy
      ? `Processing worker requests (${pending} pending)`
      : scheduled
        ? `Run scheduled (${pending} pending)`
        : `${pending} pending worker request(s)`;
    const liveRationale =
      aiHandlerStatus.lastMessage ||
      (aiHandlerStatus.lastRunResolved > 0
        ? `Last run resolved ${aiHandlerStatus.lastRunResolved}`
        : null);
    const hasLive = h.details.some((d) => d.type === 'ai_handler_live');
    if (!hasLive && h.details.length < MAX_STREAM_DETAILS_PER_BUCKET) {
      h.events = Math.max(h.events, 1);
      h.details.unshift({
        kind: 'activity',
        at: new Date().toISOString(),
        type: 'ai_handler_live',
        projectId: null,
        projectTitle: null,
        taskId: null,
        status: busy ? 'running' : scheduled ? 'scheduled' : 'waiting',
        summary: liveSummary.slice(0, 160),
        rationale: liveRationale ? String(liveRationale).slice(0, 220) : null,
        agentDisplay: 'AI Handler',
        live: true,
      });
    }
  }
  return hits;
}

function collectAiHandlerStream(eventLog, activityRecords, projects, aiHandlerStatus) {
  let hits = collectAgentStream('ai_handler', eventLog, activityRecords, projects);
  hits = injectAiHandlerLiveState(hits, aiHandlerStatus);
  return hits;
}

function collectLlmQueueStream(eventLog, activityRecords, projects, llmLogs, llmStatus) {
  const now = Date.now();
  const start = now - STREAM_WINDOW_MS;
  const bucketMs = STREAM_WINDOW_MS / STREAM_SEGMENTS;
  let hits = collectAgentStream('llm_queue', eventLog, activityRecords, projects);
  hits = mergeLlmLogsIntoHits(hits, llmLogs, projects, start, bucketMs, STREAM_SEGMENTS, now);
  hits = dedupeLlmQueueBucketDetails(hits);
  hits = injectLlmLiveQueueState(hits, llmStatus);
  return hits;
}

function buildStreamSegments(hits, currentStatus) {
  const segments = hits.map((h, i) => {
    let level;
    if (h.errors > 0) level = 'error';
    else if (h.events >= 2) level = 'busy';
    else if (h.events === 1) level = 'up';
    else {
      const lookback = hits.slice(Math.max(0, i - 4), i);
      level = lookback.some((x) => x.events > 0) ? 'idle' : 'unknown';
    }
    return {
      level,
      events: h.events,
      errors: h.errors,
      at: h.at,
      details: h.details || [],
    };
  });

  const last = segments.length - 1;
  if (last >= 0) {
    const live =
      currentStatus === 'busy'
        ? 'busy'
        : currentStatus === 'down'
          ? 'down'
          : currentStatus === 'idle'
            ? 'idle'
            : currentStatus === 'up'
              ? 'up'
              : segments[last].level;
    if (segments[last].events === 0 && segments[last].errors === 0) {
      segments[last] = { ...segments[last], level: live };
    } else if (currentStatus === 'busy') {
      segments[last] = { ...segments[last], level: 'busy' };
    }
  }

  return segments;
}

function latestStreamTouch(stream) {
  for (let i = stream.length - 1; i >= 0; i--) {
    const seg = stream[i];
    if (!seg?.events || !seg.details?.length) continue;
    const d = seg.details[0];
    return {
      at: d.at,
      message: d.summary || d.rationale || null,
    };
  }
  return null;
}

function buildAgentStatuses(eventLog, activityEntries, extras, projects, activityRecords, llmLogs) {
  const byAgent = scanAgentActivity(eventLog, activityEntries, activityRecords);
  const llm = getLlmQueueStatus();
  const aiHandler = getAiHandlerRuntimeStatus(eventLog, projects);
  const projectAi = getProjectAIRuntimeStatus();
  const mock = extras.mockWorker || {};

  return AGENT_DEFS.map((def) => {
    const row = byAgent.get(def.id) || { lastAt: null, lastMessage: null, errors: 0 };
    let busy = false;
    let detail = row.lastMessage;

    if (def.id === 'llm_queue') {
      busy = llm.busy;
      row.lastAt = llm.since || row.lastAt;
      if (busy && llm.currentWork?.summary) {
        detail =
          llm.waiting > 0
            ? `${llm.currentWork.summary} (${llm.waiting} waiting)`
            : llm.currentWork.summary;
      } else if (busy) {
        detail = `Running ${agentLabel(llm.currentAgent)} (${llm.waiting} waiting)`;
      } else {
        detail = row.lastMessage || 'Idle';
      }
    } else if (def.id === 'ai_handler') {
      busy = aiHandler.processing;
      row.lastAt = aiHandler.lastAt || row.lastAt;
      const pending = aiHandler.pendingNeeds ?? 0;
      if (busy) {
        detail = `Processing queue (${pending} pending)`;
      } else if (aiHandler.debounceScheduled) {
        detail =
          aiHandler.lastMessage ||
          `Run scheduled (${pending} pending)`;
      } else if (row.lastMessage) {
        detail = row.lastMessage;
      } else if (pending > 0) {
        detail = `${pending} pending worker request(s)`;
      } else {
        detail = 'Automatic handler enabled';
      }
      if (!row.lastAt && (busy || aiHandler.debounceScheduled || pending > 0)) {
        row.lastAt = new Date().toISOString();
      }
    } else if (def.id === 'project_ai') {
      busy = projectAi.pendingChecks > 0;
      if (busy) detail = `${projectAi.pendingChecks} status check(s) queued`;
    } else if (def.id === 'mock_worker') {
      busy = mock.enabled && mock.lastTickAt && agoMs(mock.lastTickAt) < mock.intervalMs * 2;
      row.lastAt = mock.lastTickAt || row.lastAt;
      detail = mock.enabled
        ? `Batch ${mock.batchSize} · last ${mock.lastTickSummary?.actions ?? 0} action(s)`
        : 'Disabled';
    }

    let status = busy ? 'busy' : uptimeStatus(row.lastAt, false);
    const hits =
      def.id === 'llm_queue'
        ? collectLlmQueueStream(eventLog, activityRecords, projects, llmLogs, llm)
        : def.id === 'ai_handler'
          ? collectAiHandlerStream(eventLog, activityRecords, projects, aiHandler)
          : collectAgentStream(def.id, eventLog, activityRecords, projects);
    const stream = buildStreamSegments(hits, status);
    const touch = latestStreamTouch(stream);
    if (!row.lastAt && touch?.at) {
      row.lastAt = touch.at;
      if (
        !detail ||
        (def.id === 'ai_handler' && detail === 'Automatic handler enabled')
      ) {
        detail = touch.message || detail;
      }
    }
    if (status === 'unknown' && row.lastAt) {
      status = uptimeStatus(row.lastAt, busy);
    }
    if (
      def.id === 'ai_handler' &&
      status === 'unknown' &&
      (aiHandler.debounceScheduled || (aiHandler.pendingNeeds ?? 0) > 0)
    ) {
      status = 'idle';
    }
    const streamUp = stream.filter((s) => s.level === 'up' || s.level === 'busy').length;
    const streamPct =
      stream.length > 0 ? Math.round((streamUp / stream.length) * 1000) / 10 : 0;

    return {
      ...def,
      status,
      lastAt: row.lastAt,
      lastMessage: detail,
      errorCount: row.errors,
      stream,
      streamUptimePct: streamPct,
    };
  });
}

const TERMINAL_NEED_STATUSES = new Set(['approved', 'rejected', 'met', 'cancelled']);

function isActiveProjectForQueue(state) {
  if (!state || state.archived) return false;
  const st = state.status || 'active';
  return st === 'active';
}

function isReviewTask(task) {
  const id = String(task?.id || '');
  const title = String(task?.title || '').toLowerCase();
  return id.startsWith('wr-') || title.includes('review worker request');
}

function buildBoards(projects, eventLog, peopleById) {
  const worked = [];
  const active = [];
  const queued = [];
  const broken = [];
  const seen = new Set();

  const needStatusById = new Map();
  for (const e of eventLog || []) {
    if (e.type === 'need' && e.id) {
      needStatusById.set(e.id, e.payload?.status || 'open');
    }
  }

  const pushCard = (c) => {
    const key = `${c.column}:${c.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (c.column === 'worked') worked.push(c);
    else if (c.column === 'active') active.push(c);
    else if (c.column === 'queued') queued.push(c);
    else if (c.column === 'broken') broken.push(c);
  };

  const projectTitle = (id) => projects[id]?.title || id;

  for (const [projectId, state] of Object.entries(projects || {})) {
    if (!state || state.status === 'killed') continue;
    const queueable = isActiveProjectForQueue(state);
    const tasks = state.progress?.tasks || [];

    for (const t of tasks) {
      if (isReviewTask(t)) continue;
      const assignee = t.assignee?.name || peopleById.get(t.assigneeId)?.name || t.assigneeId;
      const base = {
        projectId,
        projectTitle: projectTitle(projectId),
        owner: assignee,
        ownerType: assignee ? 'human' : null,
        status: t.status || 'pending',
      };

      if (t.status === 'done') {
        pushCard(
          card(`task-${t.id}`, 'worked', t.title || t.id, assignee ? `Done · ${assignee}` : 'Done', base)
        );
      } else if (t.status === 'in_progress' && queueable) {
        pushCard(
          card(
            `task-${t.id}`,
            'active',
            t.title || t.id,
            assignee ? `In progress · ${assignee}` : 'In progress',
            base
          )
        );
      } else if (t.status === 'blocked') {
        if (queueable) {
          pushCard(
            card(`task-${t.id}`, 'broken', t.title || t.id, 'Blocked', { ...base, kind: 'blocked' })
          );
        }
      } else if (queueable) {
        pushCard(
          card(
            `task-${t.id}`,
            'queued',
            t.title || t.id,
            assignee ? `Queued · ${assignee}` : 'Unassigned',
            base
          )
        );
      }
    }

    for (const b of state.blockers || []) {
      pushCard(
        card(`blocker-${b.taskId}`, 'broken', `Blocker: ${b.description || b.taskId}`, projectTitle(projectId), {
          projectId,
          projectTitle: projectTitle(projectId),
          kind: 'blocker',
          timestamp: b.raisedAt,
        })
      );
    }

    for (const n of state.needs || []) {
      const status = needStatusById.get(n.id) || n.status || 'open';
      if (TERMINAL_NEED_STATUSES.has(status)) continue;
      if (!['open', 'in_review'].includes(status)) continue;
      if (!queueable) continue;
      pushCard(
        card(`need-${n.id}`, 'queued', n.title || n.kind || 'Worker need', n.description?.slice(0, 80), {
          projectId,
          projectTitle: projectTitle(projectId),
          kind: n.kind,
          status,
        })
      );
    }
  }

  const recentExec = (eventLog || [])
    .filter((e) => e.type === 'execution' && e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12);

  for (const e of recentExec) {
    if (e.payload?.status !== 'done') continue;
    const pid = e.projectId;
    const taskId = e.payload?.taskId;
    const key = `task-${taskId}`;
    if (seen.has(`worked:${key}`)) continue;
    const state = projects[pid];
    const task = state?.progress?.tasks?.find((t) => t.id === taskId);
    if (task?.status === 'done') continue;
    pushCard(
      card(key, 'worked', task?.title || taskId, `Just completed`, {
        projectId: pid,
        projectTitle: projectTitle(pid),
        timestamp: e.timestamp,
        kind: 'execution',
      })
    );
  }

  for (const e of (eventLog || []).slice(-40)) {
    if (!ERROR_RE.test(`${e.rationale || ''} ${e.payload?.summary || ''}`)) continue;
    if (e.source === 'project_ai' && e.payload?.decisionType === 'project_assessment') continue;
    pushCard(
      card(`err-${e.id}`, 'broken', e.type, (e.rationale || e.payload?.summary || '').slice(0, 100), {
        projectId: e.projectId,
        projectTitle: projectTitle(e.projectId),
        timestamp: e.timestamp,
        kind: 'error_signal',
        ownerType: e.source,
      })
    );
  }

  const sortTs = (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  worked.sort(sortTs);
  active.sort(sortTs);
  queued.sort(sortTs);
  broken.sort(sortTs);

  return {
    worked: worked.slice(0, 24),
    active: active.slice(0, 24),
    queued: queued.slice(0, 24),
    broken: broken.slice(0, 16),
  };
}

function buildHumanActivity(projects, people) {
  const rows = [];
  for (const p of people || []) {
    if (p.id === 'org_ai') continue;
    let inProgress = 0;
    let pending = 0;
    let done = 0;
    let activeTask = null;

    for (const state of Object.values(projects || {})) {
      for (const t of state?.progress?.tasks || []) {
        const aid = t.assigneeId || t.assignee?.id;
        if (aid !== p.id) continue;
        if (t.status === 'in_progress') {
          inProgress += 1;
          if (!activeTask) activeTask = t.title;
        } else if (t.status === 'done') done += 1;
        else pending += 1;
      }
    }

    const avail = p.availabilityStatus || 'active';
    let status = 'idle';
    if (avail === 'on_leave') status = 'away';
    else if (inProgress > 0) status = 'busy';
    else if (pending > 0) status = 'queued';

    rows.push({
      personId: p.id,
      name: p.name,
      department: p.department,
      team: p.team,
      status,
      inProgress,
      pending,
      done,
      currentLoad: p.currentLoad ?? 0,
      activeTask,
    });
  }

  rows.sort((a, b) => (b.inProgress || 0) - (a.inProgress || 0) || (b.pending || 0) - (a.pending || 0));
  return rows.slice(0, 40);
}

/**
 * @param {{ getStore, loadPeople, getEventLog }} ctx
 */
async function buildOpsMonitorSnapshot(ctx) {
  const store = ctx.getStore?.() || {};
  const projects = store.projects || {};
  const eventLog = ctx.getEventLog?.() || [];
  const people = typeof ctx.loadPeople === 'function' ? ctx.loadPeople() : [];
  const peopleById = new Map((people || []).map((p) => [p.id, p]));

  let mockWorker = {};
  try {
    const { getMockWorkerStatus } = require('./mockWorkerNPC');
    mockWorker = getMockWorkerStatus();
  } catch {
    /* ignore */
  }

  const since = new Date(Date.now() - STREAM_WINDOW_MS).toISOString();
  let activityRecords = [];
  let llmLogs = [];
  try {
    activityRecords = await postgresStore.loadAgentActivitySince({ since, limit: 8000 });
    llmLogs = await postgresStore.loadLlmLogsSince({ since, limit: 500 });
  } catch (err) {
    console.warn('[opsMonitor] loadAgentActivitySince failed:', err.message);
  }

  const activityEntries = agentActivityLog.getRecent();
  const agents = buildAgentStatuses(
    eventLog,
    activityEntries,
    { mockWorker },
    projects,
    activityRecords,
    llmLogs
  );
  const boards = buildBoards(projects, eventLog, peopleById);

  const agentsUp = agents.filter((a) => a.status === 'up' || a.status === 'busy').length;
  const agentsDown = agents.filter((a) => a.status === 'down').length;

  return {
    at: new Date().toISOString(),
    streamHours: STREAM_HOURS,
    summary: {
      agentsUp,
      agentsDown,
      agentsBusy: agents.filter((a) => a.status === 'busy').length,
      activeTasks: boards.active.length,
      queuedItems: boards.queued.length,
      brokenItems: boards.broken.length,
    },
    agents,
    boards,
    llm: getLlmQueueStatus(),
  };
}

module.exports = {
  AGENT_DEFS,
  buildOpsMonitorSnapshot,
};
