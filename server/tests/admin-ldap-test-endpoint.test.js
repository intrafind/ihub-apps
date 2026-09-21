/**
 * Route tests for `POST /api/admin/auth/ldap/_test` (issue #2442).
 *
 * The endpoint answers the three questions an admin could previously only
 * answer by asking a user to try logging in: does the directory accept this
 * login, what does it return about the person, and which internal groups do
 * their directory groups become. These tests drive it with a stubbed LDAP
 * client and a real TCP listener standing in for the directory, and check the
 * reported steps, the mapping, and that nothing secret is echoed back.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import net from 'net';

const state = {
  /** Queue of results the stubbed authenticateResult() returns, in call order. */
  results: [],
  calls: [],
  credentials: { ldap_corp: 'bind-secret' },
  groupMapping: { 'ihub-admins': ['admins'], 'ihub-users': ['users'] }
};

const AUTH_RESULT_SUCCESS = 1;
const AUTH_RESULT_FAILURE_IDENTITY_NOT_FOUND = -1;
const AUTH_RESULT_FAILURE_CREDENTIAL_INVALID = -3;

jest.unstable_mockModule('ldap-authentication', () => ({
  AUTH_RESULT_SUCCESS,
  authenticateResult: async options => {
    state.calls.push(options);
    const next = state.results.shift();
    if (typeof next === 'function') return next(options);
    if (next instanceof Error) throw next;
    return next;
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({
      auth: { authenticatedGroup: 'authenticated' },
      ldapAuth: { enabled: true, providers: [{ ...PROVIDER, name: 'saved-corp' }] }
    })
  }
}));

jest.unstable_mockModule('../services/CredentialService.js', () => ({
  default: {
    resolveSecret: ref => {
      if (!(ref in state.credentials)) throw new Error(`Credential "${ref}" not found`);
      return state.credentials[ref];
    }
  }
}));

jest.unstable_mockModule('../utils/authorization.js', () => ({
  loadGroupMapping: () => state.groupMapping,
  mapExternalGroups: groups => {
    const mapped = new Set();
    for (const group of groups) {
      for (const internal of state.groupMapping[group] || []) mapped.add(internal);
    }
    return mapped.size > 0 ? Array.from(mapped) : ['anonymous'];
  },
  getAuthenticatedGroup: authConfig => authConfig?.authenticatedGroup || 'authenticated',
  getPermissionsForUser: groups => ({
    apps: new Set(groups.includes('admins') ? ['*'] : ['chat']),
    prompts: new Set(),
    models: new Set(),
    adminAccess: groups.includes('admins')
  })
}));

const { default: registerAdminLdapTestRoutes } = await import('../routes/admin/ldapTest.js');

let directory;
let PROVIDER;

/** A provider pointing at the local stand-in directory. */
function providerFor(port, overrides = {}) {
  return {
    name: 'corp',
    displayName: 'Corporate LDAP',
    url: `ldap://127.0.0.1:${port}`,
    baseDn: 'dc=example,dc=org',
    adminDn: 'cn=admin,dc=example,dc=org',
    adminPasswordRef: 'ldap_corp',
    defaultGroups: ['ldap-users'],
    ...overrides
  };
}

const ENTRY = {
  dn: 'uid=jdoe,ou=people,dc=example,dc=org',
  uid: 'jdoe',
  displayName: 'Jane Doe',
  mail: 'jane@example.org',
  userPassword: '{SSHA}should-never-be-echoed',
  'msDS-PrincipalName': 'CONTOSO\\jdoe',
  groups: [{ cn: 'ihub-admins' }, { cn: 'not-mapped' }]
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  registerAdminLdapTestRoutes(app);
  return app;
}

const stepById = (body, id) => body.steps.find(step => step.id === id);

beforeAll(async () => {
  // A socket that accepts connections and says nothing: enough for the
  // connectivity probe, while the LDAP conversation itself is stubbed.
  directory = net.createServer(socket => socket.on('error', () => {}));
  await new Promise(resolve => directory.listen(0, '127.0.0.1', resolve));
  PROVIDER = providerFor(directory.address().port);
});

afterAll(async () => {
  await new Promise(resolve => directory.close(resolve));
});

beforeEach(() => {
  state.results = [];
  state.calls = [];
  state.credentials = { ldap_corp: 'bind-secret' };
});

