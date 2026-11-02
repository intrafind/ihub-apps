// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The four fixed facts of a marketplace integration item (sign-in, effect,
 * where it runs, action count):
 *
 *   - the card shows them for an integration and nothing for other types;
 *   - the detail shows them with the declared actions, each with its side
 *     effect as a badge (the labels of Admin → Integrations);
 *   - an MCP item (actions listed at runtime) says so instead of a count;
 *   - a detail without facts says the definition could not be read;
 *   - every string comes from shared/i18n/en.json (a missing key renders as
 *     `MISSING:<key>`), and every new key exists in de.json too.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockApi = {
  fetchMarketplaceItemDetail: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceItemDetail: (...args) => mockApi.fetchMarketplaceItemDetail(...args),
  fetchMarketplaceItemFile: jest.fn(),
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
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const MarketplaceItemCard =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemCard').default;
const MarketplaceItemDetail =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemDetail').default;
const {
  integrationFactRows,
  sideEffectTone
} = require('../../../client/src/features/admin/components/marketplace/integrationItemFacts');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

beforeEach(() => {
  mockApi.fetchMarketplaceItemDetail.mockReset();
});

const OPEN_DATA = {
  registryId: 'acme',
  registryName: 'ACME',
  type: 'integration',
  name: 'org.example__open-data',
  displayName: { en: 'Open Data' },
  description: { en: 'Search open data portals.' },
  version: '1.0.0',
  installationStatus: 'available',
  compatible: true,
  facts: {
    protocol: 'openapi',
    authModes: ['none', 'service-account'],
    effect: 'read-write',
    runs: 'cloud',
    actionCount: 2
  }
};

const ACTIONS = [
  { name: 'search', title: { en: 'Search datasets', de: 'Datensätze suchen' }, sideEffect: 'read' },
  { name: 'publish', title: { en: 'Publish a dataset' }, sideEffect: 'write' }
];

/**
 * The text of one fact row of a facts list.
 *
 * @param {HTMLElement} container
 * @param {string} id - signIn | effect | runs | actions
 */
function factText(container, id) {
  return within(container).getByTestId(`integration-fact-${id}`).textContent;
}

describe('MarketplaceItemCard', () => {
  test('shows the four facts of an integration', () => {
    render(<MarketplaceItemCard item={OPEN_DATA} onClick={() => {}} />);

    const facts = screen.getByTestId('integration-facts');
    expect(factText(facts, 'signIn')).toBe('Sign-innone, service account');
    expect(factText(facts, 'effect')).toBe('Effectread · write');
    expect(factText(facts, 'runs')).toBe('Where it runscloud');
    expect(factText(facts, 'actions')).toBe('Actions2');
    expect(facts.textContent).not.toMatch(/MISSING:/);
  });

  test('an MCP item has no action count: the server lists its actions', () => {
    const mcp = {
      ...OPEN_DATA,
      facts: {
        protocol: 'mcp',
        authModes: ['oauth-user'],
        effect: 'unknown',
        runs: null,
        actionCount: null
      }
    };
    render(<MarketplaceItemCard item={mcp} onClick={() => {}} />);

    const facts = screen.getByTestId('integration-facts');
    expect(factText(facts, 'signIn')).toBe('Sign-inuser OAuth');
    expect(factText(facts, 'effect')).toBe('Effectnot declared');
    expect(factText(facts, 'runs')).toBe('Where it runsnot stated');
    expect(factText(facts, 'actions')).toBe('Actionslisted by the server');
  });

  test('shows no facts for other item types or without facts', () => {
    const { rerender } = render(
      <MarketplaceItemCard item={{ ...OPEN_DATA, type: 'app' }} onClick={() => {}} />
    );
    expect(screen.queryByTestId('integration-facts')).not.toBeInTheDocument();

    rerender(<MarketplaceItemCard item={{ ...OPEN_DATA, facts: null }} onClick={() => {}} />);
    expect(screen.queryByTestId('integration-facts')).not.toBeInTheDocument();
  });
});

describe('MarketplaceItemDetail', () => {
  /**
   * Render the detail with the given server answer and wait for it to load.
   *
   * @param {object} detail
   */
  async function renderDetail(detail) {
    mockApi.fetchMarketplaceItemDetail.mockResolvedValue(detail);
    render(
      <MemoryRouter>
        <MarketplaceItemDetail item={OPEN_DATA} onClose={() => {}} />
      </MemoryRouter>
    );
    return screen.findByTestId('integration-facts-section');
  }

  test('shows the facts and the actions with their effect', async () => {
    const section = await renderDetail({
      ...OPEN_DATA,
      facts: { ...OPEN_DATA.facts, actions: ACTIONS }
    });

    expect(within(section).getByText('Integration facts')).toBeInTheDocument();
    expect(factText(section, 'effect')).toBe('Effectread · write');
    const actions = within(section).getByTestId('integration-actions');
    const rows = within(actions).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Search datasets');
    expect(rows[0]).toHaveTextContent('search');
    expect(within(rows[0]).getByText('read')).toHaveClass('bg-blue-100');
    expect(rows[1]).toHaveTextContent('Publish a dataset');
    expect(within(rows[1]).getByText('write')).toHaveClass('bg-amber-100');
    expect(section.textContent).not.toMatch(/MISSING:/);
  });

  test('an MCP item explains that the server lists its actions', async () => {
    const section = await renderDetail({
      ...OPEN_DATA,
      facts: {
        protocol: 'mcp',
        authModes: ['service-account'],
        effect: 'unknown',
        runs: 'cloud',
        actionCount: null,
        actions: []
      }
    });

    expect(within(section).queryByTestId('integration-actions')).not.toBeInTheDocument();
    expect(section).toHaveTextContent(en.admin.marketplace.integrationFacts.actionsDynamicHint);
  });

  test('says when the facts are not available', async () => {
    const section = await renderDetail({ ...OPEN_DATA, facts: null });

    expect(section).toHaveTextContent(en.admin.marketplace.integrationFacts.unavailable);
    expect(within(section).queryByTestId('integration-facts')).not.toBeInTheDocument();
  });

  test('shows no integration section for other item types', async () => {
    mockApi.fetchMarketplaceItemDetail.mockResolvedValue({ ...OPEN_DATA, type: 'prompt' });
    render(
      <MemoryRouter>
        <MarketplaceItemDetail item={{ ...OPEN_DATA, type: 'prompt' }} onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => expect(mockApi.fetchMarketplaceItemDetail).toHaveBeenCalled());
    expect(screen.queryByTestId('integration-facts-section')).not.toBeInTheDocument();
  });
});

describe('integrationItemFacts', () => {
  test('no facts, no rows', () => {
    expect(integrationFactRows(null, k => k)).toEqual([]);
  });

  test('side effects map onto the shared Badge tones', () => {
    expect(sideEffectTone('read')).toBe('info');
    expect(sideEffectTone('write')).toBe('warning');
    expect(sideEffectTone('destructive')).toBe('danger');
    expect(sideEffectTone('unknown')).toBe('neutral');
    expect(sideEffectTone(undefined)).toBe('neutral');
  });

  test('every integrationFacts key exists in en and de', () => {
    const flatten = (obj, prefix = '') =>
      Object.entries(obj).flatMap(([key, value]) =>
        value && typeof value === 'object'
          ? flatten(value, `${prefix}${key}.`)
          : [`${prefix}${key}`]
      );
    const enKeys = flatten(en.admin.marketplace.integrationFacts).sort();
    const deKeys = flatten(de.admin.marketplace.integrationFacts).sort();
    expect(deKeys).toEqual(enKeys);
  });
});
