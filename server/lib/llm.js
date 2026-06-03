/**
 * Shared LLM helper: load prompt templates and call OpenAI or Google Gemini with structured JSON output.
 * Provider selection: if GOOGLE_API_KEY or GEMINI_API_KEY is set, use Google Gemini; else if OPENAI_API_KEY is set, use OpenAI.
 * Replaceable later (e.g. other provider). Callers use complete() and get parsed JSON or null.
 *
 * Model access is serialized: only one agent uses the LLM at a time. Agents wait for the lock before calling the provider.
 */

const path = require('path');
const fs = require('fs');
const postgresStore = require('../store/postgresStore');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

/** Promise-based mutex: only one caller runs at a time; others wait. */
let _modelLock = Promise.resolve();
async function withModelLock(fn) {
  const prev = _modelLock;
  let release;
  _modelLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function stripTrailingCommas(jsonText) {
  return jsonText.replace(/,(\s*[}\]])/g, '$1');
}

/** Close unclosed strings/brackets when the model hits num_predict mid-object. */
function repairTruncatedJson(slice) {
  let repaired = slice.trimEnd();
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if ((c === '}' || c === ']') && stack.length && stack[stack.length - 1] === c) {
      stack.pop();
    }
  }

  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/:\s*$/, ': null');
  while (stack.length) repaired += stack.pop();
  return repaired;
}

function tryParseJsonCandidate(candidate) {
  if (!candidate) return null;
  const cleaned = stripTrailingCommas(candidate.trim());
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  try {
    return JSON.parse(repairTruncatedJson(cleaned));
  } catch (_) {}
  return null;
}

/** Parse JSON from LLM text; handles markdown code blocks, trailing text, trailing commas, and truncated JSON. */
function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  const direct = tryParseJsonCandidate(t);
  if (direct !== null) return direct;

  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    const fromFence = tryParseJsonCandidate(m[1]);
    if (fromFence !== null) return fromFence;
  }

  const i0 = t.indexOf('{');
  const i1 = t.indexOf('[');
  const start = i0 >= 0 && (i1 < 0 || i0 <= i1) ? i0 : i1;
  if (start < 0) return null;

  const stack = [];
  let inString = false;
  let escape = false;
  let closedAt = -1;

  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if ((c === '}' || c === ']') && stack.length && stack[stack.length - 1] === c) {
      stack.pop();
      if (stack.length === 0) {
        closedAt = i + 1;
        break;
      }
    }
  }

  const slice = closedAt > 0 ? t.slice(start, closedAt) : t.slice(start);
  return tryParseJsonCandidate(slice);
}

