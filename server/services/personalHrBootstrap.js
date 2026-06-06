/**
 * Bootstrap personal HR assignments in Postgres on startup.
 */

const postgresStore = require('../store/postgresStore');
const { computePersonalHrAssignments } = require('./personalHr');

async function ensurePersonalHrAssignments(refreshPeopleCache) {
  const people = await postgresStore.loadAllPeople();
  if (people.length === 0) return { updated: 0 };

  const assignments = computePersonalHrAssignments(people);
  let updated = 0;

  for (const p of people) {
    const hrPersonId = assignments.get(p.id);
    if (!hrPersonId || p.hrPersonId === hrPersonId) continue;
    await postgresStore.upsertPerson({ ...p, hrPersonId });
    updated += 1;
  }

  if (updated > 0) {
    console.log(`[Store] Assigned personal HR partners for ${updated} employee(s).`);
    if (typeof refreshPeopleCache === 'function') await refreshPeopleCache();
  }

  return { updated };
}

module.exports = { ensurePersonalHrAssignments };
