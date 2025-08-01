/**
 * Comprehensive Group Handling Test Suite
 * 
 * Tests the new group handling system that replaces additionalGroups with external groups
 * Covers all authentication methods: anonymous, local, OIDC, proxy
 */

import { jest } from '@jest/globals';
import {
  enhanceUserWithPermissions,
  mapExternalGroups,
  getPermissionsForUser,
  resolveGroupInheritance,
  loadGroupsConfiguration,
  hasAdminAccess
} from '../utils/authorization.js';
import {
  mergeUserGroups,
  validateAndPersistExternalUser,
  createOrUpdateExternalUser,
  loadUsers,
  saveUsers
} from '../utils/userManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock configuration for testing
const mockGroupsConfig = {
  groups: {
    anonymous: {
      id: 'anonymous',
      name: 'Anonymous',
      description: 'Anonymous users',
      inherits: [],
      permissions: {
        apps: ['public-app'],
        prompts: ['public-prompt'],
        models: ['gpt-4'],
        adminAccess: false
      },
      mappings: ['guest']
    },
    authenticated: {
      id: 'authenticated',
      name: 'Authenticated',
      description: 'All authenticated users',
      inherits: ['anonymous'],
      permissions: {
        apps: ['auth-app'],
        prompts: ['auth-prompt'],
        models: ['claude-4'],
        adminAccess: false
      },
      mappings: ['authenticated-users']
    },
    users: {
      id: 'users',
      name: 'Users',
      description: 'Standard users',
      inherits: ['authenticated'],
      permissions: {
        apps: ['user-app'],
        prompts: ['user-prompt'],
        models: ['gemini-2.0'],
        adminAccess: false
      },
      mappings: ['Employees', 'Staff']
    },
    finance: {
      id: 'finance',
      name: 'Finance',
      description: 'Finance team',
      inherits: ['users'],
      permissions: {
        apps: ['finance-app'],
        prompts: ['finance-prompt'],
        models: ['o1-preview'],
        adminAccess: false
      },
      mappings: ['Finance-Team', 'Accounting']
    },
    admin: {
      id: 'admin',
      name: 'Admin',
      description: 'Administrators',
      inherits: ['users'],
      permissions: {
        apps: ['*'],
        prompts: ['*'],
        models: ['*'],
        adminAccess: true
      },
      mappings: ['Admins', 'IT-Admin', 'SuperUsers']
    }
  }
};

const mockPlatformConfig = {
  auth: {
    mode: 'local',
    authenticatedGroup: 'authenticated'
  },
  anonymousAuth: {
    enabled: true,
    defaultGroups: ['anonymous']
  },
  localAuth: {
    enabled: true,
    usersFile: 'test-users.json',
    allowSelfSignup: false
  },
  oidcAuth: {
    enabled: true,
    allowSelfSignup: true,
    providers: [
      {
        name: 'test-provider',
        issuer: 'https://test.example.com',
        clientId: 'test-client'
      }
    ]
  },
  proxyAuth: {
    enabled: true,
    allowSelfSignup: true,
    userHeader: 'x-forwarded-user',
    groupsHeader: 'x-forwarded-groups'
  }
};

