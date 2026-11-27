// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { isSkillAssigned } from '../../../../../shared/appWildcards.js';

/**
 * The `/` picker's group for a skill, by the skill's scope. Global skills
 * keep the existing `skill` group; personal skills get their own groups after
 * it (see `GROUP_ORDER` in `PromptSearch`).
 */
export const PICKER_SKILL_GROUPS = {
  global: 'skill',
  mine: 'skillMine',
  shared: 'skillShared',
  server: 'skillServer'
};

/**
 * The scope of an entry of `GET /api/skills`. Entries without a scope come
 * from a server that knows only global skills.
 *
 * @param {Object} skill - A picker entry.
 * @returns {'global'|'mine'|'shared'|'server'}
 */
export function pickerSkillScope(skill) {
  return ['mine', 'shared', 'server'].includes(skill?.scope) ? skill.scope : 'global';
}

/**
 * What picking a skill writes into the message after `/`: its name, or for a
 * skill an MCP server ships its id (`billing:deploy`), which no other skill
 * shares.
 *
 * @param {Object} skill - A picker entry.
 * @returns {string}
 */
export function pickerSkillToken(skill) {
  return pickerSkillScope(skill) === 'server' ? skill.id : skill.name;
}

/**
 * Which skills the `/` picker offers in an app, ready for the search list.
 *
 * - A **global** skill is offered only when the app lists it in `app.skills`
 *   (`"*"` lists every skill).
 * - A **personal** skill (the caller's own, or shared with them) is offered
 *   unless the app sets `skillSettings.allowPersonal: false`.
 * - A **server** skill (an MCP server's, approved) is offered as the server
 *   listed it: `GET /api/skills?appId=` lists only the ones of that app.
 *
 * Whether the app offers skills at all (`skillSettings.enabled`) is decided by
 * the caller: it does not open the picker's skill list otherwise.
 *
 * Each entry gets `_type: 'skill'`, its picker `group`, and an `id` — the
 * value sent as `requestedSkills`: the name of a global skill, the `usk_…` id
 * of a personal one.
 *
 * @param {Object[]} rawSkills - The entries of `GET /api/skills`.
 * @param {Object} [options]
 * @param {string[]} [options.appSkills=[]] - The app's `skills` list.
 * @param {boolean} [options.allowPersonal=true] - Whether the app offers personal skills.
 * @returns {Object[]}
 *
 * @example
 * selectPickerSkills(
 *   [{ name: 'brand-voice', scope: 'global' }, { id: 'usk_1', name: 'mine', scope: 'mine' }],
 *   { appSkills: [], allowPersonal: true }
 * ); // → only the personal skill, in group 'skillMine'
 */
export function selectPickerSkills(rawSkills, { appSkills = [], allowPersonal = true } = {}) {
  const result = [];
  for (const skill of Array.isArray(rawSkills) ? rawSkills : []) {
    if (!skill?.name) continue;
    const scope = pickerSkillScope(skill);
    if (scope === 'global' && !isSkillAssigned(appSkills, skill.name)) continue;
    if ((scope === 'mine' || scope === 'shared') && !allowPersonal) continue;
    result.push({
      ...skill,
      _type: 'skill',
      scope,
      group: PICKER_SKILL_GROUPS[scope],
      id: skill.id || skill.name,
      description: skill.description || '',
      ownerName: skill.owner?.name || '',
      serverName: skill.server?.name || ''
    });
  }
  return result;
}
