import { describe, it, expect, beforeEach } from '@jest/globals';
import { getPermissionsForUser } from '../../../server/utils/authorization.js';

describe('Tools Permissions', () => {
  let mockGroupPermissions;

  beforeEach(() => {
    // Mock group permissions structure similar to groups.json
    mockGroupPermissions = {
      groups: {
        admins: {
          id: 'admins',
          permissions: {
            apps: ['*'],
            prompts: ['*'],
            models: ['*'],
            tools: ['*'],
            adminAccess: true
          }
        },
        users: {
          id: 'users',
          permissions: {
            apps: ['*'],
            prompts: ['*'],
            models: ['*'],
            tools: ['*'],
            adminAccess: false
          }
        },
        authenticated: {
          id: 'authenticated',
          permissions: {
            apps: ['*'],
            prompts: ['*'],
            models: ['*'],
            tools: ['*'],
            adminAccess: false
          }
        },
        anonymous: {
          id: 'anonymous',
          permissions: {
            apps: ['chat'],
            prompts: ['*'],
            models: ['gemini-2.0-flash'],
            tools: [],
            adminAccess: false
          }
        },
        limitedTools: {
          id: 'limitedTools',
          permissions: {
            apps: ['*'],
            prompts: ['*'],
            models: ['*'],
            tools: ['braveSearch', 'webContentExtractor'],
            adminAccess: false
          }
        }
      }
    };
  });

  it('should include tools in permissions object', () => {
    const permissions = getPermissionsForUser(['users'], mockGroupPermissions);

    expect(permissions).toHaveProperty('tools');
    expect(permissions.tools).toBeInstanceOf(Set);
  });

  it('should assign wildcard tools permission to admins', () => {
    const permissions = getPermissionsForUser(['admins'], mockGroupPermissions);

    expect(permissions.tools.has('*')).toBe(true);
  });

  it('should assign wildcard tools permission to regular users', () => {
    const permissions = getPermissionsForUser(['users'], mockGroupPermissions);

    expect(permissions.tools.has('*')).toBe(true);
  });

  it('should assign wildcard tools permission to authenticated users', () => {
    const permissions = getPermissionsForUser(['authenticated'], mockGroupPermissions);

    expect(permissions.tools.has('*')).toBe(true);
  });

  it('should assign empty tools set to anonymous users', () => {
    const permissions = getPermissionsForUser(['anonymous'], mockGroupPermissions);

    expect(permissions.tools.size).toBe(0);
  });

  it('should assign specific tools to limited tools group', () => {
    const permissions = getPermissionsForUser(['limitedTools'], mockGroupPermissions);

    expect(permissions.tools.has('braveSearch')).toBe(true);
    expect(permissions.tools.has('webContentExtractor')).toBe(true);
    expect(permissions.tools.size).toBe(2);
  });

  it('should merge tools permissions from multiple groups', () => {
    const permissions = getPermissionsForUser(
      ['limitedTools', 'anonymous'],
      mockGroupPermissions
    );

    // Should have tools from limitedTools (braveSearch, webContentExtractor)
    expect(permissions.tools.has('braveSearch')).toBe(true);
    expect(permissions.tools.has('webContentExtractor')).toBe(true);
    expect(permissions.tools.size).toBe(2);
  });

  it('should handle wildcard taking precedence in merged permissions', () => {
    const permissions = getPermissionsForUser(['users', 'limitedTools'], mockGroupPermissions);

    // Users has wildcard, so it should override specific tools
    expect(permissions.tools.has('*')).toBe(true);
  });

  it('should initialize tools as empty set when group has no tools permission', () => {
    const groupsWithoutTools = {
      groups: {
        noToolsGroup: {
          id: 'noToolsGroup',
          permissions: {
            apps: ['*'],
            prompts: ['*'],
            models: ['*'],
            adminAccess: false
            // No tools field
          }
        }
      }
    };

    const permissions = getPermissionsForUser(['noToolsGroup'], groupsWithoutTools);

    expect(permissions).toHaveProperty('tools');
    expect(permissions.tools).toBeInstanceOf(Set);
    expect(permissions.tools.size).toBe(0);
  });
});
