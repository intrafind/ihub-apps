// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Reviewing the files of a marketplace skill in the item detail:
 *
 *   - a skill with more than its SKILL.md gets a Files tab with the number of
 *     files; a skill with only SKILL.md, or any other item, does not;
 *   - the tab lists every file, opens SKILL.md first and fetches a file from the
 *     registry when it is selected, once, and keeps it while the panel is open;
 *   - Markdown reads rendered and can be switched to its source, any other file
 *     is plain text;
 *   - a file that cannot be loaded says so and can be tried again;
 *   - every string comes from shared/i18n/en.json.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockFetchDetail = jest.fn();
const mockFetchFile = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceItemDetail: (...args) => mockFetchDetail(...args),
  fetchMarketplaceItemFile: (...args) => mockFetchFile(...args),
  installMarketplaceItem: jest.fn(),
  updateMarketplaceItem: jest.fn(),
  uninstallMarketplaceItem: jest.fn(),
  detachMarketplaceItem: jest.fn(),
  makeAdminApiCall: jest.fn()
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// Shows the Markdown it is given, so a test can tell rendered from source.
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: ({ content }) => <div data-testid="rendered-markdown">{content}</div>
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const MarketplaceItemDetail =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemDetail').default;

// jsdom has no layout: give elements a box, as a browser would, so the
// drawer's focus trap sees its buttons.
const layoutProps = ['offsetWidth', 'offsetHeight', 'offsetParent'];
const originals = {};
beforeAll(async () => {
  for (const prop of layoutProps) {
    originals[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 100
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 20
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentNode;
    }
  });
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});
afterAll(() => {
  for (const prop of layoutProps) {
    if (originals[prop]) Object.defineProperty(HTMLElement.prototype, prop, originals[prop]);
  }
});

const SKILL = {
  registryId: 'official',
  type: 'skill',
  name: 'accessibility-audit',
  displayName: { en: 'Accessibility Audit' },
  description: { en: 'Audits a site.' },
  author: 'Anthropic',
  version: '1.0.0',
  installationStatus: 'available',
  contentPreview: { body: '# Audit', frontmatter: {} },
  files: ['SKILL.md', 'references/wcag-violations.md', 'scripts/scan.py']
};

const FILES = {
  'SKILL.md': '---\nname: accessibility-audit\n---\n# Audit\n<!-- hidden note -->',
  'references/wcag-violations.md': '# WCAG\n\nScan mechanics.',
  'scripts/scan.py': 'print("scan")'
};

const renderDetail = item => {
  mockFetchDetail.mockResolvedValue(item);
  return render(
    <MemoryRouter>
      <MarketplaceItemDetail item={item} onClose={() => {}} />
    </MemoryRouter>
  );
};

const openFilesTab = async () => {
  const tab = await screen.findByRole('button', { name: 'Files (3)' });
  fireEvent.click(tab);
  return await screen.findByTestId('marketplace-skill-files');
};

beforeEach(() => {
  mockFetchDetail.mockReset();
  mockFetchFile.mockReset();
  mockFetchFile.mockImplementation(async (_registry, _type, _name, path) => FILES[path]);
});