function cleanEnvValue(value) {
  if (value == null) return '';
  return String(value).replace(/\s+#.*$/, '').trim();
}

/** Default free-tier cloud models (direct API at ollama.com). See https://docs.ollama.com/cloud */
const OLLAMA_CLOUD_DEFAULT_MODELS = 'gpt-oss:120b,nemotron-3-super,gpt-oss:20b';
const OLLAMA_LOCAL_CLOUD_PROXY_MODELS = 'gpt-oss:120b-cloud,nemotron-3-super:cloud,gpt-oss:20b-cloud';

/**
 * Resolve Ollama host, auth, and model names.
 * - Direct cloud: OLLAMA_API_KEY + https://ollama.com (models without -cloud suffix)
 * - Local app proxy: localhost:11434 after `ollama signin` + `ollama pull …-cloud`
 */
function getOllamaConfig(options = {}) {
  const apiKey = cleanEnvValue(process.env.OLLAMA_API_KEY);
  const useCloudApi = !!apiKey;
  const baseUrl = cleanEnvValue(
    options.baseUrl ||
      process.env.OLLAMA_BASE_URL ||
      (useCloudApi ? 'https://ollama.com' : 'http://localhost:11434')
  ).replace(/\/$/, '');
  const isDirectCloud = useCloudApi || baseUrl.includes('ollama.com');

  const modelSpec = cleanEnvValue(
    options.model ||
      process.env.OLLAMA_MODEL ||
      (isDirectCloud && !baseUrl.includes('localhost') ? OLLAMA_CLOUD_DEFAULT_MODELS : OLLAMA_LOCAL_CLOUD_PROXY_MODELS)
  );

  const modelCandidates = modelSpec
    .split(',')
    .map((s) => cleanEnvValue(s))
    .filter(Boolean)
    .map((name) => {
      if (isDirectCloud && name.endsWith('-cloud')) {
        return name.replace(/-cloud$/i, '');
      }
      const cloudApiNames = OLLAMA_CLOUD_DEFAULT_MODELS.split(',');
      if (
        !isDirectCloud &&
        baseUrl.includes('localhost') &&
        !name.endsWith('-cloud') &&
        !name.includes(':cloud') &&
        cloudApiNames.includes(name)
      ) {
        return `${name}-cloud`;
      }
      return name;
    });

  return {
    baseUrl,
    apiKey,
    isDirectCloud,
    modelCandidates: modelCandidates.length ? modelCandidates : ['gpt-oss:120b'],
    label: isDirectCloud ? 'Ollama Cloud' : 'Ollama (local)',
  };
}

async function ollamaChatRequest(baseUrl, apiKey, body, timeoutMs) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

/** Max retries when LLM returns null; we wait for a proper response. */
const LLM_MAX_RETRIES = Math.max(1, parseInt(cleanEnvValue(process.env.LLM_MAX_RETRIES) || '5', 10));
/** Delay in ms before each retry; can use exponential backoff. */
const LLM_RETRY_DELAY_MS = Math.max(500, parseInt(cleanEnvValue(process.env.LLM_RETRY_DELAY_MS) || '3000', 10));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logLlmInteraction(details) {
  try {
    await postgresStore.insertLlmLog(details);
  } catch (err) {
    // Logging must never break the main flow
    console.error('LLM log insert failed:', err.message);
  }
}

/**
 * Load a prompt template by name (e.g. 'orchestrator' -> prompts/orchestrator.txt).
 */
function readPrompt(name) {
  const file = path.join(PROMPTS_DIR, `${name}.txt`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim();
}

/** Ollama tool definitions for structured output: model returns JSON via tool call for better reliability. */
const OLLAMA_TOOLS = Object.freeze({
  orchestrator: [
    {
      type: 'function',
      function: {
        name: 'submit_plan',
        description: 'Submit the structured plan: tasks, risk level, impact level, and summary. Call this with your final plan.',
        parameters: {
          type: 'object',
          required: ['tasks', 'riskLevel', 'impactLevel', 'summary'],
          properties: {
            tasks: {
              type: 'array',
              description: 'List of tasks for the plan',
              items: {
                type: 'object',
                required: ['id', 'title'],
                properties: {
                  id: { type: 'string', description: 'Unique task id' },
                  title: { type: 'string', description: 'Short task title' },
                  description: { type: 'string', description: 'Optional task description' },
                  requiredDepartments: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional department/role labels',
                  },
                },
              },
            },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk level' },
            impactLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Impact level' },
            summary: { type: 'string', description: 'One or two sentence summary for the UI log' },
          },
        },
      },
    },
  ],
  teamBuilder: [
    {
      type: 'function',
      function: {
        name: 'submit_assignment',
        description: 'Submit the chosen person and rationale for the task assignment. Call this with your final assignment.',
        parameters: {
          type: 'object',
          required: ['personId', 'rationale'],
          properties: {
            personId: { type: 'string', description: 'Id of the selected person from the provided people list' },
            rationale: { type: 'string', description: 'Short explanation (1-2 sentences) for the UI log' },
          },
        },
      },
    },
  ],
  scheduler: [
    {
      type: 'function',
      function: {
        name: 'submit_schedule',
        description: 'Submit the proposed schedule: array of taskId, proposedStart, proposedEnd, rationale per task. Call this with your final schedule.',
        parameters: {
          type: 'object',
          required: ['proposals'],
          properties: {
            proposals: {
              type: 'array',
              description: 'Proposed start/end per task',
              items: {
                type: 'object',
                required: ['taskId', 'proposedStart', 'proposedEnd'],
                properties: {
                  taskId: { type: 'string', description: 'Task id' },
                  proposedStart: { type: 'string', description: 'ISO 8601 start date' },
                  proposedEnd: { type: 'string', description: 'ISO 8601 end date' },
                  rationale: { type: 'string', description: 'Optional short explanation' },
                },
              },
            },
          },
        },
      },
    },
  ],
  projectAI: [
    {
      type: 'function',
      function: {
        name: 'submit_project_assessment',
        description: 'Submit project status assessment and optional agent delegations.',
        parameters: {
          type: 'object',
          required: ['summary', 'riskLevel', 'riskReason'],
          properties: {
            summary: { type: 'string', description: 'Two sentence project status summary' },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
            riskReason: { type: 'string', description: 'One line risk explanation' },
            recentChanges: {
              type: 'array',
              items: { type: 'string' },
            },
            suggestProjectCompleted: { type: 'boolean' },
            agentActions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string', enum: ['orchestrator', 'team_builder', 'scheduler', 'system'] },
                  action: {
                    type: 'string',
                    enum: ['assign_unassigned', 'assign_task', 'reschedule', 'replan', 'create_need'],
                  },
                  reason: { type: 'string' },
                  taskId: { type: 'string' },
                  taskIds: { type: 'array', items: { type: 'string' } },
                  payload: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
  ],
});

/**
 * Call Google Gemini generateContent with system instruction and user message; request JSON output.
 * Returns parsed JSON object, or null if no API key or on error.
 */
async function completeWithGoogle(systemPrompt, userMessage, options = {}) {
  const apiKey = cleanEnvValue(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  if (!apiKey) return null;

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const model = cleanEnvValue(options.model || 'gemini-2.0-flash');

    // Use the simplest, documented shape for @google/genai:
    // - systemInstruction at top level
    // - generationConfig for temperature / JSON response
    const response = await ai.models.generateContent({
      model,
      contents: userMessage,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

    const text = response?.text;
    if (!text || typeof text !== 'string') return null;

    return parseJsonResponse(text);
  } catch (err) {
    console.error('Google Gemini complete error:', err.message);
    return null;
  }
}

/**
 * Call a local Ollama model via HTTP API.
 * When options.tools is provided, uses Ollama tool calling for structured output (better performance/reliability).
 * Returns parsed JSON object, or null if not configured or on error.
 */
async function completeWithOllama(systemPrompt, userMessage, options = {}) {
  const { baseUrl, apiKey, isDirectCloud, modelCandidates, label } = getOllamaConfig(options);
  const tools = options.tools != null && Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : null;

  try {
    const requested = Number(
      cleanEnvValue(
        options.timeoutMs != null ? String(options.timeoutMs) : process.env.OLLAMA_TIMEOUT_MS
      ) || 60000
    );
    const timeoutMs = Math.max(requested, isDirectCloud ? 180000 : 120000);

    const candidates = modelCandidates.slice();
    candidates.sort((a, b) => {
      const ax = a.toLowerCase().includes('thinking') ? 1 : 0;
      const bx = b.toLowerCase().includes('thinking') ? 1 : 0;
      return ax - bx;
    });

    if (candidates.length) {
      console.log(`[LLM] ${label} models: ${candidates.join(', ')}`);
    }

    for (let idx = 0; idx < candidates.length; idx++) {
      const model = candidates[idx];

      try {
        const body = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: Number(
              process.env.OLLAMA_NUM_PREDICT ||
                (isDirectCloud ? 8192 : 2048)
            ),
          },
        };
        if (tools) {
          body.tools = tools;
        } else {
          body.format = 'json';
        }

        const res = await ollamaChatRequest(baseUrl, apiKey, body, timeoutMs);

        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) {
            console.error(
              '[LLM] Ollama Cloud auth failed. Set OLLAMA_API_KEY from https://ollama.com/settings/keys'
            );
            return null;
          }
          if (res.status === 404 || /model .* not found/i.test(bodyText)) {
            console.warn(`[LLM] Ollama model not found: ${model}`);
            continue;
          }
          if (res.status >= 500 && candidates.length > 1) {
            console.warn(`[LLM] Ollama model failed (${res.status}) for ${model}; trying next model candidate`);
            continue;
          }
          console.error('Ollama HTTP error:', res.status, res.statusText, bodyText.slice(0, 500));
          return null;
        }

        const data = await res.json();
        const msg = data?.message;

        // Prefer tool call result when using tools (structured output)
        if (tools && msg?.tool_calls && msg.tool_calls.length > 0) {
          const call = msg.tool_calls[0];
          const fn = call?.function;
          let args = fn?.arguments;
          if (args != null) {
            if (typeof args === 'string') {
              const parsed = parseJsonResponse(args);
              if (parsed !== null) return parsed;
            } else if (typeof args === 'object') {
              return args;
            }
          }
        }

        const text = msg?.content;
        if (!text || typeof text !== 'string') return null;
        const parsed = parseJsonResponse(text);
        if (parsed !== null) return parsed;
        try {
          return JSON.parse(text);
        } catch (_) {}
        const preview = String(text).slice(0, 200);
        const likelyTruncated = text.length > 500 && text.trimStart().startsWith('{');
        console.warn(
          `[LLM] Ollama response did not parse as JSON${
            likelyTruncated ? ' (likely truncated — raise OLLAMA_NUM_PREDICT)' : ''
          }. First 200 chars: ${preview}`
        );
        return null;
      } catch (err) {
        if (err.name === 'AbortError') {
          if (idx < candidates.length - 1) {
            console.warn(`[LLM] Ollama model timed out: ${model}; trying next model candidate`);
            continue;
          }
          console.error('Ollama complete error: request timed out');
          return null;
        }
        if (idx < candidates.length - 1) {
          console.warn(`[LLM] Ollama request failed for ${model}: ${err.message}; trying next model candidate`);
          continue;
        }
        console.error('Ollama complete error:', err.message);
        return null;
      }
    }

    return null;
  } finally {
  }
}

/**
 * Call OpenAI chat completions with system prompt and user message; request JSON output.
 * Returns parsed JSON object, or null if no API key or on error.
 */
async function completeWithOpenAI(systemPrompt, userMessage, options = {}) {
  const apiKey = cleanEnvValue(process.env.OPENAI_API_KEY);
  if (!apiKey) return null;

  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });
    const model = cleanEnvValue(options.model || 'gpt-4o-mini');

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseJsonResponse(content) || (() => { try { return JSON.parse(content); } catch (_) { return null; } })();
  } catch (err) {
    console.error('OpenAI complete error:', err.message);
    return null;
  }
}

