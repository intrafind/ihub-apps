// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The version policy in the marketplace registry dialog (versioning phase 3,
 * #3091): the channel (stable hides pre-releases, all offers them) and the
 * per-item pins, each a semver range keyed `<type>:<name>`. The dialog loads
 * both from the registry, sends them back on save (pins as an object, empty
 * rows dropped) and refuses a pin without an item key or a range. Every string
 * comes from shared/i18n/en.json.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  createMarketplaceRegistry: jest.fn(),
  updateMarketplaceRegistry: jest.fn(),
  testMarketplaceRegistry: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  createMarketplaceRegistry: (...args) => mockApi.createMarketplaceRegistry(...args),
  updateMarketplaceRegistry: (...args) => mockApi.updateMarketplaceRegistry(...args),
  testMarketplaceRegistry: (...args) => mockApi.testMarketplaceRegistry(...args)
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => ''
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const RegistryFormDialog =
  require('../../../client/src/features/admin/components/marketplace/RegistryFormDialog').default;
const {
  pinsToRows,
  rowsToPins
} = require('../../../client/src/features/admin/components/marketplace/registryPins');

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
  jest.clearAllMocks();
  mockApi.updateMarketplaceRegistry.mockResolvedValue({});
});

const REGISTRY = {
  id: 'official',
  name: 'Official',
  source: 'https://marketplace.example/catalog.json',
  auth: { type: 'none' },
  enabled: true,
  channel: 'all',
  pins: { 'integration:org.ckan__open-data-portal': '1.3.x' }
};

test('pins round-trip between the config object and the editable rows', () => {
  expect(pinsToRows({ 'b:x': '2', 'a:y': '1.x' })).toEqual([
    { key: 'a:y', range: '1.x' },
    { key: 'b:x', range: '2' }
  ]);
  expect(
    rowsToPins([
      { key: ' integration:a ', range: ' 1.3.x ' },
      { key: '', range: '' }
    ])
  ).toEqual({ 'integration:a': '1.3.x' });
});

test('loads the channel and the pins, and saves what the admin changed', async () => {
  const onSave = jest.fn();
  render(<RegistryFormDialog registry={REGISTRY} onSave={onSave} onCancel={() => {}} />);
  const policy = screen.getByTestId('registry-version-policy');
  const channel = within(policy).getByLabelText('Channel');
  expect(channel).toHaveValue('all');
  expect(within(policy).getAllByLabelText('Item')[0]).toHaveValue(
    'integration:org.ckan__open-data-portal'
  );
  expect(within(policy).getAllByLabelText('Version range')[0]).toHaveValue('1.3.x');

  fireEvent.change(channel, { target: { value: 'stable' } });
  fireEvent.click(within(policy).getByRole('button', { name: 'Add pin' }));
  fireEvent.change(within(policy).getAllByLabelText('Item')[1], {
    target: { value: 'skill:summarize' }
  });
  fireEvent.change(within(policy).getAllByLabelText('Version range')[1], {
    target: { value: '~2.1.0' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockApi.updateMarketplaceRegistry).toHaveBeenCalled());
  const [id, payload] = mockApi.updateMarketplaceRegistry.mock.calls[0];
  expect(id).toBe('official');
  expect(payload.channel).toBe('stable');
  expect(payload.pins).toEqual({
    'integration:org.ckan__open-data-portal': '1.3.x',
    'skill:summarize': '~2.1.0'
  });
  expect(onSave).toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/MISSING:/);
});

test('removes a pin, and refuses a pin without an item key or a range', async () => {
  render(<RegistryFormDialog registry={REGISTRY} onSave={() => {}} onCancel={() => {}} />);
  const policy = screen.getByTestId('registry-version-policy');
  fireEvent.click(within(policy).getByRole('button', { name: 'Add pin' }));
  fireEvent.change(within(policy).getAllByLabelText('Item')[1], {
    target: { value: 'not a key' }
  });
  fireEvent.change(within(policy).getAllByLabelText('Version range')[1], {
    target: { value: '1.x' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await within(policy).findByText(/Each pin needs an item as <type>:<name>/)
  ).toBeInTheDocument();
  expect(mockApi.updateMarketplaceRegistry).not.toHaveBeenCalled();

  for (const button of within(policy).getAllByRole('button', { name: 'Remove pin' }).reverse()) {
    fireEvent.click(button);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mockApi.updateMarketplaceRegistry).toHaveBeenCalled());
  expect(mockApi.updateMarketplaceRegistry.mock.calls[0][1].pins).toEqual({});
});
