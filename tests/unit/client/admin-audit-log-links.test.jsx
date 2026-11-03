/**
 * Audit log rows link to what they are about: the resource an entry names and
 * the user who acted. These are the pure route builders behind those links.
 */
import { describe, it, expect } from '@jest/globals';
import {
  getAuditActorLink,
  getAuditResourceLink
} from '../../../client/src/features/admin/utils/auditLinks';

describe('getAuditResourceLink', () => {
  it('links explicit (singular) and middleware (plural) resource names to the same page', () => {
    expect(getAuditResourceLink({ resource: 'app', resourceId: 'web-chat' })).toBe(
      '/admin/apps/web-chat'
    );
    expect(getAuditResourceLink({ resource: 'apps', resourceId: 'web-chat' })).toBe(
      '/admin/apps/web-chat'
    );
  });

  it('links users to their view page', () => {
    expect(getAuditResourceLink({ resource: 'user', resourceId: 'user_1' })).toBe(
      '/admin/users/user_1/view'
    );
  });

  it('encodes ids into a single path segment', () => {
    expect(getAuditResourceLink({ resource: 'model', resourceId: 'a/b c' })).toBe(
      '/admin/models/a%2Fb%20c'
    );
  });

  it('base64url-encodes CIMD client ids, which are URLs', () => {
    const link = getAuditResourceLink({
      resource: 'oauthCimdClient',
      resourceId: 'https://client.example/meta.json'
    });
    expect(link).toMatch(/^\/admin\/oauth\/clients\/cimd\/[A-Za-z0-9_-]+$/);
  });

  it('links resource types without a detail page to their list page', () => {
    expect(
      getAuditResourceLink({ resource: 'marketplaceRegistryCatalog', resourceId: 'ihub-official' })
    ).toBe('/admin/marketplace/registries');
  });

  it('does not link unknown types, missing or multi-valued ids, or deletes', () => {
    expect(getAuditResourceLink({ resource: 'exports', resourceId: 'pdf' })).toBeNull();
    expect(getAuditResourceLink({ resource: 'app', resourceId: '' })).toBeNull();
    expect(getAuditResourceLink({ resource: 'project', resourceId: 'p1,p2' })).toBeNull();
    expect(
      getAuditResourceLink({ resource: 'app', resourceId: 'web-chat', action: 'delete' })
    ).toBeNull();
  });
});

describe('getAuditActorLink', () => {
  it('links an authenticated user to their user page', () => {
    expect(getAuditActorLink({ actor: { id: 'user_abc', authenticated: true } })).toBe(
      '/admin/users/user_abc/view'
    );
  });

  it('does not link anonymous, system, OAuth client, CLI or failed-login actors', () => {
    expect(getAuditActorLink({ actor: { id: 'anonymous', authenticated: false } })).toBeNull();
    expect(getAuditActorLink({ actor: { id: 'system', authenticated: true } })).toBeNull();
    expect(getAuditActorLink({ actor: { id: 'client_x_1', authenticated: true } })).toBeNull();
    expect(getAuditActorLink({ actor: { id: 'cli:root', authenticated: true } })).toBeNull();
    expect(
      getAuditActorLink({
        action: 'login',
        result: 'failure',
        actor: { id: 'someone', authenticated: true }
      })
    ).toBeNull();
    expect(getAuditActorLink({ admin: 'old-admin' })).toBeNull();
  });
});
