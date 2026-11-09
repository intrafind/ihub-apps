// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V236 — Raise the default limits of user projects (#3523)
 *
 * The item ceiling went from 50 to 200, and the defaults follow:
 *
 * - `platform.projects.limits.maxFiles` 25 → 100 items per project.
 * - `platform.projects.limits.maxProjectBytes` 200 MB → 500 MB per project.
 *
 * V172 wrote the old defaults into every platform.json, so a stored value
 * equal to the old default is taken as "never chosen" and raised. Any other
 * value is an admin's choice and stays. A missing value is left missing: the
 * built-in default (now the new one) applies.
 */

export const version = '236';
export const description = 'raise_project_limit_defaults';

/** limit key → [old default, new default] */
export const RAISED = Object.freeze({
  maxFiles: [25, 100],
  maxProjectBytes: [200 * 1024 * 1024, 500 * 1024 * 1024]
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const limits = platform?.projects?.limits;
  if (!limits || typeof limits !== 'object') {
    ctx.log('No platform.projects.limits — the built-in defaults apply');
    return;
  }
  const changed = [];
  for (const [key, [oldDefault, newDefault]] of Object.entries(RAISED)) {
    if (limits[key] === oldDefault) {
      limits[key] = newDefault;
      changed.push(`${key}=${newDefault}`);
    }
  }
  if (changed.length === 0) {
    ctx.log('Project limits were set by an admin — left as they are');
    return;
  }
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Raised project limit defaults (${changed.join(', ')})`);
}
