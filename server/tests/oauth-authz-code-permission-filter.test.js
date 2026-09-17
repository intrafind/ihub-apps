/**
 * OAuth Authorization Code Permission Filter Tests (GitHub issue #1299)
 *
 * Verifies that OAuth client allow-lists (allowedApps / allowedModels / allowedPrompts)
 * act as a filter on top of the signed-in user's group permissions when the token is
 * issued through the authorization_code grant (e.g. the Outlook add-in).
 *
 * Expected semantics:
 *   - Empty / undefined / ['*'] client allow-list → no client-level restriction
 *     (user keeps their full group permissions).
 *   - Non-wildcard list → intersection with the user's group permissions.
 *   - If the user has '*', the result collapses to the client's list.
 */

import { intersectWithClientAllowList, applyOAuthClientFilter } from '../utils/authorization.js';

describe('intersectWithClientAllowList', () => {
  test('empty client list → no restriction (returns user set unchanged)', () => {
    const userAllowed = new Set(['chat', 'analysis']);
    const result = intersectWithClientAllowList(userAllowed, []);
    expect(result).toBe(userAllowed);
  });

  test('undefined client list → no restriction', () => {
    const userAllowed = new Set(['chat', 'analysis']);
    const result = intersectWithClientAllowList(userAllowed, undefined);
    expect(result).toBe(userAllowed);
  });

  test('client list containing "*" → no restriction', () => {
    const userAllowed = new Set(['chat', 'analysis']);
    const result = intersectWithClientAllowList(userAllowed, ['*']);
    expect(result).toBe(userAllowed);
  });

  test('user wildcard + explicit client list → client list', () => {
    const userAllowed = new Set(['*']);
    const result = intersectWithClientAllowList(userAllowed, ['chat', 'analysis']);
    expect(result.has('chat')).toBe(true);
    expect(result.has('analysis')).toBe(true);
    expect(result.has('*')).toBe(false);
    expect(result.size).toBe(2);
  });

  test('intersection narrows user permissions', () => {
    const userAllowed = new Set(['chat', 'analysis', 'translator']);
    const result = intersectWithClientAllowList(userAllowed, ['chat', 'reports']);
    expect(result.has('chat')).toBe(true);
    expect(result.has('reports')).toBe(false); // user does not have this
    expect(result.has('analysis')).toBe(false);
    expect(result.size).toBe(1);
  });

  test('empty intersection → empty set', () => {
    const userAllowed = new Set(['chat']);
    const result = intersectWithClientAllowList(userAllowed, ['analysis']);
    expect(result.size).toBe(0);
  });

  test('handles null userAllowed gracefully', () => {
    const result = intersectWithClientAllowList(null, ['chat']);
    expect(result.size).toBe(0);
  });
});

describe('applyOAuthClientFilter', () => {
  test('leaves permissions intact when no client restrictions are set', () => {
    const permissions = {
      apps: new Set(['chat', 'analysis']),
      models: new Set(['gpt-4']),
      prompts: new Set(['standard-prompt']),
      tools: new Set(['search']),
      adminAccess: false
    };
    const user = {
      authMode: 'oauth_authorization_code',
      clientAllowedApps: [],
      clientAllowedModels: [],
      clientAllowedPrompts: []
    };

    const filtered = applyOAuthClientFilter(permissions, user);

    expect(filtered.apps).toBe(permissions.apps);
    expect(filtered.models).toBe(permissions.models);
    expect(filtered.prompts).toBe(permissions.prompts);
    expect(filtered.tools).toEqual(permissions.tools);
  });

  test('intersects apps, models, and prompts with the client allow-list', () => {
    const permissions = {
      apps: new Set(['chat', 'analysis', 'translator']),
      models: new Set(['gpt-4', 'claude-3']),
      prompts: new Set(['standard-prompt', 'analysis-prompt']),
      adminAccess: false
    };
    const user = {
      authMode: 'oauth_authorization_code',
      clientAllowedApps: ['chat'],
      clientAllowedModels: ['gpt-4'],
      clientAllowedPrompts: ['analysis-prompt']
    };

    const filtered = applyOAuthClientFilter(permissions, user);

    expect(filtered.apps.has('chat')).toBe(true);
    expect(filtered.apps.has('analysis')).toBe(false);
    expect(filtered.apps.has('translator')).toBe(false);
    expect(filtered.apps.size).toBe(1);

    expect(filtered.models.has('gpt-4')).toBe(true);
    expect(filtered.models.has('claude-3')).toBe(false);

    expect(filtered.prompts.has('analysis-prompt')).toBe(true);
    expect(filtered.prompts.has('standard-prompt')).toBe(false);
  });

  test('drops resources user does not have even when listed by client', () => {
    const permissions = {
      apps: new Set(['chat']),
      models: new Set(),
      prompts: new Set(),
      adminAccess: false
    };
    const user = {
      authMode: 'oauth_authorization_code',
      clientAllowedApps: ['chat', 'restricted-admin-app'],
      clientAllowedModels: [],
      clientAllowedPrompts: []
    };

    const filtered = applyOAuthClientFilter(permissions, user);

    expect(filtered.apps.has('chat')).toBe(true);
    expect(filtered.apps.has('restricted-admin-app')).toBe(false);
    expect(filtered.apps.size).toBe(1);
  });

  test('collapses wildcard user permissions to the client list', () => {
    const permissions = {
      apps: new Set(['*']),
      models: new Set(['*']),
      prompts: new Set(['*']),
      adminAccess: true
    };
    const user = {
      authMode: 'oauth_authorization_code',
      clientAllowedApps: ['chat'],
      clientAllowedModels: ['gpt-4'],
      clientAllowedPrompts: []
    };

    const filtered = applyOAuthClientFilter(permissions, user);

    expect(filtered.apps.has('*')).toBe(false);
    expect(filtered.apps.has('chat')).toBe(true);
    expect(filtered.apps.size).toBe(1);

    expect(filtered.models.has('*')).toBe(false);
    expect(filtered.models.has('gpt-4')).toBe(true);
    expect(filtered.models.size).toBe(1);

    // Prompts keep wildcard because client list is empty
    expect(filtered.prompts.has('*')).toBe(true);
  });
});