/**
 * Call LLM (Google Gemini or OpenAI or Ollama) with system prompt and user message; request JSON output.
 * Only one agent uses the model at a time; others wait for the lock. See withModelLock.
 * Retries up to LLM_MAX_RETRIES when the provider returns null so the main brain (LLM) is given every chance to respond.
 * Returns parsed JSON object, or null only after all retries are exhausted.
 * @param {string} systemPrompt - System message (e.g. prompt template)
 * @param {string} userMessage - User message (e.g. stringified input)
 * @param {{ model?: string, timeoutMs?: number }} [options] - Optional model/timeout override
 */
async function complete(systemPrompt, userMessage, options = {}) {
  return withModelLock(async () => {
    const providerPref = cleanEnvValue(process.env.LLM_PROVIDER || '').toLowerCase();

    async function tryOnce() {
      if (providerPref === 'google') {
        console.log('[LLM] Provider preference: Google Gemini');
        return completeWithGoogle(systemPrompt, userMessage, options);
      }
      if (providerPref === 'openai') {
        console.log('[LLM] Provider preference: OpenAI');
        return completeWithOpenAI(systemPrompt, userMessage, options);
      }
      if (providerPref === 'ollama') {
        console.log(`[LLM] Provider preference: ${getOllamaConfig(options).label}`);
        return completeWithOllama(systemPrompt, userMessage, options);
      }
      const useGoogle = !!cleanEnvValue(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
      if (useGoogle) {
        console.log('[LLM] Using Google Gemini via @google/genai (auto)');
        const r = await completeWithGoogle(systemPrompt, userMessage, options);
        if (r !== null) return r;
      }
      if (!!cleanEnvValue(process.env.OPENAI_API_KEY)) {
        console.log('[LLM] Using OpenAI (auto)');
        const r = await completeWithOpenAI(systemPrompt, userMessage, options);
        if (r !== null) return r;
      }
      const ollamaCfg = getOllamaConfig(options);
      console.log(`[LLM] Using ${ollamaCfg.label} (auto)`);
      const r = await completeWithOllama(systemPrompt, userMessage, options);
      if (r !== null) return r;
      return null;
    }

    let lastLog = '';
    for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
      const result = await tryOnce();
      if (result !== null) {
        await logLlmInteraction({
          agent: options.agent || null,
          provider: providerPref || 'auto',
          model: options.model || null,
          projectId: options.projectId || null,
          context: options.context || null,
          systemPrompt,
          userMessage,
          rawResponse: JSON.stringify(result),
          parsedJson: result,
          error: null,
        });
        return result;
      }
      if (attempt < LLM_MAX_RETRIES) {
        const msg = `[LLM] Attempt ${attempt}/${LLM_MAX_RETRIES} returned null; retrying in ${LLM_RETRY_DELAY_MS}ms...`;
        if (msg !== lastLog) {
          console.log(msg);
          lastLog = msg;
        }
        await delay(LLM_RETRY_DELAY_MS);
      }
    }
    console.warn(`[LLM] All ${LLM_MAX_RETRIES} attempts returned null.`);
    await logLlmInteraction({
      agent: options.agent || null,
      provider: providerPref || 'auto',
      model: options.model || null,
      projectId: options.projectId || null,
      context: options.context || null,
      systemPrompt,
      userMessage,
      rawResponse: null,
      parsedJson: null,
      error: 'all_attempts_null',
    });
    return null;
  });
}

