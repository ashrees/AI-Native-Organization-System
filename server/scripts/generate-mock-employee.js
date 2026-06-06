#!/usr/bin/env node
/**
 * CLI: generate mock employee preview or hire into Postgres.
 *
 * Usage:
 *   node server/scripts/generate-mock-employee.js
 *   node server/scripts/generate-mock-employee.js --hire --profile data
 *   node server/scripts/generate-mock-employee.js --hire --requirements "data science specialist"
 *   node server/scripts/generate-mock-employee.js --hire --project proj-organize-company-legal-cases
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const args = process.argv.slice(2);
  const hire = args.includes('--hire');
  const profileIdx = args.indexOf('--profile');
  const profileId = profileIdx >= 0 ? args[profileIdx + 1] : null;
  const reqIdx = args.indexOf('--requirements');
  const requirements = reqIdx >= 0 ? args.slice(reqIdx + 1).join(' ').replace(/^--project.*$/, '').trim() : '';
  const projIdx = args.indexOf('--project');
  const projectId = projIdx >= 0 ? args[projIdx + 1] : null;

  const postgresStore = require('../store/postgresStore');
  await postgresStore.ensureTables();

  const { previewMockEmployee, hireFromRequirements, hireEmployee, normalizePersonInput } =
    require('../services/hiringService');
  const eventsRouter = require('../routes/events');
  await eventsRouter.initStore();

  const ctx = {
    emitEvent: eventsRouter.emitEvent,
    getStore: eventsRouter.getStore,
    refreshPeopleCache: eventsRouter.refreshPeopleCache,
    recomputePeopleLoad: eventsRouter.recomputePeopleLoadFromProjects,
  };

  if (hire) {
    let result;
    if (requirements || profileId) {
      result = await hireFromRequirements(
        { profileId, requirements, description: requirements, projectId },
        { ...ctx, source: 'ai', hiredByName: 'CLI' }
      );
    } else {
      const gen = await previewMockEmployee({ profileId });
      result = await hireEmployee(gen.person, {
        ...ctx,
        hiredByName: 'CLI',
        projectId,
      });
    }
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    console.log('Hired:', result.person);
    if (result.teamMember) console.log('Project team:', result.teamMember);
    return;
  }

  const gen = await previewMockEmployee({
    profileId,
    requirements,
    description: requirements,
    matchRequirements: !!requirements,
  });
  console.log(JSON.stringify(gen, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
