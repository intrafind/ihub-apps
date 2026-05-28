/**
 * Regression tests for the iFinder JWT subject env-var leak.
 *
 * Bug (pre-V043 / pre-skip-list): configCache's `resolveEnvVars` matched
 * `${field}` placeholders in `iFinder.jwtSubjectField` against process.env.
 * On Windows `process.env.username` is set to the OS user running the
 * server, so a template like `BMG\${username}` was rewritten to
 * `BMG\<service-account>` at config-load time. Every iFinder JWT then
 * carried the service account in its `sub` claim, regardless of the
 * authenticated user.
 *
 * These tests pin three guarantees:
 *   1. configCache does not env-resolve `iFinder.jwtSubjectField` even
 *      when a same-named env var exists.
 *   2. iFinderJwt's template regex matches both `${field}` (legacy) and
 *      `${user.field}` (preferred) syntaxes, and the legacy detector
 *      flags only the unprefixed form.
 *   3. The V043 migration converts `${field}` to `${user.field}` in
 *      existing platform.json files.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvVarsInObject } from '../configCache.js';
import { up as migrationUp } from '../migrations/V043__fix_ifinder_jwt_subject_template.js';

describe('iFinder JWT subject — env var resolution skip', () => {
  // configCache passes this skipPaths list when caching the platform config.
  // Tests reproduce that contract directly so we exercise the resolver the
  // same way `setCacheEntry` does.
  const platformSkipPaths = ['iFinder.jwtSubjectField'];

  let originalUsername;

  before(() => {
    originalUsername = process.env.username;
    process.env.username = 'svc_ifinder-indexer';
  });

  after(() => {
    if (originalUsername === undefined) {
      delete process.env.username;
    } else {
      process.env.username = originalUsername;
    }
  });

  it('preserves iFinder.jwtSubjectField when caller skips it and env var is set', () => {
    const platform = {
      iFinder: { jwtSubjectField: 'BMG\\${username}', baseUrl: 'https://x/' }
    };
    const resolved = resolveEnvVarsInObject(platform, { skipPaths: platformSkipPaths });
    assert.equal(resolved.iFinder.jwtSubjectField, 'BMG\\${username}');
  });

  it('preserves ${user.field} verbatim regardless of skip list', () => {
    const platform = { iFinder: { jwtSubjectField: 'BMG\\${user.username}' } };
    const resolved = resolveEnvVarsInObject(platform, { skipPaths: platformSkipPaths });
    assert.equal(resolved.iFinder.jwtSubjectField, 'BMG\\${user.username}');
  });

  it('still resolves env vars on sibling iFinder.* fields', () => {
    process.env.MY_TEST_VAR = 'replaced';
    try {
      const platform = {
        iFinder: {
          jwtSubjectField: 'BMG\\${username}',
          baseUrl: 'https://${MY_TEST_VAR}/'
        }
      };
      const resolved = resolveEnvVarsInObject(platform, { skipPaths: platformSkipPaths });
      assert.equal(resolved.iFinder.jwtSubjectField, 'BMG\\${username}');
      assert.equal(resolved.iFinder.baseUrl, 'https://replaced/');
    } finally {
      delete process.env.MY_TEST_VAR;
    }
  });

  it('still resolves env vars at unrelated config paths (no regression)', () => {
    process.env.MY_TEST_VAR = 'replaced';
    try {
      const platform = {
        iFinder: { jwtSubjectField: 'BMG\\${username}' },
        elsewhere: '${MY_TEST_VAR}'
      };
      const resolved = resolveEnvVarsInObject(platform, { skipPaths: platformSkipPaths });
      assert.equal(resolved.elsewhere, 'replaced');
    } finally {
      delete process.env.MY_TEST_VAR;
    }
  });

  it('without skipPaths the field IS env-resolved (proves the bug returns if caller forgets)', () => {
    const platform = { iFinder: { jwtSubjectField: 'BMG\\${username}' } };
    const resolved = resolveEnvVarsInObject(platform);
    assert.equal(resolved.iFinder.jwtSubjectField, 'BMG\\svc_ifinder-indexer');
  });

  it('accepts skipPaths as a Set', () => {
    const platform = { iFinder: { jwtSubjectField: 'BMG\\${username}' } };
    const resolved = resolveEnvVarsInObject(platform, {
      skipPaths: new Set(['iFinder.jwtSubjectField'])
    });
    assert.equal(resolved.iFinder.jwtSubjectField, 'BMG\\${username}');
  });
});

describe('iFinder JWT subject — template regex pin', () => {
  // These regexes are intentionally duplicated from `resolveJwtSubject` in
  // iFinderJwt.js. They are the part of the contract that callers (admins
  // writing templates) depend on — if you change the regex, update both
  // sites AND bump V043 (or add a new migration) to convert existing configs.

  const TEMPLATE_RE = /\$\{(?:user\.)?(\w+)\}/g;
  const LEGACY_DETECT_RE = /\$\{(?!user\.)\w+\}/;

  it('captures field name from ${user.field}', () => {
    const m = [...'BMG\\${user.username}'.matchAll(TEMPLATE_RE)];
    assert.equal(m.length, 1);
    assert.equal(m[0][1], 'username');
  });

  it('captures field name from ${field} (legacy)', () => {
    const m = [...'BMG\\${username}'.matchAll(TEMPLATE_RE)];
    assert.equal(m.length, 1);
    assert.equal(m[0][1], 'username');
  });

  it('detects legacy placeholders but not modern ones', () => {
    assert.equal(LEGACY_DETECT_RE.test('BMG\\${username}'), true);
    assert.equal(LEGACY_DETECT_RE.test('BMG\\${user.username}'), false);
    assert.equal(LEGACY_DETECT_RE.test('plain-string'), false);
  });

  it('handles multiple placeholders in one template', () => {
    const m = [...'${domain}\\${user.username}'.matchAll(TEMPLATE_RE)];
    assert.equal(m.length, 2);
    assert.equal(m[0][1], 'domain');
    assert.equal(m[1][1], 'username');
  });
});

describe('V043 migration', () => {
  function makeCtx(initialPlatform) {
    let platform = JSON.parse(JSON.stringify(initialPlatform));
    const logs = [];
    return {
      _platform: () => platform,
      logs,
      async readJson() {
        return platform;
      },
      async writeJson(_path, data) {
        platform = data;
      },
      async fileExists() {
        return true;
      },
      log(msg) {
        logs.push(['log', msg]);
      },
      warn(msg) {
        logs.push(['warn', msg]);
      }
    };
  }

  it('rewrites BMG\\${username} to BMG\\${user.username}', async () => {
    const ctx = makeCtx({ iFinder: { jwtSubjectField: 'BMG\\${username}' } });
    await migrationUp(ctx);
    assert.equal(ctx._platform().iFinder.jwtSubjectField, 'BMG\\${user.username}');
    assert.ok(ctx.logs.some(([lvl]) => lvl === 'warn'));
  });

  it('rewrites all legacy placeholders in one pass', async () => {
    const ctx = makeCtx({ iFinder: { jwtSubjectField: '${domain}\\${username}' } });
    await migrationUp(ctx);
    assert.equal(ctx._platform().iFinder.jwtSubjectField, '${user.domain}\\${user.username}');
  });

  it('does not touch already-safe ${user.field} templates', async () => {
    const ctx = makeCtx({ iFinder: { jwtSubjectField: 'BMG\\${user.username}' } });
    await migrationUp(ctx);
    assert.equal(ctx._platform().iFinder.jwtSubjectField, 'BMG\\${user.username}');
    assert.ok(!ctx.logs.some(([lvl]) => lvl === 'warn'));
  });

  it('leaves standard values untouched', async () => {
    for (const std of ['email', 'username', 'domain\\username']) {
      const ctx = makeCtx({ iFinder: { jwtSubjectField: std } });
      await migrationUp(ctx);
      assert.equal(ctx._platform().iFinder.jwtSubjectField, std);
    }
  });

  it('is a no-op when iFinder.jwtSubjectField is missing', async () => {
    const ctx = makeCtx({ iFinder: { baseUrl: 'https://x/' } });
    await migrationUp(ctx);
    assert.equal(ctx._platform().iFinder.jwtSubjectField, undefined);
  });

  it('is a no-op when iFinder section is missing', async () => {
    const ctx = makeCtx({});
    await migrationUp(ctx);
    assert.deepEqual(ctx._platform(), {});
  });
});
