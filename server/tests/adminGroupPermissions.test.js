import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

/**
 * The admin create/update handlers rebuild a group's `permissions` object field
 * by field. Anything missing from that list is dropped on every save — which is
 * how `skills` silently disappeared from a live `users` group that an admin
 * merely opened and saved, and would have done the same to `tools`.
 *
 * `normalizeGroupPermissions` is module-private, so this reads the source and
 * asserts the single normalizer covers every permission the authorization layer
 * reads. A new permission added to authorization.js without being added here
 * fails this test instead of silently vanishing on the next admin save.
 */

const groupsRoute = fs.readFileSync(path.join(process.cwd(), 'routes/admin/groups.js'), 'utf8');
const authorization = fs.readFileSync(path.join(process.cwd(), 'utils/authorization.js'), 'utf8');

const LIST_PERMISSIONS = ['apps', 'prompts', 'models', 'workflows', 'skills', 'tools'];

describe('admin group permission persistence', () => {
  it('normalizes permissions in exactly one place', () => {
    // Both handlers must delegate; a second hand-rolled object is how these drift.
    const calls = groupsRoute.match(/normalizeGroupPermissions\(/g) || [];
    // 1 definition + 2 call sites (create, update)
    expect(calls.length).toBe(3);
  });

  it.each(LIST_PERMISSIONS)('persists the "%s" permission on save', key => {
    const normalizer = groupsRoute.slice(
      groupsRoute.indexOf('function normalizeGroupPermissions'),
      groupsRoute.indexOf('function normalizeGroupPermissions') + 800
    );
    expect(normalizer).toContain(`${key}:`);
  });

  it('persists the boolean permissions on save', () => {
    const normalizer = groupsRoute.slice(
      groupsRoute.indexOf('function normalizeGroupPermissions'),
      groupsRoute.indexOf('function normalizeGroupPermissions') + 800
    );
    expect(normalizer).toContain('adminAccess:');
    expect(normalizer).toContain('contentAdmin:');
  });

  it('covers every list permission the authorization layer reads', () => {
    // getPermissionsForUser seeds one Set per list permission it understands.
    const seeded = [...authorization.matchAll(/^\s{4}(\w+): new Set\(\),$/gm)].map(m => m[1]);
    expect(seeded.sort()).toEqual([...LIST_PERMISSIONS].sort());
  });
});
