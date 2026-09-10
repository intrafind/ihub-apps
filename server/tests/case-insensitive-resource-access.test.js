/**
 * Regression tests for https://github.com/intrafind/ihub-apps/issues/2327:
 * model/app/prompt/workflow ids supplied by external callers (e.g. the
 * OpenAI-compatible inference API) must resolve and pass permission checks
 * regardless of casing.
 *
 * Runs under the server's own native-ESM jest (see the `test:auth-routes` npm
 * script, which `test:quick` — and therefore CI — chains in). It cannot live
 * under tests/unit/server/: the root jest config transforms `.js` to CJS, and
 * middleware/authRequired.js reaches utils/authorization.js, which uses
 * `import.meta.url`.
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  filterResourcesByPermissions,
  canUserAccessResource,
  intersectWithClientAllowList
} from '../utils/authorization.js';
import { appAccessRequired, modelAccessRequired } from '../middleware/authRequired.js';

describe('filterResourcesByPermissions (case-insensitive)', () => {
  it('matches a resource whose id differs only in case from the permission list', () => {
    const resources = [{ id: 'Translator' }, { id: 'summarizer' }];
    const allowed = new Set(['translator']);
    expect(filterResourcesByPermissions(resources, allowed)).toEqual([{ id: 'Translator' }]);
  });

  it('still honors the wildcard', () => {
    const resources = [{ id: 'a' }, { id: 'b' }];
    expect(filterResourcesByPermissions(resources, new Set(['*']))).toEqual(resources);
  });
});

describe('canUserAccessResource (case-insensitive)', () => {
  it('allows access when only casing differs', () => {
    const user = { permissions: { apps: new Set(['translator']) } };
    expect(canUserAccessResource(user, 'apps', 'Translator')).toBe(true);
  });

  it('denies access for an unrelated id', () => {
    const user = { permissions: { apps: new Set(['translator']) } };
    expect(canUserAccessResource(user, 'apps', 'summarizer')).toBe(false);
  });
});

describe('intersectWithClientAllowList (case-insensitive)', () => {
  it('keeps a user-permitted id whose case differs from the client allow-list entry', () => {
    const result = intersectWithClientAllowList(new Set(['gpt-4o']), ['GPT-4O']);
    expect(result.has('gpt-4o')).toBe(true);
  });
});

function createMockReqRes(user, params) {
  const req = { user, params };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
  return { req, res };
}

describe('appAccessRequired / modelAccessRequired (case-insensitive gate)', () => {
  it('allows a request whose app id differs in case from the granted permission', () => {
    const { req, res } = createMockReqRes(
      { id: 'u1', permissions: { apps: new Set(['translator']) } },
      { appId: 'Translator' }
    );
    const next = jest.fn();
    appAccessRequired(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('allows an inference-API-style request whose model id differs in case', () => {
    const { req, res } = createMockReqRes(
      { id: 'u1', permissions: { models: new Set(['gpt-4o']) } },
      { modelId: 'GPT-4O' }
    );
    const next = jest.fn();
    modelAccessRequired(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('still denies access to a genuinely different model id', () => {
    const { req, res } = createMockReqRes(
      { id: 'u1', permissions: { models: new Set(['gpt-4o']) } },
      { modelId: 'claude-sonnet' }
    );
    const next = jest.fn();
    modelAccessRequired(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
