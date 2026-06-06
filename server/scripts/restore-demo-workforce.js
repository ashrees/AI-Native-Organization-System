/**
 * Reset demo workers to active (after mock NPC leave flood).
 * Usage:
 *   node server/scripts/restore-demo-workforce.js --all
 *   node server/scripts/restore-demo-workforce.js --core
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const CORE_DEMO_IDS = [
  'person-2', // Sam Lee
  'person-5', // Hermione Granger
  'person-1', // Alex Rivera
  'person-11', // Neville Longbottom
  'person-15', // Harper Moore
  'person-16', // Rowan Brown
  'person-13', // Gram Pho
  'person-4', // Harry Potter
  'person-6', // Ron Weasley
];

async function main() {
  const mode = process.argv[2] || '--core';
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const { clearPersonAvailability } = require('../lib/personAvailability');
  const ctx = {
    loadPeople: eventsRouter.loadPeople,
    refreshPeopleCache: eventsRouter.refreshPeopleCache,
  };

  const people = eventsRouter.loadPeople();
  const targets =
    mode === '--all'
      ? people.map((p) => p.id)
      : CORE_DEMO_IDS.filter((id) => people.some((p) => p.id === id));

  let restored = 0;
  for (const personId of targets) {
    const person = people.find((p) => p.id === personId);
    if (!person || (person.availabilityStatus || 'active') === 'active') continue;
    await clearPersonAvailability(personId, ctx);
    restored += 1;
    console.log(`Active: ${person.name} (${personId})`);
  }

  if (typeof eventsRouter.recomputePeopleLoadFromProjects === 'function') {
    await eventsRouter.recomputePeopleLoadFromProjects();
  }

  console.log(`Restored ${restored} person(s) to active.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
