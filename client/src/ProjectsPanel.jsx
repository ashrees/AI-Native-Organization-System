/**
 * Projects tab — master-detail portfolio: pick a project from the list, view details on the right.
 */

import { useEffect, useMemo, useState } from 'react';
import { recentEventSummary } from './recentEvents';

const PHASES = [
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'killed', label: 'Killed' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
];

function taskCounts(project) {
  const tasks = project.progress?.tasks || [];
  const c = { total: tasks.length, done: 0, in_progress: 0, blocked: 0 };
  for (const t of tasks) {
    const s = t.status || 'pending';
    if (s === 'done') c.done += 1;
    else if (s === 'in_progress') c.in_progress += 1;
    else if (s === 'blocked') c.blocked += 1;
  }
  return c;
}

function statusClass(status, archived) {
  if (archived) return 'project-status--archived';
  if (status === 'completed') return 'project-status--completed';
  if (status === 'killed') return 'project-status--killed';
  return 'project-status--active';
}

function statusLabel(project) {
  if (project.archived) return 'archived';
  return project.status || 'active';
}

function filterByPhase(projects, phase) {
  if (phase === 'all') return projects;
  if (phase === 'active') {
    return projects.filter((p) => (p.status || 'active') === 'active' && !p.archived);
  }
  if (phase === 'completed') {
    return projects.filter((p) => p.status === 'completed' && !p.archived);
  }
  if (phase === 'killed') {
    return projects.filter((p) => p.status === 'killed' && !p.archived);
  }
  if (phase === 'archived') {
    return projects.filter((p) => p.archived);
  }
  return projects;
}

function computeCounts(projects) {
  return {
    active: projects.filter((p) => (p.status || 'active') === 'active' && !p.archived).length,
    completed: projects.filter((p) => p.status === 'completed' && !p.archived).length,
    killed: projects.filter((p) => p.status === 'killed' && !p.archived).length,
    archived: projects.filter((p) => p.archived).length,
    all: projects.length,
  };
}

function projectDepartment(project) {
  const d = (project.department || '').trim();
  return d || 'Other';
}

/** Unique people on the project (roles roster + task assignees). */
function teamMemberStats(project) {
  const roles = project.roles || {};
  const membersById = new Map();

  for (const entry of Object.values(roles)) {
    if (!entry?.personId) continue;
    membersById.set(entry.personId, {
      id: entry.personId,
      name: entry.name || entry.personId,
      label: entry.label || entry.roleId || 'Member',
      department: entry.department,
      team: entry.team,
    });
  }

  for (const t of project.progress?.tasks || []) {
    const id = t.assigneeId || t.assignee?.id;
    if (!id || membersById.has(id)) continue;
    const a = t.assignee;
    membersById.set(id, {
      id,
      name: a?.name || id,
      label: 'Assignee',
      department: a?.department,
      team: a?.team,
    });
  }

  const members = [...membersById.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );
  const roleSlots = Object.values(roles).filter((r) => r?.personId).length;
  const uniqueRoleHolders = new Set(
    Object.values(roles).map((r) => r?.personId).filter(Boolean)
  ).size;
  const assigneeOnly = members.filter(
    (m) => !Object.values(roles).some((r) => r?.personId === m.id)
  ).length;

  return {
    teamSize: members.length,
    roleSlots,
    uniqueRoleHolders,
    assigneeOnly,
    members,
  };
}

function isInternalReviewTask(task) {
  const id = String(task?.id || '');
  const title = String(task?.title || '').toLowerCase();
  return id.startsWith('wr-') || title.includes('review worker request');
}

function deliveryTasks(project) {
  return (project.progress?.tasks || []).filter((t) => !isInternalReviewTask(t));
}

function groupProjectsByDepartment(projects) {
  const map = new Map();
  for (const p of projects) {
    const dept = projectDepartment(p);
    if (!map.has(dept)) map.set(dept, []);
    map.get(dept).push(p);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([department, list]) => ({
      department,
      projects: list.sort((x, y) =>
        (x.title || x.id || '').localeCompare(y.title || y.id || '')
      ),
      totalMembers: list.reduce((sum, proj) => sum + teamMemberStats(proj).teamSize, 0),
    }));
}

