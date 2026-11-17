// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { supportedAuthModesOf } from '../../services/integrations/protocols/index.js';

/**
 * The sign-in modes the install form offers (IN-B5, review R8). A native or
 * script connector is offered the modes it declares that iHub has a flow for:
 * `oauth-user` only for Jira and the storage providers, which iHub signs each
 * user into, and never `oauth-client`, for which iHub obtains no token.
 */

const definition = (id, type, modes) => ({
  id,
  protocol: { type, module: 'x' },
  auth: { modes }
});

describe('supportedAuthModesOf', () => {
  test.each([
    'com.intrafind/jira',
    'com.intrafind/office365',
    'com.intrafind/google-drive',
    'com.intrafind/nextcloud'
  ])('%s is offered oauth-user: iHub signs each user in', id => {
    expect(supportedAuthModesOf(definition(id, 'native', ['oauth-user']))).toEqual(['oauth-user']);
  });

  test('a script connector is not offered oauth-user or oauth-client', () => {
    const modes = ['none', 'service-account', 'oauth-client', 'oauth-user'];
    expect(supportedAuthModesOf(definition('org.example/crm', 'script', modes))).toEqual([
      'none',
      'service-account'
    ]);
  });

  test('a third-party native connector is not offered oauth-user either', () => {
    expect(
      supportedAuthModesOf(definition('org.example/tracker', 'native', ['none', 'oauth-user']))
    ).toEqual(['none']);
  });

  test('adapters with their own list and the OpenAPI default are unchanged', () => {
    expect(supportedAuthModesOf(definition('org.example/mcp', 'mcp', ['oauth-user']))).toContain(
      'oauth-user'
    );
    expect(supportedAuthModesOf(definition('org.example/api', 'openapi', ['oauth-user']))).toEqual([
      'none',
      'service-account'
    ]);
  });
});