describe('POST /api/admin/auth/ldap/_test', () => {
  it('reports the derived configuration, the mapped user and the internal groups', async () => {
    state.results = [
      { code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] }, // lookup
      { code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] } // password check
    ];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'jdoe', password: 'secret' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The base DN alone produced both search bases and the DN template.
    const config = stepById(res.body, 'configuration');
    expect(config.status).toBe('ok');
    expect(config.details.values.userSearchBase).toContain('dc=example,dc=org');
    expect(config.details.values.userSearchBase).toContain('(baseDn)');
    expect(config.details.values.userDn).toContain('uid={{username}},dc=example,dc=org');

    expect(stepById(res.body, 'connectivity').status).toBe('ok');
    expect(stepById(res.body, 'directory-lookup').status).toBe('ok');
    expect(stepById(res.body, 'login').status).toBe('ok');

    // What iHub would make of the entry.
    const attributes = stepById(res.body, 'attributes');
    expect(attributes.details.mapping.id).toContain('used: uid');
    expect(attributes.details.mapping.email).toContain('used: mail');

    // ihub-admins maps to admins; not-mapped is reported, not silently dropped.
    const mapping = stepById(res.body, 'group-mapping');
    expect(mapping.status).toBe('warn');
    expect(mapping.details.unmappedLdapGroups).toEqual(['not-mapped']);
    expect(mapping.details.finalGroups).toEqual(['admins', 'ldap-users', 'authenticated']);

    expect(res.body.user).toMatchObject({
      id: 'jdoe',
      name: 'Jane Doe',
      email: 'jane@example.org',
      provider: 'corp'
    });
    expect(stepById(res.body, 'result').details.access.adminAccess).toBe(true);

    // The NetBIOS domain the iFinder `domain\username` subject needs, detected
    // from the entry because this provider configures none.
    expect(attributes.details.domain).toContain('CONTOSO');
    expect(attributes.details.domain).toContain('detected from msDS-PrincipalName');
    expect(res.body.user.domain).toBe('CONTOSO');
    // ...and the attribute it is read from is actually requested, since AD does
    // not return constructed attributes under `*`.
    expect(state.calls[0].attributes).toContain('msDS-PrincipalName');
  });

  it('reports a configured domain as configured, over what the directory says', async () => {
    state.results = [{ code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] }];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: { ...PROVIDER, domain: 'FABRIKAM' }, username: 'jdoe' });

    expect(stepById(res.body, 'attributes').details.domain).toBe('FABRIKAM  (configured)');
    expect(res.body.user.domain).toBe('FABRIKAM');
  });

  it('never echoes a password attribute back to the admin', async () => {
    state.results = [{ code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] }];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'jdoe' });

    const entry = stepById(res.body, 'attributes').details.entry;
    expect(entry.userPassword).toBe('[redacted]');
    expect(JSON.stringify(res.body)).not.toContain('should-never-be-echoed');
    expect(JSON.stringify(res.body)).not.toContain('bind-secret');
  });

  it('inspects a user without a password and says the password check was skipped', async () => {
    state.results = [{ code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] }];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'jdoe' });

    expect(res.body.success).toBe(true);
    expect(stepById(res.body, 'login').status).toBe('skip');
    expect(res.body.message).toMatch(/Supply a password/);
    // Only the lookup ran, and it needed no user password.
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].verifyUserExists).toBe(true);
    expect(state.calls[0].userPassword).toBeUndefined();
  });

  it('separates a rejected password from a user that cannot be found', async () => {
    state.results = [
      { code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] },
      {
        code: AUTH_RESULT_FAILURE_CREDENTIAL_INVALID,
        user: null,
        messages: ['Invalid credentials']
      }
    ];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'jdoe', password: 'wrong' });

    expect(res.body.success).toBe(false);
    expect(stepById(res.body, 'directory-lookup').status).toBe('ok');
    const login = stepById(res.body, 'login');
    expect(login.status).toBe('fail');
    expect(login.hints.join(' ')).toMatch(/password itself being rejected/);
  });

  it('stops at the lookup when the directory has no such user', async () => {
    state.results = [
      { code: AUTH_RESULT_FAILURE_IDENTITY_NOT_FOUND, user: null, messages: ['not found'] }
    ];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'ghost', password: 'secret' });

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/could not be found/);
    expect(stepById(res.body, 'directory-lookup').status).toBe('fail');
    expect(stepById(res.body, 'login')).toBeUndefined();
  });

  it('reports an incomplete configuration instead of dialling out', async () => {
    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: { name: 'broken' }, username: 'jdoe' });

    expect(res.body.success).toBe(false);
    expect(stepById(res.body, 'configuration').status).toBe('fail');
    expect(res.body.steps).toHaveLength(1);
    expect(state.calls).toHaveLength(0);
  });

  it('reports an unresolvable bind credential as a configuration problem', async () => {
    state.credentials = {};

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER, username: 'jdoe', password: 'secret' });

    expect(res.body.success).toBe(false);
    expect(stepById(res.body, 'bind-credential').status).toBe('fail');
    expect(state.calls).toHaveLength(0);
  });

  it('reports an unreachable directory as a connection failure', async () => {
    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({
        // Port 1 on loopback: nothing listens there.
        provider: providerFor(1),
        username: 'jdoe',
        password: 'secret'
      });

    expect(res.body.success).toBe(false);
    expect(stepById(res.body, 'connectivity').status).toBe('fail');
    expect(state.calls).toHaveLength(0);
  });

  it('rejects a URL that is not an LDAP URL', async () => {
    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: providerFor(0, { url: 'https://ldap.example.com' }), username: 'jdoe' });

    expect(res.body.success).toBe(false);
    expect(stepById(res.body, 'connectivity').message).toMatch(/Unsupported protocol/);
  });

  it('tests a saved provider by name', async () => {
    state.results = [{ code: AUTH_RESULT_SUCCESS, user: ENTRY, messages: ['ok'] }];

    const res = await request(createTestApp())
      .post('/api/admin/auth/ldap/_test')
      .send({ providerName: 'saved-corp', username: 'jdoe' });

    expect(res.body.success).toBe(true);
    expect(res.body.user.provider).toBe('saved-corp');
  });

  it('refuses a request without a username or a provider', async () => {
    const app = createTestApp();

    const noUsername = await request(app)
      .post('/api/admin/auth/ldap/_test')
      .send({ provider: PROVIDER });
    expect(noUsername.status).toBe(400);

    const noProvider = await request(app)
      .post('/api/admin/auth/ldap/_test')
      .send({ username: 'jdoe' });
    expect(noProvider.status).toBe(400);

    const unknownProvider = await request(app)
      .post('/api/admin/auth/ldap/_test')
      .send({ username: 'jdoe', providerName: 'nope' });
    expect(unknownProvider.status).toBe(400);
  });
});
