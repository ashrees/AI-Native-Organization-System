/**
 * Postgres-backed store for events, projects, and people.
 * Uses DATABASE_URL. Supports POSTGRES_SCHEMA (default: public) for Neon/schema isolation.
 */

const { pool } = require('../db');

const SCHEMA = (process.env.POSTGRES_SCHEMA || 'public').replace(/["']/g, '');
function table(name) {
  return `"${SCHEMA}"."${name}"`;
}

const CREATE_EVENTS = `
  CREATE TABLE IF NOT EXISTS ${table('events')} (
    id             text PRIMARY KEY,
    type           text NOT NULL,
    timestamp      timestamptz NOT NULL,
    project_id     text NOT NULL,
    source         text NOT NULL,
    correlation_id text,
    rationale      text,
    payload        jsonb NOT NULL
  );
`;

const CREATE_PROJECTS = `
  CREATE TABLE IF NOT EXISTS ${table('projects')} (
    id              text PRIMARY KEY,
    state           jsonb NOT NULL,
    last_updated_at timestamptz,
    last_event_id   text
  );
`;

const CREATE_PEOPLE = `
  CREATE TABLE IF NOT EXISTS ${table('people')} (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    department    text,
    team          text,
    role          text,
    skills        jsonb NOT NULL DEFAULT '[]',
    current_load  int NOT NULL DEFAULT 0
  );
`;

const CREATE_NEEDS = `
  CREATE TABLE IF NOT EXISTS ${table('needs')} (
    id          text PRIMARY KEY,
    project_id  text NOT NULL,
    task_id     text,
    source      text NOT NULL,
    kind        text NOT NULL,
    description text NOT NULL,
    status      text NOT NULL DEFAULT 'open',
    event_id    text NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
  );
`;

const CREATE_PROJECT_TASK_INDEX = `
  CREATE TABLE IF NOT EXISTS ${table('project_task_index')} (
    project_id      text    NOT NULL,
    task_id         text    NOT NULL,
    task_title      text,
    assignee_id     text,
    status          text,
    last_event_id   text,
    last_updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, task_id)
  );
`;

const CREATE_LLM_LOGS = `
  CREATE TABLE IF NOT EXISTS ${table('llm_logs')} (
    id            bigserial PRIMARY KEY,
    created_at    timestamptz NOT NULL DEFAULT now(),
    agent         text,
    provider      text,
    model         text,
    project_id    text,
    context       jsonb,
    system_prompt text,
    user_message  text,
    raw_response  text,
    parsed_json   jsonb,
    error         text
  );
`;

const DEFAULT_PEOPLE = [
  { id: 'person-1', name: 'Alex Rivera', department: 'Engineering', team: 'Auth', role: 'Senior Backend Engineer', skills: ['backend', 'node', 'api', 'auth'], currentLoad: 0 },
  { id: 'person-2', name: 'Sam Lee', department: 'Engineering', team: 'Frontend', role: 'Frontend Engineer', skills: ['frontend', 'react', 'design-systems'], currentLoad: 0 },
  { id: 'person-3', name: 'Jordan Kim', department: 'Engineering', team: 'Platform', role: 'Fullstack Engineer', skills: ['fullstack', 'node', 'react', 'infrastructure'], currentLoad: 0 },
  { id: 'person-4', name: 'Harry Potter', department: 'Marketing', team: 'Marketing', role: 'Marketing Manager', skills: ['marketing', 'branding', 'content', 'social-media'], currentLoad: 0 },
  { id: 'person-5', name: 'Hermione Granger', department: 'Human Resources', team: 'Human Resources', role: 'Human Resources Manager', skills: ['human-resources', 'recruiting', 'training', 'employee-relations'], currentLoad: 0 },
  { id: 'person-6', name: 'Ron Weasley', department: 'Finance', team: 'Finance', role: 'Finance Manager', skills: ['finance', 'accounting', 'budgeting', 'financial-reporting'], currentLoad: 0 },
  { id: 'person-7', name: 'Ginny Weasley', department: 'Legal', team: 'Legal', role: 'Legal Counsel', skills: ['legal', 'compliance', 'contracts', 'intellectual-property'], currentLoad: 0 },
  { id: 'person-8', name: 'Fred Weasley', department: 'Sales', team: 'Sales', role: 'Sales Manager', skills: ['sales', 'customer-service', 'sales-training', 'sales-management'], currentLoad: 0 },
  { id: 'person-9', name: 'George Weasley', department: 'AI/ML', team: 'AI', role: 'AI/ML Manager', skills: ['ai', 'machine-learning', 'data-science', 'ai-engineering'], currentLoad: 0 },
  { id: 'person-10', name: 'Luna Lovegood', department: 'data engineering', team: 'data science', role: 'data science Manager', skills: ['data-science', 'machine-learning', 'data-engineering', 'data-analysis'], currentLoad: 0 },
  { id: 'person-11', name: 'Neville Longbottom', department: 'data engineering', team: 'data engineering', role: 'data engineering Manager', skills: ['data-engineering', 'data-architecture', 'data-modeling', 'data-pipeline'], currentLoad: 0 },
  { id: 'person-12', name: 'Draco Malfoy', department: 'data engineering', team: 'database engineering', role: 'database engineering Manager', skills: ['database-engineering', 'database-architecture', 'database-modeling', 'database-pipeline'], currentLoad: 0 },
  { id: 'person-13', name: 'Ginny Weasley', department: 'Engineering', team: 'devops', role: 'devops Manager', skills: ['devops', 'infrastructure', 'networking', 'security'], currentLoad: 0 },
  { id: 'person-14', name: 'Ginny Weasley', department: 'Security', team: 'Security', role: 'Security Manager', skills: ['security', 'penetration-testing', 'vulnerability-assessment', 'security-audit'], currentLoad: 0 },
];

function rowToPerson(r) {
  return {
    id: r.id,
    name: r.name || '',
    department: r.department || '',
    team: r.team || '',
    role: r.role || '',
    skills: Array.isArray(r.skills) ? r.skills : (r.skills && typeof r.skills === 'object' ? Object.values(r.skills) : []),
    currentLoad: r.current_load != null ? Number(r.current_load) : 0,
    availabilityStatus: r.availability_status || 'active',
    availabilityUntil: r.availability_until
      ? r.availability_until instanceof Date
        ? r.availability_until.toISOString()
        : r.availability_until
      : null,
    availabilityReason: r.availability_reason || null,
    activeNeedId: r.active_need_id || null,
  };
}

function rowToEvent(r) {
  return {
    id: r.id,
    type: r.type,
    timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    projectId: r.project_id,
    source: r.source,
    correlationId: r.correlation_id || undefined,
    rationale: r.rationale || undefined,
    payload: r.payload,
  };
}

/**
 * Create events, projects, people, needs, project_task_index, and llm_logs tables if they do not exist. Safe for fresh start.
 */
async function ensurePeopleAvailabilityColumns() {
  if (!pool) return;
  await pool.query(
    `ALTER TABLE ${table('people')} ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'active'`
  );
  await pool.query(
    `ALTER TABLE ${table('people')} ADD COLUMN IF NOT EXISTS availability_until timestamptz`
  );
  await pool.query(
    `ALTER TABLE ${table('people')} ADD COLUMN IF NOT EXISTS availability_reason text`
  );
  await pool.query(
    `ALTER TABLE ${table('people')} ADD COLUMN IF NOT EXISTS active_need_id text`
  );
}

async function ensureTables() {
  if (!pool) return;
  await pool.query(CREATE_EVENTS);
  await pool.query(CREATE_PROJECTS);
  await pool.query(CREATE_PEOPLE);
  await ensurePeopleAvailabilityColumns();
  await pool.query(CREATE_NEEDS);
  await pool.query(CREATE_PROJECT_TASK_INDEX);
  await pool.query(CREATE_LLM_LOGS);
}

/**
 * Append a single event to the database. Idempotent: ON CONFLICT (id) DO NOTHING.
 */
async function appendEvent(event) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO ${table('events')} (id, type, timestamp, project_id, source, correlation_id, rationale, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.type,
      event.timestamp,
      event.projectId,
      event.source,
      event.correlationId || null,
      event.rationale || null,
      event.payload,
    ]
  );
}

