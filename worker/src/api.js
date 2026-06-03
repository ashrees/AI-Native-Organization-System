const API_BASE = import.meta.env.VITE_API_URL || '/api';

export async function fetchJson(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || 'Request failed');
  }
  return data;
}

export function workerApiBase() {
  return `${API_BASE}/worker`;
}