describe('the Files tab of a marketplace skill', () => {
  it('is there for a skill with more than SKILL.md, with the number of files', async () => {
    renderDetail(SKILL);
    expect(await screen.findByRole('button', { name: 'Files (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Content' })).toBeInTheDocument();
  });

  it('is not there for a skill that is only its SKILL.md', async () => {
    renderDetail({ ...SKILL, files: ['SKILL.md'] });
    await screen.findByRole('button', { name: 'Content' });
    expect(screen.queryByRole('button', { name: /^Files/ })).not.toBeInTheDocument();
  });

  it('is not there for a skill whose file list is unknown, nor for another type', async () => {
    const { unmount } = renderDetail({ ...SKILL, files: undefined });
    await screen.findByRole('button', { name: 'Content' });
    expect(screen.queryByRole('button', { name: /^Files/ })).not.toBeInTheDocument();
    unmount();

    renderDetail({ ...SKILL, type: 'app', name: 'translator', files: SKILL.files });
    await screen.findByRole('button', { name: 'Content' });
    expect(screen.queryByRole('button', { name: /^Files/ })).not.toBeInTheDocument();
  });

  it('lists every file and opens SKILL.md first, fetched from the registry', async () => {
    renderDetail(SKILL);
    const files = await openFilesTab();

    const list = within(files).getByRole('navigation', { name: 'Files of this skill' });
    expect(
      within(list)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(SKILL.files);
    expect(within(list).getByRole('button', { name: 'SKILL.md' })).toHaveAttribute(
      'aria-current',
      'true'
    );

    const view = await screen.findByTestId('marketplace-skill-file-view');
    await waitFor(() => expect(within(view).getByTestId('rendered-markdown')).toBeInTheDocument());
    expect(mockFetchFile).toHaveBeenCalledTimes(1);
    expect(mockFetchFile).toHaveBeenCalledWith(
      'official',
      'skill',
      'accessibility-audit',
      'SKILL.md'
    );
    expect(files.textContent).not.toMatch(/MISSING:/);
  });

  it('opens another file when it is selected, and keeps a file it has loaded', async () => {
    renderDetail(SKILL);
    const files = await openFilesTab();
    await screen.findByTestId('rendered-markdown');

    fireEvent.click(within(files).getByRole('button', { name: 'scripts/scan.py' }));
    const view = screen.getByTestId('marketplace-skill-file-view');
    await waitFor(() => expect(within(view).getByText('print("scan")')).toBeInTheDocument());
    expect(mockFetchFile).toHaveBeenLastCalledWith(
      'official',
      'skill',
      'accessibility-audit',
      'scripts/scan.py'
    );

    // Back to a file already loaded: no second request
    fireEvent.click(within(files).getByRole('button', { name: 'SKILL.md' }));
    await screen.findByTestId('rendered-markdown');
    expect(mockFetchFile).toHaveBeenCalledTimes(2);
  });

  it('shows a file that is not Markdown as plain text, without a source switch', async () => {
    renderDetail(SKILL);
    const files = await openFilesTab();
    await screen.findByTestId('rendered-markdown');

    fireEvent.click(within(files).getByRole('button', { name: 'scripts/scan.py' }));
    await screen.findByText('print("scan")');
    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show source' })).not.toBeInTheDocument();
  });

  it('reads Markdown rendered and switches to its source, with what rendering hides', async () => {
    renderDetail(SKILL);
    await openFilesTab();
    await screen.findByTestId('rendered-markdown');

    const toggle = screen.getByRole('button', { name: 'Show source' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
    const source = screen.getByText(/hidden note/);
    expect(source.tagName).toBe('PRE');
    expect(source.textContent).toBe(FILES['SKILL.md']);
    expect(screen.getByRole('button', { name: 'Show rendered' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show rendered' }));
    expect(await screen.findByTestId('rendered-markdown')).toBeInTheDocument();
  });

  it('says so when a file cannot be loaded, and loads it again on request', async () => {
    mockFetchFile.mockImplementation(async (_registry, _type, _name, path) => {
      if (path === 'references/wcag-violations.md' && mockFetchFile.mock.calls.length <= 2) {
        const error = new Error('Request failed');
        error.response = { data: { code: 'NOT_FOUND', detail: 'File not found' } };
        throw error;
      }
      return FILES[path];
    });
    renderDetail(SKILL);
    const files = await openFilesTab();
    await screen.findByTestId('rendered-markdown');

    fireEvent.click(within(files).getByRole('button', { name: 'references/wcag-violations.md' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('File not found');

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByText(/Scan mechanics/)).toBeInTheDocument();
  });
});