/**
 * Update an existing event payload (and optional rationale) in the database.
 */
async function updateEventPayload(eventId, payload, rationale) {
  if (!pool || !eventId) return;
  await pool.query(
    `UPDATE ${table('events')} SET payload = $2, rationale = COALESCE($3, rationale) WHERE id = $1`,
    [eventId, payload, rationale || null]
  );
}

/**
 * Load all events from the database, ordered by timestamp ascending.
 */
async function loadAllEvents() {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM ${table('events')} ORDER BY timestamp ASC`);
  return rows.map(rowToEvent);
}

/**
 * Save project state (full state object). Upserts by project id.
 */
async function saveProjectState(projectId, state) {
  if (!pool) return;
  const lastUpdatedAt = state.lastUpdatedAt || new Date().toISOString();
  const lastEventId = state.lastEventId || null;
  await pool.query(
    `INSERT INTO ${table('projects')} (id, state, last_updated_at, last_event_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id)
     DO UPDATE SET state = EXCLUDED.state, last_updated_at = EXCLUDED.last_updated_at, last_event_id = EXCLUDED.last_event_id`,
    [projectId, state, lastUpdatedAt, lastEventId]
  );
}

/**
 * Load all projects as a map projectId -> state object.
 */
async function loadAllProjects() {
  if (!pool) return {};
  const { rows } = await pool.query(`SELECT id, state FROM ${table('projects')}`);
  const out = {};
  for (const r of rows) {
    out[r.id] = r.state;
  }
  return out;
}

/**
 * Load all people (for Team Builder AI).
 */
async function loadAllPeople() {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM ${table('people')} ORDER BY id`);
  return rows.map(rowToPerson);
}

