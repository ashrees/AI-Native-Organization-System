/**
 * Project finance state helpers (budget, burn, runway).
 */

const MAX_BURN_LOG = 40;

function defaultFinanceForProject(projectState) {
  const tasks = projectState?.progress?.tasks || [];
  const teamSize = Object.values(projectState?.roles || {}).filter((r) => r?.personId).length;
  const base = 50000 + tasks.length * 3500 + teamSize * 8000;
  const budgetTotal = Math.round(base / 1000) * 1000;
  return {
    currency: 'USD',
    budgetTotal,
    budgetSpent: 0,
    revenuePlanned: Math.round(budgetTotal * 1.25),
    burnLog: [],
    pendingBudgetRequests: 0,
  };
}

function ensureFinance(state) {
  if (!state.finance || typeof state.finance.budgetTotal !== 'number') {
    state.finance = defaultFinanceForProject(state);
  }
  if (!Array.isArray(state.finance.burnLog)) state.finance.burnLog = [];
  return state.finance;
}

function sumBurnInWindow(burnLog, days, now = new Date()) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return (burnLog || []).reduce((sum, e) => {
    const t = new Date(e.at || e.timestamp).getTime();
    if (Number.isNaN(t) || t < cutoff) return sum;
    return sum + (Number(e.amount) || 0);
  }, 0);
}

function computeFinanceMetrics(finance, now = new Date()) {
  const budgetTotal = Math.max(0, Number(finance.budgetTotal) || 0);
  const budgetSpent = Math.max(0, Number(finance.budgetSpent) || 0);
  const remaining = Math.max(0, budgetTotal - budgetSpent);
  const utilizationPct = budgetTotal > 0 ? Math.round((budgetSpent / budgetTotal) * 100) : 0;
  const burn7d = sumBurnInWindow(finance.burnLog, 7, now);
  const burn30d = sumBurnInWindow(finance.burnLog, 30, now);
  const dailyBurn7d = burn7d / 7;
  const dailyBurn30d = burn30d / 30;
  const runwayDays =
    dailyBurn7d > 0 ? Math.round(remaining / dailyBurn7d) : dailyBurn30d > 0 ? Math.round(remaining / dailyBurn30d) : null;

  let healthBand = 'healthy';
  if (utilizationPct >= 95) healthBand = 'critical';
  else if (utilizationPct >= 80) healthBand = 'watch';
  else if (utilizationPct >= 60) healthBand = 'steady';

  const revenuePlanned = Number(finance.revenuePlanned) || 0;
  const marginPct =
    revenuePlanned > 0 ? Math.round(((revenuePlanned - budgetSpent) / revenuePlanned) * 100) : null;

  return {
    budgetTotal,
    budgetSpent,
    remaining,
    utilizationPct,
    burn7d,
    burn30d,
    dailyBurn7d: Math.round(dailyBurn7d),
    dailyBurn30d: Math.round(dailyBurn30d),
    runwayDays,
    healthBand,
    revenuePlanned,
    marginPct,
    pendingBudgetRequests: finance.pendingBudgetRequests || 0,
  };
}

function appendBurn(finance, entry) {
  const log = [...(finance.burnLog || []), entry];
  finance.burnLog = log.slice(-MAX_BURN_LOG);
  finance.budgetSpent = (Number(finance.budgetSpent) || 0) + (Number(entry.amount) || 0);
  finance.lastBurnAt = entry.at;
}

function formatMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

module.exports = {
  MAX_BURN_LOG,
  defaultFinanceForProject,
  ensureFinance,
  computeFinanceMetrics,
  appendBurn,
  sumBurnInWindow,
  formatMoney,
};
