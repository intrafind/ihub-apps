/**
 * The `/` picker's group for a skill, by the skill's scope. Global skills
 * keep the existing `skill` group; personal skills get their own groups after
 * it (see `GROUP_ORDER` in `PromptSearch`).
 */
export const PICKER_SKILL_GROUPS = {
  global: 'skill',
  mine: 'skillMine',
  shared: 'skillShared'
};

/**
 * The scope of an entry of `GET /api/skills`. Entries without a scope come
 * from a server that knows only global skills.
 *
 * @param {Object} skill - A picker entry.
 * @returns {'global'|'mine'|'shared'}
 */
export function pickerSkillScope(skill) {
  return skill?.scope === 'mine' || skill?.scope === 'shared' ? skill.scope : 'global';
}

/**
 * Which skills the `/` picker offers in an app, ready for the search list.
 *
 * - A **global** skill is offered only when the app lists it in `app.skills`.
 * - A **personal** skill (the caller's own, or shared with them) is offered in
 *   every app, unless the app sets `skillSettings.allowPersonal: false`.
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
  const assigned = new Set(Array.isArray(appSkills) ? appSkills : []);
  const result = [];
  for (const skill of Array.isArray(rawSkills) ? rawSkills : []) {
    if (!skill?.name) continue;
    const scope = pickerSkillScope(skill);
    if (scope === 'global' ? !assigned.has(skill.name) : !allowPersonal) continue;
    result.push({
      ...skill,
      _type: 'skill',
      scope,
      group: PICKER_SKILL_GROUPS[scope],
      id: skill.id || skill.name,
      description: skill.description || '',
      ownerName: skill.owner?.name || ''
    });
  }
  return result;
}
