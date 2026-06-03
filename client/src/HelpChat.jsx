/**
 * Floating help chat — ask AI agents about org status using live API context.
 */

import { useState, useEffect, useRef } from 'react';

const API_HELP = '/api/help-chat';

async function postHelp(body) {
  const res = await fetch(API_HELP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function formatAnswer(text) {
  if (!text) return '';
  return text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return (
        <li key={i} className="help-chat-li">
          {trimmed.replace(/^[-*]\s+/, '')}
        </li>
      );
    }
    if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
      return (
        <p key={i} className="help-chat-strong">
          {trimmed.replace(/\*\*/g, '')}
        </p>
      );
    }
    if (!trimmed) return <br key={i} />;
    return <p key={i}>{line}</p>;
  });
}

export default function HelpChat({ projects = [] }) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState('auto');
  const [projectId, setProjectId] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'Ask me anything about the org — projects, tasks, people, workforce health & productivity, worker requests, events, leave, and AI activity. I use a full live snapshot and route to the right agent.',
      meta: { agentLabel: 'Help' },
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [suggested, setSuggested] = useState([]);
  const [agents, setAgents] = useState({});
  const scrollRef = useRef(null);

  useEffect(() => {
    fetch(`${API_HELP}/meta`)
      .then((r) => r.json())
      .then((d) => {
        setSuggested(d.suggestedQuestions || []);
        setAgents(d.agents || {});
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open]);

  async function sendQuestion(text) {
    const question = (text || input).trim();
    if (!question || loading) return;

    setError(null);
    setInput('');
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !m.meta?.welcome)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setLoading(true);

    try {
      const data = await postHelp({
        message: question,
        agent: agent === 'auto' ? 'auto' : agent,
        projectId: projectId || undefined,
        messages: history,
      });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.answer,
          meta: {
            agent: data.agent,
            agentLabel: data.agentLabel,
            fallback: data.fallback,
          },
        },
      ]);
      if (data.suggestedQuestions?.length) {
        setSuggested(data.suggestedQuestions);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`help-chat-fab ${open ? 'help-chat-fab--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="help-chat-panel"
        title="Ask AI agents"
      >
        {open ? '×' : '?'}
        <span className="help-chat-fab-label">Help</span>
      </button>

      {open && (
        <div
          id="help-chat-panel"
          className="help-chat-panel"
          role="dialog"
          aria-label="Help chat with AI agents"
        >
          <header className="help-chat-header">
            <div>
              <h2 className="help-chat-title">Help</h2>
              <p className="help-chat-subtitle">Full org context · all projects & people</p>
            </div>
            <button
              type="button"
              className="help-chat-close"
              onClick={() => setOpen(false)}
              aria-label="Close help chat"
            >
              ×
            </button>
          </header>

          <div className="help-chat-controls">
            <label className="help-chat-field">
              <span>Agent</span>
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="auto">Auto (recommended)</option>
                {Object.entries(agents)
                  .filter(([id]) => id !== 'auto')
                  .map(([id, a]) => (
                    <option key={id} value={id}>
                      {a.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="help-chat-field">
              <span>Project (optional)</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {suggested.length > 0 && messages.length <= 2 && (
            <div className="help-chat-suggestions">
              <span className="help-chat-suggestions-label">Try asking:</span>
              <div className="help-chat-chips">
                {suggested.slice(0, 5).map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="help-chat-chip"
                    onClick={() => sendQuestion(q)}
                    disabled={loading}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="help-chat-messages" ref={scrollRef}>
            {messages.map((m, i) => (
              <div
                key={i}
                className={`help-chat-bubble help-chat-bubble--${m.role}`}
              >
                {m.meta?.agentLabel && m.role === 'assistant' && (
                  <span className="help-chat-agent-tag">
                    {m.meta.agentLabel}
                    {m.meta.fallback && ' · data only'}
                  </span>
                )}
                <div className="help-chat-bubble-body">
                  {m.role === 'assistant' ? formatAnswer(m.content) : m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="help-chat-bubble help-chat-bubble--assistant">
                <span className="help-chat-agent-tag">Thinking…</span>
              </div>
            )}
          </div>

          {error && <p className="help-chat-error">{error}</p>}

          <form
            className="help-chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              sendQuestion();
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about projects, people, requests…"
              disabled={loading}
              aria-label="Your question"
            />
            <button type="submit" className="help-chat-send" disabled={loading || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
