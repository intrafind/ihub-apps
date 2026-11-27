// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project catalog dialog: one list ordered by source (iFinder smart
 * collections, administrators, colleagues, already yours), each entry marked
 * with a source badge, a fixed header with close, search and source filter,
 * and per-source loading, warning and error states. Plus the pure rules behind it (`catalogSources`).
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchProjectCatalog: jest.fn(),
  addCatalogProject: jest.fn(),
  removeCatalogProject: jest.fn(),
  fetchSmartCollections: jest.fn(),
  addSmartCollection: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  fetchProjectCatalog: (...args) => mockApi.fetchProjectCatalog(...args),
  addCatalogProject: (...args) => mockApi.addCatalogProject(...args),
  removeCatalogProject: (...args) => mockApi.removeCatalogProject(...args),
  fetchSmartCollections: (...args) => mockApi.fetchSmartCollections(...args),
  addSmartCollection: (...args) => mockApi.addSmartCollection(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ProjectCatalogDialog =
  require('../../../client/src/features/projects/components/ProjectCatalogDialog').default;
const {
  availableSources,
  catalogProjectSource,
  collectionEntry,
  filterCatalogEntries,
  matchesQuery,
  projectEntry
} = require('../../../client/src/features/projects/utils/catalogSources');

const CATALOG = [
  {
    id: 'company-faq',
    ownership: 'admin',
    name: { en: 'Company FAQ', de: 'Firmen-FAQ' },
    description: { en: 'Answers to common questions' },
    owner: null,
    usage: { items: 3 },
    role: 'catalog',
    subscribed: false
  },
  {
    id: 'prj_docs',
    ownership: 'user',
    name: 'iHub knowledge',
    description: 'Curated delivery docs',
    owner: { name: 'Ann' },
    usage: { items: 12 },
    role: 'catalog',
    subscribed: true
  },
  {
    id: 'prj_case',
    ownership: 'user',
    name: 'Case 2026-114',
    owner: { name: 'Dana' },
    usage: { items: 4 },
    role: 'owner',
    subscribed: false
  }
];
const COLLECTIONS = {
  available: true,
  warnings: [],
  items: [
    {
      collectionId: 'c1',
      name: 'Contracts',
      description: 'Signed',
      documentCount: 40,
      added: false
    },
    {
      collectionId: 'c2',
      name: 'Tenders',
      description: '',
      documentCount: 9,
      added: true,
      projectId: 'ifc_c2'
    }
  ]
};

function renderDialog(props = {}) {
  const handlers = { onClose: jest.fn(), onChanged: jest.fn() };
  render(
    <MemoryRouter>
      <ProjectCatalogDialog {...handlers} collectionsEnabled {...props} />
    </MemoryRouter>
  );
  return handlers;
}

const rowOf = name => screen.getByText(name).closest('li');
const listOrder = () =>
  within(screen.getByRole('list', { name: 'Project catalog' }))
    .getAllByRole('listitem')
    .map(item => item.querySelector('a, span.truncate').textContent);

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchProjectCatalog.mockResolvedValue({ enabled: true, items: CATALOG });
  mockApi.fetchSmartCollections.mockResolvedValue(COLLECTIONS);
});

describe('catalogSources', () => {
  test('tells the source of a catalog project', () => {
    expect(catalogProjectSource({ ownership: 'admin', role: 'catalog' })).toBe('admin');
    expect(catalogProjectSource({ ownership: 'user', role: 'catalog' })).toBe('colleagues');
    expect(catalogProjectSource({ ownership: 'user', role: 'owner' })).toBe('yours');
    expect(catalogProjectSource({ ownership: 'user', role: 'viewer' })).toBe('yours');
  });

  test('derives the status of an entry', () => {
    expect(projectEntry(CATALOG[0], 'en').status).toBe('add');
    expect(projectEntry(CATALOG[1], 'en').status).toBe('added');
    expect(projectEntry(CATALOG[2], 'en').status).toBe('inList');
    expect(collectionEntry(COLLECTIONS.items[0]).status).toBe('add');
    expect(collectionEntry(COLLECTIONS.items[1])).toMatchObject({
      status: 'inList',
      projectId: 'ifc_c2'
    });
  });

  test('searches every word in name, description (all languages) and owner', () => {
    const faq = projectEntry(CATALOG[0], 'en');
    expect(faq.name).toBe('Company FAQ');
    expect(matchesQuery(faq, 'firmen')).toBe(true);
    expect(matchesQuery(faq, 'common FAQ')).toBe(true);
    expect(matchesQuery(faq, 'faq tender')).toBe(false);
    expect(matchesQuery(projectEntry(CATALOG[1], 'en'), 'ann')).toBe(true);
  });

  test('orders by source, iFinder first, and keeps the order within a source', () => {
    const entries = [
      ...CATALOG.map(project => projectEntry(project, 'en')),
      ...COLLECTIONS.items.map(collectionEntry)
    ];
    expect(filterCatalogEntries(entries, '').map(entry => entry.id)).toEqual([
      'c1',
      'c2',
      'company-faq',
      'prj_docs',
      'prj_case'
    ]);
    expect(filterCatalogEntries(entries, 'contracts').map(entry => entry.id)).toEqual(['c1']);
    expect(availableSources(entries.slice(0, 1))).toEqual(['admin']);
    expect(availableSources(entries.slice(0, 1), ['ifinder'])).toEqual(['ifinder', 'admin']);
  });
});

