/**
 * Map activity log / event sources to Ops Monitor agent rows.
 */

const AI_HANDLER_MSG_RE = /\bAI Handler\b/i;

function isAiHandlerMessage(text) {
  return AI_HANDLER_MSG_RE.test(String(text || ''));
}

/**
 * Which AGENT_DEFS row should own this activity line.
 */
function resolveActivityAgentId(source, message, summary) {
  const src = source || 'org_ai';
  const text = `${message || ''} ${summary || ''}`;
  if (src === 'ai_handler' || (src === 'org_ai' && isAiHandlerMessage(text))) {
    return 'ai_handler';
  }
  return src;
}

module.exports = {
  AI_HANDLER_MSG_RE,
  isAiHandlerMessage,
  resolveActivityAgentId,
};
