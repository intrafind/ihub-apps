// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Snapshot of how an old tool reference (`ask_user`, `iFinder_search`,
 * `braveSearch`, `<installation>__<action>`, an installation id) maps to an
 * installed integration, as of V229/V230 (#3275). Not a migration. It is shared
 * by V229 and V230, never changes, and imports nothing: the migrations stay
 * reproducible. Do NOT replace it with application code.
 */

const IHUB_ACTIONS = [
  'ask_user',
  'schedule_task',
  'list_scheduled_tasks',
  'update_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task_now',
  'list_task_runs',
  'get_task_run'
];
const IFINDER_ACTIONS = [
  'search',
  'getContent',
  'getMetadata',
  'discover',
  'getFields',
  'getFacetValues',
  'listProfiles'
];
const JIRA_ACTIONS = [
  'searchTickets',
  'getTicket',
  'addComment',
  'getTransitions',
  'transitionTicket',
  'getAttachment'
];
const ENGINE_TOOL_IDS = {
  'com.intrafind/brave-search': 'braveSearch',
  'com.intrafind/staan-search': 'staanSearch',
  'com.intrafind/qwant-search': 'qwantSearch'
};

/**
 * The installation and actions a tool reference points at, or null.
 * @param {string} ref
 * @param {Array<{id: string, definition?: string}>} installed
 * @returns {{ instanceId: string, actions: string[]|'all' }|null}
 */
export function resolveReference(ref, installed) {
  const byDefinition = definition => installed.find(inst => inst?.definition === definition);
  const ihub = byDefinition('com.intrafind/ihub');
  if (ihub && IHUB_ACTIONS.includes(ref)) return { instanceId: ihub.id, actions: [ref] };
  const ifinder = byDefinition('com.intrafind/ifinder');
  if (ifinder) {
    if (ref === 'iFinder') return { instanceId: ifinder.id, actions: 'all' };
    const name = ref.startsWith('iFinder_') ? ref.slice('iFinder_'.length) : null;
    if (name && IFINDER_ACTIONS.includes(name)) return { instanceId: ifinder.id, actions: [name] };
  }
  const jira = byDefinition('com.intrafind/jira');
  if (jira) {
    if (ref === 'jira') return { instanceId: jira.id, actions: 'all' };
    const name = ref.startsWith('jira_') ? ref.slice('jira_'.length) : null;
    if (name && JIRA_ACTIONS.includes(name)) return { instanceId: jira.id, actions: [name] };
  }
  for (const [definition, toolId] of Object.entries(ENGINE_TOOL_IDS)) {
    const engine = byDefinition(definition);
    if (engine && ref === toolId) return { instanceId: engine.id, actions: ['search'] };
  }
  const whole = installed.find(inst => inst?.id === ref);
  if (whole) return { instanceId: whole.id, actions: 'all' };
  if (ref.startsWith('a2a__')) {
    const agent = installed.find(inst => ref === `a2a__${inst?.id}`);
    if (agent) return { instanceId: agent.id, actions: 'all' };
    const skill = installed.find(inst => ref.startsWith(`a2a__${inst?.id}__`));
    if (skill) return { instanceId: skill.id, actions: [ref.slice(`a2a__${skill.id}__`.length)] };
  }
  const owner = [...installed]
    .filter(inst => typeof inst?.id === 'string' && ref.startsWith(`${inst.id}__`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (owner) return { instanceId: owner.id, actions: [ref.slice(`${owner.id}__`.length)] };
  return null;
}
