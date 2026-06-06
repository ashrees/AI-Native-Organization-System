/**
 * Leadership Workforce tab — productivity matrix, health scores, department charts.
 */

import { useState, useMemo } from 'react';
import HiringPanel from './HiringPanel';

function scoreColor(score) {
  if (score >= 75) return 'wf-score--high';
  if (score >= 50) return 'wf-score--mid';
  return 'wf-score--low';
}

function bandLabel(band) {
  const map = {
    thriving: 'Thriving',
    steady: 'Steady',
    watch: 'Watch',
    at_risk: 'At risk',
  };
  return map[band] || band;
}

function bandClass(band) {
  return `wf-band wf-band--${band}`;
}

function BarChart({ items, valueKey, labelKey, maxValue }) {
  const max = maxValue || Math.max(1, ...items.map((i) => i[valueKey] || 0));
  return (
    <div className="wf-bars">
      {items.map((item) => {
        const v = item[valueKey] || 0;
        const pct = Math.round((v / max) * 100);
        return (
          <div key={item[labelKey]} className="wf-bar-row">
            <span className="wf-bar-label" title={item[labelKey]}>
              {item[labelKey]}
            </span>
            <div className="wf-bar-track">
              <div
                className="wf-bar-fill"
                style={{ width: `${pct}%` }}
                title={`${v}`}
              />
            </div>
            <span className="wf-bar-value">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

function IndexBar({ label, value }) {
  return (
    <div className="wf-index-bar">
      <span className="wf-index-label">{label}</span>
      <div className="wf-index-track">
        <div
          className={`wf-index-fill ${scoreColor(value)}`}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className={`wf-index-num ${scoreColor(value)}`}>{value}</span>
    </div>
  );
}

function MatrixHeatmap({ matrix, workers }) {
  const cols = matrix?.columns || [];
  const rows = matrix?.rows || [];
  if (!cols.length || !rows.length) {
    return <p className="empty">No matrix data.</p>;
  }

  return (
    <div className="wf-matrix-wrap">
      <table className="wf-matrix">
        <thead>
          <tr>
            <th>Worker</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const w = workers.find((x) => x.personId === row.personId);
            return (
              <tr key={row.personId}>
                <td className="wf-matrix-name">
                  <strong>{row.name}</strong>
                  <span className="wf-matrix-dept">{row.department}</span>
                </td>
                {row.values.map((v, i) => (
                  <td key={cols[i]} className="wf-matrix-cell">
                    <span
                      className={`wf-heat ${scoreColor(v)}`}
                      style={{ opacity: 0.35 + (v / 100) * 0.65 }}
                      title={`${cols[i]}: ${v}`}
                    >
                      {v}
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkerDetail({ worker }) {
  if (!worker) return null;
  const m = worker.metrics;
  const idx = worker.indexes;
  return (
    <article className="wf-detail-card">
      <header className="wf-detail-head">
        <div>
          <h3>{worker.name}</h3>
          <p className="wf-detail-meta">
            {worker.role} · {worker.department} / {worker.team}
          </p>
        </div>
        <span className={bandClass(worker.statusBand)}>{bandLabel(worker.statusBand)}</span>
      </header>
      <p className="wf-detail-overall">
        Overall performance index: <strong className={scoreColor(idx.overall)}>{idx.overall}</strong>
        {' · '}
        Health score: <strong className={scoreColor(idx.health)}>{idx.health}</strong>
      </p>
      <div className="wf-detail-indexes">
        <IndexBar label="Productivity" value={idx.productivity} />
        <IndexBar label="Reliability" value={idx.reliability} />
        <IndexBar label="Engagement" value={idx.engagement} />
        <IndexBar label="Health" value={idx.health} />
      </div>
      <dl className="wf-metrics-dl">
        <dt>Active load</dt>
        <dd>{m.currentLoad} tasks</dd>
        <dt>Assigned</dt>
        <dd>
          {m.tasksAssigned} total ({m.tasksInProgress} in progress, {m.tasksDone} done,{' '}
          {m.tasksBlocked} blocked)
        </dd>
        <dt>Projects</dt>
        <dd>{m.activeProjects}</dd>
        <dt>Completions</dt>
        <dd>
          {m.completions7d} (7d) · {m.completions30d} (30d)
        </dd>
        <dt>Completion rate</dt>
        <dd>{m.completionRate != null ? `${m.completionRate}%` : '—'}</dd>
        <dt>Worker requests</dt>
        <dd>
          {m.openRequestsSubmitted} open · {m.requestsSubmitted30d} submitted (30d)
        </dd>
        <dt>Availability</dt>
        <dd>
          {worker.availabilityStatus.replace(/_/g, ' ')}
          {worker.availabilityReason ? ` — ${worker.availabilityReason}` : ''}
        </dd>
      </dl>
      {worker.signals?.length > 0 && (
        <ul className="wf-signals">
          {worker.signals.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default function WorkforcePanel({ data, loading, error, apiBase, onHired, onError }) {
  const [selectedId, setSelectedId] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [sortBy, setSortBy] = useState('overall');

  const workers = data?.workers || [];
  const departments = useMemo(() => {
    const set = new Set(workers.map((w) => w.department).filter(Boolean));
    return [...set].sort();
  }, [workers]);

  const filtered = useMemo(() => {
    let list = [...workers];
    if (deptFilter) list = list.filter((w) => w.department === deptFilter);
    list.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'health') return b.indexes.health - a.indexes.health;
      if (sortBy === 'productivity') return b.indexes.productivity - a.indexes.productivity;
      return b.indexes.overall - a.indexes.overall;
    });
    return list;
  }, [workers, deptFilter, sortBy]);

  const selected =
    filtered.find((w) => w.personId === selectedId) ||
    workers.find((w) => w.personId === selectedId) ||
    filtered[0];

  if (loading && !data) {
    return <p className="empty">Loading workforce analytics…</p>;
  }
  if (error) {
    return <p className="error">Workforce analytics: {error}</p>;
  }
  if (!data) {
    return <p className="empty">No workforce data.</p>;
  }

  const dist = data.distribution || {};
  const bench = data.orgBenchmarks || {};

  return (
    <div className="workforce-panel">
      <p className="section-desc wf-intro">
        Explainable indexes (0–100) from tasks, executions, worker requests, availability, and
        load. {data.methodology?.overall}
      </p>

      <div className="wf-kpi-grid">
        <div className="wf-kpi">
          <span className="wf-kpi-label">Headcount</span>
          <span className="wf-kpi-value">{bench.headcount ?? workers.length}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">Thriving</span>
          <span className="wf-kpi-value wf-score--high">{dist.thriving ?? 0}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">Watch / at risk</span>
          <span className="wf-kpi-value wf-score--low">
            {(dist.watch ?? 0) + (dist.at_risk ?? 0)}
          </span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">Median load</span>
          <span className="wf-kpi-value">{bench.medianLoad ?? '—'}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">Updated</span>
          <span className="wf-kpi-value wf-kpi-small">
            {data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—'}
          </span>
        </div>
      </div>

      <div className="wf-grid-2">
        <section className="wf-section">
          <h3>Department performance</h3>
          <p className="wf-section-hint">Average overall index & 7-day completions by department</p>
          <BarChart
            items={data.departmentSummary || []}
            valueKey="avgOverall"
            labelKey="department"
          />
        </section>
        <section className="wf-section">
          <h3>Department health</h3>
          <p className="wf-section-hint">Average health score by department</p>
          <BarChart
            items={(data.departmentSummary || []).map((d) => ({
              ...d,
              label: d.department,
            }))}
            valueKey="avgHealth"
            labelKey="department"
          />
        </section>
      </div>

      <section className="wf-section">
        <div className="wf-section-toolbar">
          <h3>Productivity matrix</h3>
          <div className="wf-filters">
            <label>
              Department
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
                <option value="">All</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sort
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="overall">Overall index</option>
                <option value="productivity">Productivity</option>
                <option value="health">Health</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
        </div>
        <MatrixHeatmap
          matrix={{
            columns: data.matrix?.columns,
            rows: filtered.map((w) => ({
              personId: w.personId,
              name: w.name,
              department: w.department,
              values: [
                w.indexes.productivity,
                w.indexes.reliability,
                w.indexes.engagement,
                w.indexes.health,
                w.indexes.overall,
              ],
            })),
          }}
          workers={filtered}
        />
      </section>

      <div className="wf-grid-2 wf-grid-2--detail">
        <section className="wf-section">
          <h3>Worker roster</h3>
          <ul className="wf-roster">
            {filtered.map((w) => (
              <li key={w.personId}>
                <button
                  type="button"
                  className={`wf-roster-btn ${selected?.personId === w.personId ? 'active' : ''}`}
                  onClick={() => setSelectedId(w.personId)}
                >
                  <span className="wf-roster-name">{w.name}</span>
                  <span className={`wf-roster-score ${scoreColor(w.indexes.overall)}`}>
                    {w.indexes.overall}
                  </span>
                  <span className={bandClass(w.statusBand)}>{bandLabel(w.statusBand)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="wf-section">
          <h3>Performance & health detail</h3>
          <WorkerDetail worker={selected} />
        </section>
      </div>

      <HiringPanel apiBase={apiBase} onHired={onHired} onError={onError} />

      <section className="wf-section wf-methodology">
        <h3>How scores are calculated</h3>
        <ul>
          <li>
            <strong>Productivity:</strong> {data.methodology?.productivity}
          </li>
          <li>
            <strong>Reliability:</strong> {data.methodology?.reliability}
          </li>
          <li>
            <strong>Engagement:</strong> {data.methodology?.engagement}
          </li>
          <li>
            <strong>Health:</strong> {data.methodology?.health}
          </li>
        </ul>
      </section>
    </div>
  );
}
