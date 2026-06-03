/**
 * Person availability (active / on_leave / emergency_active) in Postgres + cache refresh.
 */

async function setPersonAvailability(personId, { status, until, reason, needId }, ctx) {
  const { loadPeople, refreshPeopleCache } = ctx;
  const postgresStore = require('../store/postgresStore');
  const person = loadPeople().find((p) => p.id === personId);
  if (!person) return null;

  const updated = {
    ...person,
    availabilityStatus: status,
    availabilityUntil: until || null,
    availabilityReason: reason || null,
    activeNeedId: needId || null,
  };
  await postgresStore.upsertPerson(updated);
  if (typeof refreshPeopleCache === 'function') {
    await refreshPeopleCache();
  }
  return updated;
}

async function clearPersonAvailability(personId, ctx) {
  return setPersonAvailability(
    personId,
    { status: 'active', until: null, reason: null, needId: null },
    ctx
  );
}

module.exports = { setPersonAvailability, clearPersonAvailability };