/**
 * Upsert a single person. Idempotent by id.
 */
async function upsertPerson(person) {
  if (!pool) return;
  const id = person.id;
  const name = person.name || '';
  const department = person.department || '';
  const team = person.team || '';
  const role = person.role || '';
  const skills = Array.isArray(person.skills) ? person.skills : [];
  const currentLoad = person.currentLoad != null ? Number(person.currentLoad) : 0;
  const availabilityStatus = person.availabilityStatus || 'active';
  const availabilityUntil = person.availabilityUntil || null;
  const availabilityReason = person.availabilityReason || null;
  const activeNeedId = person.activeNeedId || null;
  await pool.query(
    `INSERT INTO ${table('people')} (id, name, department, team, role, skills, current_load,
       availability_status, availability_until, availability_reason, active_need_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department, team = EXCLUDED.team,
       role = EXCLUDED.role, skills = EXCLUDED.skills, current_load = EXCLUDED.current_load,
       availability_status = EXCLUDED.availability_status,
       availability_until = EXCLUDED.availability_until,
       availability_reason = EXCLUDED.availability_reason,
       active_need_id = EXCLUDED.active_need_id`,
    [
      id,
      name,
      department,
      team,
      role,
      JSON.stringify(skills),
      currentLoad,
      availabilityStatus,
      availabilityUntil,
      availabilityReason,
      activeNeedId,
    ]
  );
}

/**
 * Increment a person's current_load by 1 (e.g. after assigning a task). Keeps load in sync for agent evaluation.
 */
async function incrementPersonLoad(personId) {
  if (!pool || !personId) return;
  await pool.query(
    `UPDATE ${table('people')} SET current_load = current_load + 1 WHERE id = $1`,
    [personId]
  );
}

/**
 * Decrement a person's current_load by 1 (e.g. when a task is marked done). Call from route when execution status becomes 'done'.
 */
async function decrementPersonLoad(personId) {
  if (!pool || !personId) return;
  await pool.query(
    `UPDATE ${table('people')} SET current_load = GREATEST(0, current_load - 1) WHERE id = $1`,
    [personId]
  );
}

/**
 * Upsert a need (from agent or human). Idempotent by id. Used when persisting need events.
 */
async function upsertNeed(need) {
  if (!pool || !need || !need.id) return;
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO ${table('needs')} (id, project_id, task_id, source, kind, description, status, event_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id)
     DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
    [
      need.id,
      need.projectId || need.project_id || '',
      need.taskId || need.task_id || null,
      need.source || 'system',
      need.kind || 'general',
      need.description || '',
      need.status || 'open',
      need.eventId || need.event_id || need.id,
      need.createdAt || need.created_at || now,
      now,
    ]
  );
}

/**
 * Load needs by project (optional filter). Returns array of need objects.
 */
async function loadNeedsByProject(projectId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, project_id AS "projectId", task_id AS "taskId", source, kind, description, status, event_id AS "eventId", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM ${table('needs')}
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );
  return rows;
}

/**
 * Load all needs (optionally filter by status).
 */
async function loadAllNeeds(options = {}) {
  if (!pool) return [];
  let q = `SELECT id, project_id AS "projectId", task_id AS "taskId", source, kind, description, status, event_id AS "eventId", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM ${table('needs')}`;
  const params = [];
  if (options.status) {
    params.push(options.status);
    q += ` WHERE status = $1`;
  }
  q += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query(q, params);
  return rows;
}

/**
 * Update need status (open | met | cancelled).
 */
