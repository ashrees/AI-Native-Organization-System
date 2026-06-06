/**
 * After approved worker requests that need more capacity/staffing,
 * run Team Builder, Scheduler, and optionally Orchestrator on the project.
 */

const agentActivityLog = require('../lib/agentActivityLog');
const { ORG_GENERAL_PROJECT_ID } = require('../constants/workerRequests');
const { fillAssignmentGaps } = require('./assignmentGapFill');
const { executeAgentActions, tasksNeedingSchedule } = require('./projectAIActions');

const STAFFING_KINDS = new Set([
  'capacity',
  'general',
  'workload_concern',
  'blocker_escalation',
  'team_member',
  'onboarding',
]);

const STAFFING_TEXT =
  /team\s*member|additional\s+(team|staff|resource)|capacity|headcount|understaffed|more\s+people|staffing/i;

function isStaffingOrCapacityRequest(needEvent) {
  const kind = needEvent.payload?.kind;
  const text = `${needEvent.payload?.title || ''} ${needEvent.payload?.description || ''}`;
  if (kind === 'capacity') return true;
  if (STAFFING_KINDS.has(kind) && STAFFING_TEXT.test(text)) return true;
  if (kind === 'workload_concern' || kind === 'blocker_escalation') return true;
  return STAFFING_TEXT.test(text);
}

function isProjectScoped(projectId) {
  return !!projectId && projectId !== ORG_GENERAL_PROJECT_ID;
}

/**
 * Run agents after approval so staffing/capacity requests actually change the project.
 */
async function applyStaffingAndCapacityEffects(needEvent, reviewer, ctx) {
  const projectId = needEvent.projectId;
  if (!isProjectScoped(projectId) || !isStaffingOrCapacityRequest(needEvent)) {
    return null;
  }

  const store = ctx.getStore?.();
  if (!store?.projects?.[projectId] || store.projects[projectId].status !== 'active') {
    return { skipped: 'project_not_active' };
  }

  const gapCtx =
    typeof ctx.buildAssignmentGapFillCtx === 'function'
      ? ctx.buildAssignmentGapFillCtx()
      : ctx;
  const agentCtx =
    typeof ctx.buildProjectAICtx === 'function' ? ctx.buildProjectAICtx() : ctx;

  const fill = await fillAssignmentGaps(projectId, needEvent, gapCtx);

  let rebalanced = 0;
  const hiredId =
    needEvent.payload?.hiringResult?.personId || needEvent.payload?.hiredPersonId;
  if (hiredId) {
    try {
      const { applyTeamMemberEffects } = require('./workerRequestTeamMember');
      const rebalanceNeed = {
        id: needEvent.id,
        projectId,
        type: 'need',
        payload: {
          kind: needEvent.payload?.kind || 'capacity',
          title: needEvent.payload?.title,
          description: needEvent.payload?.description,
          targetPersonId: hiredId,
          status: 'approved',
        },
      };
      const tm = await applyTeamMemberEffects(
        rebalanceNeed,
        { id: 'org-ai', name: 'Org AI' },
        ctx
      );
      rebalanced = tm?.tasksAssigned?.length ?? 0;
    } catch (err) {
      console.warn('[Staffing] Rebalance to new hire skipped:', err.message);
    }
  }

  const stateAfterFill = ctx.getStore().projects[projectId];
  const needSchedule = tasksNeedingSchedule(stateAfterFill);
  const agentActions = [];
  if (needSchedule.length > 0) {
    agentActions.push({
      agent: 'scheduler',
      action: 'reschedule',
      reason: `Approved request: schedule ${needSchedule.length} assigned task(s)`,
      taskIds: needSchedule.map((t) => t.id),
    });
  }

  let agentResults = [];
  if (agentActions.length > 0) {
    agentResults = await executeAgentActions(agentActions, projectId, needEvent, {
      ...agentCtx,
      buildAssignmentGapFillCtx: () => gapCtx,
    });
  }

  // Do not trigger full orchestrator replan — it was appending "Reassign task-*" meta rows.
  const replan = { replanned: false };

  const reviewerName = reviewer?.name || 'Reviewer';
  agentActivityLog.push({
    source: 'orchestrator',
    projectId,
    message: `Staffing workflow after approved "${needEvent.payload?.title}": ${fill.assigned ?? 0} assigned, ${needSchedule.length} scheduled, replan=${!!replan.replanned}. By ${reviewerName}.`,
  });

  return {
    assigned: fill.assigned ?? 0,
    rebalanced,
    scheduled: agentResults,
    replanned: !!replan.replanned,
    replanRequestId: replan.requestId,
  };
}

module.exports = {
  applyStaffingAndCapacityEffects,
  isStaffingOrCapacityRequest,
};
