// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-skill settings an administrator keeps next to the skills themselves.
 *
 * A skill is found by its directory; whether it is switched on and the
 * description shown for it are the admin's to change without touching the
 * skill's files (which an installed or marketplace skill gets overwritten on
 * update, and a system skill ships read-only). They live in
 * `config/skills.json`:
 *
 * ```json
 * { "skills": { "my-skill": { "enabled": false, "configOverrides": { "description": "…" } } } }
 * ```
 *
 * A skill without an entry is enabled and unchanged. System skills ignore
 * entries: they are always on and keep their own description.
 */

import configStore from '../config/ConfigStore.js';

export const SKILL_OVERRIDES_PATH = 'config/skills.json';
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * The well-formed entries of `config/skills.json`, by skill name. Anything else
 * in the file (a hand edit gone wrong) is ignored rather than breaking the
 * skills list. A null-prototype object: a skill directory may be named anything.
 *
 * @param {any} raw - Parsed file body
 * @returns {Record<string, { enabled?: boolean, configOverrides?: { description: string } }>}
 */
export function normalizeSkillOverrides(raw) {
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.skills : null;
  const overrides = Object.create(null);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return overrides;

  for (const [name, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const clean = {};
    if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled;
    const description = entry.configOverrides?.description;
    if (typeof description === 'string' && description.trim()) {
      clean.configOverrides = {
        description: description.trim().slice(0, MAX_SKILL_DESCRIPTION_LENGTH)
      };
    }
    if (Object.keys(clean).length > 0) overrides[name] = clean;
  }
  return overrides;
}

/** @returns {Promise<ReturnType<typeof normalizeSkillOverrides>>} */
export async function readSkillOverrides() {
  return normalizeSkillOverrides(await configStore.readJson(SKILL_OVERRIDES_PATH));
}

/**
 * Lay the overrides over the discovered skills. `enabled` is always set;
 * `configOverrides` and the description shown follow an override that exists.
 *
 * @param {Array<object>} skills - From `loadSkillsMetadata`
 * @param {ReturnType<typeof normalizeSkillOverrides>} overrides
 * @returns {Array<object>}
 */
export function applySkillOverrides(skills, overrides) {
  return skills.map(skill => {
    const override = skill.isSystem ? undefined : overrides[skill.name];
    if (!override) return { ...skill, enabled: true };
    return {
      ...skill,
      enabled: override.enabled !== false,
      ...(override.configOverrides
        ? {
            configOverrides: override.configOverrides,
            description: override.configOverrides.description
          }
        : {})
    };
  });
}

/**
 * Change one skill's entry and save the file. An entry that ends up as the
 * default (enabled, no description override) is removed.
 *
 * @param {string} name - Skill name
 * @param {{ enabled?: boolean, description?: string|null }} change - `description`
 *   of '' or null removes the override
 */
export async function updateSkillOverride(name, change) {
  // Strict read: a file that exists but cannot be parsed must not be replaced
  // by one that holds only this change.
  const raw = await configStore.readJsonStrict(SKILL_OVERRIDES_PATH);
  const all = normalizeSkillOverrides(raw);
  const next = { ...(all[name] || {}) };

  if (change.enabled !== undefined) next.enabled = change.enabled;
  if (change.description !== undefined) {
    const description = typeof change.description === 'string' ? change.description.trim() : '';
    if (description) next.configOverrides = { description };
    else delete next.configOverrides;
  }
  if (next.enabled === true) delete next.enabled;

  if (Object.keys(next).length > 0) all[name] = next;
  else delete all[name];

  await configStore.writeJson(SKILL_OVERRIDES_PATH, {
    skills: Object.fromEntries(Object.entries(all))
  });
}