async function updateNeedStatus(needId, status) {
  if (!pool || !needId) return null;
  const valid = ['open', 'in_review', 'approved', 'rejected', 'met', 'cancelled'];
  if (!valid.includes(status)) return null;
  const { rows } = await pool.query(
    `UPDATE ${table('needs')} SET status = $1, updated_at = $2 WHERE id = $3
     RETURNING id, project_id AS "projectId", task_id AS "taskId", source, kind, description, status, event_id AS "eventId", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [status, new Date().toISOString(), needId]
  );
  return rows[0] || null;
}

/**
 * Upsert a single task row into project_task_index for fast querying of assignments and statuses.
 */
async function upsertProjectTaskIndex(projectId, taskId, taskTitle, assigneeId, status, lastEventId, lastUpdatedAt) {
  if (!pool || !projectId || !taskId) return;
  const ts = lastUpdatedAt || new Date().toISOString();
  await pool.query(
    `INSERT INTO ${table('project_task_index')} (project_id, task_id, task_title, assignee_id, status, last_event_id, last_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, task_id)
     DO UPDATE SET task_title = EXCLUDED.task_title,
                   assignee_id = EXCLUDED.assignee_id,
                   status = EXCLUDED.status,
                   last_event_id = EXCLUDED.last_event_id,
                   last_updated_at = EXCLUDED.last_updated_at`,
    [projectId, taskId, taskTitle || null, assigneeId || null, status || null, lastEventId || null, ts]
  );
}

/**
 * Insert one LLM log row capturing full request/response for debugging.
 */
async function insertLlmLog(log) {
  if (!pool || !log) return;
  const {
    agent,
    provider,
    model,
    projectId,
    context,
    systemPrompt,
    userMessage,
    rawResponse,
    parsedJson,
    error,
  } = log;
  await pool.query(
    `INSERT INTO ${table('llm_logs')} (agent, provider, model, project_id, context, system_prompt, user_message, raw_response, parsed_json, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      agent || null,
      provider || null,
      model || null,
      projectId || null,
      context ? JSON.stringify(context) : null,
      systemPrompt || null,
      userMessage || null,
      rawResponse || null,
      parsedJson != null ? JSON.stringify(parsedJson) : null,
      error || null,
    ]
  );
}

/**
 * Load recent LLM logs, optionally filtered by projectId and/or agent.
 */
async function loadLlmLogs(options = {}) {
  if (!pool) return [];
  const conditions = [];
  const params = [];
  let idx = 1;
  if (options.projectId) {
    conditions.push(`project_id = $${idx++}`);
    params.push(options.projectId);
  }
  if (options.agent) {
    conditions.push(`agent = $${idx++}`);
    params.push(options.agent);
  }
  let q = `SELECT id, created_at AS "createdAt", agent, provider, model, project_id AS "projectId",
                  context, system_prompt AS "systemPrompt", user_message AS "userMessage",
                  raw_response AS "rawResponse", parsed_json AS "parsedJson", error
           FROM ${table('llm_logs')}`;
  if (conditions.length > 0) {
    q += ` WHERE ${conditions.join(' AND ')}`;
  }
  q += ' ORDER BY created_at DESC LIMIT 200';
  const { rows } = await pool.query(q, params);
  return rows;
}

/**
 * If people table is empty, insert default people. Safe to call on every startup.
 */
async function ensureDefaultPeople() {
  if (!pool) return;
  const people = await loadAllPeople();
  if (people.length > 0) return;
  for (const p of DEFAULT_PEOPLE) {
    await upsertPerson(p);
  }
}

/**
 * Return current connection database and schema, and row counts. For startup diagnostic (Neon: verify same branch/DB).
 */
async function getConnectionDiagnostic() {
  if (!pool) return null;
  try {
    const [dbRes, countRes] = await Promise.all([
      pool.query('SELECT current_database() AS db, current_schema() AS schema'),
      pool.query(
        `SELECT
          (SELECT count(*) FROM ${table('events')}) AS events,
          (SELECT count(*) FROM ${table('projects')}) AS projects,
          (SELECT count(*) FROM ${table('people')}) AS people,
          (SELECT count(*) FROM ${table('needs')}) AS needs,
          (SELECT count(*) FROM ${table('llm_logs')}) AS llm_logs`
      ),
    ]);
    const { db, schema } = dbRes.rows[0] || {};
    const { events, projects, people, needs, llm_logs: llmLogs } = countRes.rows[0] || {};
    return {
      database: db,
      schema,
      events: Number(events) || 0,
      projects: Number(projects) || 0,
      people: Number(people) || 0,
      needs: Number(needs) || 0,
      llmLogs: Number(llmLogs) || 0,
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  ensureTables,
  appendEvent,
  updateEventPayload,
  loadAllEvents,
  saveProjectState,
  loadAllProjects,
  loadAllPeople,
  upsertPerson,
  incrementPersonLoad,
  decrementPersonLoad,
  upsertNeed,
  loadNeedsByProject,
  loadAllNeeds,
  updateNeedStatus,
   upsertProjectTaskIndex,
   insertLlmLog,
   loadLlmLogs,
  ensureDefaultPeople,
  getConnectionDiagnostic,
};
