/**
 * Admin → What's New: a grouped release switcher, one release at a time, a table of contents per
 * release, breaking changes ahead of features and fixes, and release notes rendered as real
 * Markdown.
 *
 * The page, the shared `marked` configuration and DOMPurify are real here; only the admin API
 * and the translation hook are stubbed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
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

import AdminChangelogPage from '../../../client/src/features/admin/pages/AdminChangelogPage';

const INDEX = {
  currentVersion: '5.5.7',
  previousVersion: '5.5.5',
  versions: [
    {
      version: 'next',
      unreleased: true,
      installed: false,
      isNew: false,
      counts: { total: 1, breakingChanges: 0, features: 1, fixes: 0 }
    },
    {
      version: '5.5.7',
      unreleased: false,
      installed: true,
      isNew: true,
      counts: { total: 3, breakingChanges: 1, features: 1, fixes: 1 }
    },
    {
      version: '5.5.6',
      unreleased: false,
      installed: false,
      isNew: true,
      counts: { total: 1, breakingChanges: 0, features: 1, fixes: 0 }
    }
  ]
};

/** A release per minor series, enough of them to hit the ten-per-group cap. */
const LONG_INDEX = {
  currentVersion: '5.5.12',
  previousVersion: null,
  versions: [
    ...Array.from({ length: 13 }, (_, i) => ({
      version: `5.5.${12 - i}`,
      unreleased: false,
      installed: i === 0,
      isNew: false,
      counts: { total: 1, breakingChanges: 0, features: 1, fixes: 0 }
    })),
    {
      version: '5.4.1',
      unreleased: false,
      installed: false,
      isNew: false,
      counts: { total: 1, breakingChanges: 0, features: 1, fixes: 0 }
    },
    {
      version: '4.9.0',
      unreleased: false,
      installed: false,
      isNew: false,
      counts: { total: 1, breakingChanges: 0, features: 1, fixes: 0 }
    }
  ]
};

const RELEASES = {
  next: {
    version: 'next',
    unreleased: true,
    sections: {
      breakingChanges: [],
      features: [{ id: 'coming-soon', title: 'Coming Soon', body: 'Not tagged yet.' }],
      fixes: []
    }
  },
  '5.5.7': {
    version: '5.5.7',
    unreleased: false,
    sections: {
      breakingChanges: [
        {
          id: 'reasoning-effort-is-a-level',
          title: 'Reasoning Effort Is a Level',
          body: '**Before upgrading:** check the `reasoning` setting.'
        }
      ],
      features: [
        {
          id: 'grant-tools-to-a-group',
          title: 'Grant `tools` to a Group',
          body: [
            'A paragraph that is hard-wrapped',
            'onto a second line.',
            '',
            '- Outer item',
            '  - Nested item',
            '',
            '1. First step',
            '2. Second step',
            '',
            '### Configuration',
            '',
            '> The endpoint could not be reached',
            '',
            '| Setting | Value |',
            '| ------- | ----- |',
            '| `tools` | `["*"]` |',
            '',
            'See [the docs](https://example.com/docs).'
          ].join('\n')
        }
      ],
      fixes: [{ id: 'image-models-save-again', title: 'Image Models Save Again', body: 'Body.' }]
    }
  },
  '5.5.6': {
    version: '5.5.6',
    unreleased: false,
    sections: {
      breakingChanges: [],
      features: [{ id: 'older', title: 'Older Feature', body: 'Older body.' }],
      fixes: []
    }
  }
};

function mockApi({ index = INDEX, releases = RELEASES, failVersion } = {}) {
  mockMakeAdminApiCall.mockImplementation(url => {
    if (url === '/admin/changelog') return Promise.resolve({ data: index });
    const match = /^\/admin\/changelog\/(.+)$/.exec(url);
    if (match) {
      const version = decodeURIComponent(match[1]);
      if (version === failVersion) return Promise.reject(new Error('boom'));
      if (releases[version]) return Promise.resolve({ data: releases[version] });
      return Promise.reject(new Error('Release not found'));
    }
    return Promise.reject(new Error(`unexpected call ${url}`));
  });
}

const detailCalls = () =>
  mockMakeAdminApiCall.mock.calls.map(([url]) => url).filter(url => url !== '/admin/changelog');

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

