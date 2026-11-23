// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "?" help links beside admin page titles (`DocsLink`) open a section of Admin →
 * Documentation. Each topic names a page and a heading anchor; when a heading is renamed, the link
 * would land at the top of the page, so this test checks every anchor against the Markdown.
 */
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/api/${p}`,
  buildPath: p => p
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

let mockUser;
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  __esModule: true,
  useOptionalAuth: () => ({ user: mockUser })
}));

import DocsLink from '../../../client/src/features/admin/components/DocsLink';
import {
  DOCS_HELP_TOPICS,
  docsHelpPath
} from '../../../client/src/features/admin/utils/docsHelpTopics';
import { createAnchorSequence } from '../../../shared/docsAnchors.js';

const docsDir = path.join(__dirname, '..', '..', '..', 'docs');

/** The anchors of a page's headings, outside fenced code blocks. */
function headingAnchors(page) {
  const markdown = readFileSync(path.join(docsDir, page), 'utf8').replace(
    /^---\n[\s\S]*?\n---\n/,
    ''
  );
  const nextAnchor = createAnchorSequence();
  const anchors = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) anchors.push(nextAnchor(match[1]));
  }
  return anchors;
}

describe('docsHelpPath', () => {
  test('a topic maps to its documentation route and heading', () => {
    expect(docsHelpPath('models')).toBe('/admin/docs/models.md#set-up-models-in-the-admin-ui');
    expect(docsHelpPath('apps')).toBe('/admin/docs/app-quickstart.md');
  });

  test('an unknown topic has no route', () => {
    expect(docsHelpPath('nope')).toBeNull();
    expect(docsHelpPath('toString')).toBeNull();
  });

  test.each(Object.entries(DOCS_HELP_TOPICS))(
    'topic %s points to an existing page and heading',
    (topic, { page, section }) => {
      const anchors = headingAnchors(page);
      expect(anchors.length).toBeGreaterThan(0);
      if (section) expect(anchors).toContain(section);
    }
  );
});

describe('DocsLink', () => {
  const renderLink = topic =>
    render(
      <MemoryRouter>
        <DocsLink topic={topic} />
      </MemoryRouter>
    );

  test('renders a named link to the documentation section for an administrator', () => {
    mockUser = { isAdmin: true, permissions: { adminAccess: true } };
    renderLink('providers');
    const link = screen.getByRole('link', { name: 'Help: Connect a provider' });
    expect(link).toHaveAttribute('href', '/admin/docs/models.md#connect-a-provider');
    expect(link).toHaveAttribute('title', 'Help: Connect a provider');
  });

  test('is not rendered for a content admin, who cannot open the documentation', () => {
    mockUser = { isAdmin: false, permissions: { contentAdmin: true, adminAccess: false } };
    renderLink('apps');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('is not rendered for an unknown topic', () => {
    mockUser = { isAdmin: true, permissions: { adminAccess: true } };
    renderLink('nope');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
