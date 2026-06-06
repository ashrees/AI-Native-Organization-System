/**
 * Operations Monitor — standalone app (monitor/).
 * Agent uptime, human activity, and animated work boards.
 */

import { useEffect, useState } from 'react';
import OpsMonitorPanel from './OpsMonitorPanel';

const THEME_KEY = 'ops-monitor-theme';
const LEADERSHIP_URL = import.meta.env.VITE_LEADERSHIP_URL || 'http://localhost:5173';
const WORKER_URL = import.meta.env.VITE_WORKER_PORTAL_URL || 'http://localhost:5174';

function getStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState(getStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="monitor-app">
      <header className="monitor-header">
        <div>
          <h1>Operations Monitor</h1>
          <p className="monitor-subtitle">
            Agent uptime streams and work boards — worked, in progress, queued, and broken.
          </p>
        </div>
        <div className="monitor-header-actions">
          <a className="monitor-portal-link" href={LEADERSHIP_URL} target="_blank" rel="noopener noreferrer">
            Leadership View
          </a>
          <a className="monitor-portal-link" href={WORKER_URL} target="_blank" rel="noopener noreferrer">
            Worker Portal
          </a>
          <button type="button" className="monitor-theme-btn" onClick={toggleTheme}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>
      <OpsMonitorPanel />
    </div>
  );
}
