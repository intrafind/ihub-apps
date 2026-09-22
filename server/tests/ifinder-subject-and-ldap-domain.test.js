#!/usr/bin/env node

/**
 * Specs for strict iFinder JWT subject resolution and LDAP domain detection.
 *
 * Background: `resolveJwtSubject` used to fall through to whatever the user
 * happened to have — `email` down to username down to id, and
 * `domain\username` all the way down to a bare account name when no domain was
 * set. That never raised. It signed a perfectly valid token identifying a
 * *different* principal than the configured setting named, and iFinder keyed
 * its user mapping on it. The failure was invisible on both sides.
 *
 * LDAP had no way to supply a domain at all: `ntlmAuth` takes one from the
 * handshake, but the LDAP provider schema had no equivalent field and nothing
 * read one from the directory, so `domain\username` could not work for an LDAP
 * user however it was configured.
 *
 * These specs pin both halves: the subject resolver refuses rather than
 * substitutes, and an LDAP user can actually carry a domain.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveJwtSubject } from '../utils/iFinderJwt.js';
import { parsePrincipalName, resolveLdapDomain } from '../middleware/ldapAuth.js';

/** An LDAP user as `buildTestUser`/`req.user` present them. */
function user(overrides = {}) {
  return {
    id: 'user_a85086a4',
    username: 'leipolda',
    email: 'Andreas.Leipold@bmas.bund.de',
    name: 'Leipold, Andreas',
    ...overrides
  };
}

describe('resolveJwtSubject — standard fields', () => {
  it('uses the configured field', () => {
    assert.equal(
      resolveJwtSubject(user(), { jwtSubjectField: 'email' }),
      'Andreas.Leipold@bmas.bund.de'
    );
    assert.equal(resolveJwtSubject(user(), { jwtSubjectField: 'username' }), 'leipolda');
  });

  it('defaults to email when nothing is configured', () => {
    assert.equal(resolveJwtSubject(user(), {}), 'Andreas.Leipold@bmas.bund.de');
  });

  it('refuses to substitute the username when email is configured but absent', () => {
    assert.throws(
      () => resolveJwtSubject(user({ email: null }), { jwtSubjectField: 'email' }),
      /has no email address/
    );
  });

  it('refuses to substitute the email when username is configured but absent', () => {
    assert.throws(
      () => resolveJwtSubject(user({ username: '' }), { jwtSubjectField: 'username' }),
      /has no username/
    );
  });

  it('treats a blank value as absent', () => {
    assert.throws(
      () => resolveJwtSubject(user({ username: '   ' }), { jwtSubjectField: 'username' }),
      /has no username/
    );
  });
});

describe('resolveJwtSubject — domain\\username', () => {
  it('joins the domain and the username', () => {
    assert.equal(
      resolveJwtSubject(user({ domain: 'ROCHUS' }), { jwtSubjectField: 'domain\\username' }),
      'ROCHUS\\leipolda'
    );
  });

  it('refuses to emit a bare account name when no domain is known', () => {
    // The regression that made this whole change necessary: the token used to
    // go out as "leipolda" under a setting that says domain\username.
    assert.throws(
      () => resolveJwtSubject(user(), { jwtSubjectField: 'domain\\username' }),
      /has no NetBIOS domain/
    );
  });

  it('names both gaps when the user has neither', () => {
    assert.throws(
      () =>
        resolveJwtSubject(user({ domain: null, username: null }), {
          jwtSubjectField: 'domain\\username'
        }),
      /has no NetBIOS domain and username/
    );
  });

  it('points at the setting that supplies the missing domain', () => {
    assert.throws(
      () => resolveJwtSubject(user(), { jwtSubjectField: 'domain\\username' }),
      /"Domain" field on the provider/
    );
  });
});

describe('resolveJwtSubject — templates', () => {
  it('resolves ${user.field} placeholders', () => {
    assert.equal(
      resolveJwtSubject(user(), { jwtSubjectField: 'ROCHUS\\${user.username}' }),
      'ROCHUS\\leipolda'
    );
  });

  it('still resolves the legacy ${field} form', () => {
    assert.equal(
      resolveJwtSubject(user(), { jwtSubjectField: 'ROCHUS\\${username}' }),
      'ROCHUS\\leipolda'
    );
  });

  it('refuses to sign a subject with a hole in it', () => {
    // Previously this produced "ROCHUS\" plus a log line nobody reads.
    assert.throws(
      () =>
        resolveJwtSubject(user({ username: null }), {
          jwtSubjectField: 'ROCHUS\\${user.username}'
        }),
      /has no user\.username/
    );
  });

  it('names every unresolved placeholder', () => {
    assert.throws(
      () =>
        resolveJwtSubject(user({ username: null, domain: null }), {
          jwtSubjectField: '${user.domain}\\${user.username}'
        }),
      /user\.domain and user\.username/
    );
  });
});

describe('parsePrincipalName', () => {
  it('splits DOMAIN\\account', () => {
    assert.deepEqual(parsePrincipalName('ROCHUS\\leipolda'), {
      domain: 'ROCHUS',
      account: 'leipolda'
    });
  });

  it('accepts the single-element array form LDAP servers may return', () => {
    assert.deepEqual(parsePrincipalName(['ROCHUS\\leipolda']), {
      domain: 'ROCHUS',
      account: 'leipolda'
    });
  });

  it('reports no domain for a bare account name', () => {
    assert.deepEqual(parsePrincipalName('leipolda'), { domain: null, account: 'leipolda' });
  });

  it('reports nothing for a missing attribute', () => {
    // OpenLDAP has no msDS-PrincipalName, and AD omits it when the bind
    // account cannot read it.
    assert.deepEqual(parsePrincipalName(undefined), { domain: null, account: null });
    assert.deepEqual(parsePrincipalName(''), { domain: null, account: null });
  });

  it('does not treat a trailing separator as a domain', () => {
    assert.deepEqual(parsePrincipalName('ROCHUS\\'), { domain: null, account: 'ROCHUS\\' });
  });
});

describe('resolveLdapDomain', () => {
  const principal = { 'msDS-PrincipalName': 'ROCHUS\\leipolda' };

  it('detects the domain from msDS-PrincipalName', () => {
    assert.equal(resolveLdapDomain(principal, {}, 'leipolda'), 'ROCHUS');
  });

  it('prefers the configured domain over the directory', () => {
    // An admin who typed a domain has stated what iFinder expects to see.
    assert.equal(resolveLdapDomain(principal, { domain: 'CONTOSO' }, 'leipolda'), 'CONTOSO');
  });

  it('ignores a blank configured domain', () => {
    assert.equal(resolveLdapDomain(principal, { domain: '  ' }, 'leipolda'), 'ROCHUS');
  });

  it('returns null when neither source has one', () => {
    // OpenLDAP with nothing configured — the subject resolver then reports it
    // rather than emitting a bare account name.
    assert.equal(resolveLdapDomain({}, {}, 'jdoe'), null);
  });
});
