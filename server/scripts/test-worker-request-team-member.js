#!/usr/bin/env node
/**
 * Regression checks for team-member approval effects (no DB required).
 * Usage: node server/scripts/test-worker-request-team-member.js
 */

const assert = require('assert');
const {
  isTeamMemberRequest,
  resolveTargetPerson,
  teamMemberEffectsComplete,
  validateTeamMemberRequestPayload,
} = require('../services/workerRequestTeamMember');

const people = [
  { id: 'person-10', name: 'Luna Lovegood', department: 'data engineering', team: 'data science', role: 'Manager' },
  { id: 'person-14', name: 'Ginny Weasley', department: 'Security', team: 'Security', role: 'Manager' },
];

function need(payload) {
  return { payload, projectId: 'proj-test' };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('team_member kind is detected', () => {
  assert.strictEqual(isTeamMemberRequest(need({ kind: 'team_member', title: 'x' })), true);
});

test('general assign-to-team text is detected', () => {
  assert.strictEqual(
    isTeamMemberRequest(
      need({ kind: 'general', title: 'Request assign Luna Lovegood as team member' })
    ),
    true
  );
});

test('resolves Luna from title, not submitter', () => {
  const p = resolveTargetPerson(
    need({
      kind: 'team_member',
      title: 'Add Luna Lovegood to the Organize Legal Cases project team',
      personId: 'person-14',
    }),
    people
  );
  assert.strictEqual(p?.id, 'person-10');
});

test('targetPersonId takes precedence', () => {
  const p = resolveTargetPerson(need({ kind: 'onboarding', targetPersonId: 'person-10', personId: 'person-14' }), people);
  assert.strictEqual(p?.id, 'person-10');
});

test('validate rejects missing target for onboarding', () => {
  const v = validateTeamMemberRequestPayload(
    { kind: 'onboarding', title: 'Onboard someone', personId: 'person-14' },
    people
  );
  assert.strictEqual(v.ok, false);
});

test('validate accepts onboarding with name in title', () => {
  const v = validateTeamMemberRequestPayload(
    {
      kind: 'onboarding',
      title: 'Onboard Luna Lovegood',
      personId: 'person-14',
    },
    people
  );
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.targetPersonId, 'person-10');
});

test('teamMemberEffectsComplete when on team', () => {
  assert.strictEqual(
    teamMemberEffectsComplete(
      need({
        kind: 'team_member',
        effectsApplied: {
          teamMember: { targetPersonId: 'person-10', alreadyOnTeam: true },
        },
      })
    ),
    true
  );
});

test('teamMemberEffectsComplete false when target missing', () => {
  assert.strictEqual(
    teamMemberEffectsComplete(
      need({
        effectsApplied: { teamMember: { skipped: 'target_person_not_found' } },
      })
    ),
    false
  );
});

const {
  buildAssigneeSnapshot,
  isLeadershipJobTitle,
} = require('../lib/projectMemberRoles');

test('contributor on project shows Contributor on task not Team Lead', () => {
  const person = {
    id: 'person-10',
    name: 'Luna Lovegood',
    department: 'data engineering',
    team: 'data science',
    role: 'Team Lead',
  };
  const projectState = {
    roles: {
      'contributor_person-10': {
        roleId: 'contributor',
        label: 'Contributor',
        personId: 'person-10',
        jobTitle: 'data science Manager',
      },
    },
  };
  const snap = buildAssigneeSnapshot(person, projectState);
  assert.strictEqual(snap.role, 'Contributor');
  assert.strictEqual(snap.jobTitle, 'data science Manager');
});

test('leadership job title detection', () => {
  assert.strictEqual(isLeadershipJobTitle('Team Lead'), true);
  assert.strictEqual(isLeadershipJobTitle('data science Manager'), false);
});

console.log(`\n${passed} checks passed.`);
if (process.exitCode) process.exit(process.exitCode);