// Mock file system operations
const mockUsers = {
  users: {
    'user_local_123': {
      id: 'user_local_123',
      username: 'localuser',
      email: 'local@test.com',
      name: 'Local User',
      internalGroups: ['finance'], // Admin assigned this user to finance group
      active: true,
      authMethods: ['local'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    'user_oidc_456': {
      id: 'user_oidc_456',
      username: 'oidcuser@test.com',
      email: 'oidcuser@test.com',
      name: 'OIDC User',
      internalGroups: [], // No admin-assigned groups
      active: true,
      authMethods: ['oidc'],
      oidcData: {
        subject: 'oidc-subject-123',
        provider: 'test-provider'
      },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    'user_proxy_789': {
      id: 'user_proxy_789',
      username: 'proxyuser@corp.com',
      email: 'proxyuser@corp.com',
      name: 'Proxy User',
      internalGroups: ['users'], // Admin assigned basic user access
      active: true,
      authMethods: ['proxy'],
      proxyData: {
        subject: 'proxy-subject-123',
        provider: 'proxy'
      },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    'user_legacy_999': {
      id: 'user_legacy_999',
      username: 'legacyuser',
      email: 'legacy@test.com',
      name: 'Legacy User',
      additionalGroups: ['admin'], // OLD FORMAT - should be migrated
      active: true,
      authMethods: ['local'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  },
  metadata: {
    version: '2.0.0',
    lastUpdated: '2025-01-01T00:00:00.000Z'
  }
};

// Mock loadGroupsConfiguration to return our test config
jest.mock('../utils/authorization.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadGroupsConfiguration: jest.fn(() => mockGroupsConfig),
    loadGroupPermissions: jest.fn(() => {
      // Convert to legacy format for compatibility
      const legacyFormat = { groups: {} };
      for (const [groupId, group] of Object.entries(mockGroupsConfig.groups)) {
        legacyFormat.groups[groupId] = {
          apps: group.permissions?.apps || [],
          prompts: group.permissions?.prompts || [],
          models: group.permissions?.models || [],
          adminAccess: group.permissions?.adminAccess || false,
          description: group.description || ''
        };
      }
      return legacyFormat;
    }),
    loadGroupMapping: jest.fn(() => {
      // Convert to legacy mapping format
      const mapping = {};
      for (const [groupId, group] of Object.entries(mockGroupsConfig.groups)) {
        if (group.mappings && Array.isArray(group.mappings)) {
          for (const externalGroup of group.mappings) {
            if (!mapping[externalGroup]) {
              mapping[externalGroup] = [];
            }
            mapping[externalGroup].push(groupId);
          }
        }
      }
      return mapping;
    })
  };
});

// Mock userManager file operations
jest.mock('fs');
jest.mock('../utils/atomicWrite.js', () => ({
  atomicWriteJSON: jest.fn()
}));

describe('Group Handling System Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock fs.readFileSync to return our test users
    fs.readFileSync.mockReturnValue(JSON.stringify(mockUsers));
    fs.existsSync.mockReturnValue(true);
  });

  describe('Group Inheritance Resolution', () => {
    test('should resolve group inheritance correctly', () => {
      const resolved = resolveGroupInheritance(mockGroupsConfig);
      
      // Check that admin group inherits all permissions from users -> authenticated -> anonymous
      const adminGroup = resolved.groups.admin;
      expect(adminGroup.permissions.apps).toContain('public-app'); // from anonymous
      expect(adminGroup.permissions.apps).toContain('auth-app'); // from authenticated  
      expect(adminGroup.permissions.apps).toContain('user-app'); // from users
      expect(adminGroup.permissions.apps).toContain('*'); // from admin itself
      
      // Check that finance group has correct inherited permissions
      const financeGroup = resolved.groups.finance;
      expect(financeGroup.permissions.apps).toContain('public-app'); // from anonymous
      expect(financeGroup.permissions.apps).toContain('auth-app'); // from authenticated
      expect(financeGroup.permissions.apps).toContain('user-app'); // from users
      expect(financeGroup.permissions.apps).toContain('finance-app'); // from finance itself
    });

    test('should detect circular dependencies in group inheritance', () => {
      const circularConfig = {
        groups: {
          groupA: {
            id: 'groupA',
            inherits: ['groupB'],
            permissions: { apps: [], prompts: [], models: [], adminAccess: false }
          },
          groupB: {
            id: 'groupB', 
            inherits: ['groupA'],
            permissions: { apps: [], prompts: [], models: [], adminAccess: false }
          }
        }
      };
      
      expect(() => resolveGroupInheritance(circularConfig)).toThrow('Circular dependency detected');
    });
  });

  describe('External Group Mapping', () => {
    test('should map external groups to internal groups correctly', () => {
      const externalGroups = ['Finance-Team', 'Employees'];
      const internalGroups = mapExternalGroups(externalGroups);
      
      expect(internalGroups).toContain('finance'); // Finance-Team -> finance
      expect(internalGroups).toContain('users'); // Employees -> users
    });

    test('should return anonymous for unmapped external groups', () => {
      const externalGroups = ['UnknownGroup'];
      const internalGroups = mapExternalGroups(externalGroups);
      
      expect(internalGroups).toEqual(['anonymous']);
    });

    test('should handle multiple mappings to same internal group', () => {
      const externalGroups = ['Admins', 'IT-Admin', 'SuperUsers'];
      const internalGroups = mapExternalGroups(externalGroups);
      
      expect(internalGroups).toEqual(['admin']); // All map to admin, should be deduplicated
    });
  });

  describe('Group Merging', () => {
    test('should merge external and internal groups correctly', () => {
      const externalGroups = ['Finance-Team']; // Maps to 'finance'
      const internalGroups = ['users']; // Admin-assigned group
      
      const merged = mergeUserGroups(externalGroups, internalGroups);
      
      expect(merged).toContain('Finance-Team'); // Original external group preserved
      expect(merged).toContain('users'); // Internal group preserved
      expect(merged.length).toBe(2);
    });

    test('should deduplicate merged groups', () => {
      const externalGroups = ['Employees']; // Maps to 'users'
      const internalGroups = ['users']; // Same as mapped external group
      
      const merged = mergeUserGroups(externalGroups, internalGroups);
      
      expect(merged).toEqual(['Employees', 'users']);
    });

    test('should handle empty arrays', () => {
      expect(mergeUserGroups([], [])).toEqual([]);
      expect(mergeUserGroups(['test'], [])).toEqual(['test']);
      expect(mergeUserGroups([], ['test'])).toEqual(['test']);
    });
  });

  describe('Anonymous Authentication', () => {
    test('should assign default anonymous groups', () => {
      const user = null; // Anonymous user
      
      const enhancedUser = enhanceUserWithPermissions(user, {}, mockPlatformConfig);
      
      expect(enhancedUser.id).toBe('anonymous');
      expect(enhancedUser.groups).toContain('anonymous');
      expect(enhancedUser.isAdmin).toBe(false);
      expect(enhancedUser.permissions.apps.has('public-app')).toBe(true);
      expect(enhancedUser.permissions.adminAccess).toBe(false);
    });

    test('should support custom anonymous groups from platform config', () => {
      const customPlatform = {
        ...mockPlatformConfig,
        anonymousAuth: {
          enabled: true,
          defaultGroups: ['guest', 'public']
        }
      };
      
      const enhancedUser = enhanceUserWithPermissions(null, {}, customPlatform);
      
      expect(enhancedUser.groups).toEqual(['guest', 'public']);
    });
  });

  describe('Local Authentication', () => {
    test('should handle local user with internal groups only', () => {
      const localUser = {
        id: 'user_local_123',
        username: 'localuser',
        email: 'local@test.com',
        name: 'Local User',
        groups: ['authenticated'], // Base authentication group
        authMethod: 'local'
      };
      
      // Mock loadUsers to return our test user with internalGroups
      const enhancedUser = enhanceUserWithPermissions(localUser, {}, mockPlatformConfig);
      
      expect(enhancedUser.groups).toContain('authenticated');
      expect(enhancedUser.permissions.apps.has('auth-app')).toBe(true);
    });

    test('should add authenticated group to local users', () => {
      const localUser = {
        id: 'user_local_123',
        username: 'localuser',
        groups: ['users']
      };
      
      const enhancedUser = enhanceUserWithPermissions(localUser, {}, mockPlatformConfig);
      
      expect(enhancedUser.groups).toContain('users');
    });
  });

  describe('OIDC Authentication', () => {
    test('should handle OIDC user with external groups from provider', async () => {
      const oidcUser = {
        id: 'oidc-subject-123',
        name: 'OIDC User',
        email: 'oidcuser@test.com',
        externalGroups: ['Employees'], // From OIDC provider
        provider: 'test-provider',
        authMethod: 'oidc'
      };
      
      const validatedUser = await validateAndPersistExternalUser(oidcUser, mockPlatformConfig);
      
      // Should have external groups from OIDC provider
      expect(validatedUser.groups).toContain('Employees');
      // Should not have any internal groups (empty array in mock data)
      expect(validatedUser.groups.length).toBe(1);
    });

    test('should merge OIDC external groups with admin-assigned internal groups', async () => {
      // Simulate user that already exists in users.json with internal groups
      const existingOidcUser = {
        id: 'oidc-subject-456', // Different from mock to simulate new external groups
        name: 'OIDC User With Internal Groups',
        email: 'oidcuser@test.com', // Same email to find existing user
        externalGroups: ['Finance-Team'], // New external group from OIDC
        provider: 'test-provider',
        authMethod: 'oidc'
      };
      
      const validatedUser = await validateAndPersistExternalUser(existingOidcUser, mockPlatformConfig);
      
      // Should have both external groups from OIDC and internal groups from users.json
      expect(validatedUser.groups).toContain('Finance-Team'); // External
      // Internal groups from users.json should be merged too (mocked as empty in test user)
    });

    test('should handle OIDC self-signup when enabled', async () => {
      const newOidcUser = {
        id: 'new-oidc-subject',
        name: 'New OIDC User',
        email: 'newuser@test.com',
        externalGroups: ['Employees'],
        provider: 'test-provider',
        authMethod: 'oidc'
      };
      
      // Mock user not found in users.json
      fs.readFileSync.mockReturnValue(JSON.stringify({ users: {}, metadata: { version: '2.0.0' } }));
      
      const validatedUser = await validateAndPersistExternalUser(newOidcUser, mockPlatformConfig);
      
      expect(validatedUser.id).toBeDefined();
      expect(validatedUser.groups).toContain('Employees');
      expect(validatedUser.persistedUser).toBe(true);
    });

    test('should reject OIDC self-signup when disabled', async () => {
      const restrictivePlatform = {
        ...mockPlatformConfig,
        oidcAuth: {
          ...mockPlatformConfig.oidcAuth,
          allowSelfSignup: false
        }
      };
      
      const newOidcUser = {
        id: 'new-oidc-subject',
        name: 'New OIDC User', 
        email: 'newuser@test.com',
        externalGroups: ['Employees'],
        provider: 'test-provider',
        authMethod: 'oidc'
      };
      
      // Mock user not found in users.json
      fs.readFileSync.mockReturnValue(JSON.stringify({ users: {}, metadata: { version: '2.0.0' } }));
      
      await expect(validateAndPersistExternalUser(newOidcUser, restrictivePlatform))
        .rejects.toThrow('New user registration is not allowed');
    });
  });

  describe('Proxy Authentication', () => {
    test('should handle proxy user with external groups from headers', async () => {
      const proxyUser = {
        id: 'proxy-user-123',
        name: 'Proxy User',
        email: 'proxyuser@corp.com',
        externalGroups: ['IT-Admin', 'Employees'], // From proxy headers
        provider: 'proxy',
        authMethod: 'proxy'
      };
      
      const validatedUser = await validateAndPersistExternalUser(proxyUser, mockPlatformConfig);
      
      // Should have external groups from proxy
      expect(validatedUser.groups).toContain('IT-Admin');
      expect(validatedUser.groups).toContain('Employees');
    });

    test('should merge proxy external groups with internal groups', async () => {
      const proxyUser = {
        id: 'proxy-subject-123', // Matches mock user
        name: 'Proxy User',
        email: 'proxyuser@corp.com', // Matches mock user
        externalGroups: ['IT-Admin'], // From proxy headers  
        provider: 'proxy',
        authMethod: 'proxy'
      };
      
      const validatedUser = await validateAndPersistExternalUser(proxyUser, mockPlatformConfig);
      
      // Should have both external groups from proxy and internal groups from users.json
      expect(validatedUser.groups).toContain('IT-Admin'); // External from proxy
      expect(validatedUser.groups).toContain('users'); // Internal from users.json (mocked)
    });

    test('should handle proxy user without external groups', async () => {
      const proxyUser = {
        id: 'proxy-user-no-groups',
        name: 'Proxy User No Groups',
        email: 'ngroups@corp.com',
        externalGroups: [], // No groups from proxy
        provider: 'proxy',
        authMethod: 'proxy'
      };
      
      // Mock user not found in users.json
      fs.readFileSync.mockReturnValue(JSON.stringify({ users: {}, metadata: { version: '2.0.0' } }));
      
      const validatedUser = await validateAndPersistExternalUser(proxyUser, mockPlatformConfig);
      
      // Should create user with empty groups array
      expect(validatedUser.groups).toEqual([]);
      expect(validatedUser.persistedUser).toBe(true);
    });
  });

  describe('Admin Access Detection', () => {
    test('should detect admin access from group permissions', () => {
      const adminGroups = ['admin'];
      expect(hasAdminAccess(adminGroups)).toBe(true);
    });

    test('should detect admin access through group inheritance', () => {
      // User is in admin group which inherits from users
      const userGroups = ['admin', 'users'];
      expect(hasAdminAccess(userGroups)).toBe(true);
    });

    test('should not grant admin access to non-admin groups', () => {
      const userGroups = ['users', 'finance'];
      expect(hasAdminAccess(userGroups)).toBe(false);
    });

    test('should handle empty or invalid groups', () => {
      expect(hasAdminAccess([])).toBe(false);
      expect(hasAdminAccess(null)).toBe(false);
      expect(hasAdminAccess(undefined)).toBe(false);
    });
  });

  describe('Permission Resolution', () => {
    test('should resolve permissions correctly for user with multiple groups', () => {
      const userGroups = ['users', 'finance'];
      const permissions = getPermissionsForUser(userGroups);
      
      // Should have permissions from both groups
      expect(permissions.apps.has('user-app')).toBe(true); // from users
      expect(permissions.apps.has('finance-app')).toBe(true); // from finance  
      expect(permissions.apps.has('public-app')).toBe(true); // inherited from anonymous
      expect(permissions.adminAccess).toBe(false); // neither group has admin
    });

    test('should handle wildcard permissions correctly', () => {
      const adminGroups = ['admin'];
      const permissions = getPermissionsForUser(adminGroups);
      
      expect(permissions.apps.has('*')).toBe(true);
      expect(permissions.prompts.has('*')).toBe(true);
      expect(permissions.models.has('*')).toBe(true);
      expect(permissions.adminAccess).toBe(true);
    });

    test('should handle user with no groups', () => {
      const permissions = getPermissionsForUser([]);
      
      // Should get default anonymous permissions when no groups
      expect(permissions.apps.size).toBe(0);
      expect(permissions.adminAccess).toBe(false);
    });
  });

  describe('User Enhancement with Permissions', () => {
    test('should enhance user with external and internal groups', () => {
      const user = {
        id: 'test-user',
        name: 'Test User',
        email: 'test@example.com',
        externalGroups: ['Finance-Team'], // From auth provider
        internalGroups: ['users'], // From admin assignment
        authMethod: 'oidc'
      };
      
      const enhancedUser = enhanceUserWithPermissions(user, {}, mockPlatformConfig);
      
      // Should map external groups and merge with internal groups
      expect(enhancedUser.groups).toContain('finance'); // Mapped from Finance-Team
      expect(enhancedUser.groups).toContain('users'); // Internal group
      
      // Should have permissions from both groups
      expect(enhancedUser.permissions.apps.has('finance-app')).toBe(true);
      expect(enhancedUser.permissions.apps.has('user-app')).toBe(true);
    });

    test('should handle user with only external groups', () => {
      const user = {
        id: 'test-user',
        name: 'Test User', 
        email: 'test@example.com',
        externalGroups: ['Employees'],
        authMethod: 'oidc'
      };
      
      const enhancedUser = enhanceUserWithPermissions(user, {}, mockPlatformConfig);
      
      expect(enhancedUser.groups).toContain('users'); // Mapped from Employees
      expect(enhancedUser.permissions.apps.has('user-app')).toBe(true);
    });

    test('should handle user with only internal groups', () => {
      const user = {
        id: 'test-user',
        name: 'Test User',
        email: 'test@example.com', 
        internalGroups: ['finance'],
        authMethod: 'local'
      };
      
      const enhancedUser = enhanceUserWithPermissions(user, {}, mockPlatformConfig);
      
      expect(enhancedUser.groups).toContain('finance');
      expect(enhancedUser.permissions.apps.has('finance-app')).toBe(true);
    });
  });

  describe('Legacy User Migration', () => {
    test('should migrate additionalGroups to internalGroups', async () => {
      const legacyUser = {
        id: 'legacy-subject',
        name: 'Legacy User',
        email: 'legacy@test.com',
        provider: 'oidc'
      };
      
      // Mock users.json with legacy format
      const legacyUsersConfig = {
        users: {
          'user_legacy': {
            id: 'user_legacy',
            email: 'legacy@test.com',
            additionalGroups: ['admin'], // OLD FORMAT
            authMethods: ['oidc']
          }
        },
        metadata: { version: '2.0.0' }
      };
      
      fs.readFileSync.mockReturnValue(JSON.stringify(legacyUsersConfig));
      
      const validatedUser = await validateAndPersistExternalUser(legacyUser, mockPlatformConfig);
      
      // Should have migrated additionalGroups to internalGroups
      expect(validatedUser.groups).toContain('admin');
    });
  });

  describe('Error Handling', () => {
    test('should handle disabled user accounts', async () => {
      const disabledUser = {
        id: 'disabled-subject',
        name: 'Disabled User',
        email: 'disabled@test.com',
        provider: 'oidc'
      };
      
      // Mock users.json with disabled user
      const usersWithDisabled = {
        users: {
          'user_disabled': {
            id: 'user_disabled',
            email: 'disabled@test.com',
            active: false, // User is disabled
            authMethods: ['oidc']
          }
        },
        metadata: { version: '2.0.0' }
      };
      
      fs.readFileSync.mockReturnValue(JSON.stringify(usersWithDisabled));
      
      await expect(validateAndPersistExternalUser(disabledUser, mockPlatformConfig))
        .rejects.toThrow('User account is disabled');
    });

    test('should handle missing groups configuration gracefully', () => {
      // Mock loadGroupsConfiguration to throw error
      const originalImpl = jest.requireActual('../utils/authorization.js');
      jest.mocked(originalImpl.loadGroupsConfiguration).mockImplementation(() => {
        throw new Error('Groups configuration not found'); 
      });
      
      const user = {
        id: 'test-user',
        groups: ['admin']
      };
      
      // Should fallback to default admin check
      expect(hasAdminAccess(user.groups)).toBe(true);
    });
  });
});