// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marketplace item detail on the shared Drawer (intrafind/ihub-apps#2925):
 *
 *   - a modal dialog named by the item's display name, described by its author;
 *   - the type, version and installation badges under the title;
 *   - focus moves into it, Escape and the close button close it, and focus
 *     returns to the element that opened it;
 *   - every string comes from shared/i18n/en.json.
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockFetchDetail = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceItemDetail: (...args) => mockFetchDetail(...args),
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

const MarketplaceItemDetail =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemDetail').default;

// jsdom has no layout: every element has no size and no offsetParent, which
// the focus trap reads as "not rendered". Give elements a box, as a browser
// would, so the trap sees the drawer's buttons.
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

const ITEM = {
  registryId: 'official',
  type: 'app',
  name: 'translator',
  displayName: { en: 'Translator' },
  description: { en: 'Translates text.' },
  author: 'IntraFind',
  version: '1.2.0',
  installationStatus: 'installed'
};

/**
 * The marketplace page in miniature: a card button opens the detail, its
 * `onClose` unmounts it again.
 */
function Harness({ onClose = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen(true)}>
        open translator
      </button>
      {open && (
        <MarketplaceItemDetail
          item={ITEM}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockFetchDetail.mockReset();
  mockFetchDetail.mockResolvedValue(ITEM);
});

it('is a modal dialog named by the item and described by its author', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'open translator' }));

  const dialog = await screen.findByRole('dialog', { name: 'Translator' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveAttribute('data-testid', 'marketplace-item-detail');
  expect(dialog).toHaveAccessibleDescription('by IntraFind');

  const badges = within(dialog).getByTestId('marketplace-detail-badges');
  expect(badges).toHaveTextContent(en.admin.marketplace.types.app);
  expect(badges).toHaveTextContent('v1.2.0');
  expect(badges).toHaveTextContent(en.admin.marketplace.installed);
  // The body keeps its tabs and actions.
  expect(within(dialog).getByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
  await waitFor(() => expect(mockFetchDetail).toHaveBeenCalled());
  expect(dialog.textContent).not.toMatch(/MISSING:/);
});

it('moves focus in, closes on Escape and returns focus to the opener', async () => {
  const onClose = jest.fn();
  render(<Harness onClose={onClose} />);
  const opener = screen.getByRole('button', { name: 'open translator' });
  opener.focus();
  fireEvent.click(opener);

  const dialog = await screen.findByRole('dialog', { name: 'Translator' });
  await waitFor(() => expect(dialog).toContainElement(document.activeElement));

  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(opener).toHaveFocus());
});

it('closes from its close button', async () => {
  const onClose = jest.fn();
  render(<Harness onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'open translator' }));

  const dialog = await screen.findByRole('dialog', { name: 'Translator' });
  fireEvent.click(within(dialog).getByRole('button', { name: en.common.close }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
