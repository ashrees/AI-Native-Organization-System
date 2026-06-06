/**
 * Human Worker Portal — standalone app (worker/).
 * Login by name, view assignments, update status, submit HR/ops requests.
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchJson } from './api';

const SESSION_KEY = 'worker-portal-person-id';
const THEME_KEY = 'worker-portal-theme';
const LEADERSHIP_URL =
  import.meta.env.VITE_LEADERSHIP_URL || 'http://localhost:5173';
const MONITOR_URL =
  import.meta.env.VITE_MONITOR_PORTAL_URL || 'http://localhost:5175';

const API_WORKER = '/worker';

function getStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

applyTheme(getStoredTheme());

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusLabel(s) {
  if (!s || s === 'pending') return 'Pending';
  return s.replace(/_/g, ' ');
}

function filterPeopleLocally(allPeople, query) {
  const q = query.trim().toLowerCase();
  if (!q) return allPeople;
  const terms = q.split(/\s+/).filter(Boolean);
  return allPeople.filter((p) => {
    const hay = `${p.name} ${p.department} ${p.team} ${p.role} ${p.id}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

function LoginScreen({ onLogin }) {
  const [query, setQuery] = useState('');
  const [allPeople, setAllPeople] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`${API_WORKER}/people`)
      .then((data) => {
        if (cancelled) return;
        const list = data.people || [];
        setAllPeople(list);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAllPeople([]);
        const msg =
          err.message === 'Not Found'
            ? 'Worker API is unavailable. Restart the API server from the project root: npm start'
            : err.message;
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (error) {
      setPeople([]);
      return;
    }
    setPeople(filterPeopleLocally(allPeople, query));
  }, [query, allPeople, error]);

  return (
    <div className="worker-login">
      <div className="worker-login-card">
        <h1>Worker Portal</h1>
        <p className="worker-login-desc">
          Sign in with your name to view assignments, update task status, and submit requests.
        </p>
        <label className="worker-label">
          Your name
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(null);
            }}
            placeholder="Search your name…"
            autoComplete="name"
            autoFocus
          />
        </label>
        {error && <p className="worker-error">{error}</p>}
        {loading && <p className="worker-muted">Loading team directory…</p>}
        {!loading && !error && allPeople.length > 0 && !query.trim() && (
          <p className="worker-muted">Select your name below ({allPeople.length} people in directory).</p>
        )}
        <ul className="worker-people-list">
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" className="worker-person-btn" onClick={() => onLogin(p)}>
                <span className="worker-person-name">{p.name}</span>
                <span className="worker-person-meta">
                  {p.role} · {p.department} / {p.team}
                </span>
                <span className="worker-person-load">Load: {p.currentLoad}</span>
              </button>
            </li>
          ))}
        </ul>
        {!loading && !error && query.trim() && people.length === 0 && (
          <p className="worker-muted">No matching people for “{query.trim()}”. Try first name only.</p>
        )}
        <a className="worker-external-link" href={LEADERSHIP_URL}>
          Leadership View →
        </a>
      </div>
    </div>
  );
}

/** Overview: task summary only — status updates live on the Tasks tab. */
function TaskPreviewCard({ task, onOpenTasks }) {
  const status = task.status || 'pending';
  return (
    <article className={`worker-task worker-task--preview worker-task--${status}`}>
      <header className="worker-task-head">
        <h3>{task.title}</h3>
        <span className={`worker-pill worker-pill--status-${status}`}>{statusLabel(status)}</span>
      </header>
      <p className="worker-task-project">{task.projectTitle}</p>
      {task.description && <p className="worker-task-desc">{task.description}</p>}
      {(task.scheduledStart || task.scheduledEnd) && (
        <p className="worker-task-schedule">
          {formatDate(task.scheduledStart)} — {formatDate(task.scheduledEnd)}
        </p>
      )}
      <button type="button" className="worker-btn worker-btn--secondary worker-btn--sm" onClick={onOpenTasks}>
        Update status in Tasks →
      </button>
    </article>
  );
}

