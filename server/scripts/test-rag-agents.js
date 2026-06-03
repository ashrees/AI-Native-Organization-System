/**
 * Test script for RAG agent context.
 * Uses Postgres when DATABASE_URL is set; otherwise loads store from JSON files.
 * Run from repo root: node server/scripts/test-rag-agents.js
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const storeDir = path.join(__dirname, '../store');
const mockDir = path.join(__dirname, '../../mock-data');

async function loadStore() {
  if (process.env.DATABASE_URL) {
    const postgresStore = require('../store/postgresStore');
    const { applyEvents } = require('../models/projectState');
    await postgresStore.ensureTables();
    const events = await postgresStore.loadAllEvents();
    const projectIds = [...new Set(events.map((e) => e.projectId).filter(Boolean))];
    const projects = {};
    for (const projectId of projectIds) {
      const projectEvents = events.filter((e) => e.projectId === projectId);
      projects[projectId] = applyEvents(null, projectEvents, projectId);
    }
    return { events, projects };
  }
  const eventsPath = path.join(storeDir, 'events.json');
  const projectsPath = path.join(storeDir, 'projects.json');
  const events = fs.existsSync(eventsPath)
    ? JSON.parse(fs.readFileSync(eventsPath, 'utf8'))
    : [];
  const projects = fs.existsSync(projectsPath)
    ? JSON.parse(fs.readFileSync(projectsPath, 'utf8'))
    : {};
  return { events, projects };
}

function loadPeople() {
  const peoplePath = path.join(mockDir, 'people.json');
  if (!fs.existsSync(peoplePath)) return [];
  return JSON.parse(fs.readFileSync(peoplePath, 'utf8'));
}

async function loadPeopleAsync() {
  if (process.env.DATABASE_URL) {
    const postgresStore = require('../store/postgresStore');
    return await postgresStore.loadAllPeople();
  }
  return loadPeople();
}

const { buildAllProjectMetrics } = require('../services/metrics');
const { buildAgentContext } = require('../services/retrieval');
const { stubPlan } = require('../services/orchestratorAI');
const { stubAssign } = require('../services/teamBuilderAI');
const { stubSchedule } = require('../services/schedulerAI');

function run() {
  loadStore()
    .then(async ({ events, projects }) => {
      const people = await loadPeopleAsync();
      runWithStore(events, projects, people);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

function runWithStore(events, projects, people) {
  const metrics = buildAllProjectMetrics(projects, events);

  const store = { eventLog: events, projects, people, metrics };
  const projectIds = (metrics.projects || []).map((m) => m.projectId).filter(Boolean);
  const projectId = projectIds[0] || 'proj-beta';
  const validProjectIds = new Set(Object.keys(projects));
  const validPersonIds = new Set((people || []).map((p) => p.id));

  console.log('RAG agent context test');
  console.log('Store:', process.env.DATABASE_URL ? 'Postgres' : 'JSON');
  console.log('Projects in store:', projectIds.length, projectIds.slice(0, 5));
  console.log('');

  const agents = [
    ['orchestrator', projectId, { request: { title: 'Test request', description: 'RAG test' } }],
    ['team_builder', projectId, { currentTask: { id: 'task-1', title: 'Test task' } }],
    ['scheduler', projectId, { tasks: [] }],
    ['org_ai', null, { metrics, projects }],
  ];

  for (const [agentName, pid, extra] of agents) {
    const ctx = buildAgentContext(agentName, pid, extra, store);
    const size = JSON.stringify(ctx).length;
    console.log(`${agentName} (projectId=${pid || 'null'}): context size ${size} chars`);
    console.log('  projectSnapshot:', ctx.projectSnapshot ? `${ctx.projectSnapshot.id} (${ctx.projectSnapshot.progress?.tasks?.length ?? 0} tasks)` : 'null');
    console.log('  recentEvents:', (ctx.recentEvents || []).length);
    console.log('  peopleContext.peopleStats:', (ctx.peopleContext?.peopleStats || []).length);
    console.log('  metricsSummary.validProjectIds:', (ctx.metricsSummary?.validProjectIds || []).length);

    if (ctx.projectSnapshot && ctx.projectSnapshot.id) {
      assert(validProjectIds.has(ctx.projectSnapshot.id), `${agentName}: projectSnapshot.id must be in store.projects`);
    }
    for (const s of ctx.peopleContext?.peopleStats || []) {
      if (s.personId) assert(validPersonIds.has(s.personId), `${agentName}: peopleStats.personId must be in store.people`);
    }
    for (const id of ctx.metricsSummary?.validProjectIds || []) {
      assert(validProjectIds.has(id), `${agentName}: metricsSummary.validProjectIds must only contain existing projectIds`);
    }
    console.log('');
  }

  console.log('Stub fallback verification (deterministic stub behavior):');
  const requestPayload = { title: 'Bad output test', description: 'Test' };
  const plan1 = stubPlan(requestPayload);
  const plan2 = stubPlan(requestPayload);
  assert(Array.isArray(plan1.tasks), 'stubPlan returns tasks array');
  assert(plan1.tasks.length >= 1, 'stubPlan returns at least one task');
  assert.strictEqual(plan1.tasks.length, plan2.tasks.length, 'stubPlan task count is deterministic');
  assert.deepStrictEqual(
    plan1.tasks.map((t) => t.title),
    plan2.tasks.map((t) => t.title),
    'stubPlan task titles are deterministic'
  );

  const task = { id: 't1', title: 'Task' };
  const peopleList = people.length ? people.slice(0, 3) : [{ id: 'p1', name: 'P1', department: 'Engineering', skills: [] }];
  const a1 = stubAssign(task, peopleList, null, {});
  const a2 = stubAssign(task, peopleList, null, {});
  assert(a1.personId != null || peopleList.length === 0, 'stubAssign returns personId when people exist');
  assert.strictEqual(a1.personId, a2.personId, 'stubAssign is deterministic');

  const tasksWithAssignees = [{ id: 't1', assigneeId: 'p1' }];
  const s1 = stubSchedule(tasksWithAssignees);
  const s2 = stubSchedule(tasksWithAssignees);
  assert(Array.isArray(s1) && s1.length === 1, 'stubSchedule returns one proposal per task');
  assert.strictEqual(s1.length, s2.length, 'stubSchedule length is deterministic');
  assert.deepStrictEqual(s1.map((p) => p.taskId), s2.map((p) => p.taskId), 'stubSchedule taskIds are deterministic');

  console.log('  stubPlan, stubAssign, stubSchedule: deterministic and valid shape.');
  console.log('');
  console.log('Done. Bad LLM outputs fall back to these stubs (orchestrator stubPlan, teamBuilder stubAssign, scheduler stubSchedule, orgInsights buildStubInsights).');
}

run();
