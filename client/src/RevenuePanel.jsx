/**
 * Revenue tab — project budgets, burn, budget requests, financial matrix & charts.
 */

import { useEffect, useMemo, useState } from 'react';

function formatMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

function bandClass(band) {
  return `rev-band rev-band--${band || 'healthy'}`;
}

function bandLabel(band) {
  const map = {
    healthy: 'Healthy',
    steady: 'Steady',
    watch: 'Watch',
    critical: 'Critical',
  };
  return map[band] || band;
}

function projectPhaseLabel(row) {
  if (row.archived) return 'Archived';
  if (row.status === 'completed') return 'Completed';
  if (row.status === 'killed') return 'Killed';
  return 'Active';
}

function projectPhaseClass(row) {
  if (row.archived) return 'rev-phase--archived';
  if (row.status === 'completed') return 'rev-phase--completed';
  if (row.status === 'killed') return 'rev-phase--killed';
  return 'rev-phase--active';
}

function BarChart({ items, valueKey, labelKey, format = (v) => v }) {
  const max = Math.max(1, ...items.map((i) => i[valueKey] || 0));
  return (
    <div className="rev-bars">
      {items.map((item) => {
        const v = item[valueKey] || 0;
        const pct = Math.round((v / max) * 100);
        return (
          <div key={item[labelKey]} className="rev-bar-row">
            <span className="rev-bar-label" title={item[labelKey]}>
              {item[labelKey]}
            </span>
            <div className="rev-bar-track">
              <div className="rev-bar-fill" style={{ width: `${pct}%` }} title={format(v)} />
            </div>
            <span className="rev-bar-value">{format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

function FinanceMatrix({ matrix }) {
  const cols = matrix?.columns || [];
  const rows = matrix?.rows || [];
  if (!cols.length || !rows.length) return <p className="empty">No matrix data.</p>;

  const maxPerCol = cols.map((_, ci) =>
    Math.max(1, ...rows.map((r) => Math.abs(r.values[ci] || 0)))
  );

  return (
    <div className="rev-matrix-wrap">
      <table className="rev-matrix">
        <thead>
          <tr>
            <th>Project</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.projectId}>
              <td>
                <span className="rev-matrix-name">{row.name}</span>
                <span className="rev-matrix-dept">{row.department}</span>
              </td>
              {row.values.map((v, ci) => {
                const pct = Math.round((Math.abs(v) / maxPerCol[ci]) * 100);
                const isUtil = cols[ci] === 'Util %';
                const heat =
                  isUtil && v >= 90
                    ? 'rev-heat--critical'
                    : isUtil && v >= 75
                      ? 'rev-heat--watch'
                      : 'rev-heat--ok';
                return (
                  <td key={cols[ci]}>
                    <div className={`rev-heat ${heat}`} style={{ opacity: 0.35 + (pct / 100) * 0.65 }}>
                      {cols[ci].includes('%') || cols[ci].includes('Util') ? v : formatMoney(v)}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BurnChart({ projects }) {
  const items = [...projects]
    .sort((a, b) => b.finance.metrics.burn7d - a.finance.metrics.burn7d)
    .slice(0, 10);
  if (!items.length) return <p className="empty">No burn data yet.</p>;
  const max = Math.max(1, ...items.map((p) => p.finance.metrics.burn7d));
  return (
    <div className="rev-burn-chart">
      {items.map((p) => {
        const v = p.finance.metrics.burn7d;
        const h = Math.max(8, Math.round((v / max) * 120));
        return (
          <div key={p.projectId} className="rev-burn-col" title={`${p.title}: ${formatMoney(v)} (7d)`}>
            <div className="rev-burn-bar" style={{ height: `${h}px` }} />
            <span className="rev-burn-label">{((p.title || p.projectId) || '').slice(0, 12)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectFinanceCard({ row, apiBase, onRefresh, onError }) {
  const m = row.finance.metrics;
  const [budgetInput, setBudgetInput] = useState(String(row.finance.budgetTotal || ''));
  const [burnAmount, setBurnAmount] = useState('');
  const [burnReason, setBurnReason] = useState('');
  const [requestAmount, setRequestAmount] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function post(path, body) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      setMsg('Saved.');
      onRefresh?.();
    } catch (e) {
      setMsg(e.message);
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  const pct = m.utilizationPct;

  return (
    <article className={`rev-project-card ${bandClass(m.healthBand)}`}>
      <header className="rev-project-head">
        <h4>{row.title}</h4>
        <span className={`rev-phase-pill ${projectPhaseClass(row)}`}>{projectPhaseLabel(row)}</span>
        <span className={bandClass(m.healthBand)}>{bandLabel(m.healthBand)}</span>
      </header>
      <p className="rev-project-meta">
        {row.department} · {row.projectId} · {m.utilizationPct}% utilized
        {m.runwayDays != null && ` · ~${m.runwayDays}d runway`}
      </p>

      <div className="rev-budget-bar" aria-label="Budget utilization">
        <div className="rev-budget-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <dl className="rev-dl">
        <div>
          <dt>Budget</dt>
          <dd>{formatMoney(m.budgetTotal, row.currency)}</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>{formatMoney(m.budgetSpent, row.currency)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{formatMoney(m.remaining, row.currency)}</dd>
        </div>
        <div>
          <dt>7d burn</dt>
          <dd>{formatMoney(m.burn7d, row.currency)}</dd>
        </div>
        {m.revenuePlanned > 0 && (
          <div>
            <dt>Planned revenue</dt>
            <dd>{formatMoney(m.revenuePlanned, row.currency)}</dd>
          </div>
        )}
      </dl>

      <div className="rev-actions-grid">
        <label>
          Set budget
          <input
            type="number"
            min="0"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="nav-tab"
            disabled={busy}
            onClick={() =>
              post(`/revenue/projects/${encodeURIComponent(row.projectId)}/budget`, {
                budgetTotal: Number(budgetInput),
                revenuePlanned: Number(budgetInput) * 1.2,
              })
            }
          >
            Save budget
          </button>
        </label>
        <label>
          Record burn
          <input
            type="number"
            min="1"
            placeholder="Amount"
            value={burnAmount}
            onChange={(e) => setBurnAmount(e.target.value)}
            disabled={busy}
          />
          <input
            type="text"
            placeholder="Reason"
            value={burnReason}
            onChange={(e) => setBurnReason(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="nav-tab"
            disabled={busy || !burnAmount}
            onClick={() =>
              post(`/revenue/projects/${encodeURIComponent(row.projectId)}/burn`, {
                amount: Number(burnAmount),
                reason: burnReason.trim() || 'Manual burn',
              })
            }
          >
            Burn
          </button>
        </label>
        <label>
          Request more budget
          <input
            type="number"
            min="1"
            placeholder="Additional amount"
            value={requestAmount}
            onChange={(e) => setRequestAmount(e.target.value)}
            disabled={busy}
          />
          <input
            type="text"
            placeholder="Justification"
            value={requestReason}
            onChange={(e) => setRequestReason(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="nav-tab"
            disabled={busy || !requestAmount}
            onClick={() =>
              post(`/revenue/projects/${encodeURIComponent(row.projectId)}/budget-request`, {
                amount: Number(requestAmount),
                reason: requestReason.trim(),
                requestedBy: 'leadership',
              })
            }
          >
            Request budget
          </button>
        </label>
      </div>
      {msg && <p className={msg === 'Saved.' ? 'submit-ok' : 'error'}>{msg}</p>}
    </article>
  );
}

const REVENUE_PHASES = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'killed', label: 'Killed' },
  { id: 'archived', label: 'Archived' },
];

function filterRevenueProjects(projects, phase) {
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

export default function RevenuePanel({ data, loading, error, apiBase, onRefresh, onError }) {
  const [deptFilter, setDeptFilter] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);

  const projects = data?.projects || [];
  const phaseFiltered = useMemo(
    () => filterRevenueProjects(projects, phaseFilter),
    [projects, phaseFilter]
  );
  const departments = useMemo(() => {
    const set = new Set(phaseFiltered.map((p) => p.department).filter(Boolean));
    return [...set].sort();
  }, [phaseFiltered]);

  const filtered = useMemo(() => {
    if (!deptFilter) return phaseFiltered;
    return phaseFiltered.filter((p) => p.department === deptFilter);
  }, [phaseFiltered, deptFilter]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((p) => p.projectId === selectedId)) {
      setSelectedId(filtered[0].projectId);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((p) => p.projectId === selectedId) || filtered[0] || null;

  if (loading) return <p className="empty">Loading revenue analytics…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="empty">No revenue data.</p>;

  const totals = data.totals || {};

  return (
    <div className="rev-panel">
      <div className="rev-totals">
        <div className="rev-total-card">
          <span className="rev-total-label">Portfolio budget</span>
          <strong>{formatMoney(totals.budgetTotal)}</strong>
        </div>
        <div className="rev-total-card">
          <span className="rev-total-label">Spent</span>
          <strong>{formatMoney(totals.budgetSpent)}</strong>
          <span className="rev-total-sub">{totals.utilizationPct}% utilized</span>
        </div>
        <div className="rev-total-card">
          <span className="rev-total-label">Remaining</span>
          <strong>{formatMoney(totals.remaining)}</strong>
        </div>
        <div className="rev-total-card">
          <span className="rev-total-label">7d burn</span>
          <strong>{formatMoney(totals.burn7d)}</strong>
        </div>
        {data.openBudgetRequests > 0 && (
          <div className="rev-total-card rev-total-card--warn">
            <span className="rev-total-label">Open budget requests</span>
            <strong>{data.openBudgetRequests}</strong>
          </div>
        )}
      </div>

      <div className="rev-grid-2">
        <section className="rev-section">
          <h3>Spend by department</h3>
          <BarChart
            items={data.departmentSummary || []}
            valueKey="budgetSpent"
            labelKey="department"
            format={(v) => formatMoney(v)}
          />
        </section>
        <section className="rev-section">
          <h3>Budget allocation by department</h3>
          <BarChart
            items={data.departmentSummary || []}
            valueKey="budgetTotal"
            labelKey="department"
            format={(v) => formatMoney(v)}
          />
        </section>
      </div>

      <section className="rev-section">
        <h3>7-day burn by project</h3>
        <BurnChart projects={projects} />
      </section>

      <section className="rev-section">
        <h3>Financial matrix</h3>
        <p className="rev-section-hint">{data.methodology?.matrix}</p>
        <FinanceMatrix matrix={data.matrix} />
      </section>

      <section className="rev-section rev-projects-manage">
        <div className="rev-section-head">
          <h3>Project budgets</h3>
          <p className="rev-section-hint">
            {projects.length} project{projects.length === 1 ? '' : 's'} in portfolio
            {phaseFilter !== 'all' ? ` · showing ${filtered.length} in filter` : ''}
          </p>
          <div className="rev-section-filters">
            <div className="rev-phase-tabs" role="tablist" aria-label="Project lifecycle filter">
              {REVENUE_PHASES.map((ph) => (
                <button
                  key={ph.id}
                  type="button"
                  role="tab"
                  aria-selected={phaseFilter === ph.id}
                  className={`rev-phase-tab${phaseFilter === ph.id ? ' active' : ''}`}
                  onClick={() => setPhaseFilter(ph.id)}
                >
                  {ph.label}
                </button>
              ))}
            </div>
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
          </div>
        </div>
        <div className="rev-projects-layout">
          <nav className="rev-project-nav">
            {filtered.map((p) => (
              <button
                key={p.projectId}
                type="button"
                className={`rev-project-nav-btn${selected?.projectId === p.projectId ? ' active' : ''}`}
                onClick={() => setSelectedId(p.projectId)}
              >
                <span className="rev-nav-title">
                  <span>{p.title}</span>
                  <span className={`rev-phase-pill rev-phase-pill--small ${projectPhaseClass(p)}`}>
                    {projectPhaseLabel(p)}
                  </span>
                </span>
                <span className="rev-nav-pct">{p.finance.metrics.utilizationPct}%</span>
              </button>
            ))}
          </nav>
          {selected ? (
            <ProjectFinanceCard
              row={selected}
              apiBase={apiBase}
              onRefresh={onRefresh}
              onError={onError}
            />
          ) : (
            <p className="empty">No projects in this filter.</p>
          )}
        </div>
      </section>

      <section className="rev-section rev-methodology">
        <h3>How metrics are calculated</h3>
        <ul>
          <li>{data.methodology?.budget}</li>
          <li>{data.methodology?.burn}</li>
          <li>{data.methodology?.runway}</li>
        </ul>
      </section>
    </div>
  );
}
