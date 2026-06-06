/**
 * Leadership View — read-only summary + minimal forms to submit:
 * - new work requests
 * - execution / decision events
 *
 * AI owns planning, assignment, and scheduling; humans own execution and judgment.
 */

import { useState, useEffect, useCallback } from 'react';
import HelpChat from './HelpChat';
import WorkforcePanel from './WorkforcePanel';
import ProjectsPanel from './ProjectsPanel';
import RevenuePanel from './RevenuePanel';
import { logMessageShort, isRecentChangeEvent, recentEventSummary } from './recentEvents';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WORKER_PORTAL_URL =
  import.meta.env.VITE_WORKER_PORTAL_URL || 'http://localhost:5174';
const MONITOR_PORTAL_URL =
  import.meta.env.VITE_MONITOR_PORTAL_URL || 'http://localhost:5175';
const THEME_STORAGE_KEY = 'leadership-view-theme';

function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

applyTheme(getStoredTheme());

async function fetchJson(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function randomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function App() {
  const [theme, setTheme] = useState(getStoredTheme);
  const [projects, setProjects] = useState([]);
  const [eventsByProject, setEventsByProject] = useState({});
  const [orgInsights, setOrgInsights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitStatus, setSubmitStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [logProjectId, setLogProjectId] = useState('');
  const [logEvents, setLogEvents] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [llmProjectId, setLlmProjectId] = useState('');
  const [llmLogs, setLlmLogs] = useState([]);
  const [llmLoading, setLlmLoading] = useState(false);
  const [needs, setNeeds] = useState([]);
  const [needsLoading, setNeedsLoading] = useState(false);
  const [pendingNeedsCount, setPendingNeedsCount] = useState(0);
  const [aiHandlerAutomatic, setAiHandlerAutomatic] = useState(false);
  const [aiHandlerSaving, setAiHandlerSaving] = useState(false);
  const [workforce, setWorkforce] = useState(null);
  const [workforceLoading, setWorkforceLoading] = useState(false);
  const [workforceError, setWorkforceError] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [revenueError, setRevenueError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [projectsRes, eventsRes] = await Promise.all([
        fetchJson('/events/projects'),
        fetchJson('/events?recentChanges=1&limit=300'),
      ]);
      const list = (projectsRes.projects || [])
        .slice()
        .sort((a, b) => {
          const ta = a.lastUpdatedAt ? new Date(a.lastUpdatedAt).getTime() : 0;
          const tb = b.lastUpdatedAt ? new Date(b.lastUpdatedAt).getTime() : 0;
          return tb - ta; // latest first
        });
      setProjects(list);
      const events = (eventsRes.events || []).filter(isRecentChangeEvent);
      const byProject = {};
      for (const e of events) {
        const pid = e.projectId;
        if (!byProject[pid]) byProject[pid] = [];
        byProject[pid].push(e);
      }
      for (const pid of Object.keys(byProject)) {
        byProject[pid].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        byProject[pid] = byProject[pid].slice(0, 15);
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

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    fetch(`${API_BASE}/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'leadership', preferences: { theme } }),
    }).catch(() => {});
  }, [theme]);

  const refreshNeeds = useCallback(async () => {
    try {
      const [summary, data] = await Promise.all([
        fetchJson('/events/needs/summary'),
        fetchJson('/events/needs'),
      ]);
      setPendingNeedsCount(summary.pending ?? 0);
      if (summary.aiHandlerAutomatic != null) setAiHandlerAutomatic(!!summary.aiHandlerAutomatic);
      const list = (data.needs || []).slice().sort((a, b) => {
        const pending = (s) => (['open', 'in_review'].includes(s) ? 0 : 1);
        const pa = pending(a.status);
        const pb = pending(b.status);
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
      setNeeds(list);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/preferences?personId=leadership`)
      .then((r) => r.json())
      .then((d) => {
        const t = d?.preferences?.theme;
        if (t === 'light' || t === 'dark') setTheme(t);
        const ah = d?.preferences?.aiHandlerAutomatic;
        if (ah === true || ah === 'true') setAiHandlerAutomatic(true);
        if (ah === false || ah === 'false') setAiHandlerAutomatic(false);
      })
      .catch(() => {});
    refreshNeeds();
  }, [refreshNeeds]);

  const toggleTheme = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

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
        if (activeTab === 'workforce') {
          fetchJson('/workforce/analytics')
            .then(setWorkforce)
            .catch((e) => setWorkforceError(e.message));
        }
        if (activeTab === 'revenue') {
          fetchJson('/revenue/analytics')
            .then(setRevenue)
            .catch((e) => setRevenueError(e.message));
        }
      }, 350);
    };

    const es = new EventSource(`${API_BASE}/events/stream`);
    es.addEventListener('event', (ev) => {
      scheduleRefresh();
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data.type === 'need') refreshNeeds();
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('needs', (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (typeof data.pending === 'number') setPendingNeedsCount(data.pending);
        if (activeTab === 'needs') refreshNeeds();
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('ready', () => {});
    es.onerror = () => {
      // If SSE drops, the UI still works; user can refresh or we can add polling later.
    };

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [load, activeTab, refreshNeeds]);

  useEffect(() => {
    if (activeTab !== 'workforce') return undefined;
    let cancelled = false;
    setWorkforceLoading(true);
    setWorkforceError(null);
    fetchJson('/workforce/analytics')
      .then((data) => {
        if (!cancelled) setWorkforce(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setWorkforceError(err.message);
          setWorkforce(null);
        }
      })
      .finally(() => {
        if (!cancelled) setWorkforceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'revenue') return undefined;
    let cancelled = false;
    setRevenueLoading(true);
    setRevenueError(null);
    fetchJson('/revenue/analytics')
      .then((data) => {
        if (!cancelled) setRevenue(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setRevenueError(err.message);
          setRevenue(null);
        }
      })
      .finally(() => {
        if (!cancelled) setRevenueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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
        const events = (eventsData.events || []).filter(
          (e) =>
            ['orchestrator', 'team_builder', 'scheduler', 'project_ai'].includes(e.source) ||
            (e.type === 'decision' && e.payload?.decisionType === 'project_assessment')
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

  useEffect(() => {
    if (activeTab !== 'needs') return undefined;
    let cancelled = false;
    setNeedsLoading(true);
    refreshNeeds().finally(() => {
      if (!cancelled) setNeedsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, refreshNeeds]);

  const setAiHandler = async (enabled) => {
    setAiHandlerSaving(true);
    try {
      await fetch(`${API_BASE}/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personId: 'leadership',
          preferences: { aiHandlerAutomatic: enabled },
        }),
      });
      setAiHandlerAutomatic(enabled);
      if (enabled) {
        setTimeout(() => refreshNeeds(), 2500);
      }
    } catch (e) {
      setSubmitStatus(e.message);
    } finally {
      setAiHandlerSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const onSuccess = () => {
    setSubmitStatus('ok');
    load();
  };
  const onError = (msg) => setSubmitStatus(msg);

  return (
    <div className="app">
      <HelpChat projects={projects} />
      <header className="app-header">
        <div className="app-header-top">
          <div className="app-header-brand">
            <h1>Leadership View</h1>
            <p className="subtitle">What is happening, why, and what changed recently.</p>
          </div>
          <div className="app-header-actions">
            <a
              href={MONITOR_PORTAL_URL}
              className="portal-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Ops Monitor
            </a>
            <a
              href={WORKER_PORTAL_URL}
              className="portal-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Worker Portal
            </a>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              <span className="theme-toggle-icon" aria-hidden="true">
                {theme === 'dark' ? '☀' : '☾'}
              </span>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>
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
            {projects.filter((p) => (p.status || 'active') === 'active' && !p.archived).length > 0 && (
              <span className="nav-badge">
                {projects.filter((p) => (p.status || 'active') === 'active' && !p.archived).length}
              </span>
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
          <button
            type="button"
            className={`nav-tab ${activeTab === 'workforce' ? 'active' : ''}`}
            onClick={() => setActiveTab('workforce')}
          >
            Workforce
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === 'revenue' ? 'active' : ''}`}
            onClick={() => setActiveTab('revenue')}
          >
            Revenue
            {revenue?.openBudgetRequests > 0 && (
              <span className="nav-tab-badge" aria-label={`${revenue.openBudgetRequests} open budget requests`}>
                {revenue.openBudgetRequests > 99 ? '99+' : revenue.openBudgetRequests}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`nav-tab nav-tab--needs ${activeTab === 'needs' ? 'active' : ''}`}
            onClick={() => setActiveTab('needs')}
          >
            Worker requests
            {pendingNeedsCount > 0 && (
              <span className="nav-tab-badge" aria-label={`${pendingNeedsCount} pending requests`}>
                {pendingNeedsCount > 99 ? '99+' : pendingNeedsCount}
              </span>
            )}
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
          <ProjectsPanel
            projects={projects}
            eventsByProject={eventsByProject}
            apiBase={API_BASE}
            onRefresh={load}
            onError={onError}
          />
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
                  <p className="empty">No AI agent activity for this project yet. Select a project to see orchestrator, team_builder, scheduler, project_ai, org_ai, and mock_worker NPC logs.</p>
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
              <p className="empty">Select a project above to see AI agent logs (orchestrator, team_builder, scheduler, project_ai, org_ai, mock_worker).</p>
            )}
          </section>
        )}

        {activeTab === 'workforce' && (
          <section className="app-section" aria-labelledby="section-workforce">
            <h2 id="section-workforce" className="section-title">Workforce analytics</h2>
            <WorkforcePanel
              data={workforce}
              loading={workforceLoading}
              error={workforceError}
              apiBase={API_BASE}
              onHired={() => {
                fetchJson('/workforce/analytics')
                  .then(setWorkforce)
                  .catch(() => {});
                load();
              }}
              onError={onError}
            />
          </section>
        )}

        {activeTab === 'revenue' && (
          <section className="app-section" aria-labelledby="section-revenue">
            <h2 id="section-revenue" className="section-title">Revenue &amp; project budgets</h2>
            <p className="section-desc">
              Track portfolio spend, burn budget on delivery, request increases when utilization is high, and review
              the financial matrix across projects and departments.
            </p>
            <RevenuePanel
              data={revenue}
              loading={revenueLoading}
              error={revenueError}
              apiBase={API_BASE}
              onRefresh={() => {
                fetchJson('/revenue/analytics')
                  .then(setRevenue)
                  .catch(() => {});
                load();
                refreshNeeds();
              }}
              onError={onError}
            />
          </section>
        )}

        {activeTab === 'needs' && (
          <section className="app-section" aria-labelledby="section-needs">
            <div className="needs-section-head">
              <div>
                <h2 id="section-needs" className="section-title">Worker requests</h2>
                <p className="section-desc">
                  Track worker and project requests. With AI Handler on, routine items (approvals, legal sign-off,
                  scheduling) are resolved automatically—no manual Approve/Reject queue.
                  {pendingNeedsCount > 0 && (
                    <> <strong>{pendingNeedsCount} pending</strong> need your attention when AI Handler is off.</>
                  )}
                </p>
              </div>
              <label className="ai-handler-toggle">
                <input
                  type="checkbox"
                  checked={aiHandlerAutomatic}
                  disabled={aiHandlerSaving}
                  onChange={(e) => setAiHandler(e.target.checked)}
                />
                <span>AI Handler (automatic)</span>
              </label>
            </div>
            {needsLoading ? (
              <p className="empty">Loading…</p>
            ) : needs.length === 0 ? (
              <p className="empty">No worker requests yet.</p>
            ) : (
              <ul className="log-list needs-list">
                {needs.map((n) => (
                  <li key={n.id} className="log-entry needs-item">
                    <div className="needs-item-header">
                      <span className={`needs-status needs-status--${n.status}`}>{n.status}</span>
                      <strong>{n.title || n.kind}</strong>
                      <span className="needs-kind">{n.kind}</span>
                      {(n.handlingMode === 'ai' || n.aiAutoApproved || n.aiHandlerResolved) && (
                        <span className="needs-kind needs-ai-badge">AI handled</span>
                      )}
                    </div>
                    <span className="log-meta">
                      {n.submitterName && <>From {n.submitterName} · </>}
                      {n.projectId} — {new Date(n.createdAt).toLocaleString()}
                    </span>
                    {n.forwardsTo && (
                      <p className="needs-routing">Routes to: {n.forwardsTo}</p>
                    )}
                    {n.roleAssignments?.length > 0 && (
                      <p className="needs-routing">
                        Review tasks:{' '}
                        {n.roleAssignments.map((a) => `${a.roleLabel || 'review'} → ${a.assigneeName || a.assigneeId}`).join('; ')}
                      </p>
                    )}
                    <span className="log-message">{n.description}</span>
                    {n.reviewedByName && (
                      <p className="needs-review-notes">
                        {n.status} by {n.reviewedByName}
                        {n.reviewNotes ? ` — ${n.reviewNotes}` : ''}
                      </p>
                    )}
                    {n.effectsError && (
                      <p className="needs-routing needs-routing--error">
                        Effects not fully applied: {n.effectsError}
                      </p>
                    )}
                    {n.effectsApplied?.staffing && (
                      <p className="needs-routing">
                        Staffing: {n.effectsApplied.staffing.assigned ?? 0} task(s) assigned
                        {n.effectsApplied.staffing.replanned ? ' · replan triggered' : ''}
                      </p>
                    )}
                    {n.effectsApplied?.teamMember?.targetPersonName && (
                      <p className="needs-routing">
                        Applied: {n.effectsApplied.teamMember.targetPersonName}
                        {n.effectsApplied.teamMember.addedToTeam
                          ? ' added to project team'
                          : n.effectsApplied.teamMember.alreadyOnTeam
                            ? ' already on project team'
                            : ''}
                        {n.effectsApplied.teamMember.tasksAssigned?.length > 0
                          ? ` · ${n.effectsApplied.teamMember.tasksAssigned.length} task(s) assigned`
                          : ''}
                      </p>
                    )}
                    {n.effectsApplied?.taskCount > 0 && (
                      <p className="needs-routing">
                        Applied: unassigned from {n.effectsApplied.taskCount} task(s)
                        {n.effectsApplied.projectsCleared?.length
                          ? ` (${n.effectsApplied.projectsCleared.join(', ')})`
                          : ''}
                      </p>
                    )}
                    {(n.hrHiringQueue || n.hiringRequirements) && (
                      <p className="needs-routing">
                        HR hiring queue ({n.hiringStatus || 'pending'}):{' '}
                        {n.hiredPersonName
                          ? `Hired ${n.hiredPersonName}`
                          : n.hiringRequirements || 'See Worker Portal → HR tab'}
                      </p>
                    )}
                    {n.hiringResult?.personName && (
                      <p className="needs-routing needs-routing--ok">
                        AI Handler hired {n.hiringResult.personName}
                        {n.hiringResult.matchScore != null ? ` (match ${n.hiringResult.matchScore})` : ''}
                      </p>
                    )}
                    {!aiHandlerAutomatic &&
                      n.handlingMode !== 'ai' &&
                      !n.aiAutoApproved &&
                      !n.aiHandlerResolved &&
                      ['open', 'in_review'].includes(n.status) && (
                      <div className="needs-actions">
                        {n.kind === 'budget_request' && (
                          <button
                            type="button"
                            className="nav-tab"
                            style={{ marginBottom: 0 }}
                            onClick={async () => {
                              try {
                                await fetchJson(`/revenue/budget-requests/${n.id}/approve`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ reviewerName: 'Leadership' }),
                                });
                                await refreshNeeds();
                                fetchJson('/revenue/analytics').then(setRevenue).catch(() => {});
                                load();
                              } catch (e) {
                                onError(e.message);
                              }
                            }}
                          >
                            Approve budget
                          </button>
                        )}
                        <button
                          type="button"
                          className="nav-tab"
                          style={{ marginBottom: 0 }}
                          onClick={async () => {
                            try {
                              await fetchJson(`/events/needs/${n.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'in_review', reviewedBy: 'leadership' }),
                              });
                              await refreshNeeds();
                            } catch (e) {
                              onError(e.message);
                            }
                          }}
                        >
                          In review
                        </button>
                        <button
                          type="button"
                          className="nav-tab"
                          style={{ marginBottom: 0 }}
                          onClick={async () => {
                            try {
                              await fetchJson(`/events/needs/${n.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'approved', reviewedBy: 'leadership' }),
                              });
                              await refreshNeeds();
                              load();
                            } catch (e) {
                              onError(e.message);
                            }
                          }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="nav-tab"
                          style={{ marginBottom: 0 }}
                          onClick={async () => {
                            try {
                              await fetchJson(`/events/needs/${n.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'rejected', reviewedBy: 'leadership' }),
                              });
                              await refreshNeeds();
                              load();
                            } catch (e) {
                              onError(e.message);
                            }
                          }}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="nav-tab"
                          style={{ marginBottom: 0 }}
                          onClick={async () => {
                            try {
                              await fetchJson(`/events/needs/${n.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'met', reviewedBy: 'leadership' }),
                              });
                              await refreshNeeds();
                              load();
                            } catch (e) {
                              onError(e.message);
                            }
                          }}
                        >
                          Close
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
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
  const [requestAssignment, setRequestAssignment] = useState(false);
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
      payload = {
        taskId,
        status,
        notes: notes || undefined,
        requestAssignment: requestAssignment || undefined,
      };
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
      <p className="submit-event-desc">
        Execution: update task status. To clear a blocker, set the task to In progress or Done (not Blocked).
        Optionally request AI to assign unassigned tasks (Team Builder only — no full replan).
        Decision: human judgment (reprioritize or kill project).
      </p>
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
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={requestAssignment}
                onChange={(e) => setRequestAssignment(e.target.checked)}
              />
              Request AI to assign unassigned tasks on this project
            </label>
          </>
        )}
        {eventType === 'decision' && (
          <>
            <label>
              Decision
              <select value={decisionType} onChange={(e) => setDecisionType(e.target.value)}>
                <option value="reprioritize">Reprioritize</option>
                <option value="complete">Mark project completed</option>
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
            {peopleInsights.map((pi) => {
              const onLeave =
                pi.loadLevel === 'on_leave' || pi.availabilityStatus === 'on_leave';
              const loadLabel =
                pi.loadLevel === 'on_leave'
                  ? 'on leave'
                  : pi.loadLevel === 'emergency_return'
                    ? 'emergency return'
                    : pi.loadLevel;
              return (
              <li key={pi.personId || pi.name} className="org-item">
                <div className="org-item-header">
                  <strong>{pi.name || pi.personId}</strong>
                  {loadLabel && (
                    <span className={`org-tag${onLeave ? ' org-tag--leave' : ''}`}>{loadLabel}</span>
                  )}
                  {pi.availabilityReason && onLeave && (
                    <span className="org-tag org-tag--leave-reason">{pi.availabilityReason}</span>
                  )}
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
            );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