function TaskCard({ task, personId, onUpdated }) {
  const [status, setStatus] = useState(task.status || 'pending');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submitStatus(nextStatus) {
    setSaving(true);
    setMsg(null);
    try {
      await fetchJson(`${API_WORKER}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: task.projectId,
          taskId: task.id,
          personId,
          status: nextStatus,
          notes: notes.trim() || undefined,
        }),
      });
      setStatus(nextStatus);
      setMsg('Saved');
      onUpdated();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`worker-task worker-task--${status || 'pending'}`}>
      <header className="worker-task-head">
        <h3>{task.title}</h3>
        <span className={`worker-pill worker-pill--${task.projectStatus}`}>{task.projectStatus}</span>
      </header>
      <p className="worker-task-project">{task.projectTitle}</p>
      {task.description && <p className="worker-task-desc">{task.description}</p>}
      {(task.scheduledStart || task.scheduledEnd) && (
        <p className="worker-task-schedule">
          Schedule: {formatDate(task.scheduledStart)} — {formatDate(task.scheduledEnd)}
        </p>
      )}
      <p className="worker-task-current">
        Current: <span className={`worker-pill worker-pill--status-${status}`}>{statusLabel(status)}</span>
      </p>
      <label className="worker-label worker-label--inline">
        Notes (optional)
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={status === 'blocked' ? 'What is blocking you?' : 'Update notes'}
        />
      </label>
      <div className="worker-btn-group" role="group" aria-label="Update task status">
        <button
          type="button"
          className={`worker-btn worker-btn--secondary ${status === 'in_progress' ? 'is-active' : ''}`}
          disabled={saving}
          onClick={() => submitStatus('in_progress')}
        >
          In progress
        </button>
        <button
          type="button"
          className={`worker-btn worker-btn--success ${status === 'done' ? 'is-active' : ''}`}
          disabled={saving}
          onClick={() => submitStatus('done')}
        >
          Done
        </button>
        <button
          type="button"
          className={`worker-btn worker-btn--danger ${status === 'blocked' ? 'is-active' : ''}`}
          disabled={saving}
          onClick={() => submitStatus('blocked')}
        >
          Blocked
        </button>
      </div>
      {msg && <p className={msg === 'Saved' ? 'worker-ok' : 'worker-error'}>{msg}</p>}
    </article>
  );
}

const HANDLING_LABELS = { ai: 'AI agents', notify: 'Notify teams', self: 'Self-manage' };

const DEFAULT_MODE_BY_KIND = {
  sick_leave: 'ai',
  vacation: 'ai',
  workload_concern: 'notify',
  blocker_escalation: 'notify',
  project_transfer: 'notify',
  schedule_change: 'ai',
  general: 'notify',
};

function RequestForm({ dashboard, personId, onSubmitted }) {
  const [kind, setKind] = useState('general');
  const [handlingMode, setHandlingMode] = useState(DEFAULT_MODE_BY_KIND.general);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('org-general');
  const [taskId, setTaskId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState(null);

  const kinds = dashboard.requestKinds || [];
  const modes = dashboard.handlingModes || [];
  const selectedKind = kinds.find((k) => k.id === kind);
  const projectOptions = [
    { id: 'org-general', title: 'General / HR (no specific project)' },
    ...(dashboard.projects || []).map((p) => ({ id: p.id, title: p.title })),
  ];
  const tasksForProject = (dashboard.tasks || []).filter((t) => t.projectId === projectId);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus(null);
    try {
      await fetchJson(`${API_WORKER}/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personId,
          kind,
          handlingMode,
          title,
          description,
          projectId: projectId === 'org-general' ? undefined : projectId,
          taskId: taskId || undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        }),
      });
      setTitle('');
      setDescription('');
      setStartDate('');
      setEndDate('');
      setTaskId('');
      setStatus('ok');
      onSubmitted();
    } catch (err) {
      setStatus(err.message);
    }
  }

  return (
    <form className="worker-request-form" onSubmit={handleSubmit}>
      <h3>New request</h3>
      <p className="worker-muted">Sick leave, transfers, workload, schedule changes, and more.</p>
      <fieldset className="worker-handling-modes">
        <legend className="worker-label">How should this be handled?</legend>
        {modes.map((m) => (
          <label key={m.id} className="worker-radio">
            <input
              type="radio"
              name="handlingMode"
              value={m.id}
              checked={handlingMode === m.id}
              onChange={() => setHandlingMode(m.id)}
            />
            <span>
              <strong>{m.label}</strong>
              <span className="worker-muted"> — {m.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="worker-label">
        Request type
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value;
            setKind(next);
            setHandlingMode(DEFAULT_MODE_BY_KIND[next] || 'notify');
          }}
        >
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {selectedKind?.forwardsTo && (
        <p className="worker-routing-hint">
          Forwards to: <strong>{selectedKind.forwardsTo}</strong>
          {selectedKind.aiAgent && (
            <span className="worker-muted"> · coordinated by {selectedKind.aiAgent}</span>
          )}
        </p>
      )}
      <label className="worker-label">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Short summary" />
      </label>
      <label className="worker-label">
        Details
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Describe your request…"
        />
      </label>
      <label className="worker-label">
        Related project
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </label>
      {tasksForProject.length > 0 && (
        <label className="worker-label">
          Related task (optional)
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">— None —</option>
            {tasksForProject.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </label>
      )}
      <div className="worker-date-row">
        <label className="worker-label">
          Start date
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="worker-label">
          End date
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="worker-btn worker-btn--primary">Submit request</button>
      {status === 'ok' && (
        <p className="worker-ok">
          Request submitted ({HANDLING_LABELS[handlingMode] || handlingMode}). Routed to:{' '}
          {selectedKind?.forwardsTo || 'mapped roles'}.
        </p>
      )}
      {status && status !== 'ok' && <p className="worker-error">{status}</p>}
    </form>
  );
}

function RequestRow({ r }) {
  return (
    <li>
      <span className={`worker-pill worker-pill--req-${r.status || 'open'}`}>{r.status || 'open'}</span>
      <strong>{r.title}</strong>
      <span className="worker-req-kind">{r.kind}</span>
      <span className="worker-req-kind"> · {HANDLING_LABELS[r.handlingMode] || r.handlingMode}</span>
      {(r.forwardsTo || r.routingLabel) && (
        <span className="worker-muted"> → {r.forwardsTo || r.routingLabel}</span>
      )}
      {r.aiAgent && <span className="worker-muted"> · {r.aiAgent}</span>}
      <p>{r.description}</p>
      {(r.forwardTargets?.length || r.notifyTargets?.length) > 0 && (
        <p className="worker-muted">
          Forwarded to: {(r.forwardTargets || r.notifyTargets).map((t) =>
            t.roleLabel ? `${t.name} (${t.roleLabel})` : t.name
          ).join(', ')}
        </p>
      )}
      {r.roleAssignments?.length > 0 && (
        <p className="worker-muted">
          AI tasks: {r.roleAssignments.map((a) => `${a.roleLabel || 'review'} → ${a.assigneeName || a.assigneeId}`).join('; ')}
        </p>
      )}
      {r.aiHandlerWatching && r.status !== 'approved' && (
        <p className="worker-muted">AI Handler is monitoring — {r.aiHandlerOversightReason || 'awaiting team review'}.</p>
      )}
      {r.oversight && (
        <p className="worker-muted">Oversight: {r.oversight.reason || r.oversight.action}</p>
      )}
      {(r.aiAutoApproved || r.handlingMode === 'ai') && r.status === 'approved' && (
        <p className="worker-ok">Handled autonomously by {r.reviewedByName || r.autoApprovedByName || 'Org AI'}</p>
      )}
      {r.reviewedByName && ['approved', 'rejected', 'met'].includes(r.status) && !r.aiAutoApproved && (
        <p className="worker-ok">
          {r.status} by {r.reviewedByName}
          {r.reviewNotes ? ` — ${r.reviewNotes}` : ''}
        </p>
      )}
      {r.effectsApplied?.taskCount > 0 && (
        <p className="worker-muted">
          System updated: removed from {r.effectsApplied.taskCount} task(s)
          {r.effectsApplied.projectsCleared?.length
            ? ` on ${r.effectsApplied.projectsCleared.join(', ')}`
            : ''}
        </p>
      )}
      {r.reviewNotes && !r.reviewedByName && <p className="worker-ok">Notes: {r.reviewNotes}</p>}
      <span className="worker-muted">{formatDate(r.timestamp)} · {r.projectId}</span>
    </li>
  );
}

function RequestReviewActions({ requestId, personId, notes, setNotes, onDone, msg, setMsg }) {
  async function review(status) {
    setMsg(null);
    try {
      await fetchJson(`${API_WORKER}/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          reviewerPersonId: personId,
          reviewNotes: notes[requestId] || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setMsg(e.message);
    }
  }

  return (
    <>
      {msg && <p className="worker-error">{msg}</p>}
      <label className="worker-label">
        Review notes
        <input
          value={notes[requestId] || ''}
          onChange={(e) => setNotes((n) => ({ ...n, [requestId]: e.target.value }))}
          placeholder="Decision or next steps for the employee"
        />
      </label>
      <div className="worker-btn-group worker-btn-group--wrap">
        <button type="button" className="worker-btn worker-btn--secondary" onClick={() => review('in_review')}>
          In review
        </button>
        <button type="button" className="worker-btn worker-btn--success" onClick={() => review('approved')}>
          Approve
        </button>
        <button type="button" className="worker-btn worker-btn--danger" onClick={() => review('rejected')}>
          Reject
        </button>
        <button type="button" className="worker-btn worker-btn--ghost" onClick={() => review('met')}>
          Close
        </button>
      </div>
    </>
  );
}

function ProjectReviewInbox({ personId, onUpdated }) {
  const [inbox, setInbox] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState({});
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchJson(`${API_WORKER}/project/inbox?personId=${encodeURIComponent(personId)}`)
      .then((d) => setInbox(d.inbox || []))
      .catch(() => setInbox([]))
      .finally(() => setLoading(false));
  }, [personId]);

  useEffect(() => {
    load();
  }, [load, onUpdated]);

  if (loading) return <p className="worker-muted">Loading project reviews…</p>;

  return (
    <section>
      <h2>Project reviews</h2>
      <p className="worker-muted">
        Manage workload, contribution, and blocker requests assigned to you. Approve or reject to close review tasks.
      </p>
      <ul className="worker-request-list">
        {inbox.map((r) => (
          <li key={r.id} className="worker-hr-item">
            <RequestRow r={r} />
            <p className="worker-muted">From: {r.submitterName || r.submitterId}</p>
            {r.handlingMode === 'ai' || r.aiAutoApproved ? (
              <p className="worker-muted">This request was handled autonomously by Org AI.</p>
            ) : (
              <RequestReviewActions
                requestId={r.id}
                personId={personId}
                notes={notes}
                setNotes={setNotes}
                onDone={() => {
                  load();
                  onUpdated();
                }}
                msg={msg}
                setMsg={setMsg}
              />
            )}
          </li>
        ))}
      </ul>
      {inbox.length === 0 && (
        <p className="worker-muted">No project-scoped requests assigned to you right now.</p>
      )}
    </section>
  );
}

function HrEmergencyPanel({ personId, onUpdated }) {
  const [onLeave, setOnLeave] = useState([]);
  const [reason, setReason] = useState({});
  const [projectId, setProjectId] = useState({});
  const [taskId, setTaskId] = useState({});
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetchJson(`${API_WORKER}/hr/on-leave?personId=${encodeURIComponent(personId)}`)
      .then((d) => setOnLeave(d.people || []))
      .catch(() => setOnLeave([]));
  }, [personId, onUpdated]);

  async function activate(targetId) {
    setMsg(null);
    try {
      await fetchJson(`${API_WORKER}/hr/emergency-activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hrPersonId: personId,
          targetPersonId: targetId,
          reason: reason[targetId] || 'Emergency operational need',
          projectId: projectId[targetId] || undefined,
          taskId: taskId[targetId] || undefined,
        }),
      });
      onUpdated();
      const d = await fetchJson(`${API_WORKER}/hr/on-leave?personId=${encodeURIComponent(personId)}`);
      setOnLeave(d.people || []);
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function endEmergency(targetId, returnTo) {
    setMsg(null);
    try {
      await fetchJson(`${API_WORKER}/hr/emergency-end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hrPersonId: personId,
          targetPersonId: targetId,
          returnTo,
          reason: reason[targetId] || undefined,
        }),
      });
      onUpdated();
      const d = await fetchJson(`${API_WORKER}/hr/on-leave?personId=${encodeURIComponent(personId)}`);
      setOnLeave(d.people || []);
    } catch (e) {
      setMsg(e.message);
    }
  }

  const needsAction = onLeave.filter((p) => p.availabilityStatus === 'on_leave');
  const inEmergency = onLeave.filter((p) => p.availabilityStatus === 'emergency_active');
  if (needsAction.length === 0 && inEmergency.length === 0) return null;

  return (
    <div className="worker-hr-emergency">
      <h3>Emergency return to work</h3>
      <p className="worker-muted">
        Authorize someone on sick leave or PTO to work temporarily. Original leave stays on record until you end emergency or close leave.
      </p>
      {msg && <p className="worker-error">{msg}</p>}
      {needsAction.map((p) => (
        <div key={p.id} className="worker-hr-emergency-card">
          <strong>{p.name}</strong>
          <span className="worker-muted"> — on leave ({p.availabilityReason || 'leave'})</span>
          <label className="worker-label">
            Reason
            <input
              value={reason[p.id] || ''}
              onChange={(e) => setReason((r) => ({ ...r, [p.id]: e.target.value }))}
              placeholder="e.g. Production outage needs database lead"
            />
          </label>
          <label className="worker-label">
            Project id (optional)
            <input
              value={projectId[p.id] || ''}
              onChange={(e) => setProjectId((r) => ({ ...r, [p.id]: e.target.value }))}
              placeholder="proj-native-app"
            />
          </label>
          <label className="worker-label">
            Task id (optional)
            <input
              value={taskId[p.id] || ''}
              onChange={(e) => setTaskId((r) => ({ ...r, [p.id]: e.target.value }))}
              placeholder="task-12"
            />
          </label>
          <button type="button" className="worker-btn worker-btn--primary" onClick={() => activate(p.id)}>
            Authorize emergency work
          </button>
        </div>
      ))}
      {inEmergency.map((p) => (
        <div key={p.id} className="worker-hr-emergency-card worker-hr-emergency-card--active">
          <strong>{p.name}</strong>
          <span className="worker-muted"> — emergency work active</span>
          <div className="worker-btn-group worker-btn-group--wrap">
            <button type="button" className="worker-btn worker-btn--secondary" onClick={() => endEmergency(p.id, 'leave')}>
              End emergency → on leave
            </button>
            <button type="button" className="worker-btn worker-btn--success" onClick={() => endEmergency(p.id, 'active')}>
              End emergency → returned
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const HR_HIRE_PROFILES = [
  { id: 'data', label: 'Data / ML' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'legal', label: 'Legal' },
  { id: 'security', label: 'Security' },
  { id: 'ai', label: 'AI/ML' },
  { id: 'hr', label: 'Human Resources' },
  { id: 'finance', label: 'Finance' },
  { id: 'marketing', label: 'Marketing' },
];

function HrHiringPanel({ personId, onUpdated, draft }) {
  const [profileId, setProfileId] = useState(draft?.profileId || 'data');
  const [requirements, setRequirements] = useState(draft?.requirements || '');
  const [projectId, setProjectId] = useState(draft?.projectId || '');
  const [linkedNeedId, setLinkedNeedId] = useState(draft?.needId || '');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!draft) return;
    if (draft.profileId) setProfileId(draft.profileId);
    if (draft.requirements) setRequirements(draft.requirements);
    if (draft.projectId) setProjectId(draft.projectId);
    if (draft.needId) setLinkedNeedId(draft.needId);
  }, [draft]);

  const bodyBase = () => ({
    hrPersonId: personId,
    needId: linkedNeedId || undefined,
    correlationId: linkedNeedId || undefined,
  });

  async function generatePreview(matchRequirements = false) {
    setLoading(true);
    setMsg(null);
    try {
      const data = await fetchJson(`${API_WORKER}/hr/generate-mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bodyBase(),
          profileId: profileId || undefined,
          requirements: requirements.trim() || undefined,
          description: requirements.trim() || undefined,
          matchRequirements,
        }),
      });
      setPreview(data);
      setMsg(matchRequirements ? 'Best-match candidate (preview).' : 'Random candidate (preview).');
    } catch (e) {
      setMsg(e.message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function hirePreview() {
    if (!preview?.person) return;
    setLoading(true);
    setMsg(null);
    try {
      const data = await fetchJson(`${API_WORKER}/hr/hire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bodyBase(),
          person: preview.person,
          projectId: projectId.trim() || undefined,
          requirements: requirements.trim() || undefined,
        }),
      });
      setMsg(`Hired ${data.person?.name} (${data.person?.id})${data.teamMember ? ' — on project team' : ''}.`);
      setPreview(null);
      onUpdated?.();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function hireForRequirements() {
    setLoading(true);
    setMsg(null);
    try {
      const data = await fetchJson(`${API_WORKER}/hr/hire-for-requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bodyBase(),
          profileId: profileId || undefined,
          requirements: requirements.trim(),
          description: requirements.trim(),
          projectId: projectId.trim() || undefined,
        }),
      });
      setMsg(
        `Hired ${data.person?.name} (match ${data.matchScore ?? '—'})${data.teamMember ? ' — on project team' : ''}.`
      );
      setPreview(null);
      onUpdated?.();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="worker-hr-hiring">
      <h3>Hiring — mock employee generator</h3>
      <p className="worker-muted">
        Generate candidates, preview fit, and add to the database. AI Handler auto-hires when possible; otherwise
        requirements appear in the hiring queue below.
      </p>
      {linkedNeedId && (
        <p className="worker-muted">Linked to hiring need: {linkedNeedId}</p>
      )}
      <div className="worker-hr-hiring-form">
        <label className="worker-label">
          Profile
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {HR_HIRE_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="worker-label">
          Requirements (optional)
          <textarea
            rows={2}
            placeholder="e.g. data science specialist for legal case analysis"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
        </label>
        <label className="worker-label">
          Add to project (optional)
          <input
            type="text"
            placeholder="proj-organize-company-legal-cases"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </label>
      </div>
      <div className="worker-btn-group worker-btn-group--wrap">
        <button type="button" className="worker-btn worker-btn--secondary" disabled={loading} onClick={() => generatePreview(false)}>
          Random preview
        </button>
        <button type="button" className="worker-btn worker-btn--secondary" disabled={loading} onClick={() => generatePreview(true)}>
          Match preview
        </button>
        <button type="button" className="worker-btn worker-btn--primary" disabled={loading || !preview?.person} onClick={hirePreview}>
          Hire preview
        </button>
        <button type="button" className="worker-btn worker-btn--success" disabled={loading} onClick={hireForRequirements}>
          Hire for requirements
        </button>
      </div>
      {msg && <p className={msg.startsWith('Hired') ? 'worker-ok' : 'worker-error'}>{msg}</p>}
      {preview?.person && (
        <div className="worker-hr-hiring-preview">
          <h4>Preview</h4>
          <p>
            <strong>{preview.person.name}</strong> — {preview.person.role}
          </p>
          <p className="worker-muted">
            {preview.person.id} · {preview.person.department} / {preview.person.team}
          </p>
          <p className="worker-muted">Skills: {(preview.person.skills || []).join(', ')}</p>
          {preview.matchScore != null && (
            <p className="worker-muted">Match score: {preview.matchScore}</p>
          )}
        </div>
      )}
    </section>
  );
}

