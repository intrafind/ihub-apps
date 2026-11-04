/**
 * Release notes and docs link to each other with repository-relative `*.md` paths. In the admin UI
 * they must point to What's New (release notes) or Admin → Documentation (everything else);
 * resolved against the page URL they broke (`https://host/integrations.md#…`).
 */
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/ihub/api/${p}`,
  buildPath: p => `/ihub${p}`
}));
import {
  docsLinkTarget,
  repositoryLinkTarget,
  resolveDocsReference,
  rewriteDocsHtml
} from '../../../client/src/features/admin/utils/docsLinks';

describe('resolveDocsReference', () => {
  test.each([
    ['../../integrations.md', 'releases/5.6.4/features.md', 'integrations.md'],
    ['breaking-changes.md', 'releases/next/features.md', 'releases/next/breaking-changes.md'],
    ['./models.md', 'apps.md', 'models.md'],
    ['../tool-calling.md', 'releases/5.6.4/features.md', 'releases/tool-calling.md'],
    ['../../../outside.md', 'releases/5.6.4/features.md', null],
    ['/abs.md', 'apps.md', null],
    ['https://example.com/a.md', 'apps.md', null]
  ])('%s from %s → %s', (reference, source, expected) => {
    expect(resolveDocsReference(reference, source)).toBe(expected);
  });
});

describe('docsLinkTarget', () => {
  test('a release-notes link to a doc opens the documentation page at the heading', () => {
    expect(
      docsLinkTarget(
        '../../integrations.md#version-compatibility-and-release-notes',
        'releases/next/features.md'
      )
    ).toBe('/admin/docs/integrations.md#version-compatibility-and-release-notes');
  });

  test("a link to release notes stays in What's New", () => {
    expect(
      docsLinkTarget('breaking-changes.md#configtoolsjson-is-removed', 'releases/5.6.4/features.md')
    ).toBe('/admin/changelog?version=5.6.4#configtoolsjson-is-removed');
  });

  test.each(['#local', 'https://example.com', 'mailto:a@b.c', 'image.png', ''])(
    'leaves %s alone',
    href => {
      expect(docsLinkTarget(href, 'apps.md')).toBeNull();
    }
  );
});

describe('repositoryLinkTarget', () => {
  test('a link that leaves docs/ opens the file on GitHub', () => {
    expect(repositoryLinkTarget('../docker/DOCKER.md#ports', 'INSTALLATION.md')).toBe(
      'https://github.com/intrafind/ihub-apps/blob/main/docker/DOCKER.md#ports'
    );
  });

  test.each(['models.md', '#x', 'https://e.com', '../../../../escape.md'])(
    'leaves %s alone',
    href => {
      expect(repositoryLinkTarget(href, 'apps.md')).toBeNull();
    }
  );
});

describe('rewriteDocsHtml', () => {
  test('rewrites links and asset images, adds mdBook heading ids', () => {
    const html = rewriteDocsHtml(
      '<h2>Version compatibility and release notes</h2><h2>Setup</h2><h2>Setup</h2>' +
        '<p><a href="../../integrations.md#x" target="_blank">x</a> <a href="https://e.com">e</a></p>' +
        '<img src="../../assets/screenshots/a.png">',
      'releases/5.6.4/features.md',
      { headingIds: true }
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const [docLink, external] = container.querySelectorAll('a');
    expect(docLink.getAttribute('data-docs-link')).toBe('/admin/docs/integrations.md#x');
    expect(docLink.getAttribute('href')).toBe('/ihub/admin/docs/integrations.md#x');
    expect(docLink.hasAttribute('target')).toBe(false);
    expect(external.getAttribute('href')).toBe('https://e.com');
    expect(container.querySelector('img').getAttribute('src')).toBe(
      '/ihub/api/admin/docs/assets/screenshots/a.png'
    );
    expect([...container.querySelectorAll('h2')].map(h => h.id)).toEqual([
      'version-compatibility-and-release-notes',
      'setup',
      'setup-1'
    ]);
  });
});
