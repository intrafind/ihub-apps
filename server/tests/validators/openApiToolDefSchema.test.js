import { describe, it, expect } from '@jest/globals';
import {
  validateOpenApiToolDef,
  openApiToolDefSchema
} from '../../validators/openApiToolDefSchema.js';

const base = {
  id: 'github_listRepos',
  name: { en: 'List repos' },
  type: 'openapi',
  openapi: {
    source: { type: 'url', url: 'https://api.example.com/openapi.json' },
    operationId: 'repos/list',
    auth: { credentialRef: 'githubOAuth' }
  }
};

describe('openApiToolDefSchema', () => {
  it('accepts a valid url-source definition and applies defaults', () => {
    const result = validateOpenApiToolDef(base);
    expect(result.success).toBe(true);
    expect(result.data.openapi.maxResponseBytes).toBe(262144);
    expect(result.data.openapi.timeoutMs).toBe(30000);
    expect(result.data.openapi.security.blockPrivateIps).toBe(true);
    expect(result.data.openapi.xDisplay.hideFields).toEqual([]);
    expect(result.data.enabled).toBe(true);
  });

  it('accepts inline and file sources', () => {
    expect(
      validateOpenApiToolDef({
        ...base,
        openapi: { ...base.openapi, source: { type: 'inline', spec: '{"openapi":"3.0.0"}' } }
      }).success
    ).toBe(true);
    expect(
      validateOpenApiToolDef({
        ...base,
        openapi: { ...base.openapi, source: { type: 'file', path: 'specs/github.json' } }
      }).success
    ).toBe(true);
  });

  it('requires a credentialRef (no inline auth)', () => {
    const result = validateOpenApiToolDef({
      ...base,
      openapi: { ...base.openapi, auth: { type: 'bearer', token: 'x' } }
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown source type', () => {
    const result = validateOpenApiToolDef({
      ...base,
      openapi: { ...base.openapi, source: { type: 'ftp', url: 'ftp://x' } }
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing operationId', () => {
    const bad = { ...base, openapi: { ...base.openapi } };
    delete bad.openapi.operationId;
    expect(validateOpenApiToolDef(bad).success).toBe(false);
  });

  it('rejects an invalid id', () => {
    expect(validateOpenApiToolDef({ ...base, id: 'has spaces' }).success).toBe(false);
  });

  it('clamps maxResponseBytes within bounds', () => {
    expect(
      openApiToolDefSchema.safeParse({
        ...base,
        openapi: { ...base.openapi, maxResponseBytes: 100 }
      }).success
    ).toBe(false);
  });
});
