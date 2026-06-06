/**
 * Personal HR partner — every employee is assigned a dedicated HR contact.
 */

function isHrPerson(person) {
  if (!person) return false;
  const d = (person.department || '').toLowerCase();
  const r = (person.role || '').toLowerCase();
  const s = (person.skills || []).join(' ').toLowerCase();
  return d.includes('human resources') || r.includes('hr') || s.includes('human-resources');
}

function listHrPeople(people) {
  return (people || []).filter(isHrPerson).filter((p) => (p.availabilityStatus || 'active') !== 'on_leave');
}

/**
 * Resolve dedicated HR partner for an employee (from hrPersonId or fallback).
 */
function getPersonalHr(personId, people) {
  if (!personId || !people?.length) return null;
  const person = people.find((p) => p.id === personId);
  if (!person) return null;
  if (isHrPerson(person)) {
    return person;
  }
  if (person.hrPersonId) {
    const hr = people.find((p) => p.id === person.hrPersonId);
    if (hr && (hr.availabilityStatus || 'active') !== 'on_leave') return hr;
  }
  const hrPool = listHrPeople(people);
  if (hrPool.length === 0) return null;
  if (person.hrPersonId) {
    const idx = hrPool.findIndex((h) => h.id === person.hrPersonId);
    if (idx >= 0 && hrPool.length > 1) return hrPool[(idx + 1) % hrPool.length];
  }
  return hrPool[0] || null;
}

/**
 * Assign each non-HR employee a personal HR partner (round-robin across HR staff).
 */
function computePersonalHrAssignments(people) {
  const hrPool = listHrPeople(people);
  if (hrPool.length === 0) return new Map();

  const assignments = new Map();
  let idx = 0;
  for (const p of people) {
    if (isHrPerson(p)) {
      assignments.set(p.id, p.id);
    } else {
      assignments.set(p.id, hrPool[idx % hrPool.length].id);
      idx += 1;
    }
  }
  return assignments;
}

module.exports = {
  isHrPerson,
  listHrPeople,
  getPersonalHr,
  computePersonalHrAssignments,
};