function HrInbox({ personId, onUpdated }) {
  const [inbox, setInbox] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState({});
  const [taskTitle, setTaskTitle] = useState({});
  const [msg, setMsg] = useState(null);
  const [hiringDraft, setHiringDraft] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchJson(`${API_WORKER}/hr/inbox?personId=${encodeURIComponent(personId)}`)
      .then(setInbox)
      .catch((e) => setMsg(e.message))
      .finally(() => setLoading(false));
  }, [personId]);

  useEffect(() => {
    load();
  }, [load]);

  async function review(requestId, status) {
    setMsg(null);
    try {
      await fetchJson(`${API_WORKER}/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          reviewerPersonId: personId,
          reviewNotes: notes[requestId] || undefined,
        }),
      });
      load();
      onUpdated();
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function createTask(requestId) {
    const title = taskTitle[requestId];
    if (!title?.trim()) return;
    try {
      await fetchJson(`${API_WORKER}/requests/${requestId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewerPersonId: personId,
          taskTitle: title.trim(),
        }),
      });
      setTaskTitle((t) => ({ ...t, [requestId]: '' }));
      load();
      onUpdated();
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (loading) return <p className="worker-muted">Loading HR inbox…</p>;
  if (!inbox) return <p className="worker-error">{msg || 'Unable to load inbox'}</p>;

  return (
    <section>
      <h2>HR inbox</h2>
      <p className="worker-muted">
        HR-only queue: leave, PTO, transfers, and org-wide items — not project workload or stopping contribution on a project.
      </p>
      {msg && <p className="worker-error">{msg}</p>}
      <ul className="worker-request-list">
        {inbox.inbox.map((r) => (
          <li key={r.id} className="worker-hr-item">
            <RequestRow r={r} />
            <p className="worker-muted">From: {r.submitterName || r.submitterId}</p>
            <label className="worker-label">
              Review notes
              <input
                value={notes[r.id] || ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                placeholder="Optional message to employee"
              />
            </label>
            {r.handlingMode === 'ai' || r.aiAutoApproved ? (
              <p className="worker-muted">Handled autonomously by Org AI — no HR approval required.</p>
            ) : (
              <div className="worker-btn-group worker-btn-group--wrap">
                <button type="button" className="worker-btn worker-btn--secondary" onClick={() => review(r.id, 'in_review')}>
                  In review
                </button>
                <button type="button" className="worker-btn worker-btn--success" onClick={() => review(r.id, 'approved')}>
                  Approve
                </button>
                <button type="button" className="worker-btn worker-btn--danger" onClick={() => review(r.id, 'rejected')}>
                  Reject
                </button>
                <button type="button" className="worker-btn worker-btn--ghost" onClick={() => review(r.id, 'met')}>
                  Close
                </button>
              </div>
            )}
            <label className="worker-label">
              Issue HR task
              <input
                value={taskTitle[r.id] || ''}
                onChange={(e) => setTaskTitle((t) => ({ ...t, [r.id]: e.target.value }))}
                placeholder="e.g. Schedule return-to-work check-in"
              />
            </label>
            <button type="button" className="worker-btn worker-btn--primary" onClick={() => createTask(r.id)}>
              Create HR task
            </button>
          </li>
        ))}
      </ul>
      {inbox.inbox.length === 0 && <p className="worker-muted">No open worker requests.</p>}

      {(inbox.hiringQueue?.length > 0 || hiringDraft) && (
        <section className="worker-hr-hiring-queue">
          <h3>Hiring queue (AI Handler)</h3>
          <p className="worker-muted">
            Staffing or expertise gaps the system could not fill from the current roster. Use the generator below or hire
            for requirements.
          </p>
          <ul className="worker-request-list">
            {(inbox.hiringQueue || []).map((item) => (
              <li key={item.id} className="worker-hr-hiring-queue-item">
                <strong>{item.title}</strong>
                <span className="worker-req-kind">{item.hiringStatus || 'pending_hr'}</span>
                <p className="worker-muted">{item.projectId}</p>
                {item.hiringRequirements && (
                  <pre className="worker-hiring-req">{item.hiringRequirements}</pre>
                )}
                {item.hiringError && <p className="worker-error">Auto-hire: {item.hiringError}</p>}
                {item.hiredPersonName && (
                  <p className="worker-ok">Hired: {item.hiredPersonName}</p>
                )}
                {item.hiringStatus !== 'hired' && (
                  <button
                    type="button"
                    className="worker-btn worker-btn--primary"
                    onClick={() =>
                      setHiringDraft({
                        needId: item.id,
                        requirements: item.hiringRequirements || item.description || item.title,
                        projectId: item.hiringProjectId || item.projectId,
                        profileId: item.hiringProfileId || 'data',
                      })
                    }
                  >
                    Open in hiring generator
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <HrHiringPanel personId={personId} onUpdated={load} draft={hiringDraft} />
      <HrEmergencyPanel personId={personId} onUpdated={onUpdated} />
      {inbox.hrTasks?.length > 0 && (
        <>
          <h3>Your HR review tasks</h3>
          <ul className="worker-activity-list">
            {inbox.hrTasks.map((t) => (
              <li key={`${t.projectId}-${t.id}`}>
                <strong>{t.title}</strong> — {t.projectTitle} [{t.status || 'pending'}]
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [personId, setPersonId] = useState(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY) || '';
    } catch {
      return '';
    }
  });
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(!!personId);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');
  const [theme, setTheme] = useState(getStoredTheme);
  const [taskFilter, setTaskFilter] = useState('all');

  const loadDashboard = useCallback(async () => {
    if (!personId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson(`${API_WORKER}/dashboard?personId=${encodeURIComponent(personId)}`);
      setDashboard(data);
    } catch (err) {
      setError(err.message);
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    if (!personId) return;
    const base = import.meta.env.VITE_API_URL || '/api';
    fetch(`${base}/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, preferences: { theme } }),
    }).catch(() => {});
  }, [theme, personId]);

  useEffect(() => {
    if (!personId) return;
    const base = import.meta.env.VITE_API_URL || '/api';
    fetch(`${base}/preferences?personId=${encodeURIComponent(personId)}`)
      .then((r) => r.json())
      .then((d) => {
        const t = d?.preferences?.theme;
        if (t === 'light' || t === 'dark') setTheme(t);
      })
      .catch(() => {});
  }, [personId]);

  useEffect(() => {
    if (!personId) return undefined;
    const base = import.meta.env.VITE_API_URL || '/api';
    const es = new EventSource(`${base}/events/stream`);
    const refresh = () => loadDashboard();
    es.addEventListener('event', refresh);
    return () => es.close();
  }, [personId, loadDashboard]);

  function handleLogin(person) {
    setLoading(true);
    setError(null);
    setDashboard(null);
    setTab('overview');
    setPersonId(person.id);
    try {
      sessionStorage.setItem(SESSION_KEY, person.id);
    } catch {
      /* ignore */
    }
  }

  function logout() {
    setPersonId('');
    setDashboard(null);
    setLoading(false);
    setError(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  if (!personId) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (!dashboard) {
    if (error) {
      return (
        <div className="worker-error-page">
          <p>{error}</p>
          <button type="button" className="worker-btn worker-btn--secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      );
    }
    return <div className="worker-loading">Loading your workspace…</div>;
  }

  const p = dashboard.person;
  const stats = dashboard.stats;
  const filteredTasks =
    taskFilter === 'all'
      ? dashboard.tasks
      : dashboard.tasks.filter((t) => (t.status || 'pending') === taskFilter);

  return (
    <div className="worker-app">
      <header className="worker-header">
        <div className="worker-header-main">
          <div>
            <h1>{p.name}</h1>
            <p className="worker-role-line">
              {p.role} · {p.department} / {p.team}
            </p>
            {dashboard.personalHr && (
              <p className="worker-personal-hr">
                Your HR partner: <strong>{dashboard.personalHr.name}</strong>
                {dashboard.personalHr.role ? ` (${dashboard.personalHr.role})` : ''}
              </p>
            )}
            {p.availabilityStatus === 'on_leave' && (
              <p className="worker-leave-banner">
                On leave{p.availabilityUntil ? ` until ${formatDate(p.availabilityUntil)}` : ''}
                {p.availabilityReason ? ` (${p.availabilityReason.replace(/_/g, ' ')})` : ''}
                . Contact HR for emergency work authorization.
              </p>
            )}
            {p.availabilityStatus === 'emergency_active' && (
              <p className="worker-emergency-banner">
                Emergency work authorized by HR — limited assignment while leave remains on record.
              </p>
            )}
            {p.skills?.length > 0 && (
              <p className="worker-skills">
                {p.skills.slice(0, 6).join(' · ')}
                {p.skills.length > 6 ? ' …' : ''}
              </p>
            )}
          </div>
          <div className="worker-header-actions">
            <button type="button" className="worker-btn worker-btn--ghost worker-btn--sm" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
              {theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
            <button type="button" className="worker-btn worker-btn--ghost worker-btn--sm" onClick={loadDashboard}>
              Refresh
            </button>
            <button type="button" className="worker-btn worker-btn--ghost worker-btn--sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="worker-nav" aria-label="Worker sections">
          {[
            'overview',
            'tasks',
            'projects',
            'requests',
            ...(dashboard.isHr ? ['hr'] : []),
            'reviews',
            'activity',
          ].map((id) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              {id === 'hr' ? 'HR' : id.charAt(0).toUpperCase() + id.slice(1)}
              {id === 'tasks' && stats.totalTasks > 0 && (
                <span className="worker-nav-badge">{stats.totalTasks}</span>
              )}
              {id === 'hr' && stats.openHrInbox > 0 && (
                <span className="worker-nav-badge">{stats.openHrInbox}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="worker-main">
        {tab === 'overview' && (
          <section className="worker-overview">
            <p className="worker-overview-intro">
              Your workspace at a glance. Open <strong>Tasks</strong> to mark work in progress, done, or blocked.
            </p>
            <div className="worker-overview-cards">
              <div className="worker-overview-card">
                <span className="worker-overview-value">{Math.max(0, stats.totalTasks - stats.done)}</span>
                <span className="worker-overview-label">Open assignments</span>
              </div>
              <div className="worker-overview-card">
                <span className="worker-overview-value">{stats.activeProjects}</span>
                <span className="worker-overview-label">Active projects</span>
              </div>
              <div className="worker-overview-card">
                <span className="worker-overview-value">{stats.openRequests}</span>
                <span className="worker-overview-label">Open requests</span>
              </div>
            </div>
            {stats.blocked > 0 && (
              <div className="worker-banner worker-banner--warn">
                {stats.blocked} assignment(s) need attention — open <strong>Tasks</strong> to update status.
              </div>
            )}
            <div className="worker-section-head">
              <h2>Up next</h2>
              <button type="button" className="worker-btn worker-btn--secondary worker-btn--sm" onClick={() => setTab('tasks')}>
                All tasks →
              </button>
            </div>
            {dashboard.tasks.slice(0, 5).map((t) => (
              <TaskPreviewCard
                key={`${t.projectId}-${t.id}`}
                task={t}
                onOpenTasks={() => setTab('tasks')}
              />
            ))}
            {dashboard.tasks.length === 0 && (
              <p className="worker-muted">No assigned tasks yet. Check back after team assignment runs.</p>
            )}
            {stats.openRequests > 0 && (
              <div className="worker-overview-footer">
                <button type="button" className="worker-btn worker-btn--ghost worker-btn--sm" onClick={() => setTab('requests')}>
                  View {stats.openRequests} open request{stats.openRequests !== 1 ? 's' : ''} →
                </button>
              </div>
            )}
          </section>
        )}

        {tab === 'tasks' && (
          <section>
            <p className="worker-muted worker-tasks-hint">
              Update your work here. Status changes sync to Leadership View and may trigger project AI review.
            </p>
            <div className="worker-chip-row" role="tablist" aria-label="Filter tasks">
              {['all', 'in_progress', 'blocked', 'pending', 'done'].map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={taskFilter === f}
                  className={`worker-chip ${taskFilter === f ? 'is-active' : ''}`}
                  onClick={() => setTaskFilter(f)}
                >
                  {f === 'all' ? 'All' : statusLabel(f)}
                </button>
              ))}
            </div>
            <div className="worker-task-grid">
              {filteredTasks.map((t) => (
                <TaskCard key={`${t.projectId}-${t.id}`} task={t} personId={personId} onUpdated={loadDashboard} />
              ))}
            </div>
            {filteredTasks.length === 0 && <p className="worker-muted">No tasks in this filter.</p>}
          </section>
        )}

        {tab === 'projects' && (
          <section className="worker-project-grid">
            {dashboard.projects.map((proj) => (
              <article key={proj.id} className="worker-project-card">
                <h3>{proj.title}</h3>
                <p className="worker-project-id">{proj.id}</p>
                <span className={`worker-pill worker-pill--${proj.status}`}>{proj.status}</span>
                <span className={`worker-pill worker-pill--risk-${proj.riskLevel}`}>Risk: {proj.riskLevel}</span>
                <ul className="worker-project-stats">
                  <li>{proj.taskCount} task(s) assigned to you</li>
                  <li>{proj.tasksDone} done · {proj.tasksBlocked} blocked</li>
                  <li>Updated {formatDate(proj.lastUpdatedAt)}</li>
                </ul>
                {proj.blockers?.length > 0 && (
                  <div className="worker-blockers">
                    <strong>Blockers</strong>
                    <ul>
                      {proj.blockers.map((b, i) => (
                        <li key={i}>{b.description || b.taskId}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ))}
            {dashboard.projects.length === 0 && (
              <p className="worker-muted">You are not assigned to any projects yet.</p>
            )}
          </section>
        )}

        {tab === 'requests' && (
          <section className="worker-requests-section">
            <RequestForm dashboard={dashboard} personId={personId} onSubmitted={loadDashboard} />
            <h2>Your requests</h2>
            <ul className="worker-request-list">
              {dashboard.requests.map((r) => (
                <RequestRow key={r.id} r={r} />
              ))}
            </ul>
            {dashboard.requests.length === 0 && (
              <p className="worker-muted">No requests submitted yet.</p>
            )}
          </section>
        )}

        {tab === 'hr' && dashboard.isHr && (
          <HrInbox personId={personId} onUpdated={loadDashboard} />
        )}

        {tab === 'reviews' && (
          <ProjectReviewInbox personId={personId} onUpdated={loadDashboard} />
        )}

        {tab === 'activity' && (
          <section>
            <ul className="worker-activity-list">
              {dashboard.recentActivity.map((a) => (
                <li key={a.id}>
                  <strong>{statusLabel(a.status)}</strong> on task {a.taskId}
                  <span className="worker-muted"> · {a.projectId} · {formatDate(a.timestamp)}</span>
                  {a.notes && <p>{a.notes}</p>}
                </li>
              ))}
            </ul>
            {dashboard.recentActivity.length === 0 && (
              <p className="worker-muted">No recent status updates from you.</p>
            )}
          </section>
        )}
      </main>

      <footer className="worker-footer">
        <a href={LEADERSHIP_URL}>Leadership View</a>
        <a href={MONITOR_URL}>Ops Monitor</a>
        <span>Worker Portal · separate deploy from client/</span>
      </footer>
    </div>
  );
}