function buildChatMessages(systemPrompt, userMessage, options = {}) {
  const history = Array.isArray(options.messages) ? options.messages : [];
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history.slice(-8)) {
    if (!m?.content || (m.role !== 'user' && m.role !== 'assistant')) continue;
    msgs.push({ role: m.role, content: String(m.content).slice(0, 4000) });
  }
  msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

async function completeTextWithOllama(systemPrompt, userMessage, options = {}) {
  const { baseUrl, apiKey, modelCandidates } = getOllamaConfig(options);
  const timeoutMs = options.timeoutMs ?? (apiKey ? 120000 : 90000);
  const messages = buildChatMessages(systemPrompt, userMessage, options);

  for (let i = 0; i < modelCandidates.length; i++) {
    const model = modelCandidates[i];
    try {
      const res = await ollamaChatRequest(
        baseUrl,
        apiKey,
        {
          model,
          messages,
          stream: false,
          options: { temperature: 0.3, num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 2048) },
        },
        timeoutMs
      );
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.message?.content;
      if (text && typeof text === 'string' && text.trim()) return text.trim();
    } catch (err) {
      if (i < modelCandidates.length - 1) continue;
      console.error('Ollama completeText error:', err.message);
    }
  }
  return null;
}

async function completeTextWithOpenAI(systemPrompt, userMessage, options = {}) {
  const apiKey = cleanEnvValue(process.env.OPENAI_API_KEY);
  if (!apiKey) return null;
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });
    const model = cleanEnvValue(options.model || 'gpt-4o-mini');
    const response = await client.chat.completions.create({
      model,
      messages: buildChatMessages(systemPrompt, userMessage, options),
      temperature: 0.3,
    });
    const content = response.choices?.[0]?.message?.content;
    return content && typeof content === 'string' ? content.trim() : null;
  } catch (err) {
    console.error('OpenAI completeText error:', err.message);
    return null;
  }
}

