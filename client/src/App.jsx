/**
 * Leadership View — read-only summary + minimal forms to submit:
 * - new work requests
 * - execution / decision events
 *
 * AI owns planning, assignment, and scheduling; humans own execution and judgment.
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

function randomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Log display: show at most 2 sentences for agent messages. */
function logMessageShort(text, maxSentences = 2) {
  if (text == null || typeof text !== 'string') return '';
  const t = text.trim();
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= maxSentences) return t;
  return sentences.slice(0, maxSentences).join(' ');
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [eventsByProject, setEventsByProject] = useState({});
  const [orgInsights, setOrgInsights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitStatus, setSubmitStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const [projectsRes, eventsRes] = await Promise.all([
        fetchJson('/events/projects'),
        fetchJson('/events'),
      ]);
      const list = (projectsRes.projects || [])
        .slice()
        .sort((a, b) => {
          const ta = a.lastUpdatedAt ? new Date(a.lastUpdatedAt).getTime() : 0;
          const tb = b.lastUpdatedAt ? new Date(b.lastUpdatedAt).getTime() : 0;
          return tb - ta; // latest first
        });
      setProjects(list);
      const events = eventsRes.events || [];
      const byProject = {};
      for (const e of events) {
        const pid = e.projectId;
        if (!byProject[pid]) byProject[pid] = [];
        byProject[pid].push(e);
      }
      for (const pid of Object.keys(byProject)) {
        byProject[pid].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        byProject[pid] = byProject[pid].slice(0, 10);
      }
      setEventsByProject(byProject);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Load org-level insights separately so the main UI never blocks on LLM calls.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const insightsRes = await fetchJson('/org-insights');
        if (!cancelled) {
          setOrgInsights(insightsRes || null);
        }
      } catch (err) {
        // Best-effort; log to console but don't surface as a blocking error.
        console.error('Failed to load org insights', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates: subscribe to server-sent events and refresh when any event arrives.
  useEffect(() => {
    let timer = null;
    const scheduleRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
        // best-effort refresh for org insights (non-blocking)
        fetchJson('/org-insights').then(setOrgInsights).catch(() => {});
      }, 350);
    };

    const es = new EventSource(`${API_BASE}/events/stream`);
    es.addEventListener('event', scheduleRefresh);
    es.addEventListener('ready', () => {});
    es.onerror = () => {
      // If SSE drops, the UI still works; user can refresh or we can add polling later.
    };

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [load]);

  const [activeTab, setActiveTab] = useState('overview');
  const [logProjectId, setLogProjectId] = useState('');
  const [logEvents, setLogEvents] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [llmProjectId, setLlmProjectId] = useState('');
  const [llmLogs, setLlmLogs] = useState([]);
  const [llmLoading, setLlmLoading] = useState(false);

  // Load events + agent activity for Log tab when project is selected (orchestrator, team_builder, scheduler, project_ai, org_ai)
  useEffect(() => {
    if (activeTab !== 'log') {
      setLogEvents([]);
      return;
    }
    let cancelled = false;
    setLogLoading(true);
    const projectId = logProjectId.trim();
    const eventsPromise = projectId
      ? fetchJson(`/events?projectId=${encodeURIComponent(projectId)}`)
      : Promise.resolve({ events: [] });
    const activityPromise = fetchJson(`/events/agent-activity${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);

    Promise.all([eventsPromise, activityPromise])
      .then(([eventsData, activityData]) => {
        if (cancelled) return;
        const events = (eventsData.events || []).filter((e) =>
          ['orchestrator', 'team_builder', 'scheduler', 'project_ai'].includes(e.source)
        );
        const activity = (activityData.agentActivity || []).map((a) => ({
          id: a.id,
          type: 'activity',
          source: a.source,
          timestamp: a.timestamp,
          rationale: a.message,
        }));
        const merged = [...events.map((e) => ({ ...e, type: e.type || 'event' })), ...activity];
        merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        setLogEvents(merged);
      })
      .catch(() => {
        if (!cancelled) setLogEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLogLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, logProjectId]);

  // Load LLM logs when LLM tab + project selected
  useEffect(() => {
    if (activeTab !== 'llm') {
      setLlmLogs([]);
      return;
    }
    const projectId = llmProjectId.trim();
    if (!projectId) {
      setLlmLogs([]);
      return;
    }
    let cancelled = false;
    setLlmLoading(true);
    fetchJson(`/events/llm-logs?projectId=${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (cancelled) return;
        setLlmLogs(data.logs || []);
      })
      .catch(() => {
        if (!cancelled) setLlmLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLlmLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, llmProjectId]);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const onSuccess = () => {
    setSubmitStatus('ok');
    load();
  };
  const onError = (msg) => setSubmitStatus(msg);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Leadership View</h1>
        <p className="subtitle">What is happening, why, and what changed recently.</p>
        <nav className="app-nav" aria-label="Main">
          <button
            type="button"
            className={`nav-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            Projects
            {projects.length > 0 && (
              <span className="nav-badge">{projects.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === 'actions' ? 'active' : ''}`}
            onClick={() => setActiveTab('actions')}
          >
            Actions
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === 'log' ? 'active' : ''}`}
            onClick={() => setActiveTab('log')}
          >
            Log
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
          >
            LLM Logs
          </button>
        </nav>
      </header>

      {submitStatus && (
        <p className={`app-status ${submitStatus === 'ok' ? 'submit-ok' : 'error'}`}>
          {submitStatus === 'ok' ? 'Event submitted. List updated.' : submitStatus}
        </p>
      )}

      <main className="app-main">
        {activeTab === 'overview' && (
          <section className="app-section" aria-labelledby="section-overview">
            <h2 id="section-overview" className="section-title">Overview</h2>
            {orgInsights ? (
              <OrgInsightsPanel orgInsights={orgInsights} />
            ) : (
              <p className="empty">Org insights loading…</p>
            )}
          </section>
        )}

        {activeTab === 'projects' && (
          <section className="app-section" aria-labelledby="section-projects">
            <h2 id="section-projects" className="section-title">Projects</h2>
            <div className="projects">
              {projects.length === 0 ? (
                <p className="empty">
                  No projects yet. Open <strong>Actions</strong> to create a new request, or add one via API.
                </p>
              ) : (
                projects.map((proj) => (
                  <ProjectCard
                    key={proj.id}
                    project={proj}
                    recentEvents={eventsByProject[proj.id] || []}
                  />
                ))
              )}
            </div>
          </section>
        )}

        {activeTab === 'actions' && (
          <section className="app-section" aria-labelledby="section-actions">
            <h2 id="section-actions" className="section-title">Actions</h2>
            <p className="section-desc">Create work requests or submit execution/decision events.</p>
            <div className="actions-grid">
              <NewRequestForm onSuccess={onSuccess} onError={onError} />
              <SubmitEventForm
                projects={projects}
                onSuccess={onSuccess}
                onError={onError}
              />
            </div>
          </section>
        )}

        {activeTab === 'log' && (
          <section className="app-section log-section" aria-labelledby="section-log">
            <h2 id="section-log" className="section-title">Log</h2>
            <p className="section-desc">AI agent activity for a project. Each entry is a max 2-sentence summary of what that agent did.</p>
            <label className="log-project-label">
              Project
              <select
                value={logProjectId}
                onChange={(e) => setLogProjectId(e.target.value)}
                className="log-project-select"
                aria-label="Select project to view logs"
              >
                <option value="">— Select project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            </label>
            {logProjectId && (
              <div className="log-entries">
                {logLoading ? (
                  <p className="empty">Loading…</p>
                ) : logEvents.length === 0 ? (
                  <p className="empty">No AI agent activity for this project yet. Select a project to see orchestrator, team_builder, scheduler, project_ai, and org_ai logs.</p>
                ) : (
                  <ul className="log-list">
                    {logEvents.map((e) => (
                      <li key={e.id} className="log-entry">
                        <span className="log-meta">
                          <strong>{e.type}</strong> ({e.source}) — {new Date(e.timestamp).toLocaleString()}
                        </span>
                        {(e.rationale || e.message) && (
                          <span className="log-message">{logMessageShort(e.rationale || e.message)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!logProjectId && activeTab === 'log' && (
              <p className="empty">Select a project above to see AI agent logs (orchestrator, team_builder, scheduler, project_ai, org_ai).</p>
            )}
          </section>
        )}

        {activeTab === 'llm' && (
          <section className="app-section log-section" aria-labelledby="section-llm">
            <h2 id="section-llm" className="section-title">LLM Logs</h2>
            <p className="section-desc">
              Live chat logs between agents and the LLM: full prompts, requests, and parsed JSON responses.
            </p>
            <label className="log-project-label">
              Project
              <select
                value={llmProjectId}
                onChange={(e) => setLlmProjectId(e.target.value)}
                className="log-project-select"
                aria-label="Select project to view LLM logs"
              >
                <option value="">— Select project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            </label>
            {llmProjectId && (
              <div className="log-entries">
                {llmLoading ? (
                  <p className="empty">Loading…</p>
                ) : llmLogs.length === 0 ? (
                  <p className="empty">No LLM logs for this project yet.</p>
                ) : (
                  <ul className="log-list">
                    {llmLogs.map((log) => (
                      <li key={log.id} className="log-entry">
                        <span className="log-meta">
                          <strong>{log.agent || 'agent'}</strong>
                          {log.provider && <> · {log.provider}</>}
                          {log.model && <> · {log.model}</>}
                          {' — '}
                          {new Date(log.createdAt).toLocaleString()}
                        </span>
                        <details className="llm-log-details">
                          <summary>View conversation</summary>
                          <div className="llm-log-block">
                            <h4>System prompt</h4>
                            <pre>{log.systemPrompt || '(none)'}</pre>
                          </div>
                          <div className="llm-log-block">
                            <h4>User message</h4>
                            <pre>{log.userMessage || '(none)'}</pre>
                          </div>
                          <div className="llm-log-block">
                            <h4>Parsed JSON</h4>
                            <pre>
                              {log.parsedJson != null
                                ? JSON.stringify(log.parsedJson, null, 2)
                                : '(null)'}
                            </pre>
                          </div>
                          {log.rawResponse && (
                            <div className="llm-log-block">
                              <h4>Raw response</h4>
                              <pre>{log.rawResponse}</pre>
                            </div>
                          )}
                          {log.error && (
                            <div className="llm-log-block">
                              <h4>Error</h4>
                              <pre>{log.error}</pre>
                            </div>
                          )}
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!llmProjectId && activeTab === 'llm' && (
              <p className="empty">Select a project above to see full LLM conversations for that project.</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function NewRequestForm({ onSuccess, onError }) {
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!projectId.trim()) {
      onError('Enter a project id');
      return;
    }
    if (!title.trim()) {
      onError('Enter a title');
      return;
    }

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const event = {
      id,
      type: 'request',
      timestamp,
      projectId: projectId.trim(),
      source: 'human',
      payload: {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
      },
    };

    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data.error || res.statusText);
        return;
      }
      setTitle('');
      setDescription('');
      // keep projectId so multiple requests can be added easily
      onSuccess();
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <section className="submit-event action-card">
      <h3>New request</h3>
      <p className="submit-event-desc">Create a new work request. AI will plan, assign, and schedule.</p>
      <form onSubmit={handleSubmit}>
        <label>
          Project id
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="e.g. proj-login-bug"
          />
        </label>
        <label>
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fix login bug"
          />
        </label>
        <label>
          Description (optional)
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short context"
          />
        </label>
        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <button type="submit">Create request</button>
      </form>
    </section>
  );
}

function SubmitEventForm({ projects, onSuccess, onError }) {
  const [eventType, setEventType] = useState('execution');
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [status, setStatus] = useState('in_progress');
  const [notes, setNotes] = useState('');
  const [decisionType, setDecisionType] = useState('reprioritize');
  const [reason, setReason] = useState('');

  const selectedProject = projects.find((p) => p.id === projectId);
  const tasks = selectedProject?.progress?.tasks || [];

  async function handleSubmit(e) {
    e.preventDefault();
    if (!projectId) { onError('Select a project'); return; }
    if (eventType === 'execution' && !taskId) { onError('Select a task for execution event'); return; }

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    let payload, type;
    if (eventType === 'execution') {
      type = 'execution';
      payload = { taskId, status, notes: notes || undefined };
    } else {
      type = 'decision';
      payload = { decisionType, reason: reason || undefined };
    }
    const event = { id, type, timestamp, projectId, source: 'human', payload };
    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || res.statusText); return; }
      onSuccess();
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <section className="submit-event action-card">
      <h3>Submit event</h3>
      <p className="submit-event-desc">Execution: update task status. Decision: human judgment (reprioritize or kill project).</p>
      <form onSubmit={handleSubmit}>
        <label>
          Event type
          <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="execution">Execution (task status)</option>
            <option value="decision">Decision</option>
          </select>
        </label>
        <label>
          Project
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}>
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title || p.id}</option>
            ))}
          </select>
        </label>
        {eventType === 'execution' && (
          <>
            <label>
              Task
              <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">—</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.title || t.id}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label>
              Notes (optional)
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. blocker reason" />
            </label>
          </>
        )}
        {eventType === 'decision' && (
          <>
            <label>
              Decision
              <select value={decisionType} onChange={(e) => setDecisionType(e.target.value)}>
                <option value="reprioritize">Reprioritize</option>
                <option value="kill_project">Kill project</option>
              </select>
            </label>
            <label>
              Reason (optional)
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </>
        )}
        <button type="submit">Submit</button>
      </form>
    </section>
  );
}

function ProjectCard({ project, recentEvents }) {
  const tasks = project.progress?.tasks || [];
  const risk = project.risk?.level || 'low';
  const reasons = project.risk?.reasons || [];
  const blockers = project.blockers || [];

  return (
    <article className="project-card">
      <h2>{project.title || project.id}</h2>
      <div className="meta">
        <span className="meta-line">
          Project: <strong>{project.id}</strong>
        </span>
        <span className="meta-line">
          Status: <strong>{project.status}</strong>
        </span>
        {(project.department || project.team || project.sponsor) && (
          <span className="meta-line">
            Org: {project.department && <>{project.department}</>}
            {project.team && <> · {project.team}</>}
            {project.sponsor && <> · Sponsor: {project.sponsor}</>}
          </span>
        )}
        {project.lastUpdatedAt && (
          <span className="meta-line">
            Last updated {new Date(project.lastUpdatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {risk !== 'low' && (
        <div className={`risk ${risk}`}>
          Risk: {risk}
          {reasons.length > 0 && ` — ${reasons[reasons.length - 1]}`}
        </div>
      )}

      {tasks.length > 0 && (
        <ul className="tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <div>
                <span className="task-title">{t.title || t.id}</span>
                {t.status && <span className="task-status"> [{t.status}]</span>}
              </div>
              {t.assignee && (
                <div className="task-assignee">
                  Assignee: <strong>{t.assignee.name || t.assignee.id}</strong>
                  {t.assignee.team && ` — ${t.assignee.team}`}
                  {t.assignee.department && ` (${t.assignee.department})`}
                  {t.assignee.role && ` · ${t.assignee.role}`}
                </div>
              )}
              {t.scheduledStart && (
                <div className="task-schedule">
                  Schedule:{' '}
                  {new Date(t.scheduledStart).toLocaleDateString()}–
                  {new Date(t.scheduledEnd || t.scheduledStart).toLocaleDateString()}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {blockers.length > 0 && (
        <div className="blockers">
          <strong>Blockers:</strong>
          <ul>
            {blockers.map((b, i) => (
              <li key={i}>{b.description || b.taskId} ({b.taskId})</li>
            ))}
          </ul>
        </div>
      )}

      {recentEvents.length > 0 && (
        <dl className="recent-events">
          <dt>What changed recently</dt>
          {recentEvents.map((e) => (
            <dd key={e.id}>
              <strong>{e.type}</strong> ({e.source}) — {new Date(e.timestamp).toLocaleString()}
              {e.rationale && ` — ${logMessageShort(e.rationale)}`}
            </dd>
          ))}
        </dl>
      )}
    </article>
  );
}

function OrgInsightsPanel({ orgInsights }) {
  const metrics = orgInsights.metrics;
  const insights = orgInsights.insights || {};
  const projectInsights = insights.projectInsights || [];
  const peopleInsights = insights.peopleInsights || [];
  const generatedAt = orgInsights.insightsGeneratedAt
    ? new Date(orgInsights.insightsGeneratedAt)
    : null;

  // Helper: look up raw metrics for a projectId
  const metricsByProjectId = new Map(
    (metrics.projects || []).map((m) => [m.projectId, m])
  );

  if (!metrics || !Array.isArray(metrics.projects) || metrics.projects.length === 0) {
    return null;
  }

  return (
    <section className="org-insights org-insights-inner">
      <h3>Org insights (AI + metrics)</h3>
      <p className="org-insights-desc">
        Org-level view of project and people health. AI suggests where humans might intervene; it never auto-approves work.
        {generatedAt && (
          <> Last updated {generatedAt.toLocaleTimeString()}.</>
        )}
      </p>

      {projectInsights.length > 0 && (
        <div className="org-section">
          <h3>Projects</h3>
          <ul className="org-list">
            {projectInsights.map((pi) => {
              const m = metricsByProjectId.get(pi.projectId);
              const isKilled = (pi.status || m?.status || '').toLowerCase() === 'killed';
              const isRisk = !isKilled && (pi.riskLevel === 'high' || pi.riskLevel === 'medium');
              const statusDot = isKilled ? 'red' : isRisk ? 'yellow' : 'green';
              return (
              <li key={pi.projectId} className="org-item">
                <div className="org-item-header">
                  <span className={`status-dot status-dot--${statusDot}`} title={isKilled ? 'Killed' : isRisk ? 'At risk' : 'Good'} aria-hidden />
                  <strong>{pi.title || pi.projectId}</strong>
                  {pi.statusSummary && <span className="org-tag">{pi.statusSummary}</span>}
                  {pi.riskLevel && <span className={`org-risk ${pi.riskLevel}`}>{pi.riskLevel}</span>}
                </div>
                {metricsByProjectId.get(pi.projectId) && (() => {
                  const m = metricsByProjectId.get(pi.projectId);
                  const done = m.tasks?.done ?? 0;
                  const total = m.tasks?.total ?? 0;
                  const successPct =
                    total > 0 && m.throughput?.successRate != null
                      ? Math.round(m.throughput.successRate * 100)
                      : null;
                  const blockedPct =
                    total > 0 && m.throughput?.blockedRate != null
                      ? Math.round(m.throughput.blockedRate * 100)
                      : null;
                  const crossTeam = m.collaboration?.crossTeamTasks ?? 0;
                  return (
                    <p className="org-summary">
                      Tasks done: {done}/{total}
                      {successPct != null && ` (${successPct}% success)`}
                      {blockedPct != null && `, ${blockedPct}% blocked`}
                      {crossTeam > 0 && ` · ${crossTeam} cross-team task${crossTeam > 1 ? 's' : ''}`}
                    </p>
                  );
                })()}
                {Array.isArray(pi.keySignals) && pi.keySignals.length > 0 && (
                  <ul className="org-sublist">
                    {pi.keySignals.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
                {Array.isArray(pi.suggestedRequests) && pi.suggestedRequests.length > 0 && (
                  <ul className="org-suggestions">
                    {pi.suggestedRequests.map((sr, i) => (
                      <li key={i}>
                        <strong>{sr.kind}</strong>: {sr.title}
                        {sr.rationale && <span className="org-note"> — {sr.rationale}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
            })}
          </ul>
        </div>
      )}

      {peopleInsights.length > 0 && (
        <div className="org-section">
          <h3>People</h3>
          <ul className="org-list">
            {peopleInsights.map((pi) => (
              <li key={pi.personId || pi.name} className="org-item">
                <div className="org-item-header">
                  <strong>{pi.name || pi.personId}</strong>
                  {pi.loadLevel && <span className="org-tag">{pi.loadLevel}</span>}
                </div>
                {pi.summary && <p className="org-summary">{pi.summary}</p>}
                {Array.isArray(pi.suggestedRequests) && pi.suggestedRequests.length > 0 && (
                  <ul className="org-suggestions">
                    {pi.suggestedRequests.map((sr, i) => (
                      <li key={i}>
                        <strong>{sr.kind}</strong>: {sr.title}
                        {sr.rationale && <span className="org-note"> — {sr.rationale}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
