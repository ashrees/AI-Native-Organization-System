/**
 * Essential project roles — assigned when a new project is created (separate from delivery tasks).
 */

const ESSENTIAL_PROJECT_ROLES = Object.freeze([
  {
    id: 'project_lead',
    label: 'Project Lead',
    description: 'Accountable for delivery, priorities, and stakeholder communication',
    match: (p) => {
      const r = (p.role || '').toLowerCase();
      return r.includes('manager') || r.includes('lead') || r.includes('director');
    },
    priority: 1,
  },
  {
    id: 'technical_lead',
    label: 'Technical Lead',
    description: 'Owns architecture, technical decisions, and engineering quality',
    match: (p) => {
      const d = (p.department || '').toLowerCase();
      const r = (p.role || '').toLowerCase();
      return (
        d.includes('engineering') ||
        d.includes('ai') ||
        d.includes('data') ||
        r.includes('engineer') ||
        r.includes('architect')
      );
    },
    priority: 2,
  },
  {
    id: 'delivery_owner',
    label: 'Delivery Owner',
    description: 'Tracks milestones, schedules, and cross-team execution',
    match: (p) => {
      const r = (p.role || '').toLowerCase();
      return r.includes('manager') || r.includes('lead') || r.includes('owner');
    },
    priority: 3,
  },
  {
    id: 'hr_liaison',
    label: 'HR Liaison',
    description: 'Project HR contact for people, leave, and workforce issues',
    match: (p) => {
      const d = (p.department || '').toLowerCase();
      return d.includes('human resources') || (p.role || '').toLowerCase().includes('hr');
    },
    priority: 4,
  },
]);

module.exports = { ESSENTIAL_PROJECT_ROLES };
