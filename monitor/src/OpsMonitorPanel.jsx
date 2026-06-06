/**
 * Operations Monitor — agent uptime streams and work boards.
 */

import { useEffect, useState, useCallback } from 'react';
import './OpsMonitor.css';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function fetchMonitor() {
  const res = await fetch(`${API_BASE}/ops/monitor`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function statusClass(status) {
  if (status === 'up' || status === 'busy') return 'ops-status--up';
  if (status === 'idle') return 'ops-status--idle';
  if (status === 'away' || status === 'down') return 'ops-status--down';
  return 'ops-status--unknown';
}

const LLM_DETAIL_TYPE_LABELS = {
  llm_call: 'Model call',
  llm_running: 'In progress',
  llm_waiting: 'Queued',
  llm_live: 'Live',
  llm_idle: 'Finished',
  ai_handler_live: 'Live',
  need_review: 'Need review',
  need_resolved: 'Resolved',
};

function detailTypeLabel(type) {
  return LLM_DETAIL_TYPE_LABELS[type] || type;
}

function buildLiveLlmDetail(liveLlm) {
  const waiting = liveLlm.waiting || 0;
  const work = liveLlm.currentWork;
  const summary = work?.summary
    ? liveLlm.busy && waiting > 0
      ? `${work.summary} (${waiting} waiting)`
      : work.summary
    : liveLlm.busy
      ? `Running ${liveLlm.currentAgent || 'model'}${waiting > 0 ? ` (${waiting} waiting)` : ''}`
      : `${waiting} caller(s) waiting for the model`;
  const rationale =
    work?.rationale ||
    (liveLlm.busy && liveLlm.since
      ? `Started ${new Date(liveLlm.since).toLocaleString()}`
      : `Lock held by ${liveLlm.currentAgent || 'another agent'}`);
  return {
    kind: 'activity',
    at: new Date().toISOString(),
    type: 'llm_live',
    status: liveLlm.busy ? 'running' : 'waiting',
    summary,
    rationale,
    agentDisplay: work?.agent || liveLlm.currentAgent,
    projectTitle: work?.projectTitle || null,
    taskId: work?.taskId || null,
    live: true,
  };
}

function StreamSegmentTooltip({ segment, extraCount, liveLlm, isLatestSegment }) {
  const rawDetails = segment?.details || [];
  const liveActive =
    liveLlm && isLatestSegment && (liveLlm.busy || (liveLlm.waiting || 0) > 0);
  const hasLiveDetail = rawDetails.some((d) => d.type === 'llm_live' || d.live);
  const details =
    liveActive && !hasLiveDetail
      ? [buildLiveLlmDetail(liveLlm), ...rawDetails]
      : rawDetails;

  if (details.length === 0 && !segment?.events) {
    return (
      <div className="ops-stream-tooltip">
        <p className="ops-stream-tooltip-empty">No events in this period</p>
      </div>
    );
  }

  return (
    <div className="ops-stream-tooltip">
      <header className="ops-stream-tooltip-head">
        <strong>{segment.level}</strong>
        <time>{segment.at ? new Date(segment.at).toLocaleString() : ''}</time>
        <span>
          {segment.events} event{segment.events !== 1 ? 's' : ''}
          {segment.errors > 0 ? ` · ${segment.errors} error(s)` : ''}
        </span>
      </header>
      <ul className="ops-stream-tooltip-list">
        {details.map((d, i) => (
          <li key={`${d.at}-${i}`}>
            <span className="ops-stream-tooltip-type">{detailTypeLabel(d.type)}</span>
            {(d.agentDisplay || d.agent) && (
              <span className="ops-stream-tooltip-agent">
                {d.agentDisplay || d.agent}
              </span>
            )}
            {d.projectTitle && <span className="ops-stream-tooltip-project">{d.projectTitle}</span>}
            {d.taskId && <span className="ops-stream-tooltip-task">Task {d.taskId}</span>}
            {d.status && <span className="ops-stream-tooltip-status">{d.status}</span>}
            <p className="ops-stream-tooltip-summary">{d.summary}</p>
            {d.rationale && <p className="ops-stream-tooltip-rationale">{d.rationale}</p>}
          </li>
        ))}
      </ul>
      {extraCount > 0 && (
        <p className="ops-stream-tooltip-more">+{extraCount} more in this bucket (not shown)</p>
      )}
    </div>
  );
}

function AgentStreamBar({ segments, windowHours, agentLabel, liveLlm }) {
  const list = segments || [];
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [hoveredIndex, setHoveredIndex] = useState(null);

  if (list.length === 0) {
    return <div className="ops-stream-bar ops-stream-bar--empty">No stream data</div>;
  }

  const activeIndex = selectedIndex != null ? selectedIndex : hoveredIndex;
  const activeSeg = activeIndex != null ? list[activeIndex] : null;
  const isPinned = selectedIndex != null;
  const extraCount =
    activeSeg && activeSeg.events > (activeSeg.details?.length || 0)
      ? activeSeg.events - activeSeg.details.length
      : 0;

  return (
    <div className="ops-stream-wrap">
      <p className="ops-stream-hint">
        Click a segment to pin details below — scroll to read tasks, projects, and rationale.
      </p>
      <div
        className="ops-stream-bar"
        role="group"
        aria-label={`${agentLabel || 'Agent'} activity stream, last ${windowHours} hours`}
      >
        {list.map((seg, i) => (
          <button
            type="button"
            key={i}
            className={`ops-stream-seg ops-stream-seg--${seg.level} ${
              selectedIndex === i ? 'ops-stream-seg--selected' : ''
            } ${hoveredIndex === i && !isPinned ? 'ops-stream-seg--hover' : ''}`}
            style={{ flex: 1 }}
            aria-pressed={selectedIndex === i}
            aria-label={`${seg.level}, ${seg.events} events`}
            onClick={() => setSelectedIndex((prev) => (prev === i ? null : i))}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}
      </div>
      <div className="ops-stream-axis">
        <span>{windowHours}h ago</span>
        <span>now</span>
      </div>

      {activeSeg ? (
        <div
          className={`ops-stream-detail ${isPinned ? 'ops-stream-detail--pinned' : 'ops-stream-detail--preview'}`}
        >
          <div className="ops-stream-detail-toolbar">
            <span>
              {isPinned ? (
                <>
                  <strong>Pinned</strong> · {agentLabel} ·{' '}
                  {new Date(activeSeg.at).toLocaleString()}
                </>
              ) : (
                <>Preview · {new Date(activeSeg.at).toLocaleString()} — click segment to pin</>
              )}
            </span>
            {isPinned && (
              <button
                type="button"
                className="ops-stream-detail-clear"
                onClick={() => setSelectedIndex(null)}
              >
                Clear
              </button>
            )}
          </div>
          <div className="ops-stream-detail-body">
            <StreamSegmentTooltip
              segment={activeSeg}
              extraCount={extraCount}
              liveLlm={liveLlm}
              isLatestSegment={activeIndex === list.length - 1 || activeIndex === list.length - 2}
            />
          </div>
        </div>
      ) : (
        <p className="ops-stream-detail-placeholder">
          Hover or click a colored segment on the bar above to inspect events.
        </p>
      )}
    </div>
  );
}

function AgentCardsGrid({ agents }) {
  return (
    <div className="ops-agent-grid">
      {(agents || []).map((a) => (
        <div key={a.id} className={`ops-agent-card ${statusClass(a.status)}`}>
          <div className="ops-agent-head">
            <span className="ops-agent-name">{a.label}</span>
            <span className={`ops-agent-dot ${statusClass(a.status)}`} title={a.status} />
          </div>
          <p className="ops-agent-status">{a.status}</p>
          <p className="ops-agent-msg">{a.lastMessage || 'No recent activity'}</p>
          {a.lastAt && (
            <time className="ops-agent-time">{new Date(a.lastAt).toLocaleTimeString()}</time>
          )}
          {a.errorCount > 0 && (
            <span className="ops-agent-errors">{a.errorCount} error signal(s)</span>
          )}
        </div>
      ))}
    </div>
  );
}

function StackColumn({ title, subtitle, cards, columnClass, emptyLabel }) {
  return (
    <section className={`ops-column ${columnClass}`}>
      <header className="ops-column-header">
        <h3>{title}</h3>
        <span className="ops-column-count">{cards.length}</span>
        {subtitle && <p className="ops-column-sub">{subtitle}</p>}
      </header>
      <div className="ops-stack">
        {cards.length === 0 ? (
          <div className="ops-stack-empty">{emptyLabel}</div>
        ) : (
          cards.map((c, i) => (
            <article
              key={c.id}
              className="ops-card"
              style={{ '--stack-index': i }}
            >
              <div className="ops-card-top">
                <span className="ops-card-title">{c.title}</span>
                {c.status && <span className={`ops-pill ops-pill--${c.status}`}>{c.status}</span>}
              </div>
              {c.subtitle && <p className="ops-card-sub">{c.subtitle}</p>}
              <div className="ops-card-meta">
                {c.projectTitle && <span>{c.projectTitle}</span>}
                {c.owner && <span>{c.owner}</span>}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export default function OpsMonitorPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const snap = await fetchMonitor();
      setData(snap);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    const streamUrl = `${API_BASE}/events/stream`;
    let es;
    try {
      es = new EventSource(streamUrl);
      es.addEventListener('monitor', () => refresh());
      es.addEventListener('event', () => refresh());
    } catch {
      /* SSE optional */
    }
    return () => {
      if (es) es.close();
    };
  }, [refresh]);

  if (loading && !data) {
    return <p className="monitor-empty">Loading operations monitor…</p>;
  }

  if (error && !data) {
    return <p className="monitor-error">Monitor: {error}</p>;
  }

  const summary = data?.summary || {};
  const boards = data?.boards || { worked: [], active: [], queued: [], broken: [] };
  const streamHours = data?.streamHours ?? 3;

  return (
    <div className="ops-monitor">
      <div className="ops-monitor-toolbar">
        <p className="ops-monitor-lead">
          Agent uptime streams and work flowing through the org. Stream bars show activity over the
          last {streamHours} hours (updates on events and every 5s).
        </p>
        <button type="button" className="monitor-btn-secondary" onClick={refresh}>
          Refresh
        </button>
      </div>

      <div className="ops-summary-row">
        <div className="ops-summary-chip">
          <span className="ops-summary-val">{summary.agentsBusy ?? 0}</span>
          <span className="ops-summary-label">agents busy</span>
        </div>
        <div className="ops-summary-chip">
          <span className="ops-summary-val">{summary.agentsUp ?? 0}</span>
          <span className="ops-summary-label">agents up</span>
        </div>
        <div className="ops-summary-chip ops-summary-chip--warn">
          <span className="ops-summary-val">{summary.brokenItems ?? 0}</span>
          <span className="ops-summary-label">issues</span>
        </div>
        <div className="ops-summary-chip">
          <span className="ops-summary-val">{summary.activeTasks ?? 0}</span>
          <span className="ops-summary-label">in progress</span>
        </div>
        <div className="ops-summary-chip">
          <span className="ops-summary-val">{summary.queuedItems ?? 0}</span>
          <span className="ops-summary-label">queued</span>
        </div>
        {data?.llm?.busy && (
          <div className="ops-summary-chip ops-summary-chip--llm">
            <span className="ops-summary-val">LLM</span>
            <span className="ops-summary-label">{data.llm.currentAgent || 'busy'}</span>
          </div>
        )}
      </div>

      <section className="ops-agents">
        <div className="ops-agents-head">
          <h2 className="ops-section-title">Agent uptime streams</h2>
          <div className="ops-stream-legend">
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--up" /> active
            </span>
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--busy" /> busy
            </span>
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--idle" /> idle gap
            </span>
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--down" /> down
            </span>
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--error" /> error
            </span>
            <span>
              <i className="ops-stream-legend-dot ops-stream-legend-dot--unknown" /> no data
            </span>
          </div>
        </div>
        <ul className="ops-agent-stream-list">
          {(data?.agents || []).map((a) => (
            <li key={a.id} className={`ops-agent-row ${statusClass(a.status)}`}>
              <div className="ops-agent-row-main">
                <div className="ops-agent-row-title">
                  <span className={`ops-agent-dot ${statusClass(a.status)}`} />
                  <strong>{a.label}</strong>
                  <span className="ops-agent-status-tag">{a.status}</span>
                  {a.streamUptimePct != null && (
                    <span className="ops-agent-stream-pct">{a.streamUptimePct}% stream</span>
                  )}
                </div>
                <AgentStreamBar
                  segments={a.stream}
                  windowHours={streamHours}
                  agentLabel={a.label}
                  liveLlm={a.id === 'llm_queue' ? data?.llm : null}
                />
                <p className="ops-agent-msg">{a.lastMessage || 'No recent activity'}</p>
                <div className="ops-agent-row-meta">
                  {a.lastAt && (
                    <time>Last event {new Date(a.lastAt).toLocaleString()}</time>
                  )}
                  {a.errorCount > 0 && (
                    <span className="ops-agent-errors">{a.errorCount} error signal(s)</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="ops-agents-cards">
        <h2 className="ops-section-title">Agent uptime</h2>
        <p className="ops-section-sub">Current status snapshot for each AI agent.</p>
        <AgentCardsGrid agents={data?.agents} />
      </section>

      <h2 className="ops-section-title">Work boards</h2>
      <div className="ops-board">
        <StackColumn
          title="Worked"
          subtitle="Recently completed"
          cards={boards.worked}
          columnClass="ops-column--worked"
          emptyLabel="Nothing completed recently"
        />
        <StackColumn
          title="In progress"
          subtitle="Active now"
          cards={boards.active}
          columnClass="ops-column--active"
          emptyLabel="No active work"
        />
        <StackColumn
          title="In line"
          subtitle="Queued & open needs"
          cards={boards.queued}
          columnClass="ops-column--queued"
          emptyLabel="Queue empty"
        />
        <StackColumn
          title="Broken / errors"
          subtitle="Blockers & signals"
          cards={boards.broken}
          columnClass="ops-column--broken"
          emptyLabel="No issues detected"
        />
      </div>
    </div>
  );
}
