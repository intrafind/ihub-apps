// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What every protocol adapter shares: how an action's tool id is formed and
 * whether an installation has an action switched on.
 */

/** Tool id of an action: `<instanceId>__<action>`, unless the action keeps a fixed id (built-ins). */
export function toolIdFor(instanceId, actionName, action) {
  if (action?.toolId) return action.toolId;
  return `${instanceId}__${actionName}`;
}

/** Whether the installation offers the action (`actions.enabled` / `actions.disabled`). */
export function actionEnabled(instance, action) {
  const policy = instance.actions || {};
  if ((policy.disabled || []).includes(action.name)) return false;
  const enabled = policy.enabled || ['*'];
  if (enabled.includes(action.name)) return true;
  return enabled.includes('*') && action.enabledByDefault !== false;
}

/**
 * The outcome of an installation test, in the shape `IntegrationTestResults`
 * renders, from a list of steps `{ id, label, status, message, details?, hints? }`.
 */
export function testResult(steps, started, extra = {}) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const step of steps) summary[step.status] = (summary[step.status] || 0) + 1;
  const success = summary.fail === 0;
  return {
    success,
    message: success
      ? extra.successMessage || 'Integration reachable'
      : steps.find(s => s.status === 'fail')?.message,
    summary,
    steps,
    durationMs: Date.now() - started,
    ...(extra.actionCount !== undefined ? { actionCount: extra.actionCount } : {})
  };
}
