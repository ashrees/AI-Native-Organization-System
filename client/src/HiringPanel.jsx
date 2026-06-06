/**
 * Mock employee generator & hire-to-database (Leadership / HR view).
 */

import { useState } from 'react';

const PROFILES = [
  { id: 'data', label: 'Data / ML' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'legal', label: 'Legal' },
  { id: 'security', label: 'Security' },
  { id: 'ai', label: 'AI/ML' },
  { id: 'hr', label: 'Human Resources' },
  { id: 'finance', label: 'Finance' },
  { id: 'marketing', label: 'Marketing' },
];

export default function HiringPanel({ apiBase, onHired, onError }) {
  const [profileId, setProfileId] = useState('data');
  const [requirements, setRequirements] = useState('');
  const [projectId, setProjectId] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const base = apiBase || '/api';

  async function fetchJson(path, options) {
    const res = await fetch(`${base}${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const generatePreview = async (matchRequirements = false) => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await fetchJson('/workforce/people/generate-mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: profileId || undefined,
          requirements: requirements.trim() || undefined,
          description: requirements.trim() || undefined,
          matchRequirements,
        }),
      });
      setPreview(data);
      setMessage(matchRequirements ? 'Generated best-match candidate (preview).' : 'Random candidate (preview).');
    } catch (e) {
      onError?.(e.message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const hirePerson = async (person) => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await fetchJson('/workforce/people/hire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person,
          projectId: projectId.trim() || undefined,
          hiredBy: 'leadership',
          hiredByName: 'Leadership',
          requirements: requirements.trim() || undefined,
        }),
      });
      setMessage(`Hired ${data.person?.name} (${data.person?.id})${data.teamMember ? ' — added to project team' : ''}.`);
      setPreview(null);
      onHired?.(data);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setLoading(false);
    }
  };

  const aiHire = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await fetchJson('/workforce/people/hire-for-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: profileId || undefined,
          requirements: requirements.trim(),
          description: requirements.trim(),
          projectId: projectId.trim() || undefined,
          source: 'ai',
          hiredByName: 'Org AI',
        }),
      });
      setMessage(
        `AI hired ${data.person?.name} (match ${data.matchScore ?? '—'})${data.teamMember ? ' — on project team' : ''}.`
      );
      setPreview(null);
      onHired?.(data);
    } catch (e) {
      setMessage(e.message);
      onError?.(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="wf-section wf-hiring">
      <h3>Hiring — mock employee generator</h3>
      <p className="wf-section-hint">
        Generate random candidates, preview skills fit, and add to the org database. Org AI can auto-hire when
        AI Handler approves recruitment needs; use this panel for manual HR hires.
      </p>

      <div className="wf-hiring-form">
        <label>
          Profile
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Requirements (optional)
          <textarea
            rows={2}
            placeholder="e.g. data science specialist for legal case analysis"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
        </label>
        <label>
          Add to project (optional)
          <input
            type="text"
            placeholder="proj-organize-company-legal-cases"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </label>
      </div>

      <div className="wf-hiring-actions">
        <button type="button" className="nav-tab" disabled={loading} onClick={() => generatePreview(false)}>
          Random preview
        </button>
        <button type="button" className="nav-tab" disabled={loading} onClick={() => generatePreview(true)}>
          Match preview
        </button>
        <button type="button" className="nav-tab" disabled={loading || !preview} onClick={() => hirePerson(preview.person)}>
          Hire preview
        </button>
        <button type="button" className="nav-tab" disabled={loading} onClick={aiHire}>
          AI hire (generate + DB)
        </button>
      </div>

      {message && (
        <p className={message.startsWith('Hired') || message.includes('preview') ? 'submit-ok' : 'error'}>
          {message}
        </p>
      )}

      {preview?.person && (
        <div className="wf-hiring-preview">
          <h4>Preview</h4>
          <dl className="wf-hiring-dl">
            <dt>ID</dt>
            <dd>{preview.person.id}</dd>
            <dt>Name</dt>
            <dd>{preview.person.name}</dd>
            <dt>Role</dt>
            <dd>{preview.person.role}</dd>
            <dt>Org</dt>
            <dd>
              {preview.person.department} · {preview.person.team}
            </dd>
            <dt>Skills</dt>
            <dd>{(preview.person.skills || []).join(', ')}</dd>
            {preview.matchScore != null && (
              <>
                <dt>Match score</dt>
                <dd>{preview.matchScore}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}