describe('ProjectCatalogDialog', () => {
  test('lists every source in one list, iFinder first, each entry marked with its source', async () => {
    renderDialog();
    expect(await screen.findByText('Contracts')).toBeInTheDocument();
    expect(listOrder()).toEqual([
      'Contracts',
      'Tenders',
      'Company FAQ',
      'iHub knowledge',
      'Case 2026-114'
    ]);
    expect(rowOf('Contracts')).toHaveTextContent('iFinder');
    expect(rowOf('Contracts')).toHaveTextContent('40 documents');
    expect(screen.getByRole('link', { name: 'Tenders' })).toHaveAttribute(
      'href',
      '/projects/ifc_c2'
    );
    expect(rowOf('Company FAQ')).toHaveTextContent('Administrators');
    expect(rowOf('Company FAQ')).toHaveTextContent('3 items');
    expect(rowOf('iHub knowledge')).toHaveTextContent('Colleagues');
    expect(rowOf('iHub knowledge')).toHaveTextContent('By Ann · 12 items');
    expect(rowOf('Case 2026-114')).toHaveTextContent('Yours');
    expect(rowOf('Case 2026-114')).toHaveTextContent('In your projects');
    // No section headers, and one scroll region: no list caps its own height.
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(document.querySelector('ul.max-h-64, ul.max-h-96')).toBeNull();
  });

  test('filters by source and search, with counts that follow the search', async () => {
    renderDialog();
    await screen.findByText('Contracts');
    const filter = screen.getByRole('group', { name: 'Show' });
    expect(within(filter).getByRole('button', { name: /^All 5$/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(within(filter).getByRole('button', { name: /^iFinder 2$/ }));
    expect(screen.queryByText('Company FAQ')).toBeNull();
    expect(screen.getByText('Contracts')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ann' } });
    expect(within(filter).getByRole('button', { name: /^All 1$/ })).toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: /^Colleagues 1$/ })).toBeInTheDocument();
    expect(screen.getByText('Nothing matches “ann”.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filter' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText('Company FAQ')).toBeInTheDocument();
    expect(screen.getByText('Contracts')).toBeInTheDocument();
  });

  test('closes from the header, which never scrolls away', async () => {
    const { onClose } = renderDialog();
    await screen.findByText('Contracts');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  test('adds a smart collection, which then links to its project', async () => {
    mockApi.addSmartCollection.mockResolvedValue({ id: 'ifc_c1' });
    const { onChanged } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Contracts to my projects' }));
    await waitFor(() =>
      expect(mockApi.addSmartCollection).toHaveBeenCalledWith({ collectionId: 'c1' })
    );
    expect(await screen.findByRole('link', { name: 'Contracts' })).toHaveAttribute(
      'href',
      '/projects/ifc_c1'
    );
    expect(onChanged).toHaveBeenCalled();
  });

  test('removes a project added from the catalog, and shows a failure under its row', async () => {
    mockApi.removeCatalogProject.mockRejectedValueOnce(new Error('Server says no'));
    renderDialog();
    const button = await screen.findByRole('button', {
      name: 'Added: remove iHub knowledge from my projects'
    });
    fireEvent.click(button);
    await waitFor(() => expect(mockApi.removeCatalogProject).toHaveBeenCalledWith('prj_docs'));
    expect(await within(button.closest('li')).findByRole('alert')).toBeInTheDocument();

    mockApi.removeCatalogProject.mockResolvedValueOnce({});
    fireEvent.click(button);
    expect(
      await screen.findByRole('button', { name: 'Add iHub knowledge to my projects' })
    ).toBeInTheDocument();
  });

  test('keeps the other sources when iFinder cannot be reached, and retries', async () => {
    mockApi.fetchSmartCollections.mockResolvedValueOnce({
      available: true,
      items: [],
      warnings: [{ code: 'IFINDER_UNREACHABLE' }]
    });
    renderDialog();
    expect(
      await screen.findByText(
        'iFinder could not be reached, so your smart collections are missing from this list.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Company FAQ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Contracts')).toBeInTheDocument();
    expect(mockApi.fetchSmartCollections).toHaveBeenCalledTimes(2);
  });

  test('shows a failed catalog as an error, not as an empty catalog', async () => {
    mockApi.fetchProjectCatalog.mockRejectedValueOnce(new Error('Boom'));
    renderDialog({ collectionsEnabled: false });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been published yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Company FAQ')).toBeInTheDocument();
  });

  test('leaves out what is switched off', async () => {
    mockApi.fetchSmartCollections.mockResolvedValue({ available: false, items: [], warnings: [] });
    renderDialog({ catalogEnabled: false });
    expect(
      await screen.findByText('You have no smart collections in iFinder.')
    ).toBeInTheDocument();
    expect(mockApi.fetchProjectCatalog).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
  });
});