async function completeTextWithGoogle(systemPrompt, userMessage, options = {}) {
  const apiKey = cleanEnvValue(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  if (!apiKey) return null;
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const model = cleanEnvValue(options.model || 'gemini-2.0-flash');
    const history = (options.messages || []).slice(-8);
    const contents = [
      ...history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(m.content).slice(0, 4000) }],
        })),
      { role: 'user', parts: [{ text: userMessage }] },
    ];
    const response = await ai.models.generateContent({
      model,
      contents,
      systemInstruction: systemPrompt,
      generationConfig: { temperature: 0.3 },
    });
    const text = response?.text;
    return text && typeof text === 'string' ? text.trim() : null;
  } catch (err) {
    console.error('Google completeText error:', err.message);
    return null;
  }
}

/**
 * Plain-text LLM completion for help chat (not JSON). Uses same provider order as complete().
 */
async function completeText(systemPrompt, userMessage, options = {}) {
  return withModelLock(async () => {
    const providerPref = cleanEnvValue(process.env.LLM_PROVIDER || '').toLowerCase();
    const maxAttempts = Math.min(3, LLM_MAX_RETRIES);

    async function tryOnce() {
      if (providerPref === 'google') return completeTextWithGoogle(systemPrompt, userMessage, options);
      if (providerPref === 'openai') return completeTextWithOpenAI(systemPrompt, userMessage, options);
      if (providerPref === 'ollama') return completeTextWithOllama(systemPrompt, userMessage, options);
      if (cleanEnvValue(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)) {
        const r = await completeTextWithGoogle(systemPrompt, userMessage, options);
        if (r) return r;
      }
      if (cleanEnvValue(process.env.OPENAI_API_KEY)) {
        const r = await completeTextWithOpenAI(systemPrompt, userMessage, options);
        if (r) return r;
      }
      return completeTextWithOllama(systemPrompt, userMessage, options);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await tryOnce();
      if (result) {
        await logLlmInteraction({
          agent: options.agent || 'help_chat',
          provider: providerPref || 'auto',
          model: options.model || null,
          projectId: options.projectId || null,
          context: 'help_chat',
          systemPrompt,
          userMessage,
          rawResponse: result,
          parsedJson: null,
          error: null,
        });
        return result;
      }
      if (attempt < maxAttempts) await delay(LLM_RETRY_DELAY_MS);
    }
    return null;
  });
}

module.exports = { readPrompt, complete, completeText, OLLAMA_TOOLS };