function lifecycleActionsFor(project) {
  const status = project.status || 'active';
  const archived = Boolean(project.archived);
  const actions = [];
  if (status === 'active' && !archived) {
    actions.push({ action: 'complete', label: 'Mark completed', variant: 'primary' });
    actions.push({ action: 'kill', label: 'Kill project', variant: 'danger' });
  }
  if ((status === 'completed' || status === 'killed') && !archived) {
    actions.push({ action: 'archive', label: 'Archive', variant: 'secondary' });
  }
  if (status === 'completed' && !archived) {
    actions.push({ action: 'reactivate', label: 'Reopen', variant: 'secondary' });
  }
  if (archived) {
    actions.push({ action: 'unarchive', label: 'Restore to list', variant: 'secondary' });
  }
  return actions;
}

async function postLifecycle(apiBase, projectId, action, reason) {
  const res = await fetch(`${apiBase}/events/projects/${encodeURIComponent(projectId)}/lifecycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, reason: reason?.trim() || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function ProjectLifecycleBar({ project, apiBase, onDone, onError }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const actions = lifecycleActionsFor(project);

  if (actions.length === 0) return null;

  async function run(action) {
    const confirmKill = action === 'kill';
    const confirmComplete = action === 'complete';
    if (confirmKill && !window.confirm(`Kill "${project.title || project.id}"? Assignees will be released.`)) {
      return;
    }
    if (
      confirmComplete &&
      !window.confirm(`Mark "${project.title || project.id}" as completed? AI agents will stop scheduling new work.`)
    ) {
      return;
    }
    setBusy(action);
    try {
      await postLifecycle(apiBase, project.id, action, reason);
      setReason('');
      onDone();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="project-lifecycle">
      <p className="project-lifecycle-label">Manage project</p>
      <label className="project-lifecycle-reason">
        Note (optional)
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. delivered Q1, scope cancelled"
          disabled={Boolean(busy)}
        />
      </label>
      <div className="project-lifecycle-actions" role="group" aria-label="Project lifecycle actions">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            className={`project-lifecycle-btn project-lifecycle-btn--${a.variant}`}
            disabled={Boolean(busy)}
            onClick={() => run(a.action)}
          >
            {busy === a.action ? '…' : a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectDetails({ project, recentEvents }) {
  const tasks = deliveryTasks(project);
  const risk = project.risk?.level || 'low';
  const reasons = project.risk?.reasons || [];
  const blockers = project.blockers || [];
  const team = teamMemberStats(project);
  const sortedRecent = [...recentEvents].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <>
      <div className="meta">
        <span className="meta-line">
          Project: <strong>{project.id}</strong>
        </span>
        <span className="meta-line">
          Status: <strong>{statusLabel(project)}</strong>
        </span>
        {(project.department || project.team || project.sponsor) && (
          <span className="meta-line">
            Org: {project.department && <>{project.department}</>}
            {project.team && <> · {project.team}</>}
            {project.sponsor && <> · Sponsor: {project.sponsor}</>}
          </span>
        )}
        <span className="meta-line">
          Team: <strong>{team.teamSize}</strong> member{team.teamSize === 1 ? '' : 's'}
          {team.roleSlots > 0 &&
            (team.assigneeOnly > 0
              ? ` (${team.uniqueRoleHolders} on roster, ${team.assigneeOnly} assignee-only)`
              : team.roleSlots > team.uniqueRoleHolders
                ? ` (${team.roleSlots} roles)`
                : '')}
        </span>
        {project.roles && Object.keys(project.roles).length > 0 && (
          <span className="meta-line project-roles-line">
            Roles:{' '}
            {Object.values(project.roles)
              .map((r) => `${r.label}: ${r.name}`)
              .join(' · ')}
          </span>
        )}
        {project.closedAt && (
          <span className="meta-line">Closed {new Date(project.closedAt).toLocaleDateString()}</span>
        )}
        {project.archivedAt && (
          <span className="meta-line">Archived {new Date(project.archivedAt).toLocaleDateString()}</span>
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

      {team.members.length > 0 && (
        <section className="project-team" aria-label="Project team members">
          <h3 className="project-team-title">Team members ({team.teamSize})</h3>
          <ul className="project-team-list">
            {team.members.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>
                <span className="project-team-role">{m.label}</span>
                {(m.department || m.team) && (
                  <span className="project-team-org">
                    {[m.department, m.team].filter(Boolean).join(' · ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tasks.length > 0 && (
        <ul className="tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <div>
                <span className="task-title">{t.title || t.id}</span>
                {t.status && <span className="task-status"> [{t.status}]</span>}
              </div>
              {t.assigneeNote && (
                <div className="task-assignee task-assignee--leave">{t.assigneeNote}</div>
              )}
              {t.assignee && !t.assigneeNote && (
                <div className="task-assignee">
                  Assignee: <strong>{t.assignee.name || t.assignee.id}</strong>
                  {t.assignee.team && ` — ${t.assignee.team}`}
                  {t.assignee.department && ` (${t.assignee.department})`}
                  {t.assignee.role && ` · ${t.assignee.role}`}
                  {t.assignee.jobTitle &&
                    t.assignee.jobTitle !== t.assignee.role &&
                    ` · ${t.assignee.jobTitle}`}
                </div>
              )}
              {!t.assignee && !t.assigneeNote && t.assigneeId && (
                <div className="task-assignee task-assignee--muted">Unassigned</div>
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
              <li key={i}>
                {b.description || b.taskId} ({b.taskId})
              </li>
            ))}
          </ul>
        </div>
      )}

      {sortedRecent.length > 0 && (
        <section className="recent-events" aria-label="What changed recently">
          <h3 className="recent-events-title">What changed recently</h3>
          <ol className="log-list recent-events-list">
            {sortedRecent.map((e) => {
              const summary = recentEventSummary(e, project);
              return (
                <li key={e.id} className="log-entry recent-events-item">
                  <time className="recent-events-time" dateTime={e.timestamp}>
                    {new Date(e.timestamp).toLocaleString()}
                  </time>
                  <span className="log-meta">
                    <strong>{e.type}</strong>
                    <span className="recent-events-source">({e.source})</span>
                  </span>
                  {summary && <p className="log-message recent-events-summary">{summary}</p>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}

function ProjectListItem({ project, selected, onSelect }) {
  const counts = taskCounts(project);
  const team = teamMemberStats(project);
  const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
  const title = project.title || project.id;
  const dept = projectDepartment(project);

  return (
    <button
      type="button"
      className={`projects-list-item${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(project.id)}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="projects-list-item-title">{title}</span>
      <span className="projects-list-item-meta">
        <span className={`project-status-pill ${statusClass(project.status, project.archived)}`}>
          {statusLabel(project)}
        </span>
        <span className="projects-list-item-team" title={`${team.teamSize} team member(s)`}>
          {team.teamSize} {team.teamSize === 1 ? 'member' : 'members'}
        </span>
        {counts.total > 0 && (
          <span className="projects-list-item-tasks">
            {counts.done}/{counts.total} done
          </span>
        )}
      </span>
      {dept !== 'Other' && (
        <span className="projects-list-item-dept">{dept}</span>
      )}
      {counts.total > 0 && (
        <span className="projects-progress" aria-hidden>
          <span className="projects-progress-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  );
}

export default function ProjectsPanel({
  projects,
  eventsByProject,
  apiBase,
  onRefresh,
  onError,
}) {
  const [phase, setPhase] = useState('active');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const counts = useMemo(() => computeCounts(projects), [projects]);

  const filtered = useMemo(() => {
    const byPhase = filterByPhase(projects, phase);
    const q = search.trim().toLowerCase();
    if (!q) return byPhase;
    return byPhase.filter((p) => {
      const hay = `${p.title || ''} ${p.id || ''} ${p.team || ''} ${p.department || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [projects, phase, search]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((p) => p.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((p) => p.id === selectedId) || null;

  const byDepartment = useMemo(() => groupProjectsByDepartment(filtered), [filtered]);

  const portfolioSummary = useMemo(() => {
    const depts = byDepartment.length;
    const members = filtered.reduce((sum, p) => sum + teamMemberStats(p).teamSize, 0);
    return { depts, members };
  }, [byDepartment, filtered]);

  return (
    <section className="app-section projects-panel" aria-labelledby="section-projects">
      <h2 id="section-projects" className="section-title">Projects</h2>
      <p className="section-desc">
        Select a project from the list to view tasks, recent activity, and lifecycle actions. Use filters and search to
        navigate the portfolio without scrolling through every card.
      </p>

      <div className="project-phase-tabs" role="tablist" aria-label="Project lifecycle filter">
        {PHASES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={phase === p.id}
            className={`project-phase-tab${phase === p.id ? ' is-active' : ''}`}
            onClick={() => setPhase(p.id)}
          >
            {p.label}
            <span className="project-phase-count">{counts[p.id] ?? counts.all}</span>
          </button>
        ))}
      </div>

      <div className="projects-shell">
        <aside className="projects-sidebar" aria-label="Project list">
          <label className="projects-search-label">
            <span className="projects-search-label-text">Search</span>
            <input
              type="search"
              className="projects-search-input"
              placeholder="Title, id, team…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search projects"
            />
          </label>
          <p className="projects-list-count">
            {filtered.length} project{filtered.length === 1 ? '' : 's'}
            {filtered.length > 0 && (
              <>
                {' '}
                · {portfolioSummary.depts} department{portfolioSummary.depts === 1 ? '' : 's'} ·{' '}
                {portfolioSummary.members} team member{portfolioSummary.members === 1 ? '' : 's'} total
              </>
            )}
          </p>
          <nav className="projects-list" aria-label="Projects grouped by department">
            {filtered.length === 0 ? (
              <p className="empty projects-list-empty">
                {phase === 'active'
                  ? 'No active projects.'
                  : `No projects in this filter.`}
              </p>
            ) : (
              byDepartment.map((group) => (
                <div key={group.department} className="projects-dept-group">
                  <h3 className="projects-dept-heading">
                    <span className="projects-dept-name">{group.department}</span>
                    <span className="projects-dept-stats">
                      {group.projects.length} project{group.projects.length === 1 ? '' : 's'} ·{' '}
                      {group.totalMembers} member{group.totalMembers === 1 ? '' : 's'}
                    </span>
                  </h3>
                  <div className="projects-dept-list">
                    {group.projects.map((proj) => (
                      <ProjectListItem
                        key={proj.id}
                        project={proj}
                        selected={proj.id === selectedId}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </nav>
        </aside>

        <div className="projects-detail" aria-label="Selected project details">
          {!selected ? (
            <div className="projects-detail-empty">
              <p className="empty">Select a project from the list, or change the filter above.</p>
            </div>
          ) : (
            <article
              className={`project-card project-card--detail project-card--${selected.status || 'active'}${selected.archived ? ' project-card--archived' : ''}`}
            >
              <header className="projects-detail-header">
                <h2 className="projects-detail-title">{selected.title || selected.id}</h2>
                <span className={`project-status-pill ${statusClass(selected.status, selected.archived)}`}>
                  {statusLabel(selected)}
                </span>
              </header>
              <div className="projects-detail-body">
                <ProjectDetails
                  project={selected}
                  recentEvents={eventsByProject[selected.id] || []}
                />
                <ProjectLifecycleBar
                  project={selected}
                  apiBase={apiBase}
                  onDone={onRefresh}
                  onError={onError}
                />
              </div>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
