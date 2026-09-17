/**
 * Regression tests for NTLM user.domain extraction.
 *
 * Bug: express-ntlm exposes the authenticated identity as
 *   { DomainName, UserName, Workstation, Authenticated }
 * but `processNtlmUser` only consulted `ntlmUser.domain` / `ntlmUser.Domain`.
 * Result: `user.domain` was always undefined, which made the standard
 * `"domain\\username"` JWT subject template fall back to bare username
 * (and `${user.domain}` placeholders resolve to empty).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processNtlmUser } from '../middleware/ntlmAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const groupsConfigPath = path.join(__dirname, '../../contents/config/groups.json');

// processNtlmUser calls mapExternalGroups, which loads
// contents/config/groups.json from disk. Ensure a minimal fixture exists for
// the test process and tear it down afterwards. If the file already exists
// (full dev environment), leave it alone.
let createdGroupsFixture = false;
let createdContentsConfig = false;
let createdContents = false;

before(() => {
  const contentsConfigDir = path.dirname(groupsConfigPath);
  const contentsDir = path.dirname(contentsConfigDir);
  if (!fs.existsSync(contentsDir)) {
    fs.mkdirSync(contentsDir);
    createdContents = true;
  }
  if (!fs.existsSync(contentsConfigDir)) {
    fs.mkdirSync(contentsConfigDir);
    createdContentsConfig = true;
  }
  if (!fs.existsSync(groupsConfigPath)) {
    fs.writeFileSync(
      groupsConfigPath,
      JSON.stringify({
        groups: {
          anonymous: { id: 'anonymous', name: 'Anonymous', permissions: {} },
          authenticated: {
            id: 'authenticated',
            name: 'Authenticated',
            inherits: ['anonymous'],
            permissions: {}
          }
        }
      })
    );
    createdGroupsFixture = true;
  }
});

after(() => {
  if (createdGroupsFixture) fs.rmSync(groupsConfigPath, { force: true });
  if (createdContentsConfig)
    fs.rmSync(path.dirname(groupsConfigPath), { force: true, recursive: true });
  if (createdContents)
    fs.rmSync(path.dirname(path.dirname(groupsConfigPath)), { force: true, recursive: true });
});

function makeReq(ntlm) {
  return { ntlm };
}

describe('processNtlmUser — domain extraction', () => {
  it('reads domain from ntlmUser.DomainName (express-ntlm shape)', () => {
    const user = processNtlmUser(
      makeReq({
        Authenticated: true,
        UserName: 'kozuch',
        DomainName: 'BMG',
        Workstation: 'BN-IFINDIDX-01'
      }),
      { name: 'ntlm' }
    );
    assert.equal(user.username, 'kozuch');
    assert.equal(user.domain, 'BMG');
  });

  it('keeps user.id stable as the bare userId (backward compat)', () => {
    // Existing users.json rows from before the DomainName fix have
    // `username = "kozuch"` (the old externalUser.id). user.id must keep
    // matching that lookup key, otherwise every NTLM user re-appears as a
    // brand new account on next login.
    const user = processNtlmUser(
      makeReq({ Authenticated: true, UserName: 'kozuch', DomainName: 'BMG' }),
      { name: 'ntlm' }
    );
    assert.equal(user.id, 'kozuch');
    assert.notEqual(user.id, 'BMG\\kozuch');
  });

  it('still accepts lowercase ntlmUser.domain when set by custom middleware', () => {
    const user = processNtlmUser(
      makeReq({ Authenticated: true, UserName: 'kozuch', domain: 'CUSTOM' }),
      { name: 'ntlm' }
    );
    assert.equal(user.domain, 'CUSTOM');
  });

  it('prefers ntlmUser.domain > Domain > DomainName when multiple are set', () => {
    // Defines a fallback order matching the source code so the
    // precedence is pinned by a test.
    const user = processNtlmUser(
      makeReq({
        Authenticated: true,
        UserName: 'kozuch',
        domain: 'A',
        Domain: 'B',
        DomainName: 'C'
      }),
      { name: 'ntlm' }
    );
    assert.equal(user.domain, 'A');
  });

  it('leaves user.domain undefined when NTLM data has no domain at all', () => {
    const user = processNtlmUser(makeReq({ Authenticated: true, UserName: 'kozuch' }), {
      name: 'ntlm'
    });
    assert.equal(user.domain, undefined);
    assert.equal(user.id, 'kozuch');
  });

  it('falls back to userId for name when no DisplayName is provided', () => {
    // Previously fell back to `fullUsername` (= "BMG\\kozuch"). The fix
    // uses just `userId` so the `name` claim in the JWT stays the
    // human-readable display (matches what admins see today).
    const user = processNtlmUser(
      makeReq({ Authenticated: true, UserName: 'kozuch', DomainName: 'BMG' }),
      { name: 'ntlm' }
    );
    assert.equal(user.name, 'kozuch');
  });

  it('returns null when req.ntlm is missing', () => {
    const user = processNtlmUser({}, { name: 'ntlm' });
    assert.equal(user, null);
  });

  it('returns null when NTLM handshake did not authenticate', () => {
    const user = processNtlmUser(
      makeReq({ Authenticated: false, UserName: 'kozuch', DomainName: 'BMG' }),
      { name: 'ntlm' }
    );
    assert.equal(user, null);
  });
});

describe('processNtlmUser — feeds JWT subject template correctly', () => {
  // Lightweight replica of `resolveJwtSubject` for the standard
  // `domain\\username` value, just enough to prove the user object
  // produced by `processNtlmUser` resolves the way an admin expects.
  function resolveDomainBackslashUsername(user) {
    return user.domain ? `${user.domain}\\${user.username || user.id}` : user.username || user.id;
  }

  it('domain\\username yields BMG\\kozuch when DomainName=BMG', () => {
    const user = processNtlmUser(
      makeReq({ Authenticated: true, UserName: 'kozuch', DomainName: 'BMG' }),
      { name: 'ntlm' }
    );
    assert.equal(resolveDomainBackslashUsername(user), 'BMG\\kozuch');
  });

  it('domain\\username falls back to bare username when domain missing', () => {
    const user = processNtlmUser(makeReq({ Authenticated: true, UserName: 'kozuch' }), {
      name: 'ntlm'
    });
    assert.equal(resolveDomainBackslashUsername(user), 'kozuch');
  });
});