describe('AdminChangelogPage', () => {
  test('lists the releases, opens the first one and renders its notes as Markdown', async () => {
    mockApi();
    render(<AdminChangelogPage />);

    const releases = await screen.findByRole('navigation', { name: 'Releases' });
    expect(
      within(releases)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Unreleased', '5.x22 new', '5.5.x22 new', '5.5.7InstalledNew', '5.5.6New']);

    // Unreleased changes open first on a build that has them.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Unreleased changes' })
    ).toBeVisible();
    expect(detailCalls()).toEqual(['/admin/changelog/next']);

    // Open the tagged release.
    fireEvent.click(within(releases).getByRole('button', { name: /5\.5\.7/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Version 5.5.7' })).toBeVisible();
    expect(screen.getByText('1 Breaking changes · 1 New & improved · 1 Fixes')).toBeVisible();
    await screen.findByRole('heading', { level: 3, name: 'Image Models Save Again' });

    // Table of contents: one link per entry, grouped by section, breaking changes first.
    const toc = screen.getByRole('navigation', { name: 'In this release' });
    const links = within(toc)
      .getAllByRole('link')
      .map(link => link.textContent);
    expect(links).toEqual([
      'Breaking changes (1)',
      'Reasoning Effort Is a Level',
      'New & improved (1)',
      'Grant tools to a Group',
      'Fixes (1)',
      'Image Models Save Again'
    ]);
    expect(within(toc).getByText('tools').tagName).toBe('CODE');

    // Sections in reading order.
    const sectionHeadings = screen
      .getAllByRole('heading', { level: 2 })
      .map(heading => heading.textContent)
      .filter(text => text !== 'Version 5.5.7');
    expect(sectionHeadings).toEqual(['Breaking changes (1)', 'New & improved (1)', 'Fixes (1)']);

    // The entry body is real Markdown, hard-wrapped lines stay one paragraph, and sub-headings
    // sit below the entry's own <h3>.
    const entry = document.getElementById('release-5-5-7-features-grant-tools-to-a-group');
    expect(entry).not.toBeNull();
    expect(within(entry).getByRole('heading', { level: 3 }).textContent).toBe(
      'Grant tools to a Group'
    );
    // The newline of a hard-wrapped line survives as whitespace in the text, not as a <br>.
    expect(entry.querySelector('p').textContent.replace(/\s+/g, ' ')).toBe(
      'A paragraph that is hard-wrapped onto a second line.'
    );
    expect(entry.querySelector('p br')).toBeNull();
    expect(entry.querySelector('ul ul li').textContent).toBe('Nested item');
    expect(entry.querySelectorAll('ol li')).toHaveLength(2);
    expect(entry.querySelector('h4').textContent).toBe('Configuration');
    expect(entry.querySelector('blockquote').textContent).toContain('could not be reached');
    expect(entry.querySelector('table td code').textContent).toBe('tools');
    expect(entry.querySelector('a[href="https://example.com/docs"]')).not.toBeNull();

    // Breaking changes render their migration note.
    expect(screen.getByText('Before upgrading:').tagName).toBe('STRONG');

    // Each opened release is fetched once and then kept.
    fireEvent.click(within(releases).getByRole('button', { name: /Unreleased/ }));
    await screen.findByRole('heading', { level: 2, name: 'Unreleased changes' });
    expect(detailCalls()).toEqual(['/admin/changelog/next', '/admin/changelog/5.5.7']);
  });

  test('says what the upgrade brought in, and marks every release it spanned', async () => {
    mockApi();
    render(<AdminChangelogPage />);

    const notice = await screen.findByRole('region', { name: /Upgraded from/ });
    expect(notice.textContent).toContain('Upgraded from 5.5.5 to 5.5.7');
    expect(notice.textContent).toContain('2 releases are new to this installation');

    // Both releases since 5.5.5 carry the badge, not only the one being run.
    const releases = screen.getByRole('navigation', { name: 'Releases' });
    expect(within(releases).getByRole('button', { name: /^5\.5\.7/ }).textContent).toBe(
      '5.5.7InstalledNew'
    );
    expect(within(releases).getByRole('button', { name: /^5\.5\.6/ }).textContent).toBe('5.5.6New');
  });

  test('says nothing about an upgrade on an installation that never had one', async () => {
    mockApi({ index: LONG_INDEX });
    render(<AdminChangelogPage />);

    await screen.findByRole('navigation', { name: 'Releases' });
    expect(screen.queryByRole('region', { name: /Upgraded from/ })).toBeNull();
  });

  test('groups the releases by major and minor, and opens only what is worth opening', async () => {
    mockApi({ index: LONG_INDEX });
    render(<AdminChangelogPage />);

    const releases = await screen.findByRole('navigation', { name: 'Releases' });
    // The installed release's series is open; the others stay shut.
    expect(
      within(releases)
        .getAllByRole('button')
        .map(button => button.textContent)
        .slice(0, 4)
    ).toEqual(['5.x14', '5.5.x13', '5.5.12Installed', '5.5.11']);
    expect(within(releases).queryByRole('button', { name: /^5\.4\.1/ })).toBeNull();

    // Opening 5.4.x brings its release into the list.
    fireEvent.click(within(releases).getByRole('button', { name: '5.4.x 1' }));
    expect(within(releases).getByRole('button', { name: /^5\.4\.1/ })).toBeVisible();

    // The 4.x major is collapsed, so its releases are not listed at all.
    expect(within(releases).queryByRole('button', { name: /^4\.9\.0/ })).toBeNull();
    fireEvent.click(within(releases).getByRole('button', { name: '4.x 1' }));
    fireEvent.click(within(releases).getByRole('button', { name: '4.9.x 1' }));
    expect(within(releases).getByRole('button', { name: /^4\.9\.0/ })).toBeVisible();

    // Collapsing a group hides what it holds again.
    fireEvent.click(within(releases).getByRole('button', { name: '5.5.x 13' }));
    expect(within(releases).queryByRole('button', { name: /^5\.5\.12/ })).toBeNull();
  });

  test('shows the newest ten releases of a series and the rest on request', async () => {
    mockApi({ index: LONG_INDEX });
    render(<AdminChangelogPage />);

    const releases = await screen.findByRole('navigation', { name: 'Releases' });
    const listed = () =>
      within(releases)
        .getAllByRole('button')
        .map(button => button.textContent)
        .filter(text => /^5\.5\.\d/.test(text));

    expect(listed()).toHaveLength(10);
    expect(listed()[0]).toBe('5.5.12Installed');
    expect(within(releases).queryByRole('button', { name: /^5\.5\.0/ })).toBeNull();

    fireEvent.click(within(releases).getByRole('button', { name: 'Show 3 older' }));
    expect(listed()).toHaveLength(13);
    expect(within(releases).getByRole('button', { name: /^5\.5\.0/ })).toBeVisible();
  });

  test('links in the table of contents scroll to and focus their entry', async () => {
    mockApi({ index: { ...INDEX, versions: INDEX.versions.slice(1) } });
    render(<AdminChangelogPage />);

    await screen.findByRole('heading', { level: 3, name: 'Image Models Save Again' });
    const scrollIntoView = jest.fn();
    const entry = document.getElementById('release-5-5-7-fixes-image-models-save-again');
    entry.scrollIntoView = scrollIntoView;

    const toc = screen.getByRole('navigation', { name: 'In this release' });
    fireEvent.click(within(toc).getByRole('link', { name: 'Image Models Save Again' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(document.activeElement).toBe(entry);
  });

  test('shows an error for a release that fails to load and retries on request', async () => {
    mockApi({ index: { ...INDEX, versions: INDEX.versions.slice(1) }, failVersion: '5.5.7' });
    render(<AdminChangelogPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom');

    mockApi({ index: { ...INDEX, versions: INDEX.versions.slice(1) } });
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Image Models Save Again' })
    ).toBeVisible();
  });

  test('says so when there are no release notes', async () => {
    mockApi({ index: { currentVersion: '5.5.7', versions: [] } });
    render(<AdminChangelogPage />);

    expect(await screen.findByText('No changelog entries yet.')).toBeVisible();
    expect(detailCalls()).toEqual([]);
  });

  test('reports a failure to load the list', async () => {
    mockMakeAdminApiCall.mockRejectedValue(new Error('offline'));
    render(<AdminChangelogPage />);

    expect((await screen.findByRole('alert')).textContent).toContain('offline');
  });
});
