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

/** Parse JSON from LLM text; handles markdown code blocks, trailing text, trailing commas, and truncated JSON. */
function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  // Remove trailing commas before ] or } (invalid in strict JSON but some models output them)
  t = t.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(t);
  } catch (_) {}
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    try {
      return JSON.parse(m[1].trim().replace(/,(\s*[}\]])/g, '$1'));
    } catch (_) {}
  }
  const i0 = t.indexOf('{');
  const i1 = t.indexOf('[');
  const start = i1 >= 0 && (i0 < 0 || i1 <= i0) ? i1 : i0;
  if (start < 0) return null;
  const open = t[start];
  const close = open === '[' ? ']' : '}';
  let depth = 1;
  let i = start + 1;
  while (i < t.length && depth > 0) {
    const c = t[i];
    if (c === '"') {
      i++;
      while (i < t.length && (t[i] !== '"' || t[i - 1] === '\\')) i++;
      i++;
      continue;
    }
    if (c === close) depth--;
    else if (c === open) depth++;
    i++;
  }
  let slice = t.slice(start, i);
  if (depth !== 0) {
    // Truncated: try appending closing brackets to get valid JSON
    const toTry = [
      slice + '}]}',   // {"tasks": [{"id": "1"  ->  {"tasks": [{"id": "1"}]}
      slice + ']}',    // {"tasks": [  ->  {"tasks": []}
      slice + ']} }',  // {"tasks": [...]  ->  {"tasks": []} (extra } safe if already closed)
      slice + '}',
      slice + ']',
    ];
    for (const s of toTry) {
      try {
        return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
      } catch (_) {}
    }
    return null;
  }
  try {
    const parsed = JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1'));
    return parsed;
  } catch (_) {
    return null;
  }
}

function cleanEnvValue(value) {
  if (value == null) return '';
  return String(value).replace(/\s+#.*$/, '').trim();
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
  const baseUrl = cleanEnvValue(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const modelSpec = cleanEnvValue(options.model || process.env.OLLAMA_MODEL || 'llama3.1:8b');
  const modelCandidates = modelSpec
    .split(',')
    .map((s) => cleanEnvValue(s))
    .filter(Boolean);

  const tools = options.tools != null && Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : null;

  try {
    // Use caller timeout or env; enforce minimum 2 min for Ollama so we wait for the model to finish.
    const requested = Number(
      cleanEnvValue(
        options.timeoutMs != null ? String(options.timeoutMs) : process.env.OLLAMA_TIMEOUT_MS
      ) || 60000
    );
    const timeoutMs = Math.max(requested, 120000);

    const candidates = (modelCandidates.length ? modelCandidates : ['llama3.1:8b']).slice();
    // Prefer non-"thinking" models first for responsiveness.
    candidates.sort((a, b) => {
      const ax = a.toLowerCase().includes('thinking') ? 1 : 0;
      const bx = b.toLowerCase().includes('thinking') ? 1 : 0;
      return ax - bx;
    });

    for (let idx = 0; idx < candidates.length; idx++) {
      const model = candidates[idx];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
            num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 2048),
          },
        };
        // Use tool calling when tools provided (structured output); otherwise request format: json
        if (tools) {
          body.tools = tools;
        } else {
          body.format = 'json';
        }

        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          // If model name is wrong, try the next candidate.
          if (res.status === 404 || /model .* not found/i.test(bodyText)) {
            console.warn(`[LLM] Ollama model not found: ${model}`);
            continue;
          }
          // If a model is unstable (500), try the next candidate (if any).
          if (res.status >= 500 && modelCandidates.length > 1) {
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
        console.warn(`[LLM] Ollama response did not parse as JSON (model may have returned prose). First 200 chars: ${String(text).slice(0, 200)}`);
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
        // If the server is unreachable, other candidates will likely fail too, but trying is cheap.
        if (idx < candidates.length - 1) {
          console.warn(`[LLM] Ollama request failed for ${model}: ${err.message}; trying next model candidate`);
          continue;
        }
        console.error('Ollama complete error:', err.message);
        return null;
      } finally {
        clearTimeout(timeout);
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
        console.log('[LLM] Provider preference: Ollama (local)');
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
      console.log('[LLM] Using Ollama (auto, local) if available');
      return completeWithOllama(systemPrompt, userMessage, options);
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

module.exports = { readPrompt, complete, OLLAMA_TOOLS };
