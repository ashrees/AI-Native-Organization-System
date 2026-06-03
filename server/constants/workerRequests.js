/**
 * Worker HR / ops request kinds (stored as `need` events; no orchestration).
 */

const HANDLING_MODES = Object.freeze([
  {
    id: 'ai',
    label: 'AI agents handle',
    description: 'AI agents create review tasks and assign each target role automatically.',
  },
  {
    id: 'notify',
    label: 'Notify teams',
    description: 'Notify every role mapped to this request type (see “Forwards to” below).',
  },
  {
    id: 'self',
    label: 'Self-manage',
    description: 'You track it yourself; all mapped roles are still notified via AI activity.',
  },
]);

const NEED_STATUSES = Object.freeze([
  'open',
  'in_review',
  'approved',
  'rejected',
  'met',
  'cancelled',
]);

const { KIND_ROUTES, ORG_GENERAL_PROJECT_ID } = require('./requestRouting');

const WORKER_REQUEST_KINDS = Object.freeze(
  [
    ['sick_leave', 'Sick leave', 'Unable to work due to illness'],
    ['vacation', 'Vacation / PTO', 'Planned time away'],
    ['project_transfer', 'Project transfer', 'Move to a different project or team'],
    ['workload_concern', 'Workload concern', 'Too many assignments or unrealistic deadlines'],
    ['project_contribution_change', 'Stop or change project contribution', 'Reduce or end work on a project'],
    ['schedule_change', 'Schedule change', 'Shift or timeline adjustment'],
    ['blocker_escalation', 'Blocker escalation', 'Blocked and need leadership help'],
    ['role_change', 'Role / responsibility change', 'Change in role or scope'],
    ['training', 'Training / learning', 'Request training or mentorship'],
    ['equipment', 'Tools / access', 'Software, hardware, or access needs'],
    ['general', 'General request', 'Other workplace request'],
    [
      'emergency_return',
      'Emergency return to work',
      'Temporary HR authorization to work during approved leave (urgent operational need)',
    ],
  ].map(([id, label, description]) => ({
    id,
    label,
    description,
    forwardsTo: KIND_ROUTES[id]?.label || KIND_ROUTES.general.label,
    aiAgent: KIND_ROUTES[id]?.aiAgent || 'org_ai',
  }))
);

module.exports = {
  WORKER_REQUEST_KINDS,
  ORG_GENERAL_PROJECT_ID,
  HANDLING_MODES,
  NEED_STATUSES,
};
